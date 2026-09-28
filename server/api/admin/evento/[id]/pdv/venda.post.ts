/**
 * POST /api/admin/evento/:id/pdv/venda — venda no balcão.
 *
 * A diferença entre isto e o checkout online não é a tela, é QUANDO o
 * dinheiro existe. Online, o pedido nasce devendo e o gateway avisa depois
 * que pagou; no guichê o dinheiro já está na mão do operador quando ele
 * aperta o botão. Então aqui não existe reserva pendente nem espera: grava a
 * venda e emite o ingresso no MESMO commit.
 *
 * É por isso que `emitirNaTransacao` existe. Commitar a venda e emitir depois
 * abriria uma janela em que uma queda deixa o dinheiro na gaveta e o cliente
 * sem ingresso — e quem descobre é o operador, com a fila esperando.
 *
 * Duas regras de dinheiro que só valem aqui:
 *   - o preço é o de BALCÃO (`fee_mode_pos`), que não é o do site;
 *   - o preço NUNCA vem do navegador, igual ao checkout. O balcão manda quais
 *     lotes e quantos; todo valor é relido do banco.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { q, q1, tx } from '../../../../../utils/db'
import { EstoqueInsuficiente, LoteIndisponivel, reservar } from '../../../../../utils/estoque'
import { faceDoTipo, type ModoTaxa } from '../../../../../utils/dinheiro'
import { aplicarCupom, CupomRecusado, PEDIDO_EM_PE, resgatarCupom } from '../../../../../utils/cupom'
import { gerarCodigo } from '../../../../../utils/ingresso'
import { emitirNaTransacao } from '../../../../../utils/emissao'
import { SQL_FIM_DO_DIA_DO_LOTE, SQL_TRAVA_TURNO_ABERTO } from '../../../../../utils/caixa'
import { cpfValido } from '../../../../../utils/documento'
import {
  conferirCotaDeMeia, CotaDeMeiaEsgotada, documentoExigido, MOTIVOS, MOTIVOS_EM_TEXTO, motivoValido,
} from '../../../../../utils/meia-entrada'

const Entrada = z.object({
  turnoId: z.string().uuid(),
  itens: z.array(z.object({
    lotId: z.string().uuid(),
    ticketTypeId: z.string().uuid().nullish(),
    quantidade: z.number().int().positive().max(50),
    /**
     * Por que esta linha é meia-entrada — a mesma declaração do checkout. O guichê pergunta
     * o motivo (estudante, idoso, PCD…) porque é ele que diz à portaria QUAL papel pedir;
     * `documento` é o número da credencial (carteira estudantil, ID Jovem), opcional aqui:
     * o operador está com o documento na mão, e sem número a linha leva o CPF do cliente.
     */
    meia: z.object({
      motivo: z.string().min(1).max(40),
      documento: z.string().trim().max(40).nullish(),
    }).nullish(),
  })).min(1).max(20),
  forma: z.enum(['dinheiro', 'debito', 'credito', 'pix']),
  /** só em dinheiro: o que a pessoa entregou, pra calcular o troco */
  recebidoCents: z.number().int().min(0).max(100_000_00).nullish(),
  /** o balcão quase nunca pede dados; quando pede, é meia-entrada ou nominal */
  comprador: z.object({
    nome: z.string().min(3).max(120).nullish(),
    email: z.string().email().nullish(),
    documento: z.string().max(18).nullish(),
    telefone: z.string().max(20).nullish(),
  }).nullish(),
  cupom: z.string().max(40).nullish(),
  observacao: z.string().max(200).nullish(),
  /**
   * Chave da venda, gerada pelo navegador UMA vez por venda. É o que impede o
   * "Vender" repetido pela rede (resposta que se perdeu, toque duplo, Wi-Fi
   * do guichê caindo) de virar duas vendas com o mesmo dinheiro na gaveta.
   * Opcional só pra não quebrar quem ainda não manda.
   */
  chave: z.string().uuid().nullish(),
})

/**
 * O código do pedido, derivado da chave da venda.
 *
 * `orders.code` é UNIQUE: com o código saindo da chave, a segunda tentativa
 * da MESMA venda esbarra no índice do banco e não grava de novo — sem coluna
 * nova e sem pré-checagem que duas requisições leem juntas. O turno entra no
 * hash pra a mesma chave em outro caixa não colidir. Mesmo formato do
 * `gerarCodigo` (PDV-XXXX-XXXX), pra o código continuar legível no guichê.
 */
const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function codigoDaVenda(turnoId: string, chave: string): string {
  const h = createHash('sha256').update(`pdv:${turnoId}:${chave}`).digest()
  let s = ''
  for (let i = 0; i < 8; i++) s += ALFABETO_CODIGO[h[i] % ALFABETO_CODIGO.length]
  return `PDV-${s.slice(0, 4)}-${s.slice(4)}`
}

/** O recado de esgotado pra quem está no guichê — não o texto de log da exceção. */
function recadoDeEsgotado(e: EstoqueInsuficiente): string {
  if (e.disponivel <= 0) {
    return `Acabou "${e.nome}". Tire do carrinho e ofereça outra opção ao cliente.`
  }
  const resta = e.disponivel === 1 ? 'Resta só 1' : `Restam só ${e.disponivel}`
  return `${resta} de "${e.nome}" e a venda pedia ${e.pedido}. `
    + `Diminua para ${e.disponivel} ou ofereça outra opção.`
}

export default defineEventHandler(async (event) => {
  const eventId = getRouterParam(event, 'id')!
  const sessao = (event.context as any).sessao
  if (!sessao?.usuarioId) {
    throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })
  }
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    const campos = p.error.flatten().fieldErrors
    throw createError({
      statusCode: 400,
      statusMessage: campos.comprador ? 'Confira os dados do cliente: nome com pelo menos 3 letras e e-mail válido.'
        : campos.itens ? 'Monte a venda com pelo menos um ingresso (no máximo 50 de cada).'
          : 'Não entendi a venda. Confira o carrinho e a forma de pagamento e tente de novo.',
      data: p.error.flatten(),
    })
  }
  const d = p.data

  // --------------------------------------------------------------- evento
  const ev = await q1<any>(
    `SELECT id, org_id, name, slug, status, fee_bps, fee_mode_pos, sales_end_at, timezone
       FROM events WHERE id = $1`, [eventId])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  if (ev.status !== 'ativo') {
    throw createError({ statusCode: 409, statusMessage: 'As vendas deste evento não estão abertas' })
  }

  // ------------------------------------------------------- ponto e formas
  // O turno vem no CORPO: cerca própria, antes de qualquer escrita. Esta é a
  // mesma folga que um dia abriu o check-in entre produtoras.
  const turno = await q1<any>(
    `SELECT t.id, t.status, t.terminal_id, p.name AS ponto, p.payment_methods
       FROM pos_shifts t JOIN pos_terminals p ON p.id = t.terminal_id
      WHERE t.id = $1 AND t.event_id = $2`, [d.turnoId, eventId])
  if (!turno) throw createError({ statusCode: 404, statusMessage: 'Caixa não encontrado' })
  if (!turno.payment_methods.includes(d.forma)) {
    throw createError({
      statusCode: 422,
      statusMessage: `${turno.ponto} não aceita essa forma de pagamento.`,
    })
  }

  // ---------------------------------------- a mesma venda chegando de novo
  // A resposta da primeira tentativa se perdeu e o navegador mandou outra
  // vez: devolve o recibo do que JÁ foi vendido, em vez de vender de novo.
  // Esta leitura é só o atalho do caso comum; quem garante é o UNIQUE de
  // `orders.code`, lá embaixo, pra quando as duas chegam juntas.
  const codigo = d.chave ? codigoDaVenda(d.turnoId, d.chave) : gerarCodigo('PDV')
  if (d.chave) {
    const ja = await q1<any>(
      `SELECT id FROM orders WHERE code = $1 AND event_id = $2 AND pos_shift_id = $3`,
      [codigo, eventId, d.turnoId])
    if (ja) return { ...(await reciboDoPedido(ja.id, turno.ponto)), repetida: true }
  }

  // ------------------------------------------- preços, relidos do banco --
  const lotIds = [...new Set(d.itens.map((i) => i.lotId))]
  const lotes = await q<any>(
    `SELECT l.id, l.name, l.price_cents, l.sector_id, s.event_id
       FROM lots l JOIN sectors s ON s.id = l.sector_id
      WHERE l.id = ANY($1::uuid[])`, [lotIds])
  const porLote = new Map(lotes.map((l) => [l.id, l]))
  for (const it of d.itens) {
    const l = porLote.get(it.lotId)
    if (!l) throw createError({ statusCode: 404, statusMessage: 'Lote não encontrado' })
    if (l.event_id !== ev.id) {
      throw createError({ statusCode: 400, statusMessage: 'Lote não pertence a este evento' })
    }
  }

  // Ingresso de dia que já passou não se vende. O estoque não sabe de data
  // (é contagem), então quem recusa é o dia do lote — a mesma régua que tira
  // o lote do catálogo do balcão. Vender ontem hoje é cobrar por uma entrada
  // que a portaria vai recusar com o cliente já dentro da fila.
  const dias = await q<any>(SQL_FIM_DO_DIA_DO_LOTE, [lotIds])
  for (const dia of dias) {
    if (dia.fim_do_dia && new Date(dia.fim_do_dia).getTime() <= Date.now()) {
      const nome = porLote.get(dia.lot_id)?.name ?? 'Este ingresso'
      throw createError({
        statusCode: 409,
        statusMessage: `"${nome}" era para ${quandoFoi(dia.fim_do_dia, ev.timezone)}, que já terminou. `
          + 'Tire do carrinho e venda um ingresso de hoje.',
        data: { tipo: 'dia_passou' },
      })
    }
  }

  const tipoIds = d.itens.map((i) => i.ticketTypeId).filter(Boolean) as string[]
  const tipos = tipoIds.length
    ? await q<any>(`SELECT id, lot_id, name, kind, discount_bps, requires_document
                      FROM ticket_types WHERE id = ANY($1::uuid[])`, [tipoIds])
    : []
  const porTipo = new Map(tipos.map((t) => [t.id, t]))

  const documento = d.comprador?.documento?.replace(/\D/g, '') || null

  const linhas = d.itens.map((it) => {
    const lote = porLote.get(it.lotId)!
    let face = Number(lote.price_cents)
    if (it.ticketTypeId) {
      const t = porTipo.get(it.ticketTypeId)
      if (!t) throw createError({ statusCode: 404, statusMessage: 'Tipo de ingresso não encontrado' })
      if (t.lot_id !== it.lotId) {
        throw createError({ statusCode: 400, statusMessage: 'Tipo de ingresso não é deste lote' })
      }
      // Meia-entrada sem documento na mão é meia-entrada que a portaria vai
      // ter que discutir com a pessoa no portão. O lugar de pedir é o guichê.
      if (t.requires_document && !documento) {
        throw createError({
          statusCode: 422,
          statusMessage: `${t.name} exige o documento do beneficiário. Peça o documento antes de vender.`,
        })
      }
      face = faceDoTipo(face, Number(t.discount_bps), Number(ev.fee_bps), ev.fee_mode_pos as ModoTaxa)
    }
    return { quantidade: it.quantidade, faceUnitCents: face }
  })

  // O documento do beneficiário vai na LINHA da meia (`half_document`), que é
  // de onde a emissão o carimba em cada ingresso — é o número que a portaria
  // confere. Antes ele só ia pro cadastro do cliente, e só quando havia
  // e-mail: sem e-mail, o CPF digitado no guichê se perdia inteiro.
  const docDaLinha = d.itens.map((it) =>
    it.ticketTypeId && porTipo.get(it.ticketTypeId)?.requires_document ? documento : null)

  if (documento && !cpfValido(documento)) {
    throw createError({ statusCode: 400, statusMessage: 'CPF inválido' })
  }

  // ------------------------------------------ meia-entrada: motivo e cota (ADM-02)
  // O guichê vendia meia sem perguntar o motivo e sem conferir a cota de 40% do lote: o
  // checkout recusava a 5ª meia de um lote de 10, e o balcão vendia a 5ª, a 6ª, a 7ª. O
  // motivo é o que diz à portaria qual documento pedir; a cota é a lei (Decreto 8.537/2015).
  // A declaração é conferida AQUI, antes de qualquer escrita; a cota, lá dentro da transação,
  // depois de `reservar()` — a mesma ordem do checkout (ver `conferirCotaDeMeia`).
  const meiaDaLinha = d.itens.map((it, i) => {
    const t = it.ticketTypeId ? porTipo.get(it.ticketTypeId) : null
    const declarado = it.meia ?? null
    if (t?.kind !== 'meia') {
      if (declarado) {
        throw createError({
          statusCode: 422,
          statusMessage: `"${t?.name ?? porLote.get(it.lotId)?.name ?? 'Este ingresso'}" não é meia-entrada: `
            + 'tire o motivo da meia desta linha ou escolha a opção de meia.',
          data: { tipo: 'meia_em_inteira' },
        })
      }
      return null
    }
    if (!declarado?.motivo) {
      throw createError({
        statusCode: 422,
        statusMessage: `Pergunte ao cliente o motivo da meia-entrada de "${t.name}" e escolha na venda: `
          + `${MOTIVOS_EM_TEXTO}. É ele que diz à portaria qual documento pedir.`,
        data: { tipo: 'meia_sem_motivo', motivos: Object.keys(MOTIVOS) },
      })
    }
    if (!motivoValido(declarado.motivo)) {
      throw createError({
        statusCode: 422,
        statusMessage: `"${declarado.motivo}" não dá direito a meia-entrada. Os motivos da lei são: ${MOTIVOS_EM_TEXTO}.`,
        data: { tipo: 'meia_motivo_invalido', motivos: Object.keys(MOTIVOS) },
      })
    }
    return {
      motivo: declarado.motivo,
      // o número da credencial, quando o operador digitou; senão o CPF do cliente (se houver)
      documento: declarado.documento?.trim() || docDaLinha[i],
      exigido: documentoExigido(declarado.motivo),
    }
  })
  const meiasPorLote = new Map<string, number>()
  d.itens.forEach((it, i) => {
    if (meiaDaLinha[i]) meiasPorLote.set(it.lotId, (meiasPorLote.get(it.lotId) ?? 0) + it.quantidade)
  })

  // --------------------------------------------------------------- cupom
  // A MESMA régua do site (ADM-15): `resgatarCupom` trava a linha do cupom e conta os usos em
  // `orders` (não no placar `uses`, que o carrinho expirado também gasta), com limite total,
  // limite por CPF e teto de desconto (`aplicarCupom`). Era um SELECT solto `uses < max_uses`
  // fora da transação e um `uses + 1` depois: dois caixas passavam juntos num cupom de 1 uso,
  // o "1 por pessoa" e o teto eram ignorados, e o balcão recusava cupom que o site aceitava.
  //
  // O "um por pessoa" responde pelo CPF — então, no balcão, cupom pede o CPF do cliente.
  if (d.cupom && !documento) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Cupom no balcão pede o CPF do cliente: é ele que responde pelo limite de uso por pessoa.',
      data: { tipo: 'cupom', motivo: 'sem_cpf' },
    })
  }

  // O modo do BALCÃO, não o do site.
  const modo: ModoTaxa = ev.fee_mode_pos

  // ------------------------ tudo num commit só: venda + estoque + ingresso
  const resultado = await tx(async (c) => {
    // A trava do caixa é a primeira coisa: pega o lock da linha do turno e só
    // devolve se ele estiver aberto. Fechamento concorrente espera aqui — ou
    // esta venda entra na contagem dele, ou esta venda é recusada. Nunca as
    // duas coisas.
    const aberto = await c.query(SQL_TRAVA_TURNO_ABERTO, [d.turnoId])
    if (aberto.rowCount !== 1) {
      throw createError({
        statusCode: 409,
        statusMessage: 'O caixa deste ponto está fechado. Abra um caixa antes de vender.',
      })
    }

    await reservar(c, d.itens.map((i) => ({
      lotId: i.lotId, ticketTypeId: i.ticketTypeId ?? null, quantidade: i.quantidade,
    })), { canal: 'bilheteria' })

    // O cupom DEPOIS de `reservar()` — a ordem do checkout (lote antes do cupom), senão duas
    // vendas que pegam os mesmos dois recursos em ordens opostas se prendem uma na outra.
    const cupom = d.cupom
      ? await resgatarCupom(c, {
          eventId: ev.id, codigo: d.cupom, documento: documento!,
          lotIdsDoPedido: d.itens.map((i) => i.lotId), fuso: ev.timezone,
        })
      : null
    // "Um por pessoa" também vê a venda de BALCÃO. `resgatarCupom` conta o CPF pelo cadastro do
    // cliente (`customers.document`), e o balcão sem e-mail não cria cadastro — o CPF vai no
    // ingresso (`holder_document`). Sem esta conta, o mesmo CPF usava o cupom "1 por pessoa"
    // no guichê quantas vezes quisesse. A linha do cupom já está travada pelo resgate.
    if (cupom) {
      const { rows: [uso] } = await c.query(
        `SELECT pc.max_per_customer,
                count(o.id) FILTER (WHERE cu.document = $2
                                       OR (o.customer_id IS NULL AND EXISTS (
                                             SELECT 1 FROM tickets t
                                              WHERE t.order_id = o.id AND t.holder_document = $2)))::int
                  AS da_pessoa
           FROM promo_codes pc
           LEFT JOIN orders o ON o.promo_code_id = pc.id AND o.status = ANY($3::text[])
           LEFT JOIN customers cu ON cu.id = o.customer_id
          WHERE pc.id = $1
          GROUP BY pc.max_per_customer`, [cupom.id, documento, PEDIDO_EM_PE as unknown as string[]])
      const porPessoa = Number(uso?.max_per_customer ?? 1)
      if (Number(uso?.da_pessoa ?? 0) >= porPessoa) {
        throw new CupomRecusado(
          porPessoa === 1
            ? `Este CPF já usou o cupom ${cupom.codigo}. Ele vale uma vez por pessoa.`
            : `Este CPF já usou o cupom ${cupom.codigo} ${uso.da_pessoa} vezes — o limite é ${porPessoa} por pessoa.`,
          'uma_vez_por_pessoa')
      }
    }
    const total = aplicarCupom(linhas, Number(ev.fee_bps), modo, cupom)

    // ------------------------------------------------------------- o troco
    // Aqui dentro porque o total só existe com o cupom resgatado; recusar aqui desfaz tudo.
    let trocoCents: number | null = null
    let recebidoCents: number | null = null
    if (d.forma === 'dinheiro') {
      recebidoCents = d.recebidoCents ?? total.totalCents
      if (recebidoCents < total.totalCents) {
        throw createError({
          statusCode: 422,
          statusMessage: 'O valor recebido é menor que o total da venda.',
        })
      }
      trocoCents = recebidoCents - total.totalCents
    }

    // A cota de meia, com a trava do lote na mão e ESTA venda já somada em `sold` — a mesma
    // conferência do checkout, na mesma ordem (lotes ordenados: duas vendas que levam os
    // mesmos lotes travam na mesma sequência e não se prendem uma na outra).
    for (const [lotId, quantas] of [...meiasPorLote].sort((a, b) => a[0].localeCompare(b[0]))) {
      await conferirCotaDeMeia(c, lotId, quantas)
    }

    // Cliente é OPCIONAL no balcão. Quem compra no portão raramente dá
    // e-mail, e exigir um faria o operador inventar um — o que polui a base
    // de contatos com endereços que não existem.
    let customerId: string | null = null
    if (d.comprador?.email) {
      const cli = await c.query(
        `INSERT INTO customers (org_id, name, email, document, phone)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_id, email) DO UPDATE
           SET name = COALESCE($6::text, customers.name),
               document = COALESCE(customers.document, EXCLUDED.document),
               phone = COALESCE(EXCLUDED.phone, customers.phone)
         RETURNING id`,
        // Nome vazio NÃO apaga o nome do cadastro (era 'Cliente do balcão'
        // por cima do nome de verdade). O CPF de quem já tem cadastro também
        // não é trocado — mesma regra do checkout: o documento da linha do
        // cliente responde pelos pedidos antigos dele. O CPF digitado aqui vai
        // pro INGRESSO (abaixo), que é o papel desta venda.
        [ev.org_id, d.comprador.nome?.trim() || 'Cliente do balcão',
         d.comprador.email.toLowerCase(), documento, d.comprador.telefone ?? null,
         d.comprador.nome?.trim() || null])
      customerId = cli.rows[0].id
    }

    const ord = await c.query(
      `INSERT INTO orders (org_id, event_id, customer_id, code, status, channel,
                           face_cents, fee_cents, platform_cents, discount_cents, total_cents,
                           payment_method, installments, promo_code_id,
                           pos_terminal_id, pos_shift_id, sold_by,
                           cash_received_cents, change_cents)
       VALUES ($1,$2,$3,$4,'aguardando_pagamento','bilheteria',
               $5,$6,$7,$8,$9,$10,1,$11,$12,$13,$14,$15,$16)
       RETURNING id, code`,
      [ev.org_id, ev.id, customerId, codigo,
       total.faceCents, total.feeCents, total.platformCents, total.discountCents, total.totalCents,
       d.forma, cupom?.id ?? null, turno.terminal_id, d.turnoId, sessao.usuarioId,
       recebidoCents, trocoCents])

    for (let i = 0; i < d.itens.length; i++) {
      const it = d.itens[i]
      const l = total.linhas[i]
      await c.query(
        `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity,
                                  unit_face_cents, unit_fee_cents, unit_total_cents,
                                  half_reason, half_document, half_document_required)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        // motivo, número e exigência entram na LINHA; a emissão os carimba em cada ingresso
        [ord.rows[0].id, it.lotId, it.ticketTypeId ?? null, it.quantidade,
         l.faceCents, l.feeCents, l.totalCents,
         meiaDaLinha[i]?.motivo ?? null,
         meiaDaLinha[i]?.documento ?? docDaLinha[i],
         meiaDaLinha[i]?.exigido ?? null])
    }

    if (cupom) await c.query(`UPDATE promo_codes SET uses = uses + 1 WHERE id = $1`, [cupom.id])

    // Emite AQUI dentro. O pedido nasceu 'aguardando_pagamento' só pra passar
    // pela mesma porta de sempre; um instante depois já é 'pago'.
    const emissao = await emitirNaTransacao(c, ord.rows[0].id)
    if (!emissao.emitiu) {
      // Não devia acontecer: acabamos de criar o pedido. Se acontecer, o
      // rollback desfaz a venda inteira, e é melhor assim — dinheiro sem
      // ingresso é pior que venda que não saiu.
      throw createError({
        statusCode: 500,
        statusMessage: `Não foi possível emitir os ingressos (${emissao.motivo ?? 'motivo desconhecido'}).`,
      })
    }

    // O titular do ingresso é quem o operador digitou, com ou sem e-mail.
    // A emissão só sabe nomear pelo CADASTRO do cliente — e balcão sem e-mail
    // não tem cadastro, então o nome digitado sumia. Mesma regra da emissão:
    // o 1º ingresso de cada linha leva o nome; os demais ficam pra nomear.
    const nomeDigitado = d.comprador?.nome?.trim() || null
    if (nomeDigitado || documento) {
      await c.query(
        `UPDATE tickets t
            SET holder_name = COALESCE($2, t.holder_name),
                holder_document = COALESCE($3, t.holder_document)
          WHERE t.id IN (SELECT DISTINCT ON (order_item_id) id FROM tickets
                          WHERE order_id = $1
                          ORDER BY order_item_id, issued_at, code)`,
        [ord.rows[0].id, nomeDigitado, documento])
    }

    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'order',$2,'venda_balcao',$3::jsonb)`,
      [ev.org_id, ord.rows[0].id, JSON.stringify({
        ponto: turno.ponto, forma: d.forma, totalCents: total.totalCents,
        trocoCents, por: sessao.nome, observacao: d.observacao ?? null,
        chave: d.chave ?? null,
      })])

    return { orderId: ord.rows[0].id as string }
  }).catch(async (e) => {
    if (e instanceof CupomRecusado) {
      throw createError({ statusCode: e.status, statusMessage: e.recado,
        data: { tipo: 'cupom', motivo: e.motivo } })
    }
    if (e instanceof EstoqueInsuficiente) {
      throw createError({ statusCode: 409, statusMessage: recadoDeEsgotado(e),
        data: { tipo: 'estoque', disponivel: e.disponivel } })
    }
    if (e instanceof LoteIndisponivel) {
      throw createError({ statusCode: 409, statusMessage: e.message, data: { tipo: 'lote' } })
    }
    if (e instanceof CotaDeMeiaEsgotada) {
      throw createError({ statusCode: 409, statusMessage: e.recadoNoBalcao,
        data: { tipo: 'cota_meia', cota: e.cota, restavam: e.restavam } })
    }
    // Trava de DIA, que mora no banco (gatilho `sessao_confere_vaga`,
    // db/016): dia lotado, lote de outro dia. A mensagem do RAISE já foi
    // escrita pra quem está no guichê; sem esta tradução ela virava
    // "Server Error" com a fila na frente. `routine = exec_stmt_raise` separa
    // o RAISE nosso de um CHECK qualquer (mesmo 23514), que é bug e merece 500
    // — a mesma assinatura que o checkout usa.
    if (e?.code === '23514' && e?.routine === 'exec_stmt_raise') {
      throw createError({ statusCode: 409, statusMessage: e.message, data: { tipo: 'sessao' } })
    }
    // A MESMA venda gravada por outra tentativa que chegou junto: o UNIQUE do
    // código segurou a segunda. Devolve o recibo da que ficou.
    if (d.chave && e?.code === '23505' && String(e?.constraint ?? '').includes('code')) {
      const ja = await q1<any>(
        `SELECT id FROM orders WHERE code = $1 AND event_id = $2 AND pos_shift_id = $3`,
        [codigo, eventId, d.turnoId])
      if (ja) return { orderId: ja.id as string, repetida: true }
    }
    throw e
  })

  return {
    ...(await reciboDoPedido(resultado.orderId, turno.ponto)),
    ...((resultado as any).repetida ? { repetida: true } : {}),
  }
})

/**
 * O recibo, relido do banco. Serve à venda nova e à tentativa repetida: as
 * duas respostas saem do MESMO lugar, então o operador vê o mesmo papel nos
 * dois casos — e é o que foi gravado, não o que o navegador pediu.
 */
async function reciboDoPedido(orderId: string, ponto: string) {
  const o = await q1<any>(
    `SELECT id, code, status, payment_method, total_cents, face_cents, fee_cents,
            discount_cents, cash_received_cents, change_cents
       FROM orders WHERE id = $1`, [orderId])
  const emitidos = await q<any>(
    `SELECT t.id, t.code, l.name AS lote, s.name AS setor, tt.name AS tipo
       FROM tickets t
       JOIN lots l ON l.id = t.lot_id
       JOIN sectors s ON s.id = t.sector_id
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
      WHERE t.order_id = $1 AND t.status <> 'cancelado'
      ORDER BY s.sort_order, l.name, t.code`, [orderId])
  const num = (v: any) => (v === null || v === undefined ? null : Number(v))
  return {
    ok: true,
    pedido: o.code as string,
    pedidoId: o.id as string,
    situacao: o.status as string,
    ponto,
    forma: o.payment_method as string,
    totalCents: Number(o.total_cents),
    faceCents: Number(o.face_cents),
    taxaCents: Number(o.fee_cents),
    descontoCents: Number(o.discount_cents),
    recebidoCents: num(o.cash_received_cents),
    trocoCents: num(o.change_cents),
    ingressos: emitidos.map((t: any) => ({
      id: t.id, codigo: t.code, lote: t.lote, setor: t.setor, tipo: t.tipo,
    })),
  }
}

/** "05/12 18:00", no fuso do evento — o dia que o operador reconhece. */
function quandoFoi(d: Date | string, fuso?: string | null): string {
  return new Date(d).toLocaleString('pt-BR', {
    timeZone: fuso || 'America/Bahia', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}
