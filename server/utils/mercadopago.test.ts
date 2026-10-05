/**
 * Pix pelo Mercado Pago (28/09) — o trilho inteiro no banco de teste, com o MP trocado por um dublê
 * (`fetch` do processo). Nenhuma chamada sai da máquina.
 *
 * O que se prova, e por que cada um custaria dinheiro:
 *
 *  · o CHECKOUT gera o Pix no MP (e não no Asaas) quando a organização tem o token — com o valor
 *    em reais, a referência do pedido e a chave de idempotência do pedido; MP fora cai pro Asaas
 *    (aqui, o simulado) e, sem plano B, devolve o lugar;
 *  · o pagamento vira ingresso UMA vez só, por qualquer porta (aviso, varredura, reprocesso) — e
 *    duas portas ao mesmo tempo não emitem duas vezes;
 *  · o salto de estado: "aprovado com estorno parcial" visto de primeira emite ANTES de estornar;
 *  · o Pix de reserva vencida é cancelado no MP; o pago no vão vira ingresso;
 *  · o aviso com assinatura torta é recusado sem gravar nada; o pagamento de outra organização não
 *    toca o pedido nem gera consulta;
 *  · a fila de devolução devolve pelo MP (`mp:<id>`), com chave por chamada; o estorno em
 *    processamento fica a confirmar, o recusado não vira recibo, e a retentativa pergunta antes;
 *  · as varreduras param na primeira falha passageira e respeitam o prazo da rodada;
 *  · o token não sai (nem troca de conta) com Pix aberto ou devolução do MP na fila.
 *
 * Fixture própria (organização, evento, lote), apagada no fim.
 */
import { createHmac, randomUUID } from 'node:crypto'
import { createError, getHeader, getQuery, getRouterParam, readBody } from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

process.env.DT_ESTORNO_WORKER = 'off'
;(globalThis as any).defineEventHandler ??= (h: any) => h
;(globalThis as any).createError ??= createError
;(globalThis as any).readBody ??= readBody
;(globalThis as any).getQuery ??= getQuery
;(globalThis as any).getHeader ??= getHeader
;(globalThis as any).getRouterParam ??= getRouterParam

const { db, q, q1 } = await import('./db')
const MP = await import('./mercadopago')
const { processarUmEstorno, SQL_ENFILEIRA_ESTORNO_DE_UM_PEDIDO } = await import('./cancelamento')
const { default: checkout } = await import('../api/checkout.post')
const { default: webhook } = await import('../api/webhooks/mercadopago/[org].post')
const { default: salvarOrganizacao } = await import('../api/admin/organizacao.patch')
const { default: lerOrganizacao } = await import('../api/admin/organizacao.get')

const TOKEN = 'APP_USR-zz-duble-do-mercado-pago-0001'
const SEGREDO = 'assinatura-secreta-do-painel-zz-0001'

/* ================================================================ o dublê do MP */

type Chamada = { metodo: string; caminho: string; corpo: any; cabecalhos: Record<string, string> }
let chamadas: Chamada[] = []
const pagamentos = new Map<string, any>()
let proximoId = 8_100_000_000
let mpFora = false
/** como o MP responde o próximo estorno: devolvido na hora, em processamento, ou recusado */
let estornoResponde: 'approved' | 'in_process' | 'rejected' = 'approved'
const idsCriados: string[] = []

function novoPagamento(id: string, valor: number, referencia: string | null) {
  return {
    id: Number(id), status: 'pending', status_detail: 'pending_waiting_transfer',
    transaction_amount: valor, transaction_amount_refunded: 0, external_reference: referencia,
    payment_method_id: 'pix', payment_type_id: 'bank_transfer', refunds: [] as any[],
    transaction_details: { net_received_amount: 0 }, fee_details: [] as any[],
  }
}
/** o comprador pagou: a tarifa de 0,99% do MP */
function aprovar(id: string) {
  const p = pagamentos.get(id)!
  const taxa = Math.round(p.transaction_amount * 0.99) / 100
  Object.assign(p, { status: 'approved', status_detail: 'accredited',
    transaction_details: { net_received_amount: Number((p.transaction_amount - taxa).toFixed(2)) },
    fee_details: [{ type: 'mercadopago_fee', amount: taxa, fee_payer: 'collector' }] })
}

function responderMp(c: Chamada): { status: number; json: any } {
  if (mpFora) return { status: 503, json: { message: 'service unavailable' } }
  if (c.cabecalhos.Authorization !== `Bearer ${TOKEN}`) return { status: 401, json: { message: 'invalid_token' } }
  const m = c.caminho.match(/^\/v1\/payments\/(\d+)(\/refunds)?$/)
  if (c.metodo === 'GET' && c.caminho === '/users/me') return { status: 200, json: { id: 777, nickname: 'ZZPARK', tags: [] } }
  if (c.metodo === 'POST' && c.caminho === '/v1/payments') {
    const id = String(++proximoId)
    idsCriados.push(id)
    const p = novoPagamento(id, c.corpo.transaction_amount, c.corpo.external_reference)
    pagamentos.set(id, p)
    // no sandbox a imagem vem vazia: quem chama desenha o QR a partir do copia-e-cola
    return { status: 201, json: { ...p, point_of_interaction: { transaction_data: {
      qr_code: `00020126580014br.gov.bcb.pix0136zz-${id}5204000053039865406${c.corpo.transaction_amount}`,
      qr_code_base64: '', ticket_url: `https://www.mercadopago.com.br/payments/${id}/ticket` } } } }
  }
  if (!m || !pagamentos.has(m[1])) return { status: 404, json: { message: 'not_found' } }
  const p = pagamentos.get(m[1])
  if (c.metodo === 'GET' && !m[2]) return { status: 200, json: p }
  if (c.metodo === 'PUT' && !m[2]) {
    if (!['pending', 'in_process'].includes(p.status)) return { status: 400, json: { message: 'Payment cannot be cancelled' } }
    Object.assign(p, { status: 'cancelled', status_detail: 'by_collector' })
    return { status: 200, json: p }
  }
  if (c.metodo === 'POST' && m[2]) {
    if (p.status !== 'approved') return { status: 400, json: { message: 'invalid status' } }
    const valor = c.corpo?.amount ?? Number((p.transaction_amount - p.transaction_amount_refunded).toFixed(2))
    const r = { id: 9_900_000 + p.refunds.length + 1, payment_id: p.id, amount: valor, status: estornoResponde }
    p.refunds.push(r)
    if (estornoResponde !== 'approved') return { status: 201, json: r }
    p.transaction_amount_refunded = Number((p.transaction_amount_refunded + valor).toFixed(2))
    if (p.transaction_amount_refunded >= p.transaction_amount) Object.assign(p, { status: 'refunded', status_detail: 'refunded' })
    else p.status_detail = 'partially_refunded'
    return { status: 201, json: r }
  }
  return { status: 405, json: null }
}

/* ===================================================================== fixture */

let orgId: string, vizinhaId: string, eventId: string, lotId: string, slug: string
let contador = 0

function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

/** um pedido de Pix no MP, direto no banco (o checkout tem os casos dele lá embaixo) */
async function pedidoMp(o: { status?: string; minutosAtras?: number } = {}) {
  const status = o.status ?? 'aguardando_pagamento'
  const pid = String(++proximoId)
  idsCriados.push(pid)
  const ped = (await q1<any>(
    `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                         discount_cents, total_cents, payment_method, installments, mp_payment_id,
                         created_at, expires_at, canceled_at)
     VALUES ($1, $2, 'PED-ZZMP-' || upper(substr(md5(random()::text), 1, 6)), $3, 'online',
             5000, 500, 500, 0, 5500, 'pix', 1, $4, now() - make_interval(mins => $5),
             CASE WHEN $3 = 'aguardando_pagamento' THEN now() + interval '20 minutes' ELSE now() - interval '1 minute' END,
             CASE WHEN $3 = 'expirado' THEN now() END)
     RETURNING id, code`, [orgId, eventId, status, pid, o.minutosAtras ?? 2]))!
  await q(`INSERT INTO order_items (order_id, lot_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents)
           VALUES ($1, $2, 1, 5000, 500, 5500)`, [ped.id, lotId])
  if (status === 'aguardando_pagamento') await q(`UPDATE lots SET reserved = reserved + 1 WHERE id = $1`, [lotId])
  pagamentos.set(pid, novoPagamento(pid, 55, ped.id))
  return { id: ped.id as string, code: ped.code as string, pid }
}

const pedido = async (id: string) => (await q1<any>(
  `SELECT status, refunded_cents, gateway_fee_cents, gateway_net_cents, mp_payment_id, asaas_payment_id
     FROM orders WHERE id = $1`, [id]))!
const ingressos = async (id: string) =>
  Number((await q1<any>(`SELECT count(*)::int AS n FROM tickets WHERE order_id = $1 AND status <> 'cancelado'`, [id]))!.n)
const lote = async () => (await q1<any>(`SELECT sold, reserved FROM lots WHERE id = $1`, [lotId]))!
const fatos = async (pid: string) => q<any>(
  `SELECT gateway_event_id, event_name, processed_at IS NOT NULL AS baixa, error
     FROM payment_events WHERE provider = 'mercadopago' AND external_id = $1 ORDER BY created_at`, [pid])

beforeAll(async () => {
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    const u = new URL(url)
    if (u.host !== 'api.mercadopago.com') throw new Error(`o teste não fala com ${u.host}`)
    const c: Chamada = { metodo: init?.method ?? 'GET', caminho: u.pathname,
      corpo: init?.body ? JSON.parse(init.body) : null, cabecalhos: { ...(init?.headers ?? {}) } }
    chamadas.push(c)
    const r = responderMp(c)
    return new Response(r.json == null ? '' : JSON.stringify(r.json), { status: r.status })
  })
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug, mp_access_token, mp_webhook_secret, mp_user_id)
    VALUES ('ZZ Mercado Pago', 'zz-mp-' || gen_random_uuid(), $1, $2, '777') RETURNING id`, [TOKEN, SEGREDO]))!.id
  vizinhaId = (await q1<any>(`INSERT INTO organizations (name, slug, mp_access_token)
    VALUES ('ZZ MP Vizinha', 'zz-mp-vizinha-' || gen_random_uuid(), $1) RETURNING id`, [TOKEN]))!.id
  slug = `zz-mp-${Date.now()}`
  eventId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online)
     VALUES ($1, 'ZZ Mercado Pago', $2, 'ativo', now() + interval '10 days', now() + interval '11 days',
             1000, 'repassar') RETURNING id`, [orgId, slug]))!.id
  const setor = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1, 'Pista') RETURNING id`, [eventId]))!.id
  lotId = (await q1<any>(`INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
    VALUES ($1, 'Lote', 5000, 200, 10, '{online}') RETURNING id`, [setor]))!.id
})

afterEach(() => { chamadas = []; mpFora = false; estornoResponde = 'approved' })

afterAll(async () => {
  vi.unstubAllGlobals()
  await q(`DELETE FROM payment_events WHERE provider = 'mercadopago' AND external_id = ANY($1::text[])`, [idsCriados])
  await q(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[orgId, vizinhaId]])
  await db().end()
})

/* =================================================================== checkout */

function requisicao(corpo: any) {
  return {
    method: 'POST', path: '/api/checkout', context: {},
    node: {
      req: { method: 'POST', url: '/api/checkout', headers: { 'content-type': 'application/json' },
             body: JSON.stringify(corpo), socket: { remoteAddress: `10.33.${contador % 250}.${1 + (contador % 200)}` } },
      res: { setHeader() {}, getHeader() {} },
    },
  } as any
}
async function comprar(forma: 'pix' | 'credito' = 'pix') {
  const email = `mp.${Date.now()}.${++contador}@teste.invalido`
  const documento = cpf()
  try {
    const corpo = await (checkout as any)(requisicao({
      eventSlug: slug, itens: [{ lotId, quantidade: 2 }],
      comprador: { nome: 'Ana Maria de Teste', email, documento }, forma,
    }))
    return { status: 200, corpo, documento }
  } catch (e: any) {
    if (!e?.statusCode) throw e
    return { status: e.statusCode as number, recado: e.statusMessage as string, documento }
  }
}

describe('checkout · o Pix sai pelo Mercado Pago quando a organização tem o token', () => {
  it('gera o Pix no MP (e não no Asaas), com valor em reais, referência e idempotência do pedido', async () => {
    const antes = await lote()
    const r = await comprar('pix')
    expect(r.status, r.recado).toBe(200)
    expect(r.corpo.pagamento.pixPayload).toMatch(/^00020126/)
    // a imagem que o MP não mandou foi desenhada a partir do copia-e-cola (PNG)
    expect(r.corpo.pagamento.pixQrBase64).toMatch(/^iVBOR/)

    const criar = chamadas.find((c) => c.metodo === 'POST' && c.caminho === '/v1/payments')!
    expect(criar, 'o checkout não chamou o MP').toBeTruthy()
    expect(criar.corpo).toMatchObject({
      transaction_amount: 110, payment_method_id: 'pix', external_reference: r.corpo.pedidoId,
      payer: { email: expect.stringContaining('@teste.invalido'), identification: { type: 'CPF', number: r.documento } },
    })
    expect(criar.corpo.date_of_expiration).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}-03:00$/)
    // PUBLIC_BASE_URL do teste é http: o MP recusaria o Pix inteiro com notification_url sem https
    expect('notification_url' in criar.corpo).toBe(false)
    expect(criar.cabecalhos['X-Idempotency-Key']).toBe(`pix-${r.corpo.pedidoId}`)

    const o = await pedido(r.corpo.pedidoId)
    expect(o.mp_payment_id).toBe(String(proximoId))
    expect(o.asaas_payment_id, 'o id do MP foi parar na régua do Asaas').toBeNull()
    expect((await lote()).reserved).toBe(antes.reserved + 2)
  })

  it('MP fora com o Asaas de pé (aqui, o simulado): o Pix sai por ele, e a falha fica na trilha', async () => {
    mpFora = true
    const r = await comprar('pix')
    expect(r.status, r.recado).toBe(200)
    expect(r.corpo.pagamento.pixPayload, 'o comprador ficou sem QR').toBeTruthy()
    const o = await pedido(r.corpo.pedidoId)
    expect(o.mp_payment_id).toBeNull()
    expect(o.asaas_payment_id).toMatch(/^sim_/)
    const trilha = await q1<any>(
      `SELECT after FROM audit_log WHERE entity = 'order' AND entity_id = $1 AND action = 'pix_mp_falhou'`,
      [r.corpo.pedidoId])
    expect(trilha?.after).toMatchObject({ saiuPor: 'asaas' })
  })

  describe('sem Asaas e sem simulado (só o MP)', () => {
    let antes: string | undefined
    beforeAll(() => { antes = process.env.PAGAMENTO_SIMULADO; process.env.PAGAMENTO_SIMULADO = '0' })
    afterAll(() => { process.env.PAGAMENTO_SIMULADO = antes })

    it('MP fora: sem plano B, o pedido morre e o lugar volta na hora', async () => {
      const antesLote = await lote()
      mpFora = true
      const r = await comprar('pix')
      expect(r.status).toBe(502)
      expect(r.recado).toMatch(/PIX/)
      expect((await lote()).reserved).toBe(antesLote.reserved)
    })

    it('cartão: recusa antes de reservar, mandando pro Pix (que está de pé)', async () => {
      const antesLote = await lote()
      const r = await comprar('credito')
      expect(r.status).toBe(503)
      expect(r.recado).toMatch(/Pague com PIX/)
      expect((await lote()).reserved).toBe(antesLote.reserved)
    })
  })

  it('cartão continua no caminho do Asaas (aqui, o simulado) — o MP não é chamado', async () => {
    const r = await comprar('credito')
    expect(r.status, r.recado).toBe(200)
    expect(chamadas.filter((c) => c.caminho === '/v1/payments')).toEqual([])
    const o = await pedido(r.corpo.pedidoId)
    expect(o.mp_payment_id).toBeNull()
  })
})

/* ======================================================= o pagamento vira ingresso */

describe('processarPagamentoMp · o que o MP diz vira efeito, uma vez só', () => {
  it('pendente: nada é gravado', async () => {
    const p = await pedidoMp()
    const r = await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    expect(r).toMatchObject({ ok: true, pendente: true, fatos: 0 })
    expect(await fatos(p.pid)).toEqual([])
    expect((await pedido(p.id)).status).toBe('aguardando_pagamento')
  })

  it('aprovado: pago, ingresso emitido, lugar vendido, tarifa e líquido do MP gravados', async () => {
    const p = await pedidoMp()
    const antes = await lote()
    aprovar(p.pid)
    const r = await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    expect(r).toMatchObject({ ok: true, fatos: 1 })
    const o = await pedido(p.id)
    expect(o.status).toBe('pago')
    expect(await ingressos(p.id)).toBe(1)
    expect(await lote()).toEqual({ sold: antes.sold + 1, reserved: antes.reserved - 1 })
    expect({ taxa: o.gateway_fee_cents, liquido: o.gateway_net_cents }).toEqual({ taxa: 54, liquido: 5446 })
    expect(await fatos(p.pid)).toEqual([expect.objectContaining({ gateway_event_id: `mp:${p.pid}:pago`, baixa: true })])

    // a mesma notícia de novo (reenvio, varredura): nada muda
    const de_novo = await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    expect(de_novo).toMatchObject({ ok: true, fatos: 0 })
    expect(await ingressos(p.id)).toBe(1)
    expect((await lote()).sold).toBe(antes.sold + 1)
  })

  it('duas portas ao mesmo tempo (aviso + varredura): um ingresso só', async () => {
    const p = await pedidoMp()
    aprovar(p.pid)
    await Promise.all([
      MP.processarPagamentoMp({ orgId, paymentId: p.pid }),
      MP.processarPagamentoMp({ orgId, paymentId: p.pid }),
      MP.processarPagamentoMp({ orgId, paymentId: p.pid }),
    ])
    expect(await ingressos(p.id)).toBe(1)
    expect((await fatos(p.pid)).length).toBe(1)
  })

  it('o salto de estado: visto de primeira "aprovado com estorno parcial", emite ANTES de estornar', async () => {
    const p = await pedidoMp()
    aprovar(p.pid)
    Object.assign(pagamentos.get(p.pid), { transaction_amount_refunded: 10, status_detail: 'partially_refunded' })
    const r = await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    expect(r).toMatchObject({ ok: true, fatos: 2 })
    const o = await pedido(p.id)
    expect(o.status).toBe('estornado_parcial')
    expect(Number(o.refunded_cents)).toBe(1000)
    expect(await ingressos(p.id), 'sem o fato "pago" antes, o pedido estornava sem ter emitido').toBe(1)
  })

  it('cancelado no MP com o pedido esperando: o lugar volta', async () => {
    const p = await pedidoMp()
    const antes = await lote()
    Object.assign(pagamentos.get(p.pid), { status: 'cancelled', status_detail: 'expired' })
    await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    expect((await pedido(p.id)).status).toBe('cancelado')
    expect((await lote()).reserved).toBe(antes.reserved - 1)
  })

  it('nunca pago aqui e o MP já diz devolvido: nenhum ingresso nasce pra morrer no mesmo segundo', async () => {
    const p = await pedidoMp()
    const antes = await lote()
    aprovar(p.pid)
    Object.assign(pagamentos.get(p.pid), { status: 'refunded', status_detail: 'refunded', transaction_amount_refunded: 55 })
    const r = await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    expect(r.ok, r.erro).toBe(true)
    expect(await ingressos(p.id)).toBe(0)
    expect((await q1<any>(`SELECT count(*)::int AS n FROM tickets WHERE order_id = $1`, [p.id]))!.n,
      'emitiu e cancelou (com e-mail de ingresso pro comprador)').toBe(0)
    expect((await fatos(p.pid)).map((f) => f.gateway_event_id)).toEqual([`mp:${p.pid}:estorno-total`])
    expect((await lote()).reserved).toBe(antes.reserved - 1)
    expect(['estornado', 'cancelado']).toContain((await pedido(p.id)).status)
  })

  it('referência do MP apontando outro pedido: nada é aplicado', async () => {
    const p = await pedidoMp()
    aprovar(p.pid)
    pagamentos.get(p.pid).external_reference = randomUUID()
    const r = await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    expect(r.ok).toBe(false)
    expect(r.erro).toMatch(/referência/)
    expect((await pedido(p.id)).status).toBe('aguardando_pagamento')
    expect(await ingressos(p.id)).toBe(0)
  })

  it('pagamento do pedido de uma organização, perguntado pela OUTRA: ignorado, e sem consulta ao MP', async () => {
    const p = await pedidoMp()
    aprovar(p.pid)
    const r = await MP.processarPagamentoMp({ orgId: vizinhaId, paymentId: p.pid })
    expect(r.ignorado).toBeTruthy()
    expect(chamadas).toEqual([])
    expect((await pedido(p.id)).status).toBe('aguardando_pagamento')
  })

  it('MP fora: falha passageira, nada gravado — a próxima volta tenta de novo', async () => {
    const p = await pedidoMp()
    mpFora = true
    const r = await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    expect(r).toMatchObject({ ok: false, passageira: true })
    expect(await fatos(p.pid)).toEqual([])
  })
})

/* ============================================================== as varreduras */

describe('varreduras · o ingresso sai mesmo sem aviso, e o Pix vencido fecha', () => {
  it('varrerPixEsperando pergunta pelos Pix esperando e aplica o aprovado', async () => {
    const p = await pedidoMp({ minutosAtras: 3 })
    aprovar(p.pid)
    await MP.varrerPixEsperando({ limite: 500 })
    expect((await pedido(p.id)).status).toBe('pago')
    expect(await ingressos(p.id)).toBe(1)
  })

  it('o Pix do pedido vencido é cancelado no MP, com a linha na trilha', async () => {
    const p = await pedidoMp({ status: 'expirado' })
    const r = await MP.cancelarPixVencidos({ limite: 500 })
    expect(r.find((x) => x.pedidoId === p.id)).toMatchObject({ ok: true, desfecho: 'pix_mp_cancelado' })
    expect(pagamentos.get(p.pid).status).toBe('cancelled')
    // a segunda volta não pede de novo
    chamadas = []
    await MP.cancelarPixVencidos({ limite: 500 })
    expect(chamadas.filter((c) => c.caminho === `/v1/payments/${p.pid}`)).toEqual([])
  })

  it('pago no vão (depois de a reserva cair, antes do cancelamento): vira ingresso, com o lugar refeito', async () => {
    const p = await pedidoMp({ status: 'expirado' })
    aprovar(p.pid)
    const r = await MP.cancelarPixVencidos({ limite: 500 })
    expect(r.find((x) => x.pedidoId === p.id)).toMatchObject({ ok: true, desfecho: 'pix_mp_pago_no_vao' })
    expect((await pedido(p.id)).status).toBe('pago')
    expect(await ingressos(p.id)).toBe(1)
  })

  it('MP fora: a varredura para na PRIMEIRA pergunta (os outros ouviriam o mesmo não)', async () => {
    await pedidoMp({ minutosAtras: 3 })
    await pedidoMp({ minutosAtras: 3 })
    mpFora = true
    const r = await MP.varrerPixEsperando({ limite: 500 })
    expect(chamadas.length, 'MP fora gastou o prazo da rodada perguntando um por um').toBe(1)
    expect(r).toEqual([expect.objectContaining({ ok: false, passageira: true })])
  })

  it('prazo da rodada vencido: nenhuma pergunta nova', async () => {
    // um de cada porta esperando pergunta: esperando, vencido e pendurado
    const p = await pedidoMp({ minutosAtras: 3 })
    aprovar(p.pid)
    await pedidoMp({ status: 'expirado' })
    const pendurado = await pedidoMp()
    await q(`INSERT INTO payment_events (provider, gateway_event_id, external_id, event_name, order_id, payload)
             VALUES ('mercadopago', $1, $2, 'PAYMENT_RECEIVED', $3, '{}'::jsonb)`,
      [`mp:${pendurado.pid}:teste-prazo`, pendurado.pid, pendurado.id])
    expect(await MP.varrerPixEsperando({ limite: 500, ate: Date.now() - 1 })).toEqual([])
    expect(await MP.cancelarPixVencidos({ limite: 500, ate: Date.now() - 1 })).toEqual([])
    expect(await MP.reprocessarFatosMp({ carenciaMin: 0, limite: 500, ate: Date.now() - 1 })).toEqual([])
    expect(chamadas).toEqual([])
    // arruma a casa pros próximos
    await q(`UPDATE payment_events SET processed_at = now() WHERE gateway_event_id = $1`, [`mp:${pendurado.pid}:teste-prazo`])
    await MP.varrerPixEsperando({ limite: 500 })
    await MP.cancelarPixVencidos({ limite: 500 })
  })

  it('Pix vencido com o MP fora: a falha fica na trilha, encerra a rodada e NÃO conta pro teto', async () => {
    const um = await pedidoMp({ status: 'expirado' })
    const outro = await pedidoMp({ status: 'expirado' })
    mpFora = true
    const r = await MP.cancelarPixVencidos({ limite: 500 })
    expect(r.length, 'seguiu perguntando com o MP fora').toBe(1)
    const falhas = await q<any>(
      `SELECT after FROM audit_log WHERE entity = 'order' AND entity_id = ANY($1::text[]) AND action = 'pix_mp_cancelar_falhou'`,
      [[um.id, outro.id]])
    expect(falhas.map((f) => f.after.passageira)).toEqual([true])

    // a régua do teto: 3 recusas de REGRA tiram o pedido da fila; 3 quedas do MP, não
    const regra = await pedidoMp({ status: 'expirado' })
    const queda = await pedidoMp({ status: 'expirado' })
    for (const [o, passageira] of [[regra, false], [queda, true]] as const) {
      for (let i = 0; i < 3; i++) {
        await q(`INSERT INTO audit_log (org_id, entity, entity_id, action, after, created_at)
                 VALUES ($1, 'order', $2, 'pix_mp_cancelar_falhou', $3::jsonb, now() - interval '11 minutes')`,
          [orgId, o.id, JSON.stringify({ passageira })])
      }
    }
    const fila = (await q<any>(MP.SQL_PIX_A_CANCELAR, [500, MP.MAX_TENTATIVAS_CANCELAR_PIX])).map((l) => l.id)
    expect(fila).not.toContain(regra.id)
    expect(fila, 'MP fora por meia hora largava o QR pagável pra sempre').toContain(queda.id)
    mpFora = false
    await MP.cancelarPixVencidos({ limite: 500 }) // fecha os que sobraram
  })
})

/* ================================================================== o aviso */

function aviso(o: { org: string; consulta: string; cabecalhos?: Record<string, string>; corpo?: any }) {
  const url = `/api/webhooks/mercadopago/${o.org}?${o.consulta}`
  return {
    method: 'POST', path: url, context: { params: { org: o.org } },
    node: {
      req: { method: 'POST', url, headers: { 'content-type': 'application/json', ...(o.cabecalhos ?? {}) },
             body: JSON.stringify(o.corpo ?? {}), socket: { remoteAddress: '127.0.0.1' } },
      res: { setHeader() {}, getHeader() {} },
    },
  } as any
}
async function avisar(o: Parameters<typeof aviso>[0]) {
  try {
    return { status: 200, corpo: await (webhook as any)(aviso(o)) }
  } catch (e: any) {
    if (!e?.statusCode) throw e
    return { status: e.statusCode as number, corpo: null }
  }
}
function assinado(pid: string, segredo = SEGREDO) {
  const ts = String(Date.now())
  const v1 = createHmac('sha256', segredo).update(`id:${pid};request-id:req-zz;ts:${ts};`).digest('hex')
  return { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'req-zz' }
}

describe('webhook · o aviso é só um aviso', () => {
  it('assinado certo: pergunta ao MP e aplica', async () => {
    const p = await pedidoMp()
    aprovar(p.pid)
    const r = await avisar({ org: orgId, consulta: `data.id=${p.pid}&type=payment&source_news=webhooks`,
      cabecalhos: assinado(p.pid), corpo: { action: 'payment.updated', data: { id: p.pid } } })
    expect(r.status).toBe(200)
    expect((await pedido(p.id)).status).toBe('pago')
  })

  it('assinatura torta: 401 e NADA gravado', async () => {
    const p = await pedidoMp()
    aprovar(p.pid)
    const r = await avisar({ org: orgId, consulta: `data.id=${p.pid}&type=payment`,
      cabecalhos: assinado(p.pid, 'segredo-de-quem-forjou-000000') })
    expect(r.status).toBe(401)
    expect(await fatos(p.pid)).toEqual([])
    expect((await pedido(p.id)).status).toBe('aguardando_pagamento')
  })

  it('sem assinatura: segue como aviso (o estado vem do MP de qualquer jeito)', async () => {
    const p = await pedidoMp()
    aprovar(p.pid)
    const r = await avisar({ org: orgId, consulta: `id=${p.pid}&topic=payment` })
    expect(r.status).toBe(200)
    expect((await pedido(p.id)).status).toBe('pago')
  })

  it('tipo que não é pagamento, ou pagamento que não é nosso: 200 sem consultar o MP', async () => {
    expect((await avisar({ org: orgId, consulta: 'data.id=123&type=merchant_order' })).status).toBe(200)
    expect((await avisar({ org: orgId, consulta: 'data.id=1999999999&type=payment' })).status).toBe(200)
    expect(chamadas).toEqual([])
  })

  it('MP fora: 500, pro MP reenviar', async () => {
    const p = await pedidoMp()
    mpFora = true
    expect((await avisar({ org: orgId, consulta: `data.id=${p.pid}&type=payment` })).status).toBe(500)
  })

  it('organização que não existe: 404', async () => {
    expect((await avisar({ org: randomUUID(), consulta: 'data.id=1&type=payment' })).status).toBe(404)
    expect((await avisar({ org: 'nao-e-uuid', consulta: 'data.id=1&type=payment' })).status).toBe(404)
  })
})

/* ================================================================ a devolução */

describe('fila de devolução · o Pix do MP volta pelo MP', () => {
  it('a linha da fila leva mp:<id>, o estorno sai no MP com chave por tentativa, e o pedido fecha', async () => {
    const p = await pedidoMp()
    aprovar(p.pid)
    await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    const [job] = await q<any>(SQL_ENFILEIRA_ESTORNO_DE_UM_PEDIDO, [p.id, 'arrependimento', null, null])
    expect(job, 'o pedido pago não entrou na fila').toBeTruthy()
    const linha = await q1<any>(`SELECT asaas_payment_id FROM refund_jobs WHERE id = $1`, [job.id])
    expect(linha!.asaas_payment_id).toBe(`mp:${p.pid}`)

    chamadas = []
    const r = await processarUmEstorno('teste-mp', job.id)
    expect(r, r?.erro).toMatchObject({ ok: true, status: 'estornado' })
    const devolver = chamadas.find((c) => c.caminho === `/v1/payments/${p.pid}/refunds`)!
    expect(devolver.corpo).toEqual({ amount: 55 })
    // a chave é da CHAMADA: repetida, o MP devolveria a resposta guardada (inclusive o erro)
    expect(devolver.cabecalhos['X-Idempotency-Key']).toMatch(new RegExp(`^estorno-${job.id}-1-[0-9a-f]{8}$`))
    expect(devolver.cabecalhos['X-Render-In-Process-Refunds']).toBe('true')
    expect(pagamentos.get(p.pid).status).toBe('refunded')
    expect((await pedido(p.id)).status).toBe('estornado')
  })

  const pedidoPagoNaFila = async () => {
    const p = await pedidoMp()
    aprovar(p.pid)
    await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    const [job] = await q<any>(SQL_ENFILEIRA_ESTORNO_DE_UM_PEDIDO, [p.id, 'arrependimento', null, null])
    return { ...p, job }
  }
  const marca = async (pid: string) => q1<any>(
    `SELECT processed_at, attempts, error, event_name FROM payment_events
      WHERE provider = 'mercadopago' AND gateway_event_id = $1`, [MP.chaveDaDevolucaoAConfirmar(pid)])

  it('estorno em processamento: a fila fecha, a devolução fica A CONFIRMAR e fecha sozinha quando o MP confirma', async () => {
    const p = await pedidoPagoNaFila()
    estornoResponde = 'in_process'
    const r = await processarUmEstorno('teste-mp', p.job.id)
    expect(r, r?.erro).toMatchObject({ ok: true, status: 'estornado' })
    expect((await pedido(p.id)).status).toBe('estornado')
    const aberta = await marca(p.pid)
    expect(aberta, 'o estorno em processamento sumiu sem deixar linha').toMatchObject({
      processed_at: null, event_name: 'MP_DEVOLUCAO_A_CONFIRMAR' })
    expect(aberta!.error).toMatch(/em processamento/)

    // o aviso do MP (ainda em processamento) não gasta tentativa; o reprocesso gasta
    await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    expect((await marca(p.pid))!.attempts).toBe(aberta!.attempts)
    await MP.reprocessarFatosMp({ carenciaMin: 0, limite: 500 })
    expect((await marca(p.pid))!.attempts).toBe(aberta!.attempts + 1)

    // o MP confirma: a linha fecha, e o eco do estorno não soma de novo
    const pg = pagamentos.get(p.pid)
    Object.assign(pg.refunds[0], { status: 'approved' })
    Object.assign(pg, { transaction_amount_refunded: 55, status: 'refunded', status_detail: 'refunded' })
    await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    expect((await marca(p.pid))!.processed_at).not.toBeNull()
    expect(Number((await pedido(p.id)).refunded_cents)).toBe(5500)
  })

  it('estorno recusado DEPOIS de aceito: a linha diz o que fazer, e a trilha registra uma vez só', async () => {
    const p = await pedidoPagoNaFila()
    estornoResponde = 'in_process'
    await processarUmEstorno('teste-mp', p.job.id)
    pagamentos.get(p.pid).refunds[0].status = 'rejected'
    await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    const m = await marca(p.pid)
    expect(m!.processed_at).toBeNull()
    expect(m!.error).toMatch(/não devolveu R\$\s?55,00/)
    const trilha = await q<any>(
      `SELECT 1 FROM audit_log WHERE entity = 'order' AND entity_id = $1 AND action = 'devolucao_mp_recusada'`, [p.id])
    expect(trilha.length).toBe(1)
    // devolvido pelo painel do MP: a linha fecha sozinha
    const pg = pagamentos.get(p.pid)
    pg.refunds.push({ id: 9_999_001, amount: 55, status: 'approved' })
    Object.assign(pg, { transaction_amount_refunded: 55, status: 'refunded' })
    await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    expect((await marca(p.pid))!.processed_at).not.toBeNull()
  })

  it('estorno que o MP responde RECUSADO: não vira recibo — a linha volta pra fila e a retentativa pergunta antes', async () => {
    const p = await pedidoPagoNaFila()
    estornoResponde = 'rejected'
    const r = await processarUmEstorno('teste-mp', p.job.id)
    expect(r).toMatchObject({ ok: false, status: 'na_fila' })
    expect((await pedido(p.id)).status, 'estorno recusado deu o pedido como devolvido').toBe('pago')

    estornoResponde = 'approved'
    chamadas = []
    const de_novo = await processarUmEstorno('teste-mp', p.job.id)
    expect(de_novo, de_novo?.erro).toMatchObject({ ok: true, status: 'estornado' })
    // a retentativa PERGUNTOU antes de mandar — e o recusado não contou como devolvido
    const feitas = chamadas.map((c) => `${c.metodo} ${c.caminho}`)
    expect(feitas[0]).toBe(`GET /v1/payments/${p.pid}`)
    expect(feitas).toContain(`POST /v1/payments/${p.pid}/refunds`)
    expect(pagamentos.get(p.pid).status).toBe('refunded')
  })

  it('retentativa com o estorno A CAMINHO no MP: não manda o dinheiro de novo', async () => {
    const p = await pedidoPagoNaFila()
    // a 1ª tentativa mandou (o MP aceitou, em processamento) e a resposta se perdeu
    pagamentos.get(p.pid).refunds.push({ id: 9_999_002, amount: 55, status: 'in_process' })
    await q(`UPDATE refund_jobs SET attempts = 1 WHERE id = $1`, [p.job.id])
    chamadas = []
    const r = await processarUmEstorno('teste-mp', p.job.id)
    expect(r, r?.erro).toMatchObject({ ok: true, status: 'estornado' })
    expect(chamadas.filter((c) => c.caminho.endsWith('/refunds')), 'devolveu em dobro').toEqual([])
  })

  it('o "tentar todos" de uma pessoa não alcança o pendurado da produtora vizinha', async () => {
    const p = await pedidoMp()
    await q(`INSERT INTO payment_events (provider, gateway_event_id, external_id, event_name, order_id, payload)
             VALUES ('mercadopago', $1, $2, 'PAYMENT_RECEIVED', $3, '{}'::jsonb)`, [`mp:${p.pid}:teste-cerca`, p.pid, p.id])
    expect(await MP.reprocessarFatosMp({ carenciaMin: 0, limite: 500, orgId: vizinhaId })).toEqual([])
    expect(chamadas).toEqual([])
    const minha = await MP.reprocessarFatosMp({ carenciaMin: 0, limite: 500, orgId })
    expect(minha.map((d) => d.pedidoId)).toContain(p.id)
    await q(`UPDATE payment_events SET processed_at = now() WHERE gateway_event_id = $1`, [`mp:${p.pid}:teste-cerca`])
  })

  it('idNoGateway: Asaas como está, MP com prefixo, nenhum = fora da plataforma', () => {
    expect(MP.idNoGateway({ asaas_payment_id: 'pay_1', mp_payment_id: null })).toBe('pay_1')
    expect(MP.idNoGateway({ asaas_payment_id: null, mp_payment_id: '123' })).toBe('mp:123')
    expect(MP.idNoGateway({ asaas_payment_id: null, mp_payment_id: null })).toBeNull()
  })
})

/* ============================================================ o painel (Dados e cobrança) */

describe('painel · o token do MP é conferido NA FONTE antes de gravar', () => {
  let painelOrg: string, dono: string
  // quem salva o token é a equipe da plataforma (05/10): a sessão de mentira, 'dono@zz', entra na lista
  const equipeAntes = process.env.EQUIPE_DA_PLATAFORMA
  beforeAll(() => { process.env.EQUIPE_DA_PLATAFORMA = 'dono@zz' })
  afterAll(() => {
    if (equipeAntes === undefined) delete process.env.EQUIPE_DA_PLATAFORMA
    else process.env.EQUIPE_DA_PLATAFORMA = equipeAntes
  })
  beforeAll(async () => {
    painelOrg = (await q1<any>(`INSERT INTO organizations (name, slug)
      VALUES ('ZZ MP Painel', 'zz-mp-painel-' || gen_random_uuid()) RETURNING id`))!.id
    dono = (await q1<any>(`INSERT INTO users (org_id, name, email, password_hash, role, papel)
      VALUES ($1, 'Dono ZZ', 'dono.zz.mp.' || gen_random_uuid() || '@teste.invalido', 'x', 'master', 'master')
      RETURNING id`, [painelOrg]))!.id
  })
  afterAll(async () => { await q(`DELETE FROM organizations WHERE id = $1`, [painelOrg]) })

  const pedidoDoPainel = (metodo: string, corpo?: any) => ({
    method: metodo, path: '/api/admin/organizacao',
    context: { sessao: { orgId: painelOrg, usuarioId: dono, email: 'dono@zz' }, papel: 'master' },
    node: {
      req: { method: metodo, url: '/api/admin/organizacao', headers: { 'content-type': 'application/json' },
             ...(corpo ? { body: JSON.stringify(corpo) } : {}), socket: { remoteAddress: '127.0.0.1' } },
      res: { setHeader() {}, getHeader() {} },
    },
  } as any)
  const salvar = async (corpo: any) => {
    try { return { status: 200, corpo: await (salvarOrganizacao as any)(pedidoDoPainel('PATCH', corpo)) } } catch (e: any) {
      if (!e?.statusCode) throw e
      return { status: e.statusCode as number, recado: e.statusMessage as string }
    }
  }
  const colunas = async () => (await q1<any>(
    `SELECT mp_access_token, mp_webhook_secret, mp_user_id, mp_test FROM organizations WHERE id = $1`, [painelOrg]))!

  it('token que o MP recusa: 422 com a frase, e NADA gravado', async () => {
    const r = await salvar({ tokenMercadoPago: 'APP_USR-token-errado-que-o-mp-recusa-000' })
    expect(r.status).toBe(422)
    expect(r.recado).toMatch(/não aceitou este token/)
    expect((await colunas()).mp_access_token).toBeNull()
  })

  it('MP fora na hora de salvar: não grava às cegas', async () => {
    mpFora = true
    const r = await salvar({ tokenMercadoPago: TOKEN })
    expect(r.status).toBe(422)
    expect(r.recado).toMatch(/Nada foi salvo/)
    expect((await colunas()).mp_access_token).toBeNull()
  })

  it('token bom: grava com a conta do MP, e a tela lê só o fim — Pix passa a sair pelo MP', async () => {
    const r = await salvar({ tokenMercadoPago: TOKEN, segredoMercadoPago: SEGREDO })
    expect(r.status, r.recado).toBe(200)
    expect(chamadas.map((c) => `${c.metodo} ${c.caminho}`)).toEqual(['GET /users/me'])
    expect(await colunas()).toMatchObject({ mp_user_id: '777', mp_test: false })

    const tela = await (lerOrganizacao as any)(pedidoDoPainel('GET'))
    expect(tela.mercadoPago).toMatchObject({
      temToken: true, tokenFinal: TOKEN.slice(-6), temSegredo: true, pixPeloMercadoPago: true, motivo: null,
    })
    // o token nunca sai da rota de leitura
    expect(JSON.stringify(tela)).not.toContain(TOKEN)
    expect(JSON.stringify(tela)).not.toContain(SEGREDO)
  })

  it('desligar: token e assinatura somem, e o Pix volta pro Asaas', async () => {
    const r = await salvar({ tokenMercadoPago: null, segredoMercadoPago: null })
    expect(r.status, r.recado).toBe(200)
    expect(await colunas()).toMatchObject({ mp_access_token: null, mp_webhook_secret: null, mp_user_id: null, mp_test: false })
    const tela = await (lerOrganizacao as any)(pedidoDoPainel('GET'))
    expect(tela.mercadoPago).toMatchObject({ temToken: false, pixPeloMercadoPago: false, motivo: 'sem_token' })
  })
})

/* ========================================================= a troca da conta do MP */

describe('troca de conta · o Pix aberto fecha antes de o token sair', () => {
  let dono: string
  const equipeAntes = process.env.EQUIPE_DA_PLATAFORMA
  beforeAll(() => { process.env.EQUIPE_DA_PLATAFORMA = 'dono@zz' })
  afterAll(() => {
    if (equipeAntes === undefined) delete process.env.EQUIPE_DA_PLATAFORMA
    else process.env.EQUIPE_DA_PLATAFORMA = equipeAntes
  })
  beforeAll(async () => {
    dono = (await q1<any>(`INSERT INTO users (org_id, name, email, password_hash, role, papel)
      VALUES ($1, 'Dono ZZ MP', 'dono.zz.mp.troca.' || gen_random_uuid() || '@teste.invalido', 'x', 'master', 'master')
      RETURNING id`, [orgId]))!.id
    // o que os casos de cima deixaram pra trás (a referência torta, o pago da vizinha) não é deste
    // bloco: fica fora da conta de "Pix aberto"
    await q(`UPDATE orders SET status = 'cancelado' WHERE org_id = $1 AND mp_payment_id IS NOT NULL
               AND status IN ('aguardando_pagamento', 'expirado')`, [orgId])
  })

  const salvarNaOrg = async (corpo: any) => {
    const ev = {
      method: 'PATCH', path: '/api/admin/organizacao',
      context: { sessao: { orgId, usuarioId: dono, email: 'dono@zz' }, papel: 'master' },
      node: {
        req: { method: 'PATCH', url: '/api/admin/organizacao', headers: { 'content-type': 'application/json' },
               body: JSON.stringify(corpo), socket: { remoteAddress: '127.0.0.1' } },
        res: { setHeader() {}, getHeader() {} },
      },
    } as any
    try { return { status: 200, corpo: await (salvarOrganizacao as any)(ev) } } catch (e: any) {
      if (!e?.statusCode) throw e
      return { status: e.statusCode as number, recado: e.statusMessage as string }
    }
  }
  const tokenGravado = async () => (await q1<any>(`SELECT mp_access_token FROM organizations WHERE id = $1`, [orgId]))!.mp_access_token

  it('MP fora: o token NÃO sai, e a frase diz qual pedido ficou com o Pix aberto', async () => {
    const p = await pedidoMp()
    mpFora = true
    const r = await salvarNaOrg({ tokenMercadoPago: null })
    expect(r.status).toBe(409)
    expect(r.recado).toContain(p.code)
    expect(r.recado).toMatch(/Nada foi salvo/)
    expect(await tokenGravado(), 'o token saiu com o Pix aberto').toBe(TOKEN)
  })

  it('token novo da MESMA conta: nada é fechado (ele enxerga os mesmos pagamentos)', async () => {
    const p = await pedidoMp()
    const r = await salvarNaOrg({ tokenMercadoPago: TOKEN })
    expect(r.status, r.recado).toBe(200)
    expect(chamadas.map((c) => `${c.metodo} ${c.caminho}`)).toEqual(['GET /users/me'])
    expect(pagamentos.get(p.pid).status).toBe('pending')
  })

  it('devolução do MP ainda na fila segura a troca', async () => {
    const p = await pedidoMp()
    aprovar(p.pid)
    await MP.processarPagamentoMp({ orgId, paymentId: p.pid })
    const [job] = await q<any>(SQL_ENFILEIRA_ESTORNO_DE_UM_PEDIDO, [p.id, 'arrependimento', null, null])
    const r = await salvarNaOrg({ tokenMercadoPago: null })
    expect(r.status).toBe(409)
    expect(r.recado).toMatch(/devolução/)
    expect(await tokenGravado()).toBe(TOKEN)
    await processarUmEstorno('teste-mp', job.id)
  })

  it('com o MP de pé: esperando cancela lá e aqui (o lugar volta), pago no vão vira ingresso — e o token sai', async () => {
    const esperando = await pedidoMp()
    const pagoNoVao = await pedidoMp()
    aprovar(pagoNoVao.pid)
    const vencido = await pedidoMp({ status: 'expirado' })
    const antes = await lote()
    const esperandoNaOrg = Number((await q1<any>(
      `SELECT count(*)::int AS n FROM orders
        WHERE org_id = $1 AND status = 'aguardando_pagamento' AND mp_payment_id IS NOT NULL`, [orgId]))!.n)
    const r = await salvarNaOrg({ tokenMercadoPago: null })
    expect(r.status, r.recado).toBe(200)
    expect(await tokenGravado()).toBeNull()

    expect(pagamentos.get(esperando.pid).status).toBe('cancelled')
    expect((await pedido(esperando.id)).status).toBe('cancelado')
    expect(pagamentos.get(vencido.pid).status).toBe('cancelled')
    expect((await pedido(pagoNoVao.id)).status).toBe('pago')
    expect(await ingressos(pagoNoVao.id)).toBe(1)
    // todo esperando saiu da reserva (os deste caso e os que os de cima deixaram abertos):
    // cancelado devolve o lugar, pago no vão vira venda
    expect((await lote()).reserved).toBe(antes.reserved - esperandoNaOrg)
  })
})
