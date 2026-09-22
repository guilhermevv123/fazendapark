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
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { q, q1, tx } from '../utils/db'
import { CadastroInvalido, prepararCadastro } from '../utils/cadastro'
import {
  EstoqueInsuficiente, liberar, LoteIndisponivel, prazoDeReserva, reservar,
} from '../utils/estoque'
import { faceComDesconto, type ModoTaxa } from '../utils/dinheiro'
import {
  aplicarCupom, CupomRecusado, PEDIDO_EM_PE, resgatarCupom, type Cupom,
} from '../utils/cupom'
import {
  acharOuCriarCliente, cancelarCobranca, centavosParaReais, criarCobranca,
  qrCodePix, vencimentoEmDias, type ConfigAsaas,
} from '../utils/asaas'
import {
  conferirCotaDeMeia, CotaDeMeiaEsgotada, documentoExigido, MOTIVOS,
  MOTIVOS_EM_TEXTO, motivoValido,
} from '../utils/meia-entrada'
import {
  compravel, estaPublicado, LOTE_DA_VITRINE, portaDeVenda, recadoDeLoteFechado,
  restaDasVariacoes, restamPorTipo, situacoesDoSetor, TETO_PADRAO_POR_PEDIDO,
  type SituacaoDoLote,
} from './e/[slug].get'
import { gerarCodigo } from '../utils/ingresso'
import { cpfValido } from '../utils/documento'
import * as simulado from '../utils/gateway-simulado'

/**
 * Quantos ingressos cabem num pedido quando o evento não disser outra coisa.
 *
 * Mora em `e/[slug].get.ts` porque a VITRINE também precisa dele: ela anuncia
 * o teto de cada linha e trava o botão de pagar, e um segundo `= 20` aqui
 * seria duas verdades sobre o mesmo limite — a tela deixando montar 20 no dia
 * em que a porta passar a recusar acima de 10. Continua reexportado daqui
 * porque é aqui que ele recusa.
 */
export { TETO_PADRAO_POR_PEDIDO }

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
    /**
     * O cadastro completo do formulário do site. TUDO opcional AQUI de
     * propósito: a rota também serve quem chega sem ele (integração antiga,
     * teste, o balcão de outro jeito) e recusar por falta de Instagram seria
     * derrubar venda. Quem EXIGE é a página. O que chega passa por
     * `prepararCadastro`, que é a única porta de validação desses campos.
     */
    nascimento: z.string().max(10).optional(),
    instagram: z.string().max(120).optional(),
    endereco: z.object({
      cep: z.string().max(12).optional(),
      rua: z.string().max(120).optional(),
      numero: z.string().max(20).optional(),
      bairro: z.string().max(80).optional(),
      cidade: z.string().max(80).optional(),
      estado: z.string().max(2).optional(),
      complemento: z.string().max(80).optional(),
    }).optional(),
    senha: z.string().max(200).optional(),
    /** `true`/`false` só quando a pessoa marcou/desmarcou; ausente NÃO mexe no consentimento. */
    aceitaNovidades: z.boolean().optional(),
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

  // O cadastro é conferido ANTES de qualquer trava, e o hash da senha é feito
  // AQUI FORA: o bcrypt custa dezenas de milissegundos de CPU, e dentro da
  // transação isso seria tempo com o lote travado — numa virada de lote, a fila.
  let cadastro: ReturnType<typeof prepararCadastro>
  try {
    cadastro = prepararCadastro(dados.comprador, {
      email: dados.comprador.email, documento })
  } catch (e) {
    if (e instanceof CadastroInvalido) {
      throw createError({ statusCode: 400, statusMessage: e.message,
        data: { tipo: 'cadastro', campo: e.campo } })
    }
    throw e
  }
  const senhaHash = cadastro.senha ? await bcrypt.hash(cadastro.senha, 10) : null

  // ------------------------------------------------------------- 1. evento
  const ev = await q1<any>(
    `SELECT e.*, o.asaas_api_key, o.asaas_env, o.asaas_wallet
       FROM events e JOIN organizations o ON o.id = e.org_id
      WHERE e.slug = $1`, [dados.eventSlug])
  // Rascunho e oculto: o MESMO 404 do slug que não existe, igual à vitrine.
  // Um 409 aqui ("As vendas deste evento não estão abertas") contra um 404 no
  // slug inventado é um oráculo: dá pra varrer nomes de slug e descobrir qual
  // lançamento está montado no painel antes do anúncio. A vitrine esconde
  // isso de propósito (`estaPublicado`) e a porta tem que esconder igual.
  if (!ev || !estaPublicado(ev)) {
    throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  }

  // A MESMA porta da vitrine, com a MESMA frase (server/api/e/[slug].get.ts).
  // Enquanto eram duas funções, a vitrine dava um evento terminado ontem por
  // `vendasAbertas: true` e o checkout respondia 409 nele — a tela montava a
  // compra e o não chegava depois do CPF.
  const porta = portaDeVenda(ev)
  if (!porta.aberta) {
    throw createError({ statusCode: 409, statusMessage: porta.recado!,
      data: { tipo: 'venda_fechada', motivo: porta.motivo } })
  }

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

    // O que a vitrine mostra fechado, a porta recusa — e com a frase dela.
    // Vem antes de `reservar` porque é uma pergunta de outra natureza ("este
    // lote está à venda?") e porque o recado dela é mais útil que "Lote não
    // está disponível": ele diz qual lote abrir no lugar.
    await conferirVitrine(c, ev, dados.itens)

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
    //
    // O CADASTRO (migração 027) entra nesta mesma linha, com quatro regras que
    // valem mais que as colunas:
    //   · o que a pessoa não mandou NÃO apaga o que já tinha (COALESCE) — quem
    //     compra de novo só com nome e CPF não zera o endereço do cadastro;
    //   · o endereço é UM bloco: chegou cidade nova, vem rua, número e CEP
    //     juntos. Mesclar campo a campo dava "Rua A" de uma cidade com "Salvador"
    //     de outra;
    //   · a SENHA já gravada nunca é trocada por quem chegou depois. Este
    //     formulário não prova que o e-mail é de quem digitou (ver 027), então
    //     deixar a última compra reescrever a senha seria entregar a conta;
    //   · o consentimento de novidades só muda quando a pessoa se manifestou, e
    //     o carimbo só anda quando o valor MUDA — é a prova de quando disse sim.
    const end = cadastro.endereco
    const cliente = await c.query(
      `INSERT INTO customers (org_id, name, email, document, phone,
                              birth_date, instagram,
                              zip_code, street, address_number, neighborhood, city, state,
                              address_complement,
                              password_hash, registered_at,
                              marketing_opt_in, marketing_opt_in_at)
       VALUES ($1,$2,$3,$4,$5, $6,$7, $8,$9,$10,$11,$12,$13, $14,
               $15, CASE WHEN $15::text IS NULL THEN NULL ELSE now() END,
               COALESCE($16::boolean, false), CASE WHEN $16::boolean IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (org_id, email) DO UPDATE
         SET name = EXCLUDED.name,
             document = COALESCE(customers.document, EXCLUDED.document),
             phone = COALESCE(EXCLUDED.phone, customers.phone),
             birth_date = COALESCE(EXCLUDED.birth_date, customers.birth_date),
             instagram = COALESCE(EXCLUDED.instagram, customers.instagram),
             zip_code = CASE WHEN EXCLUDED.city IS NOT NULL THEN EXCLUDED.zip_code ELSE customers.zip_code END,
             street = CASE WHEN EXCLUDED.city IS NOT NULL THEN EXCLUDED.street ELSE customers.street END,
             address_number = CASE WHEN EXCLUDED.city IS NOT NULL THEN EXCLUDED.address_number ELSE customers.address_number END,
             neighborhood = CASE WHEN EXCLUDED.city IS NOT NULL THEN EXCLUDED.neighborhood ELSE customers.neighborhood END,
             address_complement = CASE WHEN EXCLUDED.city IS NOT NULL THEN EXCLUDED.address_complement ELSE customers.address_complement END,
             state = CASE WHEN EXCLUDED.city IS NOT NULL THEN EXCLUDED.state ELSE customers.state END,
             city = CASE WHEN EXCLUDED.city IS NOT NULL THEN EXCLUDED.city ELSE customers.city END,
             password_hash = COALESCE(customers.password_hash, EXCLUDED.password_hash),
             registered_at = COALESCE(customers.registered_at, EXCLUDED.registered_at),
             marketing_opt_in = COALESCE($16::boolean, customers.marketing_opt_in),
             marketing_opt_in_at = CASE
               WHEN $16::boolean IS NOT NULL AND $16::boolean IS DISTINCT FROM customers.marketing_opt_in
                 THEN now() ELSE customers.marketing_opt_in_at END
       RETURNING id, asaas_customer_id, document`,
      [ev.org_id, dados.comprador.nome, dados.comprador.email.toLowerCase(),
       documento, dados.comprador.telefone ?? null,
       cadastro.nascimento, cadastro.instagram,
       end?.cep ?? null, end?.rua ?? null, end?.numero ?? null, end?.bairro ?? null,
       end?.cidade ?? null, end?.estado ?? null, end?.complemento ?? null,
       senhaHash, cadastro.aceitaNovidades])

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
    // Trava de DIA, que mora no banco (gatilho `sessao_confere_vaga`, db/016):
    // capacidade da sessão, dia que o lote não vende, dia de outro evento.
    //
    // `23514` sozinho não serve como assinatura — é o mesmo SQLSTATE de todo
    // CHECK do schema, e CHECK que estoura É bug nosso e merece o 500. O que
    // separa os dois é `routine`: `exec_stmt_raise` só aparece quando o RAISE
    // partiu de uma função NOSSA, ou seja, quando a mensagem foi escrita para
    // quem está no guichê. Medido antes disto: segundo pedido num dia de
    // capacidade 2 respondia `HTTP 500 {"statusMessage":"Server Error"}` e
    // engolia a frase boa ("O dia 05/12 09:00 não comporta mais 1 pessoa(s):
    // restam 0 de 2 lugares. Ofereça outro dia ou outro horário."), que já
    // existia e nunca chegava na tela.
    if (e?.code === '23514' && e?.routine === 'exec_stmt_raise') {
      throw createError({ statusCode: 409, statusMessage: e.message,
        data: { tipo: 'sessao' } })
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
 * O lote que a VITRINE mostra fechado, o checkout recusa — com a frase dela.
 *
 * `reservar()` (utils/estoque.ts) confere o que dá pra ver olhando a linha do
 * lote: visível, dentro das datas, no canal certo, com estoque. O que ele não
 * tem como saber é **qual lote do setor está vigente**: com `auto_rotate_lots`
 * ligado o setor vende um lote por vez, e isso é uma decisão do SETOR — só
 * aparece olhando os lotes irmãos, na ordem de `sort_order`.
 *
 * Sem esta conferência, o medido era: vitrine com o 2º lote em `em_breve` e
 * `maxPorCompra: 0`, e o `POST /api/checkout` naquele mesmo lote respondendo
 * **200** com pedido criado (PED-VU93-GARV, 6600 centavos). O comprador que
 * montasse a requisição na mão — ou a tela, num F5 na virada — comprava o lote
 * mais caro antes da hora, ou o mais barato depois dela.
 *
 * **Por que aqui dentro da transação e sem `FOR UPDATE`:** a decisão de giro
 * lê os lotes irmãos, que esta transação não trava (travar o setor inteiro
 * faria a venda do evento virar fila de um por vez). Ela roda na transação pra
 * enxergar o mundo já confirmado, e o que ela decide é "qual lote está à
 * venda", não "cabe mais um" — quem responde a segunda, com a trava na mão e
 * até o COMMIT, continua sendo `reservar()`. Uma leitura defasada aqui erra no
 * único instante em que o lote vigente está virando, e erra para o lado certo:
 * a venda segue e o estoque decide.
 */
async function conferirVitrine(c: PoolClient, ev: any, itens: any[]) {
  const lotIds = [...new Set(itens.map((i) => i.lotId))]
  const DOS_MESMOS_SETORES =
    `l.sector_id IN (SELECT sector_id FROM lots WHERE id = ANY($1::uuid[]))`

  // Os lotes IRMÃOS entram na consulta de propósito: sem eles não existe
  // "vigente", e `situacoesDoSetor` devolveria todo lote como se estivesse
  // sozinho no setor — que é exatamente o furo.
  const { rows: lotes } = await c.query(
    `SELECT l.id, l.name, l.sector_id, l.quantity, l.sold, l.reserved,
            l.starts_at, l.expires_at, l.half_quota_bps, l.sort_order
       FROM lots l
      WHERE ${DOS_MESMOS_SETORES} AND ${LOTE_DA_VITRINE}
      ORDER BY l.sector_id, l.sort_order`, [lotIds])
  if (!lotes.length) return

  const { rows: tipos } = await c.query(
    `SELECT tt.id, tt.lot_id, tt.kind, tt.quantity, tt.sold
       FROM ticket_types tt
       JOIN lots l ON l.id = tt.lot_id
      WHERE ${DOS_MESMOS_SETORES} AND ${LOTE_DA_VITRINE}`, [lotIds])

  const restam = restamPorTipo(lotes, tipos)
  for (const t of tipos) (t as any).restam = restam.get(t.id) ?? 0
  const restaPorLote = restaDasVariacoes(tipos)
  for (const l of lotes) l.restaNasVariacoes = restaPorLote.get(l.id) ?? null

  const porSetor = new Map<string, any[]>()
  for (const l of lotes) {
    if (!porSetor.has(l.sector_id)) porSetor.set(l.sector_id, [])
    porSetor.get(l.sector_id)!.push(l)
  }

  const agora = new Date()
  const situacao = new Map<string, SituacaoDoLote>()
  for (const doSetor of porSetor.values()) {
    // `vendasAbertas: true` porque a porta do EVENTO já foi decidida lá em
    // cima por `portaDeVenda` — se estivesse fechada, esta função nem rodava.
    const ss = situacoesDoSetor(doSetor, {
      vendasAbertas: true, giroAutomatico: ev.auto_rotate_lots, agora,
    })
    doSetor.forEach((l, i) => situacao.set(l.id, ss[i]))
  }

  for (const lotId of lotIds) {
    const s = situacao.get(lotId)
    // Lote fora da vitrine (invisível, ou só de bilheteria) não é caso desta
    // função: quem recusa é `reservar()`, que tem a frase do canal.
    if (!s || compravel(s)) continue
    const l = lotes.find((x) => x.id === lotId)!
    throw createError({ statusCode: 409,
      statusMessage: recadoDeLoteFechado(
        s, { nome: l.name, abreEm: l.starts_at, encerrouEm: l.expires_at },
        ev.timezone)!,
      data: { tipo: 'lote_fora_da_vitrine', situacao: s } })
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
