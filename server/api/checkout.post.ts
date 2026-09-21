/**
 * POST /api/checkout — monta o pedido, segura o estoque e cria a cobrança.
 *
 * Regra que governa o arquivo: **preço nunca vem do navegador**. O cliente diz
 * QUAIS lotes e QUANTOS; todo valor é relido do banco e recalculado aqui. Um
 * checkout que aceita `price` do front é um checkout onde o cliente escolhe
 * quanto pagar — e isso não aparece em teste nenhum, só no fechamento do mês.
 *
 * Ordem das operações, de propósito:
 *   1. fora da transação, só o que não decide nada sozinho: janela de venda,
 *      preços lidos do banco, teto de ingressos por pedido (aritmética pura)
 *   2. transação: teto por CPF → reserva estoque → cliente → cupom →
 *      grava pedido → COMMIT
 *   3. fora da transação: chama o Asaas e grava o retorno
 *
 * Cada limite é decidido COM A SUA TRAVA NA MÃO, dentro da transação que grava
 * o pedido. Limite conferido antes da transação passa em teste sequencial e
 * não segura nada: duas requisições leem "ainda cabe" no mesmo milissegundo e
 * as duas gravam.
 *
 * A chamada do gateway fica FORA da transação porque chamada externa dentro de
 * transação segura lock de linha pelo tempo da rede do terceiro. Numa virada
 * de lote isso trava a fila inteira.
 */
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { q, q1, tx } from '../utils/db'
import {
  EstoqueInsuficiente, liberar, LoteIndisponivel, prazoDeReserva, reservar,
} from '../utils/estoque'
import { faceComDesconto, type ModoTaxa } from '../utils/dinheiro'
import {
  aplicarCupom, CupomRecusado, emData, PEDIDO_EM_PE, resgatarCupom, type Cupom,
} from '../utils/cupom'
import {
  acharOuCriarCliente, cancelarCobranca, centavosParaReais, criarCobranca,
  qrCodePix, vencimentoEmDias, type ConfigAsaas,
} from '../utils/asaas'
import {
  conferirCotaDeMeia, CotaDeMeiaEsgotada, documentoExigido, MOTIVOS,
  MOTIVOS_EM_TEXTO, motivoValido,
} from '../utils/meia-entrada'
import { fimDasVendas } from './e/[slug].get'
import { gerarCodigo } from '../utils/ingresso'
import { cpfValido } from '../utils/documento'
import * as simulado from '../utils/gateway-simulado'

/**
 * Quantos ingressos cabem num pedido quando o evento não disser outra coisa.
 *
 * Sem um teto aqui, o único freio era o `max_per_order` de CADA lote — e vinte
 * linhas de seis ingressos são cento e vinte ingressos num clique só. Não é
 * hipótese de cambista: é o jeito mais barato de esvaziar um lote inteiro e
 * revender no portão. O produtor sobe este número em `events.max_per_order`
 * quando quiser vender excursão.
 */
export const TETO_PADRAO_POR_PEDIDO = 20

const Entrada = z.object({
  eventSlug: z.string().min(1),
  itens: z.array(z.object({
    lotId: z.string().uuid(),
    ticketTypeId: z.string().uuid().nullish(),
    quantidade: z.number().int().positive().max(50),
    /**
     * Declaração de meia-entrada da LINHA.
     *
     * É por linha e não por ingresso porque a linha é a unidade que o
     * comprador escolhe na vitrine ("2 meias de estudante"). Quem compra duas
     * meias por motivos diferentes manda duas linhas do mesmo tipo — o
     * checkout já soma linhas repetidas em todo teto e em toda reserva.
     *
     * `motivo` é validado contra a lista da lei em utils/meia-entrada.ts e não
     * por `z.enum` de propósito: o recado precisa dizer QUAIS motivos existem,
     * e o erro do Zod diria só "invalid enum value".
     */
    meia: z.object({
      motivo: z.string().min(1).max(40),
      documento: z.string().trim().min(3).max(40).optional(),
    }).nullish(),
  })).min(1).max(20),
  comprador: z.object({
    nome: z.string().min(3).max(120),
    email: z.string().email(),
    documento: z.string().min(11).max(18),
    telefone: z.string().min(10).max(20).optional(),
  }),
  cupom: z.string().max(40).optional(),
  promoter: z.string().max(40).optional(),
  forma: z.enum(['pix', 'credito']).default('pix'),
  parcelas: z.number().int().min(1).max(12).default(1),
})

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const p = Entrada.safeParse(body)
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const dados = p.data
  const documento = dados.comprador.documento.replace(/\D/g, '')
  if (!cpfValido(documento)) {
    throw createError({ statusCode: 400, statusMessage: 'CPF inválido' })
  }

  // ------------------------------------------------------------- 1. evento
  const ev = await q1<any>(
    `SELECT e.*, o.asaas_api_key, o.asaas_env, o.asaas_wallet
       FROM events e JOIN organizations o ON o.id = e.org_id
      WHERE e.slug = $1`, [dados.eventSlug])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  if (ev.status !== 'ativo') {
    throw createError({ statusCode: 409, statusMessage: 'As vendas deste evento não estão abertas' })
  }
  conferirJanelaDeVenda(ev)

  // --------------------------------------------- 2. preços, lidos do banco
  const lotIds = [...new Set(dados.itens.map((i) => i.lotId))]
  const lotes = await q<any>(
    `SELECT l.id, l.name, l.price_cents, l.sector_id,
            l.limit_by_document, l.max_per_document,
            s.event_id, s.kind
       FROM lots l JOIN sectors s ON s.id = l.sector_id
      WHERE l.id = ANY($1::uuid[])`, [lotIds])
  const porLote = new Map(lotes.map((l) => [l.id, l]))
  for (const it of dados.itens) {
    const l = porLote.get(it.lotId)
    if (!l) throw createError({ statusCode: 404, statusMessage: 'Lote não encontrado' })
    if (l.event_id !== ev.id) {
      // lote de outro evento no mesmo pedido: ou é bug de front ou é tentativa
      throw createError({ statusCode: 400, statusMessage: 'Lote não pertence a este evento' })
    }
  }

  const tipoIds = dados.itens.map((i) => i.ticketTypeId).filter(Boolean) as string[]
  // `max_per_customer` entra aqui porque a conferência lá embaixo lê ele: a
  // coluna existe desde o schema e o SELECT não a trazia, então o teto por
  // tipo ("no máximo 2 meias por CPF") era `undefined` e nunca recusava nada.
  // Limite que não recusa é pior que limite nenhum — o produtor configura,
  // vê na tela e acredita.
  const tipos = tipoIds.length
    ? await q<any>(`SELECT id, lot_id, name, kind, discount_bps, requires_document, max_per_customer
                      FROM ticket_types WHERE id = ANY($1::uuid[])`, [tipoIds])
    : []
  const porTipo = new Map(tipos.map((t) => [t.id, t]))

  const modo: ModoTaxa = ev.fee_mode_online
  const linhas = dados.itens.map((it) => {
    const lote = porLote.get(it.lotId)!
    let face = Number(lote.price_cents)
    if (it.ticketTypeId) {
      const t = porTipo.get(it.ticketTypeId)
      if (!t) throw createError({ statusCode: 404, statusMessage: 'Tipo de ingresso não encontrado' })
      if (t.lot_id !== it.lotId) {
        throw createError({ statusCode: 400, statusMessage: 'Tipo de ingresso não é deste lote' })
      }
      face = faceComDesconto(face, Number(t.discount_bps))
    }
    return { quantidade: it.quantidade, faceUnitCents: face }
  })

  // ------------------------------------------- 3. teto de ingressos por pedido
  conferirTetoPorPedido(ev, dados.itens)

  // ------------------------------- 3b. quem declarou direito a meia-entrada
  // Aritmética pura sobre o que já foi lido do banco: pode ficar aqui fora.
  // A COTA não — ela é soma sobre o lote e só decide coisa com a trava do
  // lote na mão, lá dentro da transação.
  const meia = conferirDeclaracoesDeMeia(dados.itens, porLote, porTipo)

  let promoter: any = null
  if (dados.promoter) {
    promoter = await q1<any>(
      `SELECT * FROM promoters WHERE event_id = $1 AND upper(code) = upper($2) AND active = true`,
      [ev.id, dados.promoter])
    // promoter inválido não derruba a venda: só não credita ninguém
  }

  // ---------- 4. transação: tetos + reserva + cupom + grava pedido ---------
  //
  // O que mudou de lugar, e por quê: o teto por CPF e o cupom eram conferidos
  // AQUI FORA, antes da transação. Os dois passavam em teste sequencial e não
  // seguravam nada — duas requisições do mesmo CPF (ou do mesmo cupom) leem
  // "ainda cabe" no mesmo milissegundo e as duas gravam. É o jeito mais barato
  // de furar os dois limites, e é exatamente o que um script de cambista faz.
  // Agora cada decisão é tomada com a sua própria trava na mão, dentro da
  // mesma transação que grava o pedido.
  //
  // A ORDEM DAS TRAVAS é fixa e vale pra todo mundo que vende (aqui e no
  // balcão): CPF → lotes → cliente → cupom. Duas transações que peguem os
  // mesmos dois recursos em ordens opostas travam uma na outra pra sempre.
  const codigo = gerarCodigo('PED')
  // Até quando este pedido segura o lote. A janela é do evento; o clamp mora
  // em prazoDeReserva pra um `hold_minutes` torto não virar `Invalid Date` no
  // INSERT (pedido não nasce) nem reserva de semanas (lugar preso).
  const expiraEm = prazoDeReserva(ev.hold_minutes)

  const pedido = await tx(async (c) => {
    await conferirTetoPorDocumento(c, ev, dados.itens, documento, porLote, porTipo)

    await reservar(c, dados.itens.map((i) => ({
      lotId: i.lotId, ticketTypeId: i.ticketTypeId ?? null, quantidade: i.quantidade,
    })), { canal: 'online' })

    // A cota de meia, com a trava do lote já na mão (`reservar` travou cada
    // lote e em Postgres a trava dura até o COMMIT). Vem DEPOIS da reserva de
    // propósito: a reserva já somou este pedido em `ticket_types.sold`, então
    // o que se conta aqui é o mundo COM esta venda dentro — que é a pergunta
    // certa ("se passar, estoura?"). Conferir antes é o furo clássico: dois
    // compradores leem "ainda cabe" no mesmo milissegundo e os dois gravam.
    for (const [lotId, quantas] of [...meia.porLote].sort((a, b) => a[0].localeCompare(b[0]))) {
      await conferirCotaDeMeia(c, lotId, quantas)
    }

    // O CPF da linha do cliente NÃO é reescrito por quem chegou depois.
    //
    // Era `COALESCE(EXCLUDED.document, customers.document)`, ou seja: o último
    // a comprar com aquele e-mail carimbava o CPF dele na linha. E como quem
    // responde "quanto este CPF já tem" é um JOIN em `customers` (a conferência
    // aqui embaixo e a contagem do cupom em utils/cupom.ts), reescrever o
    // documento REESCREVIA O PASSADO: os pedidos antigos daquele e-mail
    // passavam a contar pro CPF novo e paravam de contar pro antigo.
    //
    // Duas consequências medidas, as duas na mesma origem:
    //   1. o teto por CPF virava piada — com `max_per_customer = 2`, alternar
    //      dois CPFs no MESMO e-mail dava 2 ingressos por rodada pra sempre,
    //      porque cada compra zerava a contagem do CPF da compra anterior;
    //   2. o cupom recusava quem nunca usou — o resgate roda DEPOIS deste
    //      upsert, então o CPF novo já herdava o uso do CPF antigo e lia
    //      "Este CPF já usou o cupom", que é mentira na cara do comprador.
    //
    // `COALESCE(customers.document, EXCLUDED.document)` só PREENCHE documento
    // vazio (cliente que nasceu no balcão sem CPF). Quando o e-mail já tem
    // dono, a compra para aqui com um recado que diz o que fazer — em vez de
    // trocar em silêncio o CPF gravado em `tickets.holder_document`, que é o
    // documento que a portaria confere na meia-entrada.
    //
    // O `ON CONFLICT` é quem trava a linha, então a decisão é atômica: não
    // existe janela entre ler o dono e gravar.
    const cliente = await c.query(
      `INSERT INTO customers (org_id, name, email, document, phone)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id, email) DO UPDATE
         SET name = EXCLUDED.name,
             document = COALESCE(customers.document, EXCLUDED.document),
             phone = COALESCE(EXCLUDED.phone, customers.phone)
       RETURNING id, asaas_customer_id, document`,
      [ev.org_id, dados.comprador.nome, dados.comprador.email.toLowerCase(),
       documento, dados.comprador.telefone ?? null])

    if (cliente.rows[0].document !== documento) {
      throw createError({ statusCode: 409,
        statusMessage: `O e-mail ${dados.comprador.email.toLowerCase()} já está cadastrado `
          + `com outro CPF (final ${String(cliente.rows[0].document).slice(-2)}). `
          + 'Use o CPF desse cadastro ou compre com outro e-mail — cada e-mail responde '
          + 'por um CPF, que é o documento impresso no ingresso.',
        data: { tipo: 'email_de_outro_cpf' } })
    }

    // O cupom é o ÚLTIMO a ser travado, depois do cliente, porque o balcão
    // pega esses dois na mesma ordem (utils não, rota: pdv/venda.post.ts).
    // Inverter aqui criaria o abraço mortal clássico entre as duas rotas.
    const cupom: Cupom | null = dados.cupom
      ? await resgatarCupom(c, {
          eventId: ev.id, codigo: dados.cupom, documento,
          lotIdsDoPedido: dados.itens.map((i) => i.lotId),
          fuso: ev.timezone,
        })
      : null

    const total = aplicarCupom(linhas, Number(ev.fee_bps), modo, cupom)

    const ord = await c.query(
      `INSERT INTO orders (org_id, event_id, customer_id, code, status, channel,
                           face_cents, fee_cents, platform_cents, discount_cents, total_cents,
                           payment_method, installments, promo_code_id, promoter_id, expires_at)
       VALUES ($1,$2,$3,$4,'aguardando_pagamento','online',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, code`,
      [ev.org_id, ev.id, cliente.rows[0].id, codigo,
       total.faceCents, total.feeCents, total.platformCents, total.discountCents, total.totalCents,
       dados.forma === 'pix' ? 'pix' : 'credito', dados.parcelas,
       cupom?.id ?? null, promoter?.id ?? null, expiraEm])

    for (let i = 0; i < dados.itens.length; i++) {
      const it = dados.itens[i]
      const l = total.linhas[i]
      // O motivo e o documento entram na MESMA linha da venda. Daqui o
      // gatilho da migração 015 os carimba em cada ingresso emitido — é o
      // ingresso, e não o pedido, que chega na mão da portaria.
      const d = meia.porItem[i]
      await c.query(
        `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity,
                                  unit_face_cents, unit_fee_cents, unit_total_cents,
                                  half_reason, half_document, half_document_required)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [ord.rows[0].id, it.lotId, it.ticketTypeId ?? null, it.quantidade,
         l.faceCents, l.feeCents, l.totalCents,
         d?.motivo ?? null, d?.documento ?? null, d?.exigido ?? null])
    }

    // Placar, não trava: quem responde "quantas vezes este cupom já foi
    // usado" é a contagem em `orders` (utils/cupom.ts). Este número segue
    // gravado porque as telas do painel mostram ele.
    if (cupom) await c.query(`UPDATE promo_codes SET uses = uses + 1 WHERE id = $1`, [cupom.id])

    return { id: ord.rows[0].id, code: ord.rows[0].code, customerId: cliente.rows[0].id,
             asaasCustomerId: cliente.rows[0].asaas_customer_id, total }
  }).catch((e) => {
    if (e instanceof CupomRecusado) {
      throw createError({ statusCode: e.status, statusMessage: e.recado,
        data: { tipo: 'cupom', motivo: e.motivo } })
    }
    if (e instanceof EstoqueInsuficiente) {
      // `e.message` é texto de log ("Lote X: pedido 2, disponível 1"). Quem lê
      // isto é alguém com o cartão na mão, ou o operador do guichê com fila
      // atrás: tem que dizer o que sobrou e o que fazer agora.
      throw createError({ statusCode: 409, statusMessage: recadoDeEstoque(e),
        data: { tipo: 'estoque', disponivel: e.disponivel } })
    }
    if (e instanceof LoteIndisponivel) {
      throw createError({ statusCode: 409, statusMessage: e.message, data: { tipo: 'lote' } })
    }
    if (e instanceof CotaDeMeiaEsgotada) {
      // `e.message` é log ("cota 200, já vendidas 200, pedido 1"). Quem lê a
      // tela é o comprador: `e.recado` diz que a inteira do mesmo lote
      // continua à venda, que é a saída que ele tem.
      throw createError({ statusCode: 409, statusMessage: e.recado,
        data: { tipo: 'cota_meia', cota: e.cota, restavam: e.restavam } })
    }
    throw e
  })

  // A conta fechada saiu de dentro da transação: é ela que foi gravada no
  // pedido, com o cupom já travado e o teto de desconto já aplicado. Recalcular
  // aqui fora daria uma segunda verdade sobre o mesmo dinheiro.
  const total = pedido.total

  // Pedido gratuito (cortesia/100% off) não passa por gateway.
  if (total.totalCents === 0) {
    await confirmarGratuito(pedido.id)
    return { ok: true, pedido: pedido.code, pedidoId: pedido.id, status: 'pago', totalCents: 0 }
  }

  // ----------------------------------- 6. gateway, FORA da transação ------
  const cfg: ConfigAsaas = {
    apiKey: ev.asaas_api_key, environment: ev.asaas_env, walletId: ev.asaas_wallet,
  }

  // Sem chave: em produção isso é indisponibilidade, e o pedido tem que morrer
  // liberando o estoque. Só na máquina, com PAGAMENTO_SIMULADO=1, o fluxo segue
  // por um gateway de mentira pra a tela poder ser exercitada ponta a ponta.
  if (!cfg.apiKey) {
    if (!simulado.ligado()) {
      await desfazer(pedido.id, 'Organização sem Asaas configurado')
      throw createError({ statusCode: 503, statusMessage: 'Pagamento indisponível no momento' })
    }
    return await cobrarSimulado(pedido, ev, total, dados, expiraEm)
  }

  let cobranca: any
  try {
    const asaasCustomer = pedido.asaasCustomerId || await acharOuCriarCliente(cfg, {
      name: dados.comprador.nome, email: dados.comprador.email,
      cpfCnpj: documento, mobilePhone: dados.comprador.telefone,
    })
    if (!pedido.asaasCustomerId) {
      await q(`UPDATE customers SET asaas_customer_id = $2 WHERE id = $1`,
        [pedido.customerId, asaasCustomer])
    }

    cobranca = await criarCobranca(cfg, {
      customer: asaasCustomer,
      billingType: dados.forma === 'pix' ? 'PIX' : 'CREDIT_CARD',
      value: centavosParaReais(total.totalCents),
      dueDate: vencimentoEmDias(1),
      description: `${ev.name} — pedido ${pedido.code}`,
      externalReference: pedido.id,       // é isto que liga o webhook ao pedido
      installmentCount: dados.parcelas > 1 ? dados.parcelas : undefined,
    })
  } catch (e: any) {
    // Gateway caiu: devolve o estoque na hora. Sem isso, cada erro do Asaas
    // queima ingresso que ninguém comprou até a varredura de expirados passar.
    await desfazer(pedido.id, `Asaas: ${e.message}`)
    throw createError({ statusCode: 502, statusMessage: 'Não foi possível gerar a cobrança. Tente de novo.' })
  }

  let pix: { encodedImage?: string; payload?: string } | null = null
  if (dados.forma === 'pix') {
    try { pix = await qrCodePix(cfg, cobranca.id) } catch { pix = null }
  }

  await q(
    `UPDATE orders SET asaas_payment_id = $2, pix_payload = $3, pix_qr_base64 = $4
      WHERE id = $1`,
    [pedido.id, cobranca.id, pix?.payload ?? null, pix?.encodedImage ?? null])

  return {
    ok: true,
    pedido: pedido.code,
    pedidoId: pedido.id,
    status: 'aguardando_pagamento',
    expiraEm: expiraEm.toISOString(),
    totalCents: total.totalCents,
    faceCents: total.faceCents,
    feeCents: total.feeCents,
    descontoCents: total.discountCents,
    pagamento: {
      forma: dados.forma,
      pixPayload: pix?.payload ?? null,
      pixQrBase64: pix?.encodedImage ?? null,
      linkFatura: cobranca.invoiceUrl ?? null,
    },
  }
})

/**
 * Mesmo retorno do caminho real, com cobrança de mentira. Fica numa função
 * separada pra o caminho de produção acima continuar legível sem `if` de
 * ambiente no meio.
 */
async function cobrarSimulado(
  pedido: any, ev: any, total: any, dados: any, expiraEm: Date,
) {
  const cobranca = await simulado.criarCobrancaSimulada({
    value: centavosParaReais(total.totalCents),
    description: `${ev.name} — pedido ${pedido.code}`,
    externalReference: pedido.id,
  })
  const pix = dados.forma === 'pix'
    ? await simulado.pixSimulado(centavosParaReais(total.totalCents), pedido.code)
    : null

  await q(
    `UPDATE orders SET asaas_payment_id = $2, pix_payload = $3, pix_qr_base64 = $4
      WHERE id = $1`,
    [pedido.id, cobranca.id, pix?.payload ?? null, pix?.encodedImage ?? null])

  return {
    ok: true,
    pedido: pedido.code,
    pedidoId: pedido.id,
    status: 'aguardando_pagamento',
    expiraEm: expiraEm.toISOString(),
    totalCents: total.totalCents,
    faceCents: total.faceCents,
    feeCents: total.feeCents,
    descontoCents: total.discountCents,
    simulado: true,
    pagamento: {
      forma: dados.forma,
      pixPayload: pix?.payload ?? null,
      pixQrBase64: pix?.encodedImage ?? null,
      linkFatura: null,
    },
  }
}

/**
 * O que o comprador lê quando o ingresso acabou entre a página e o botão.
 *
 * O número vem do estoque relido COM a trava do lote na mão (utils/estoque.ts):
 * se viesse de antes da trava, esta frase diria "sobrou 1" bem na hora em que
 * a recusa foi por não ter sobrado nenhum — e aí o comprador tenta de novo, lê
 * a mesma coisa, e abre chamado dizendo que o site está quebrado.
 */
function recadoDeEstoque(e: EstoqueInsuficiente): string {
  // "opção" e não "lote": o que acabou tanto pode ser o lote quanto um tipo
  // dentro dele (meia-entrada). `e.nome` já diz qual dos dois, e `e.disponivel`
  // é o saldo DAQUELA prateleira — mandar o comprador trocar de lote quando o
  // que faltou foi a meia é conselho que falha de novo.
  if (e.disponivel <= 0) {
    return `O último ingresso de "${e.nome}" saiu enquanto você preenchia os dados. `
      + 'Escolha outra opção ou tente de novo em alguns minutos: reserva não paga volta pra venda.'
  }
  const resta = e.disponivel === 1 ? 'Restou 1 ingresso' : `Restaram ${e.disponivel} ingressos`
  return `${resta} de "${e.nome}" e você pediu ${e.pedido}. `
    + `Mude a quantidade para ${e.disponivel} ou escolha outra opção.`
}

/** Desfaz pedido que não virou cobrança: libera estoque e marca como falhou. */
async function desfazer(orderId: string, motivo: string) {
  await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT lot_id AS "lotId", ticket_type_id AS "ticketTypeId", quantity AS quantidade
         FROM order_items WHERE order_id = $1`, [orderId])
    await liberar(c, rows)
    await c.query(
      `UPDATE orders SET status = 'falhou', canceled_at = now() WHERE id = $1`, [orderId])
    await c.query(
      `INSERT INTO audit_log (entity, entity_id, action, after)
       VALUES ('order', $1, 'falhou', $2::jsonb)`,
      [orderId, JSON.stringify({ motivo })])
  })
}

async function confirmarGratuito(orderId: string) {
  const { emitirIngressos } = await import('../utils/emissao')
  await emitirIngressos(orderId)
}

/**
 * A venda está aberta AGORA?
 *
 * `sales_end_at` sozinho não responde. O painel aceita as duas formas de
 * fechar a venda — data fixa OU "X minutos depois que começar" — e o CHECK do
 * banco garante que só uma está preenchida. A vitrine já lia as duas
 * (`fimDasVendas`); o checkout lia só a primeira, então um evento configurado
 * do segundo jeito vendia ingresso para uma sessão que já tinha começado. O
 * comprador só descobre na portaria, com a família no carro.
 *
 * E, por baixo das duas, `ends_at`: evento que já terminou não vende ingresso
 * de jeito nenhum, tenha configuração de venda ou não. Este era o buraco
 * aberto — quem não preenche nenhum dos dois campos (o caso mais comum, e o
 * do evento semeado) vendia para sempre.
 */
function conferirJanelaDeVenda(ev: any, agora = new Date()) {
  const fuso = ev.timezone ?? 'America/Bahia'

  if (ev.ends_at && new Date(ev.ends_at) <= agora) {
    throw createError({ statusCode: 409,
      statusMessage: `Este evento terminou em ${emData(ev.ends_at, fuso)} `
        + 'e não vende mais ingresso. Veja as próximas datas na página do evento.' })
  }
  const fim = fimDasVendas(ev)
  if (fim && fim <= agora) {
    throw createError({ statusCode: 409,
      statusMessage: `As vendas deste evento encerraram em ${emData(fim, fuso)}.` })
  }
}

/**
 * Quantos ingressos cabem num pedido só, somando todos os lotes.
 *
 * O `max_per_order` do LOTE já existia e segura uma linha de cada vez — o que
 * não segurava nada era o pedido inteiro: vinte linhas de seis ingressos
 * passavam como vinte pedidos de seis. Quem faz isso não é família grande, é
 * script.
 */
function conferirTetoPorPedido(ev: any, itens: any[]) {
  const teto = Number(ev.max_per_order ?? TETO_PADRAO_POR_PEDIDO)
  const pedidos = itens.reduce((s, i) => s + i.quantidade, 0)
  if (pedidos > teto) {
    throw createError({ statusCode: 409,
      statusMessage: `Cada pedido leva no máximo ${teto} ingressos e você escolheu ${pedidos}. `
        + `Tire ${pedidos - teto} da lista — ou faça o resto em outra compra.`,
      data: { tipo: 'teto_por_pedido', teto, pedidos } })
  }
}

interface DeclaracaoDeMeia {
  motivo: string
  documento: string | null
  /** o que a portaria vai pedir — congelado aqui e gravado no ingresso */
  exigido: string
}

/**
 * Quem está comprando meia-entrada, e com que direito.
 *
 * Meia-entrada é obrigação legal com comprovação na entrada (Lei 12.933/2013 e
 * as leis de idoso/juventude). Vender meia sem saber o motivo é vender um
 * ingresso que a portaria não tem como conferir: o operador olha o papel, vê
 * "Meia-entrada", e não sabe se pede carteira de estudante, RG de quem tem
 * 60+ ou ID Jovem. Na prática ou deixa entrar sem conferir nada — e aí metade
 * do parque entra pela metade do preço — ou barra quem tinha direito.
 *
 * Por isso o motivo é OBRIGATÓRIO no tipo de espécie 'meia', e recusado nos
 * outros: motivo gravado numa inteira só faria a portaria pedir documento de
 * quem não precisa.
 *
 * Devolve, de uma passada só, o que cada linha declarou e quantas meias cada
 * LOTE está levando — este segundo número é o que a cota confere lá dentro da
 * transação.
 */
function conferirDeclaracoesDeMeia(
  itens: any[], porLote: Map<string, any>, porTipo: Map<string, any>,
): { porItem: (DeclaracaoDeMeia | null)[]; porLote: Map<string, number> } {
  const porItem: (DeclaracaoDeMeia | null)[] = []
  const meiasPorLote = new Map<string, number>()

  for (const it of itens) {
    const tipo = it.ticketTypeId ? porTipo.get(it.ticketTypeId) : null
    const ehMeia = tipo?.kind === 'meia'
    const declarado = it.meia ?? null

    if (!ehMeia) {
      if (declarado) {
        const nome = tipo?.name ?? porLote.get(it.lotId)?.name ?? 'este ingresso'
        throw createError({ statusCode: 422,
          statusMessage: `"${nome}" não é meia-entrada, então não precisa de motivo. `
            + 'Tire a declaração de meia deste item ou escolha a opção de meia-entrada.',
          data: { tipo: 'meia_em_inteira' } })
      }
      porItem.push(null)
      continue
    }

    if (!declarado?.motivo) {
      throw createError({ statusCode: 422,
        statusMessage: `Para levar "${tipo.name}" escolha o motivo da meia-entrada: `
          + `${MOTIVOS_EM_TEXTO}. A portaria confere o documento desse motivo na entrada.`,
        data: { tipo: 'meia_sem_motivo', motivos: Object.keys(MOTIVOS) } })
    }
    if (!motivoValido(declarado.motivo)) {
      throw createError({ statusCode: 422,
        statusMessage: `"${declarado.motivo}" não dá direito a meia-entrada. `
          + `Os motivos previstos em lei são: ${MOTIVOS_EM_TEXTO}.`,
        data: { tipo: 'meia_motivo_invalido', motivos: Object.keys(MOTIVOS) } })
    }

    const regra = MOTIVOS[declarado.motivo]
    const documento = declarado.documento?.trim() || null
    if (regra.exigeNumero && !documento) {
      throw createError({ statusCode: 422,
        statusMessage: `Informe o número do documento: ${regra.documento}. `
          + 'É ele que a portaria vai conferir com o seu na entrada.',
        data: { tipo: 'meia_sem_documento', motivo: declarado.motivo } })
    }

    porItem.push({ motivo: declarado.motivo, documento, exigido: documentoExigido(declarado.motivo) })
    meiasPorLote.set(it.lotId, (meiasPorLote.get(it.lotId) ?? 0) + it.quantidade)
  }

  return { porItem, porLote: meiasPorLote }
}

/**
 * Teto de compra por CPF, na cascata evento → setor → lote → tipo.
 * A regra mais específica ganha, que é como a Zig faz e é o que o produtor
 * espera: "no evento pode 10, mas deste camarote só 2".
 *
 * ## Duas coisas que estavam erradas aqui
 *
 * **1. Só o teto do evento olhava o passado.** Setor e tipo comparavam o
 * limite com a quantidade DESTE pedido — então "máximo 2 por CPF no camarote"
 * era na verdade "máximo 2 por pedido", e quem quisesse dez fazia cinco
 * compras. Agora todos os quatro somam o que o CPF já tem no evento.
 *
 * **2. A conferência ficava fora da transação.** Duas requisições do mesmo CPF
 * chegando juntas liam as duas "ainda cabe" e gravavam as duas. `SELECT` não
 * tranca nada, e não existe uma linha de "CPF neste evento" pra trancar com
 * `FOR UPDATE` — por isso a trava aqui é `pg_advisory_xact_lock`, que serializa
 * exatamente o par (evento, CPF) e some sozinha no COMMIT. Dois CPFs
 * diferentes nunca se esperam; o mesmo CPF entra em fila de um.
 *
 * A trava é a PRIMEIRA coisa da função, antes de qualquer leitura, pelo mesmo
 * motivo de `reservar()`: conferir antes de travar passa em teste sequencial e
 * não serializa nada.
 */
async function conferirTetoPorDocumento(
  c: PoolClient, ev: any, itens: any[], documento: string,
  porLote: Map<string, any>, porTipo: Map<string, any>,
) {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [ev.id, documento])

  // O que este CPF já tem no evento, quebrado por setor/lote/tipo numa
  // consulta só. `JOIN customers` (e não LEFT) de propósito: pedido sem
  // cliente não tem CPF e não pode ser atribuído a ninguém.
  const { rows: jaTem } = await c.query(
    `SELECT l.sector_id, oi.lot_id, oi.ticket_type_id, SUM(oi.quantity)::int AS n
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN lots l         ON l.id = oi.lot_id
       JOIN customers cu   ON cu.id = o.customer_id
      WHERE o.event_id = $1 AND cu.document = $2
        AND o.status = ANY($3::text[])
      GROUP BY 1, 2, 3`,
    [ev.id, documento, PEDIDO_EM_PE as unknown as string[]])

  const somar = (linhas: any[], chave: (l: any) => string | null) => {
    const m = new Map<string, number>()
    for (const l of linhas) {
      const k = chave(l)
      if (k) m.set(k, (m.get(k) ?? 0) + Number(l.n))
    }
    return m
  }
  const antesNoSetor = somar(jaTem, (l) => l.sector_id)
  const antesNoLote = somar(jaTem, (l) => l.lot_id)
  const antesNoTipo = somar(jaTem, (l) => l.ticket_type_id)
  const antesNoEvento = jaTem.reduce((s: number, l: any) => s + Number(l.n), 0)

  const agoraPorSetor = new Map<string, number>()
  const agoraPorLote = new Map<string, number>()
  const agoraPorTipo = new Map<string, number>()
  let agora = 0
  for (const i of itens) {
    const l = porLote.get(i.lotId)
    agora += i.quantidade
    agoraPorSetor.set(l.sector_id, (agoraPorSetor.get(l.sector_id) ?? 0) + i.quantidade)
    agoraPorLote.set(i.lotId, (agoraPorLote.get(i.lotId) ?? 0) + i.quantidade)
    if (i.ticketTypeId) {
      agoraPorTipo.set(i.ticketTypeId, (agoraPorTipo.get(i.ticketTypeId) ?? 0) + i.quantidade)
    }
  }

  /** O recado diz o teto, o que a pessoa já tem e o que dá pra levar agora. */
  const recusar = (teto: number, antes: number, onde: string) => {
    const cabe = Math.max(teto - antes, 0)
    throw createError({ statusCode: 409,
      statusMessage: antes === 0
        ? `Cada CPF leva no máximo ${teto} ${onde}. Diminua a quantidade para seguir.`
        : `Cada CPF leva no máximo ${teto} ${onde}, e este CPF já tem ${antes}. `
          + (cabe > 0 ? `Ainda dá para levar ${cabe}.` : 'Não dá para levar mais nenhum.'),
      data: { tipo: 'teto_por_cpf', teto, antes, cabe } })
  }

  if (ev.max_per_customer && antesNoEvento + agora > Number(ev.max_per_customer)) {
    recusar(Number(ev.max_per_customer), antesNoEvento, 'ingressos neste evento')
  }

  if (agoraPorSetor.size) {
    const { rows: setores } = await c.query(
      `SELECT id, name, max_per_customer FROM sectors WHERE id = ANY($1::uuid[])`,
      [[...agoraPorSetor.keys()]])
    for (const s of setores) {
      if (!s.max_per_customer) continue
      const antes = antesNoSetor.get(s.id) ?? 0
      if (antes + agoraPorSetor.get(s.id)! > Number(s.max_per_customer)) {
        recusar(Number(s.max_per_customer), antes, `ingressos do setor ${s.name}`)
      }
    }
  }

  // Lote: `limit_by_document` e `max_per_document` estão no schema desde o
  // começo e ninguém lia. O produtor marcava a caixinha na tela do lote e o
  // limite não existia — limite que não recusa é pior que limite nenhum.
  for (const [lotId, n] of agoraPorLote) {
    const l = porLote.get(lotId)
    if (!l?.limit_by_document || !l.max_per_document) continue
    const antes = antesNoLote.get(lotId) ?? 0
    if (antes + n > Number(l.max_per_document)) {
      recusar(Number(l.max_per_document), antes, `de "${l.name}"`)
    }
  }

  // tipo (sobrepõe os de cima)
  for (const [tipoId, n] of agoraPorTipo) {
    const t = porTipo.get(tipoId)
    if (!t?.max_per_customer) continue
    const antes = antesNoTipo.get(tipoId) ?? 0
    if (antes + n > Number(t.max_per_customer)) {
      recusar(Number(t.max_per_customer), antes, `de ${t.name}`)
    }
  }
}

// Re-exportado porque o balcão e os testes já importavam daqui. A regra em si
// mora em utils/documento.ts, uma cópia só pros dois caixas.
export { cpfValido }
