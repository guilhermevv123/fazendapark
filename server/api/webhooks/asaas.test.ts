/**
 * Teste da PORTA DO DINHEIRO — o webhook do Asaas.
 *
 * É por aqui, e só por aqui, que a plataforma descobre que um pagamento caiu.
 * Duas coisas erradas aqui não dão erro em lugar nenhum:
 *
 *  1. **Entrega repetida.** O Asaas reenvia a mesma entrega quando não recebe
 *     200 — e também quando o 200 demorou. Processar duas vezes emite o
 *     ingresso de novo (duas entradas válidas pro mesmo pagamento) ou devolve
 *     estoque duas vezes, comendo a reserva de OUTRO comprador do mesmo lote.
 *  2. **Entrega fora de ordem.** O reenvio de um PAYMENT_OVERDUE de ontem
 *     chega depois do PAYMENT_RECEIVED de hoje e reescreve o status do pedido
 *     pra trás. O dinheiro some do relatório sem nenhum vermelho.
 *
 * A trava da repetição é o índice único `(provider, gateway_event_id)` de
 * `db/010_webhook_eventos.sql`, não um if — por isso o caso de concorrência
 * abaixo força duas entregas SIMULTÂNEAS em duas conexões do pool, na mão.
 * Com `Promise.all` de dois `fetch` o teste fica verde sem trava nenhuma: a
 * primeira entrega já gravou quando a segunda chega.
 *
 * Fixture própria, ids fixos, apagada no fim. Nenhum dado do evento semeado é
 * tocado. Sem servidor de dev no ar, PULA em vez de falhar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

const ORG = '0000e010-0000-4000-8000-000000000001'
const EVENTO = '0000e010-0000-4000-8000-000000000002'
const SETOR = '0000e010-0000-4000-8000-000000000003'
const LOTE = '0000e010-0000-4000-8000-000000000004'

/** um pedido por assunto: assim um caso não come o estado do outro */
const PEDIDO_EMISSAO = '0000e010-0000-4000-8000-0000000000a1'
const PEDIDO_CANCELA = '0000e010-0000-4000-8000-0000000000a2'
const PEDIDO_VIZINHO = '0000e010-0000-4000-8000-0000000000a3'
const PEDIDO_PARCIAL = '0000e010-0000-4000-8000-0000000000a4'
const PEDIDO_ESTORNO = '0000e010-0000-4000-8000-0000000000a5'
/** venda de MEIA já paga — serve pra conferir a cota do tipo depois do estorno */
const PEDIDO_TIPO = '0000e010-0000-4000-8000-0000000000a6'
/** venda paga que vai levar chargeback */
const PEDIDO_DISPUTA = '0000e010-0000-4000-8000-0000000000a7'
/** outro comprador com reserva em pé no mesmo lote — é a vítima do estoque comido */
const PEDIDO_VIZINHO2 = '0000e010-0000-4000-8000-0000000000a8'

/** cota de "meia" do lote: 4 no total */
const TIPO_MEIA = '0000e010-0000-4000-8000-0000000000b1'

/** UUID bem-formado que NÃO é pedido nosso (cobrança de outro sistema na mesma conta) */
const PEDIDO_DE_FORA = '0000e010-0000-4000-8000-0000000000ff'

/** prefixo de toda chave de evento deste teste — é por ele que a limpeza anda */
const PREFIXO = 'evt_zz_wh_'

let noAr = false
let segredoLigado = false

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../utils/db')
  return q<any>(texto, par)
}

// ------------------------------------------------------------ payload do Asaas
function corpoAsaas(o: {
  idEvento: string
  evento: string
  pedido?: string | null
  cobranca: string
  status: string
  valorReais: number
  extra?: Record<string, any>
}) {
  return {
    id: o.idEvento,
    event: o.evento,
    dateCreated: '2026-09-20 10:00:00',
    payment: {
      object: 'payment',
      id: o.cobranca,
      customer: 'cus_zz_webhook',
      value: o.valorReais,
      netValue: o.valorReais,
      billingType: 'PIX',
      status: o.status,
      externalReference: o.pedido ?? null,
      ...(o.extra ?? {}),
    },
  }
}

async function entregar(corpo: any, token?: string) {
  const r = await fetch(`${BASE}/api/webhooks/asaas`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'asaas-access-token': token } : {}),
    },
    body: JSON.stringify(corpo),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any }
}

// ------------------------------------------------------------------ consultas
const pedido = async (id: string) =>
  (await sql(`SELECT status, refunded_cents, total_cents, platform_cents
                FROM orders WHERE id = $1`, [id]))[0]

const ingressos = async (id: string, situacao?: string) =>
  Number((await sql(
    `SELECT count(*)::int AS n FROM tickets
      WHERE order_id = $1 ${situacao ? 'AND status = $2' : ''}`,
    situacao ? [id, situacao] : [id]))[0].n)

const lote = async () =>
  (await sql(`SELECT quantity, sold, reserved FROM lots WHERE id = $1`, [LOTE]))[0]

const tipo = async () =>
  (await sql(`SELECT quantity, sold FROM ticket_types WHERE id = $1`, [TIPO_MEIA]))[0]

const eventosGravados = async (chave: string) =>
  await sql(`SELECT id, processed_at, attempts, error, order_id
               FROM payment_events WHERE gateway_event_id = $1`, [chave])

/** cria pedido + item e sobe o contador do lote como o checkout faria */
async function semearPedido(o: {
  id: string; codigo: string; situacao: string; cobranca: string | null
  quantidade: number; estornadoCents?: number; tipo?: string | null
}) {
  const faceUnit = 10_000
  const taxaUnit = 1_000
  const face = faceUnit * o.quantidade
  const taxa = taxaUnit * o.quantidade
  await sql(
    `INSERT INTO orders (id, org_id, event_id, code, status, channel,
                         face_cents, fee_cents, platform_cents, discount_cents,
                         total_cents, refunded_cents, asaas_payment_id, paid_at)
     VALUES ($1,$2,$3,$4,$5,'online',$6,$7,$8,0,$9,$10,$11,
             CASE WHEN $5 = 'pago' THEN now() ELSE NULL END)`,
    [o.id, ORG, EVENTO, o.codigo, o.situacao, face, taxa, taxa, face + taxa,
     o.estornadoCents ?? 0, o.cobranca])
  await sql(
    `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity,
                              unit_face_cents, unit_fee_cents, unit_total_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [o.id, LOTE, o.tipo ?? null, o.quantidade, faceUnit, taxaUnit, faceUnit + taxaUnit])
  // pago já baixou a reserva; pendente ainda segura lugar
  await sql(
    o.situacao === 'pago'
      ? `UPDATE lots SET sold = sold + $2 WHERE id = $1`
      : `UPDATE lots SET reserved = reserved + $2 WHERE id = $1`,
    [LOTE, o.quantidade])
  // `reservar()` consome a cota do TIPO já na reserva, e `confirmar()` não mexe
  // nela — então a cota fica consumida tanto no pendente quanto no pago.
  if (o.tipo) {
    await sql(`UPDATE ticket_types SET sold = sold + $2 WHERE id = $1`, [o.tipo, o.quantidade])
  }
}

async function limpar() {
  await sql(`DELETE FROM payment_events WHERE gateway_event_id LIKE $1`, [PREFIXO + '%'])
  await sql(`DELETE FROM tickets WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM events WHERE id = $1`, [EVENTO])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
}

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).status < 500
  } catch { noAr = false }
  if (!noAr) return

  await limpar()

  await sql(`INSERT INTO organizations (id, name, slug)
             VALUES ($1,'ZZ WEBHOOK TESTE','zz-webhook-teste')`, [ORG])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,'ZZ EVENTO WEBHOOK','zz-evento-webhook',
             now() + interval '10 days', now() + interval '11 days', 1000, 'ativo')`,
    [EVENTO, ORG])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZ Setor')`,
    [SETOR, EVENTO])
  await sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity, max_per_order)
     VALUES ($1,$2,'ZZ Lote',10000,50,10)`, [LOTE, SETOR])
  // Cota apertada de propósito: 4 meias. É nela que o estorno precisa devolver
  // o lugar — o lote tem 50 e não denunciaria nada.
  await sql(
    `INSERT INTO ticket_types (id, lot_id, name, quantity) VALUES ($1,$2,'ZZ Meia',4)`,
    [TIPO_MEIA, LOTE])

  await semearPedido({ id: PEDIDO_EMISSAO, codigo: 'ZZ-WH-1', situacao: 'aguardando_pagamento',
                       cobranca: 'pay_zz_wh_1', quantidade: 2 })
  await semearPedido({ id: PEDIDO_CANCELA, codigo: 'ZZ-WH-2', situacao: 'aguardando_pagamento',
                       cobranca: 'pay_zz_wh_2', quantidade: 3 })
  await semearPedido({ id: PEDIDO_VIZINHO, codigo: 'ZZ-WH-3', situacao: 'aguardando_pagamento',
                       cobranca: 'pay_zz_wh_3', quantidade: 4 })
  await semearPedido({ id: PEDIDO_PARCIAL, codigo: 'ZZ-WH-4', situacao: 'pago',
                       cobranca: 'pay_zz_wh_4', quantidade: 2 })
  await semearPedido({ id: PEDIDO_ESTORNO, codigo: 'ZZ-WH-5', situacao: 'aguardando_pagamento',
                       cobranca: 'pay_zz_wh_5', quantidade: 2 })
  await semearPedido({ id: PEDIDO_TIPO, codigo: 'ZZ-WH-6', situacao: 'pago',
                       cobranca: 'pay_zz_wh_6', quantidade: 2, tipo: TIPO_MEIA })
  await semearPedido({ id: PEDIDO_DISPUTA, codigo: 'ZZ-WH-7', situacao: 'pago',
                       cobranca: 'pay_zz_wh_7', quantidade: 2 })
  await semearPedido({ id: PEDIDO_VIZINHO2, codigo: 'ZZ-WH-8', situacao: 'aguardando_pagamento',
                       cobranca: 'pay_zz_wh_8', quantidade: 5 })

  // O servidor de dev pode ou não ter ASAAS_WEBHOOK_TOKEN no ambiente. Se
  // tiver, este teste não tem como adivinhar o valor: descobre pelo 401 e
  // avisa, em vez de ficar vermelho por um motivo que não é defeito.
  const ping = await entregar(corpoAsaas({
    idEvento: PREFIXO + 'ping', evento: 'PAYMENT_ZZ_PING', cobranca: 'pay_zz_wh_ping',
    status: 'PENDING', valorReais: 1,
  }), 'token-que-nao-e-o-certo')
  segredoLigado = ping.status === 401
}, 40_000)

afterAll(async () => {
  if (!noAr) return
  await limpar()
})

/** pula o caso quando não dá pra bater na rota */
function podeBater(): boolean {
  if (!noAr) { console.warn('  (pulado: servidor fora do ar)'); return false }
  if (segredoLigado) {
    console.warn('  (pulado: o servidor está com ASAAS_WEBHOOK_TOKEN e o teste não sabe o valor)')
    return false
  }
  return true
}

describe('webhook do Asaas · a mesma entrega duas vezes', () => {
  it('emite o ingresso UMA vez e devolve 200 na repetição', async () => {
    if (!podeBater()) return
    const chave = PREFIXO + 'pago'
    const corpo = corpoAsaas({
      idEvento: chave, evento: 'PAYMENT_RECEIVED', pedido: PEDIDO_EMISSAO,
      cobranca: 'pay_zz_wh_1', status: 'RECEIVED', valorReais: 220,
    })

    const primeira = await entregar(corpo)
    expect(primeira.status, `a primeira entrega não passou: ${JSON.stringify(primeira.corpo)}`).toBe(200)
    expect(primeira.corpo.emitiu, 'a primeira entrega não emitiu ingresso nenhum').toBe(true)

    const segunda = await entregar(corpo)
    // 200 na repetição não é gentileza: erro aqui faz o Asaas retentar pra
    // sempre e a fila dele engasga com o nosso evento.
    expect(segunda.status, 'devolveu erro na reentrega — o Asaas vai retentar pra sempre').toBe(200)
    expect(segunda.corpo.repetido, 'não reconheceu a reentrega como repetida').toBe(true)

    expect(await ingressos(PEDIDO_EMISSAO),
      'a mesma entrega gerou ingresso duas vezes — duas entradas válidas pro mesmo pagamento')
      .toBe(2)
    expect((await pedido(PEDIDO_EMISSAO)).status).toBe('pago')

    // Uma linha só, processada uma vez: é o índice único fazendo o trabalho.
    const linhas = await eventosGravados(chave)
    expect(linhas.length, 'a mesma entrega virou duas linhas em payment_events').toBe(1)
    expect(linhas[0].attempts, 'o efeito rodou mais de uma vez pro mesmo evento').toBe(1)
    expect(linhas[0].processed_at, 'ficou sem baixa mesmo tendo emitido').toBeTruthy()
    expect(linhas[0].order_id, 'não ligou o evento ao pedido').toBe(PEDIDO_EMISSAO)
  }, 30_000)

  it('guarda o payload cru — é a resposta pra "o Asaas mandou?"', async () => {
    if (!podeBater()) return
    const linha = (await sql(
      `SELECT payload, event_name, external_id FROM payment_events
        WHERE gateway_event_id = $1`, [PREFIXO + 'pago']))[0]
    expect(linha, 'o evento não ficou gravado').toBeTruthy()
    expect(linha.event_name).toBe('PAYMENT_RECEIVED')
    expect(linha.external_id, 'perdeu o id da cobrança no gateway').toBe('pay_zz_wh_1')
    expect(linha.payload?.payment?.value, 'não guardou o valor que o gateway informou').toBe(220)
  }, 20_000)

  /**
   * A prova de que a idempotência é do BANCO e não do código.
   *
   * Duas entregas simultâneas: a segunda tenta gravar a MESMA chave antes de a
   * primeira ter dado commit. Se a trava fosse um `SELECT` seguido de
   * `INSERT`, as duas passariam — não existe momento em que a linha da
   * primeira esteja visível pra segunda antes do commit. O índice único não
   * tem esse vão: a segunda fica pendurada até a primeira decidir.
   *
   * Arranque `payment_events_gateway_uk` e este caso fica vermelho na hora.
   */
  it('duas entregas simultâneas: só uma linha entra', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const chave = PREFIXO + 'corrida'
    await sql(`DELETE FROM payment_events WHERE gateway_event_id = $1`, [chave])

    const { db } = await import('../../utils/db')
    const c1 = await db().connect()
    const c2 = await db().connect()
    const INSERIR = `INSERT INTO payment_events (provider, gateway_event_id, event_name, payload)
                     VALUES ('asaas', $1, 'PAYMENT_RECEIVED', '{}'::jsonb)
                     ON CONFLICT (provider, gateway_event_id) DO NOTHING
                     RETURNING id`
    try {
      await c1.query('BEGIN')
      await c2.query('BEGIN')

      const a = await c1.query(INSERIR, [chave])
      expect(a.rowCount, 'a primeira entrega não conseguiu gravar').toBe(1)

      // B tenta a mesma chave e FICA PENDURADO: a promessa não resolve
      // enquanto A não terminar. É isso que o caso precisa provar.
      let bPassou = false
      const bEsperando = c2.query(INSERIR, [chave])
        .then((r) => { bPassou = true; return r })
        .catch(() => ({ rowCount: -1 } as any))

      await new Promise((r) => setTimeout(r, 400))
      expect(bPassou,
        'a segunda entrega gravou sem esperar — não existe trava no banco, só no código').toBe(false)

      await c1.query('COMMIT')

      const b = await bEsperando
      expect(b.rowCount, 'a segunda entrega virou uma segunda linha do mesmo evento').toBe(0)
      await c2.query('ROLLBACK')
    } finally {
      // ROLLBACK antes de devolver ao pool, SEMPRE: release() não desfaz
      // transação aberta, e uma falha no meio deixaria a trava presa numa
      // conexão devolvida — o caso SEGUINTE trava até o timeout e aponta pro
      // lugar errado.
      await c1.query('ROLLBACK').catch(() => {})
      await c2.query('ROLLBACK').catch(() => {})
      c1.release()
      c2.release()
    }

    const linhas = await eventosGravados(chave)
    expect(linhas.length, 'sobrou mais de uma linha pro mesmo evento').toBe(1)
    await sql(`DELETE FROM payment_events WHERE gateway_event_id = $1`, [chave])
  }, 30_000)
})

describe('webhook do Asaas · cancelamento e estorno', () => {
  it('cobrança apagada devolve o estoque mesmo com o pagamento em PENDING', async () => {
    if (!podeBater()) return
    const antes = await lote()
    const corpo = corpoAsaas({
      idEvento: PREFIXO + 'delete', evento: 'PAYMENT_DELETED', pedido: PEDIDO_CANCELA,
      cobranca: 'pay_zz_wh_2', status: 'PENDING', valorReais: 330,
      extra: { deleted: true },
    })

    const r = await entregar(corpo)
    expect(r.status).toBe(200)

    // PAYMENT_DELETED chega com o pagamento ainda em PENDING. Lido só pelo
    // status, virava "aguardando pagamento" e os 3 lugares ficavam presos.
    expect((await pedido(PEDIDO_CANCELA)).status,
      'cobrança apagada não cancelou o pedido').toBe('cancelado')
    expect((await lote()).reserved,
      'os lugares do pedido apagado continuaram presos no lote').toBe(antes.reserved - 3)
  }, 30_000)

  it('o mesmo cancelamento duas vezes não come a reserva de outro comprador', async () => {
    if (!podeBater()) return
    const antes = await lote()
    // o vizinho tem 4 lugares reservados neste mesmo lote e não fez nada
    expect(antes.reserved, 'a reserva do vizinho sumiu antes da hora').toBeGreaterThanOrEqual(4)

    const corpo = corpoAsaas({
      idEvento: PREFIXO + 'delete', evento: 'PAYMENT_DELETED', pedido: PEDIDO_CANCELA,
      cobranca: 'pay_zz_wh_2', status: 'PENDING', valorReais: 330,
      extra: { deleted: true },
    })
    const r = await entregar(corpo)
    expect(r.status, 'a reentrega do cancelamento devolveu erro').toBe(200)

    expect((await lote()).reserved,
      'devolveu o estoque duas vezes e comeu a reserva de outro pedido do mesmo lote')
      .toBe(antes.reserved)
    expect((await eventosGravados(PREFIXO + 'delete')).length).toBe(1)
  }, 30_000)

  it('estorno parcial grava o valor devolvido e o pedido segue contando no líquido', async () => {
    if (!podeBater()) return
    const r = await entregar(corpoAsaas({
      idEvento: PREFIXO + 'parcial', evento: 'PAYMENT_PARTIALLY_REFUNDED',
      pedido: PEDIDO_PARCIAL, cobranca: 'pay_zz_wh_4', status: 'PARTIALLY_REFUNDED',
      valorReais: 220, extra: { refundedValue: 20 },
    }))
    expect(r.status).toBe(200)

    const p = await pedido(PEDIDO_PARCIAL)
    expect(p.status, 'estorno parcial não virou estornado_parcial').toBe('estornado_parcial')
    expect(Number(p.refunded_cents), 'não gravou em centavos o que voltou pro comprador').toBe(2_000)

    // A conta do líquido depende deste par (status + refunded_cents): um
    // recorte por status = 'pago' apagaria o pedido inteiro de R$ 220 por
    // causa de um estorno de R$ 20. Medido com a expressão compartilhada,
    // no banco — não uma cópia da conta em TypeScript.
    const { PEDIDO_VIVO, SQL_LIQUIDO } = await import('../../utils/liquido')
    const [{ liquido }] = await sql(
      `SELECT ${SQL_LIQUIDO()} AS liquido FROM orders
        WHERE id = $1 AND ${PEDIDO_VIVO()}`, [PEDIDO_PARCIAL])
    expect(Number(liquido),
      'o pedido com estorno parcial sumiu do líquido em vez de descontar os R$ 20')
      .toBe(Number(p.total_cents) - Number(p.platform_cents) - 2_000)
  }, 30_000)

  it('estorno parcial sem valor no payload não grava zero devolvido', async () => {
    if (!podeBater()) return
    const chave = PREFIXO + 'parcial_sem_valor'
    const r = await entregar(corpoAsaas({
      idEvento: chave, evento: 'PAYMENT_PARTIALLY_REFUNDED', pedido: PEDIDO_EMISSAO,
      cobranca: 'pay_zz_wh_1', status: 'PARTIALLY_REFUNDED', valorReais: 220,
    }))
    expect(r.status, 'devolveu erro em vez de registrar').toBe(200)

    // Gravar estornado_parcial com zero devolvido faz o líquido contar o
    // pedido inteiro como se nada tivesse voltado: erro em dinheiro que não
    // aparece em lugar nenhum. Melhor não mexer e deixar a linha na fila.
    expect((await pedido(PEDIDO_EMISSAO)).status,
      'marcou estorno parcial sem saber quanto voltou').toBe('pago')
    const [linha] = await eventosGravados(chave)
    expect(linha.processed_at, 'deu baixa num evento que não soube tratar').toBeNull()
    expect(linha.attempts, 'não contou a tentativa').toBe(1)
    expect(String(linha.error), 'não disse por que não tratou').toContain('valor devolvido')
  }, 30_000)

  it('estorno total desfaz a venda: cancela ingresso e devolve o lugar', async () => {
    if (!podeBater()) return
    // paga primeiro, pelo caminho de verdade
    await entregar(corpoAsaas({
      idEvento: PREFIXO + 'pago5', evento: 'PAYMENT_RECEIVED', pedido: PEDIDO_ESTORNO,
      cobranca: 'pay_zz_wh_5', status: 'RECEIVED', valorReais: 220,
    }))
    expect(await ingressos(PEDIDO_ESTORNO, 'valido'),
      'o pedido nem chegou a emitir — o caso de estorno não provaria nada').toBe(2)
    const vendidosAntes = (await lote()).sold

    const r = await entregar(corpoAsaas({
      idEvento: PREFIXO + 'estorno5', evento: 'PAYMENT_REFUNDED', pedido: PEDIDO_ESTORNO,
      cobranca: 'pay_zz_wh_5', status: 'REFUNDED', valorReais: 220,
      extra: { refunds: [{ value: 220, status: 'DONE' }] },
    }))
    expect(r.status).toBe(200)

    const p = await pedido(PEDIDO_ESTORNO)
    expect(p.status).toBe('estornado')
    expect(Number(p.refunded_cents), 'não gravou o valor estornado').toBe(22_000)
    expect(await ingressos(PEDIDO_ESTORNO, 'valido'),
      'estornou o dinheiro e deixou o ingresso valendo na portaria').toBe(0)
    expect((await lote()).sold, 'não devolveu o lugar pra prateleira').toBe(vendidosAntes - 2)
  }, 40_000)

  /**
   * Reentrega de um evento ANTIGO, com id próprio — o índice único não pega
   * esta. Quem pega é a lista de permissão de `permiteAnotarStatus()`.
   */
  it('evento atrasado não ressuscita pedido já estornado', async () => {
    if (!podeBater()) return
    const r = await entregar(corpoAsaas({
      idEvento: PREFIXO + 'atrasado', evento: 'PAYMENT_OVERDUE', pedido: PEDIDO_ESTORNO,
      cobranca: 'pay_zz_wh_5', status: 'OVERDUE', valorReais: 220,
    }))
    expect(r.status).toBe(200)

    // Voltar pra 'aguardando_pagamento' tira o pedido do líquido e deixa o
    // refunded_cents lá: o dinheiro some do relatório sem nenhum vermelho.
    expect((await pedido(PEDIDO_ESTORNO)).status,
      'um evento atrasado reescreveu pra trás o status de um pedido já estornado')
      .toBe('estornado')
    expect(r.corpo.foraDeOrdem, 'aceitou o evento fora de ordem como se fosse novidade').toBe(true)
  }, 30_000)
})

describe('webhook do Asaas · o que a entrega repetida não pega', () => {
  /**
   * O caso de cima ("duas entregas simultâneas") roda um `INSERT ... ON
   * CONFLICT` escrito DENTRO DO TESTE. Isso prova que o Postgres tem índice
   * único — não prova que a ROTA se apoia nele. Medido: trocar o `ON CONFLICT`
   * da rota por um `SELECT` antes do `INSERT` (o "vão" clássico) passou pelos
   * 13 casos do arquivo sem nenhum vermelho.
   *
   * Aqui quem apanha é a rota. Uma linha com a mesma chave fica ABERTA numa
   * outra conexão; a rota chega, encosta no índice e dorme. Quando a outra
   * conexão faz commit:
   *
   *   • com `ON CONFLICT`, o INSERT volta com zero linhas e a rota trata como
   *     reentrega — 200;
   *   • com pré-checagem, o `SELECT` não enxergou a linha não commitada, o
   *     `INSERT` acorda em cima do índice e estoura 23505 — 500. E 500 aqui não
   *     é só um erro: o Asaas reentrega pra sempre a MESMA coisa e a fila de
   *     webhook da conta para naquele evento.
   */
  it('a rota se apoia no índice do banco, não num SELECT antes do INSERT', async () => {
    if (!podeBater()) return
    const chave = PREFIXO + 'bloqueada'
    await sql(`DELETE FROM payment_events WHERE gateway_event_id = $1`, [chave])

    const { db } = await import('../../utils/db')
    const c1 = await db().connect()
    let resposta: { status: number; corpo: any }
    try {
      await c1.query('BEGIN')
      await c1.query(
        `INSERT INTO payment_events (provider, gateway_event_id, event_name, payload)
         VALUES ('asaas', $1, 'PAYMENT_ZZ_IGNORADO', '{}'::jsonb)`, [chave])

      const emVoo = entregar(corpoAsaas({
        idEvento: chave, evento: 'PAYMENT_ZZ_IGNORADO', cobranca: 'pay_zz_wh_1',
        status: 'PENDING', valorReais: 1,
      }))
      // tempo de sobra pra requisição chegar no INSERT e encostar no índice
      await new Promise((r) => setTimeout(r, 500))
      await c1.query('COMMIT')
      resposta = await emVoo
    } finally {
      // ROLLBACK antes de devolver ao pool, SEMPRE: release() não desfaz
      // transação aberta, e uma falha no meio deixaria a linha travada.
      await c1.query('ROLLBACK').catch(() => {})
      c1.release()
    }

    expect(resposta.status,
      `a rota não sobreviveu a uma entrega concorrente (${JSON.stringify(resposta.corpo)}) — trocaram o ON CONFLICT por uma pré-checagem, ou o índice único sumiu`)
      .toBe(200)
    expect((await eventosGravados(chave)).length,
      'a mesma entrega virou duas linhas em payment_events').toBe(1)
    await sql(`DELETE FROM payment_events WHERE gateway_event_id = $1`, [chave])
  }, 30_000)

  /**
   * A mesma conta do Asaas atende mais de um sistema (é o arranjo do dono).
   * Cobrança criada pelo outro sistema chega aqui com um `externalReference`
   * que é UUID e não é pedido nosso. `payment_events.order_id` tem chave
   * estrangeira: gravar esse UUID cru estourava violação de FK ANTES de
   * qualquer try/catch — 500, nenhuma linha gravada, e o Asaas reentregando pra
   * sempre a mesma coisa. Uma cobrança de fora parava a fila de todas as
   * outras.
   */
  it('cobrança de outro sistema na mesma conta não derruba a porta nem some do registro', async () => {
    if (!podeBater()) return
    const chave = PREFIXO + 'de_fora'
    await sql(`DELETE FROM payment_events WHERE gateway_event_id = $1`, [chave])
    expect((await sql(`SELECT id FROM orders WHERE id = $1`, [PEDIDO_DE_FORA])).length,
      'o uuid forasteiro virou pedido de verdade — o caso não prova mais nada').toBe(0)

    const r = await entregar(corpoAsaas({
      idEvento: chave, evento: 'PAYMENT_RECEIVED', pedido: PEDIDO_DE_FORA,
      cobranca: 'pay_zz_wh_forasteiro', status: 'RECEIVED', valorReais: 10,
    }))
    expect(r.status,
      'devolveu erro: o Asaas vai reentregar pra sempre e a fila da conta para neste evento')
      .toBe(200)

    const [linha] = await eventosGravados(chave)
    expect(linha,
      'a rota promete gravar o payload cru ANTES de agir, e não gravou nada — a pergunta "o Asaas mandou?" fica sem resposta')
      .toBeTruthy()
    expect(linha.order_id, 'amarrou o evento a um pedido que não existe').toBeNull()
    expect(String(linha.error), 'não disse por que não tratou').toContain('não encontrado')
  }, 30_000)

  /**
   * `reservar()` consome `ticket_types.sold` (a cota de meia/inteira) e
   * `confirmar()` não mexe nela — quem devolve é só `liberar()`, que o ramo de
   * venda desfeita não chama. Resultado medido antes do conserto: estornar 2
   * meias devolveu o lugar em `lots` e deixou o tipo em 2 de 4. O lote mostra
   * 48 livres e a porta de venda (`sold + n <= quantity`) recusa a terceira
   * meia — prateleira presa que ninguém vê.
   */
  it('estorno devolve a cota do TIPO de ingresso, não só o lugar do lote', async () => {
    if (!podeBater()) return
    const tipoAntes = await tipo()
    const loteAntes = await lote()
    expect(Number(tipoAntes.sold), 'a cota do tipo nem foi consumida — o caso não prova nada')
      .toBeGreaterThanOrEqual(2)

    const r = await entregar(corpoAsaas({
      idEvento: PREFIXO + 'estorno_tipo', evento: 'PAYMENT_REFUNDED', pedido: PEDIDO_TIPO,
      cobranca: 'pay_zz_wh_6', status: 'REFUNDED', valorReais: 220,
      extra: { refundedValue: 220 },
    }))
    expect(r.status).toBe(200)
    expect((await pedido(PEDIDO_TIPO)).status).toBe('estornado')

    expect(Number((await lote()).sold), 'não devolveu o lugar no lote')
      .toBe(Number(loteAntes.sold) - 2)
    expect(Number((await tipo()).sold),
      'devolveu o lugar no lote e deixou a cota de meia consumida: o tipo "esgota" com o parque vazio')
      .toBe(Number(tipoAntes.sold) - 2)
  }, 30_000)

  /**
   * Chargeback no Asaas não é um evento, é uma sequência:
   *   REQUESTED → AWAITING_CHARGEBACK_REVERSAL → DISPUTE.
   * O do meio só anota e leva o pedido de 'chargeback' pra 'disputa'. Se
   * 'disputa' não contar como "já desfeito", o terceiro desfaz DE NOVO — e
   * como 'disputa' também não é 'pago', o desfazimento cai no `liberar()`, que
   * subtrai `reserved` de um pedido que não reserva mais nada. Quem paga é o
   * vizinho: medido, 5 lugares reservados viraram 3, e o lote passou a achar
   * que tem 2 a mais pra vender.
   */
  it('a sequência inteira do chargeback não come a reserva de outro comprador', async () => {
    if (!podeBater()) return
    const antes = await lote()
    expect(Number(antes.reserved), 'a reserva do vizinho sumiu antes da hora')
      .toBeGreaterThanOrEqual(5)

    const cobranca = 'pay_zz_wh_7'
    const passos: [string, string, string][] = [
      ['chargeback1', 'PAYMENT_CHARGEBACK_REQUESTED', 'CHARGEBACK_REQUESTED'],
      ['chargeback2', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL', 'AWAITING_CHARGEBACK_REVERSAL'],
      ['chargeback3', 'PAYMENT_CHARGEBACK_DISPUTE', 'CHARGEBACK_DISPUTE'],
    ]
    for (const [sufixo, evento, situacao] of passos) {
      const r = await entregar(corpoAsaas({
        idEvento: PREFIXO + sufixo, evento, pedido: PEDIDO_DISPUTA,
        cobranca, status: situacao, valorReais: 220,
      }))
      expect(r.status, `${evento} devolveu erro`).toBe(200)
    }

    const depois = await lote()
    // o lugar VENDIDO volta uma vez (o pedido era 'pago' e deixou de ser)
    expect(Number(depois.sold), 'o chargeback não devolveu o lugar vendido')
      .toBe(Number(antes.sold) - 2)
    // e a reserva de quem não tem nada com isso fica onde estava
    expect(Number(depois.reserved),
      'a sequência do chargeback desfez duas vezes e comeu a reserva de outro comprador do mesmo lote')
      .toBe(Number(antes.reserved))
    // e o pedido segue fora do líquido, não volta pra vivo
    expect(['chargeback', 'disputa']).toContain((await pedido(PEDIDO_DISPUTA)).status)
  }, 40_000)
})

// ---------------------------------------------------------------- o segredo
/**
 * A conferência do token é função pura de propósito: o servidor de dev sobe
 * com o ambiente que tem, e um teste que depende de reiniciar o servidor com
 * outra variável nunca roda. Aqui a regra é exercida direto.
 */
describe('webhook do Asaas · segredo', () => {
  it('token certo passa, token errado não', async () => {
    const { conferirSegredoWebhook } = await import('../../utils/asaas')
    expect(conferirSegredoWebhook({
      esperado: 'segredo-do-parque', recebido: 'segredo-do-parque', producao: true,
    }).ok).toBe(true)

    const errado = conferirSegredoWebhook({
      esperado: 'segredo-do-parque', recebido: 'segredo-do-parqu', producao: true,
    })
    expect(errado.ok, 'aceitou um token que não é o configurado — ingresso de graça pra quem achar a URL').toBe(false)
    expect(errado.status).toBe(401)

    const ausente = conferirSegredoWebhook({
      esperado: 'segredo-do-parque', recebido: '', producao: true,
    })
    expect(ausente.ok, 'aceitou requisição sem token nenhum').toBe(false)
    expect(ausente.status).toBe(401)
  })

  it('em produção, sem segredo configurado, a porta fecha', async () => {
    const { conferirSegredoWebhook } = await import('../../utils/asaas')
    const prod = conferirSegredoWebhook({ esperado: '', recebido: 'qualquer', producao: true })
    expect(prod.ok, 'em produção aceitou webhook anônimo porque ninguém configurou o token').toBe(false)
    expect(prod.status).toBe(503)
    expect(prod.motivo, 'não disse ao operador o que fazer').toContain('ASAAS_WEBHOOK_TOKEN')

    // fora de produção passa, senão ninguém roda o fluxo na máquina — mas avisa
    const dev = conferirSegredoWebhook({ esperado: '  ', recebido: '', producao: false })
    expect(dev.ok).toBe(true)
    expect(dev.aviso, 'passou sem conferir e sem avisar ninguém').toBeTruthy()
  })

  it('pedido com dinheiro resolvido não aceita anotação de evento atrasado', async () => {
    const { permiteAnotarStatus } = await import('../../utils/asaas')
    // o caminho normal: pedido em aberto anda
    expect(permiteAnotarStatus('aguardando_pagamento', 'em_analise')).toBe(true)
    expect(permiteAnotarStatus('rascunho', 'aguardando_pagamento')).toBe(true)

    // o que o reenvio atrasado tentaria fazer
    for (const resolvido of ['pago', 'estornado', 'estornado_parcial', 'cancelado', 'expirado']) {
      expect(permiteAnotarStatus(resolvido, 'aguardando_pagamento'),
        `um evento atrasado reescreveria um pedido ${resolvido} pra "aguardando_pagamento"`)
        .toBe(false)
    }

    // 'disputa' tira o pedido do líquido: só depois de um chargeback de verdade
    expect(permiteAnotarStatus('chargeback', 'disputa')).toBe(true)
    expect(permiteAnotarStatus('pago', 'disputa'),
      'derrubaria o líquido de um pedido pago sem ninguém ter tirado dinheiro dele').toBe(false)
  })

  /**
   * `toISOString()` converte pra UTC antes de cortar. Às 21h de Brasília o
   * "amanhã" local já é depois de amanhã em UTC, e a cobrança nasce com um dia
   * a mais de prazo — no horário de pico do parque.
   *
   * O instante é construído em horário LOCAL de propósito: é a hora que o
   * servidor vê.
   */
  it('o vencimento é a data LOCAL, não a data em UTC', async () => {
    const { vencimentoEmDias } = await import('../../utils/asaas')
    // 20/09/2026 às 23h da máquina
    const noite = new Date(2026, 8, 20, 23, 0, 0)
    expect(vencimentoEmDias(1, noite),
      'às 23h o vencimento pulou um dia: toISOString() jogou a data pra UTC antes de cortar')
      .toBe('2026-09-21')
    expect(vencimentoEmDias(0, noite)).toBe('2026-09-20')
    // e a virada de mês continua certa
    expect(vencimentoEmDias(1, new Date(2026, 8, 30, 23, 0, 0))).toBe('2026-10-01')
  })

  it('a chave de idempotência é o id do EVENTO, não o da cobrança', async () => {
    const { chaveDoEvento } = await import('../../utils/asaas')
    const pagamento = { id: 'pay_1', status: 'RECEIVED' }
    // mesma cobrança, dois eventos diferentes: não podem colidir, senão o
    // estorno seria descartado como "repetido" do pagamento
    expect(chaveDoEvento({ id: 'evt_a', event: 'PAYMENT_RECEIVED', payment: pagamento }))
      .not.toBe(chaveDoEvento({ id: 'evt_b', event: 'PAYMENT_REFUNDED', payment: pagamento }))

    // sem id de evento, corpo idêntico dá a mesma chave (é a mesma entrega)
    const semId = { event: 'PAYMENT_RECEIVED', payment: pagamento }
    expect(chaveDoEvento(semId)).toBe(chaveDoEvento({ ...semId }))
    expect(chaveDoEvento(semId)).not.toBe(
      chaveDoEvento({ event: 'PAYMENT_REFUNDED', payment: pagamento }))
  })
})
