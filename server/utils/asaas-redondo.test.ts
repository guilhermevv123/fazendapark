/**
 * Asaas "redondo" (05/10) — o cartão pelo Asaas no banco de teste, com o Asaas trocado por um dublê
 * (`fetch` do processo). Nenhuma chamada sai da máquina.
 *
 * O que se prova, e o que cada defeito custava:
 *
 *  · P0-1 parcelado: o pedido em 3x é UM parcelamento com três cobranças. O checkout guarda o id do
 *    parcelamento; estorno, cancelamento e a conferência "já saiu?" agem nele (não na 1ª parcela);
 *    o webhook soma o estorno parcela a parcela em vez de dar o pedido inteiro por 1/3;
 *  · P0-2 rede de baixo: o cartão pago sem aviso vira ingresso pela varredura (idempotente); o
 *    cancelamento que descobre a cobrança PAGA aplica; a saúde acusa o webhook desligado no Asaas;
 *  · P1-1 o webhook que gravou responde 200 mesmo com a linha do pedido travada, e desiste em ~7 s;
 *  · P1-2/P1-3 a chave trocada zera o cliente da conta velha, o cliente recusado é recriado, e a
 *    chave é conferida no Asaas antes de gravar;
 *  · P1-4 o Pix do plano B sem QR pergunta de novo (com freio);
 *  · P2 prazo e 429, só estorno DONE conta, débito, vencimento no fuso do parque, cobrança
 *    restaurada e "recebido em dinheiro" desfeito.
 *
 * Fixture própria (organização, evento, lote), apagada no fim.
 */
import { randomUUID } from 'node:crypto'
import {
  createError, getHeader, getQuery, getRequestHeader, getRouterParam, readBody,
  setResponseHeader, setResponseStatus,
} from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

process.env.DT_ESTORNO_WORKER = 'off'
process.env.DT_WEBHOOK_WORKER = 'off'
;(globalThis as any).defineEventHandler ??= (h: any) => h
;(globalThis as any).createError ??= createError
;(globalThis as any).readBody ??= readBody
;(globalThis as any).getQuery ??= getQuery
;(globalThis as any).getHeader ??= getHeader
;(globalThis as any).getRouterParam ??= getRouterParam
;(globalThis as any).getRequestHeader ??= getRequestHeader
;(globalThis as any).setResponseHeader ??= setResponseHeader
;(globalThis as any).setResponseStatus ??= setResponseStatus

const TOKEN_WH = 'zz-token-do-webhook-do-asaas-0001'
const ENV_ANTES = {
  ASAAS_WEBHOOK_TOKEN: process.env.ASAAS_WEBHOOK_TOKEN, PAGAMENTO_SIMULADO: process.env.PAGAMENTO_SIMULADO,
  ASAAS_PRAZO_MS: process.env.ASAAS_PRAZO_MS, ASAAS_CALLBACK_LIGADO: process.env.ASAAS_CALLBACK_LIGADO,
  EQUIPE_DA_PLATAFORMA: process.env.EQUIPE_DA_PLATAFORMA, TZ: process.env.TZ,
}
process.env.ASAAS_WEBHOOK_TOKEN = TOKEN_WH

const { db, q, q1 } = await import('./db')
const A = await import('./asaas')
const { processarUmEstorno, SQL_ENFILEIRA_ESTORNO_DE_UM_PEDIDO } = await import('./cancelamento')
const { default: checkout } = await import('../api/checkout.post')
const { default: webhook } = await import('../api/webhooks/asaas.post')
const { default: salvarOrganizacao } = await import('../api/admin/organizacao.patch')
const { default: lerPedido } = await import('../api/pedido/[id].get')
const { medir } = await import('../api/saude.get')

/* ================================================================ o dublê do Asaas */

const CHAVE = '$aact_hmlg_zz_duble_do_asaas_0000000000000000000001'

type Chamada = { metodo: string; caminho: string; busca: string; corpo: any }
let chamadas: Chamada[] = []
/** 'fora' = 503; '429' = limite estourado; 'lento' = responde depois de 1,5 s (ou nunca, se abortado) */
let modo: 'normal' | 'fora' | '429' | 'lento' = 'normal'
let qrPronto = true
let seq = 0
const clientes = new Map<string, any>()
const cobrancas = new Map<string, any>()
const parcelamentos = new Map<string, string[]>()
const idsCriados: string[] = []

const reais = (c: number) => Number((c / 100).toFixed(2))
const novoId = (pre: string) => { const id = `${pre}_zzar_${++seq}_${Date.now() % 100000}`; idsCriados.push(id); return id }

/** Cria no dublê a cobrança (ou o parcelamento) de um pedido — o que o POST /payments faria. */
function criarNoDuble(o: { totalCents: number; parcelas?: number; billingType?: string; ref?: string | null;
  status?: string; customer?: string }) {
  const n = o.parcelas ?? 1
  const base = { object: 'payment', customer: o.customer ?? 'cus_zzar_fixo', billingType: o.billingType ?? 'CREDIT_CARD',
    status: o.status ?? 'PENDING', externalReference: o.ref ?? null, refunds: null as any, deleted: false }
  if (n <= 1) {
    const id = novoId('pay')
    cobrancas.set(id, { ...base, id, value: reais(o.totalCents), invoiceUrl: `https://sandbox.asaas.com/i/${id}`, installment: null })
    return { id, installment: null as string | null, parcelas: [id] }
  }
  const ins = novoId('ins')
  const cada = Math.floor(o.totalCents / n)
  const ids: string[] = []
  for (let i = 1; i <= n; i++) {
    const id = novoId('pay')
    const cents = i < n ? cada : o.totalCents - cada * (n - 1)
    cobrancas.set(id, { ...base, id, value: reais(cents), installment: ins, installmentNumber: i, installmentCount: n,
      invoiceUrl: `https://sandbox.asaas.com/i/${id}` })
    ids.push(id)
  }
  parcelamentos.set(ins, ids)
  return { id: ids[0], installment: ins, parcelas: ids }
}

function estornarNoDuble(id: string, valor: number | null, status = 'DONE') {
  const p = cobrancas.get(id)!
  const v = valor ?? p.value
  p.refunds = [...(p.refunds ?? []), { id: `rf_${id}_${(p.refunds?.length ?? 0) + 1}`, status, value: v }]
  if (status === 'DONE') p.status = v >= p.value ? 'REFUNDED' : p.status
}

function responder(c: Chamada, chave: string): { status: number; json: any; cabecalhos?: Record<string, string> } {
  if (modo === 'fora') return { status: 503, json: null }
  if (modo === '429') return { status: 429, json: null, cabecalhos: { 'RateLimit-Reset': '60' } }
  if (chave !== CHAVE) {
    return { status: 401, json: { errors: [{ code: 'invalid_access_token', description: 'A chave de API fornecida é inválida' }] } }
  }
  const busca = new URLSearchParams(c.busca)
  const m = c.caminho.match(/^\/(payments|installments|customers|webhooks)(?:\/([^/]+))?(?:\/(\w+))?$/)
  if (!m) return { status: 404, json: { errors: [{ code: 'not_found' }] } }
  const [, recurso, id, acao] = m
  if (recurso === 'webhooks') return { status: 200, json: { data: [] } }
  if (recurso === 'customers') {
    if (c.metodo === 'POST') {
      const novo = novoId('cus')
      clientes.set(novo, { id: novo, cpfCnpj: c.corpo.cpfCnpj })
      return { status: 200, json: { id: novo } }
    }
    const doc = busca.get('cpfCnpj')
    return { status: 200, json: { data: doc ? [...clientes.values()].filter((x) => x.cpfCnpj === doc) : [] } }
  }
  if (recurso === 'payments' && !id && c.metodo === 'POST') {
    if (!clientes.has(c.corpo.customer)) {
      return { status: 400, json: { errors: [{ code: 'invalid_customer', description: 'Cliente inválido ou não informado.' }] } }
    }
    const totalCents = Math.round((c.corpo.totalValue ?? c.corpo.value) * 100)
    const r = criarNoDuble({ totalCents, parcelas: c.corpo.installmentCount, billingType: c.corpo.billingType,
      ref: c.corpo.externalReference, customer: c.corpo.customer })
    return { status: 200, json: cobrancas.get(r.id) }
  }
  if (recurso === 'payments' && !id && c.metodo === 'GET') {
    const ins = busca.get('installment')
    return { status: 200, json: { data: (parcelamentos.get(ins ?? '') ?? []).map((x) => cobrancas.get(x)) } }
  }
  if (recurso === 'installments') {
    const ids = parcelamentos.get(id!)
    if (!ids) return { status: 404, json: { errors: [{ code: 'not_found' }] } }
    if (c.metodo === 'DELETE') { for (const x of ids) cobrancas.get(x).deleted = true; return { status: 200, json: { deleted: true, id } } }
    if (c.metodo === 'POST' && acao === 'refund') {
      for (const x of ids) estornarNoDuble(x, null)
      return { status: 200, json: { id, object: 'installment' } }
    }
  }
  const p = cobrancas.get(id ?? '')
  if (!p) return { status: 404, json: { errors: [{ code: 'not_found', description: 'Cobrança não encontrada.' }] } }
  if (c.metodo === 'GET' && acao === 'pixQrCode') {
    return qrPronto
      ? { status: 200, json: { encodedImage: 'iVBORzzqr', payload: `00020126zz-${id}`, expirationDate: '2026-10-06' } }
      : { status: 404, json: { errors: [{ code: 'not_found' }] } }
  }
  if (c.metodo === 'GET' && !acao) return { status: 200, json: p }
  if (c.metodo === 'POST' && acao === 'refund') {
    estornarNoDuble(id!, c.corpo?.value ?? null)
    return { status: 200, json: { ...p } }
  }
  if (c.metodo === 'DELETE') {
    if (['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'].includes(p.status)) {
      return { status: 400, json: { errors: [{ code: 'invalid_action',
        description: 'Só é possível remover cobranças aguardando pagamento ou vencidas.' }] } }
    }
    p.deleted = true
    return { status: 200, json: { deleted: true, id } }
  }
  return { status: 405, json: null }
}

const chamou = (metodo: string, caminho: string) => chamadas.filter((c) => c.metodo === metodo && c.caminho === caminho)

/* ===================================================================== fixture */

let orgId: string, eventId: string, lotId: string, slug: string
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

/** Um pedido do Asaas direto no banco, com a cobrança (ou o parcelamento) já no dublê. */
async function pedidoAsaas(o: {
  status?: string; forma?: 'pix' | 'credito'; parcelas?: number; minutosAtras?: number
  statusNoGateway?: string; gravarParcelamento?: boolean; totalCents?: number; invoice?: boolean
}) {
  const status = o.status ?? 'aguardando_pagamento'
  const total = o.totalCents ?? 6000
  const parcelas = o.parcelas ?? 1
  const id = randomUUID()
  const cob = criarNoDuble({ totalCents: total, parcelas, ref: id, status: o.statusNoGateway,
    billingType: o.forma === 'pix' ? 'PIX' : 'CREDIT_CARD' })
  await q(
    `INSERT INTO orders (id, org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                         discount_cents, total_cents, payment_method, installments, asaas_payment_id,
                         asaas_installment_id, invoice_url, created_at, expires_at, canceled_at, paid_at)
     VALUES ($1, $2, $3, 'PED-ZZAR-' || upper(substr(md5(random()::text), 1, 6)), $4, 'online',
             $5, 0, 0, 0, $5, $6, $7, $8, $9, $10, now() - make_interval(mins => $11),
             CASE WHEN $4 = 'aguardando_pagamento' THEN now() + interval '20 minutes' ELSE now() - interval '1 minute' END,
             CASE WHEN $4 = 'expirado' THEN now() END,
             CASE WHEN $4 IN ('pago', 'estornado_parcial') THEN now() - interval '1 hour' END)`,
    [id, orgId, eventId, status, total, o.forma ?? 'credito', parcelas, cob.id,
     o.gravarParcelamento === false ? null : cob.installment,
     o.invoice ? `https://sandbox.asaas.com/i/${cob.id}` : null, o.minutosAtras ?? 1])
  await q(`INSERT INTO order_items (order_id, lot_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents)
           VALUES ($1, $2, 1, $3, 0, $3)`, [id, lotId, total])
  if (status === 'aguardando_pagamento') await q(`UPDATE lots SET reserved = reserved + 1 WHERE id = $1`, [lotId])
  if (status === 'pago') await q(`UPDATE lots SET sold = sold + 1 WHERE id = $1`, [lotId])
  return { id, pay: cob.id, installment: cob.installment, parcelas: cob.parcelas }
}

const pedido = async (id: string) => (await q1<any>(
  `SELECT status, refunded_cents, total_cents, payment_method, asaas_payment_id, asaas_installment_id,
          pix_payload, asaas_checked_at FROM orders WHERE id = $1`, [id]))!
const ingressos = async (id: string, situacao = 'valido') =>
  Number((await q1<any>(`SELECT count(*)::int AS n FROM tickets WHERE order_id = $1 AND status = $2`, [id, situacao]))!.n)
const trilha = async (id: string, acao: string) =>
  q<any>(`SELECT after FROM audit_log WHERE entity = 'order' AND entity_id = $1 AND action = $2`, [id, acao])

/* ======================================================= portas (handlers diretos) */

function requisicao(rota: string, corpo: any, cabecalhos: Record<string, string> = {}, contexto: any = {}) {
  return {
    method: 'POST', path: rota, context: contexto,
    node: {
      req: { method: 'POST', url: rota, headers: { 'content-type': 'application/json', ...cabecalhos },
             body: JSON.stringify(corpo), socket: { remoteAddress: `10.44.${contador % 250}.${1 + (contador++ % 200)}` } },
      res: { setHeader() {}, getHeader() {} },
    },
  } as any
}

async function comprar(o: { forma?: 'pix' | 'credito'; parcelas?: number; email?: string; documento?: string } = {}) {
  const email = o.email ?? `zzar.${Date.now()}.${++contador}@teste.invalido`
  const documento = o.documento ?? cpf()
  try {
    const corpo = await (checkout as any)(requisicao('/api/checkout', {
      eventSlug: slug, itens: [{ lotId, quantidade: 2 }],
      comprador: { nome: 'Ana Maria de Teste', email, documento }, forma: o.forma ?? 'credito',
      parcelas: o.parcelas ?? 1,
    }))
    return { status: 200, corpo, documento, email }
  } catch (e: any) {
    if (!e?.statusCode) throw e
    return { status: e.statusCode as number, recado: e.statusMessage as string, documento, email }
  }
}

/** Uma entrega do webhook do Asaas, pela rota de verdade. */
async function entregar(evento: string, pagamento: any) {
  const corpo = { id: `evt_zzar_${++seq}_${Date.now()}`, event: evento, dateCreated: '2026-10-05 10:00:00', payment: pagamento }
  try {
    return { status: 200, corpo: await (webhook as any)(requisicao('/api/webhooks/asaas', corpo,
      { 'asaas-access-token': TOKEN_WH })), chave: corpo.id }
  } catch (e: any) {
    if (!e?.statusCode) throw e
    return { status: e.statusCode as number, recado: e.statusMessage as string, chave: corpo.id }
  }
}
const linhaDoEvento = async (chave: string) => (await q1<any>(
  `SELECT processed_at, attempts, error FROM payment_events WHERE provider = 'asaas' AND gateway_event_id = $1`, [chave]))!

/* ========================================================================= ciclo */

beforeAll(async () => {
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    const u = new URL(url)
    if (u.host !== 'api-sandbox.asaas.com' && u.host !== 'api.asaas.com') throw new Error(`o teste não fala com ${u.host}`)
    const c: Chamada = { metodo: init?.method ?? 'GET', caminho: u.pathname.replace(/^\/v3/, ''), busca: u.search,
      corpo: init?.body ? JSON.parse(init.body) : null }
    chamadas.push(c)
    const r = responder(c, String(init?.headers?.access_token ?? ''))
    const resposta = () => new Response(r.json == null ? '' : JSON.stringify(r.json),
      { status: r.status, headers: r.cabecalhos })
    if (modo !== 'lento') return resposta()
    // o Asaas pendurado: responde em 1,5 s — ou nunca, se quem chamou desistir antes
    return new Promise((ok, falha) => {
      const t = setTimeout(() => ok(resposta()), 1500)
      init?.signal?.addEventListener?.('abort', () => { clearTimeout(t); falha(init.signal.reason ?? new Error('aborted')) })
    })
  })
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug, asaas_api_key, asaas_env)
    VALUES ('ZZ Asaas Redondo', 'zz-asaas-redondo-' || gen_random_uuid(), $1, 'sandbox') RETURNING id`, [CHAVE]))!.id
  slug = `zz-asaas-redondo-${Date.now()}`
  eventId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online)
     VALUES ($1, 'ZZ Asaas Redondo', $2, 'ativo', now() + interval '10 days', now() + interval '11 days',
             1000, 'repassar') RETURNING id`, [orgId, slug]))!.id
  const setor = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1, 'Pista') RETURNING id`, [eventId]))!.id
  lotId = (await q1<any>(`INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
    VALUES ($1, 'Lote', 5000, 500, 10, '{online}') RETURNING id`, [setor]))!.id
  // o cliente "fixo" que os pedidos semeados usam existe NESTA conta do dublê
  clientes.set('cus_zzar_fixo', { id: 'cus_zzar_fixo', cpfCnpj: '00000000000' })
})

afterEach(() => {
  chamadas = []; modo = 'normal'; qrPronto = true
  A.usarConsultaDeWebhooks(null)
  for (const k of ['PAGAMENTO_SIMULADO', 'ASAAS_PRAZO_MS', 'ASAAS_CALLBACK_LIGADO', 'TZ'] as const) {
    if (ENV_ANTES[k] === undefined) delete process.env[k]
    else process.env[k] = ENV_ANTES[k]
  }
})

afterAll(async () => {
  vi.unstubAllGlobals()
  for (const [k, v] of Object.entries(ENV_ANTES)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await q(`DELETE FROM payment_events WHERE external_id = ANY($1::text[])
                                        OR gateway_event_id LIKE 'evt_zzar_%' OR gateway_event_id LIKE 'poll:pay_zzar_%'`,
    [idsCriados])
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

/* ======================================================= P0-1 · o parcelamento */

describe('P0-1 · parcelado no cartão: o pedido é o PARCELAMENTO, não a 1ª parcela', () => {
  it('o checkout grava o id do parcelamento que o Asaas devolve', async () => {
    const r = await comprar({ forma: 'credito', parcelas: 3 })
    expect(r.status, r.recado).toBe(200)
    const criar = chamou('POST', '/payments')[0]
    expect(criar.corpo).toMatchObject({ billingType: 'CREDIT_CARD', installmentCount: 3, totalValue: 110 })
    const o = await pedido(r.corpo.pedidoId)
    const primeira = cobrancas.get(o.asaas_payment_id)
    expect(primeira.installmentNumber).toBe(1)
    expect(o.asaas_installment_id, 'o checkout jogou fora o `installment` da resposta').toBe(primeira.installment)
  })

  it('o estorno da fila devolve o parcelamento INTEIRO (sem value), não só a 1ª parcela', async () => {
    const p = await pedidoAsaas({ status: 'pago', parcelas: 3, totalCents: 6000, statusNoGateway: 'CONFIRMED' })
    const [job] = await q<any>(SQL_ENFILEIRA_ESTORNO_DE_UM_PEDIDO, [p.id, 'arrependimento', null, null])
    const r = await processarUmEstorno('teste-zzar', job.id)
    expect(r, r?.erro).toMatchObject({ ok: true, status: 'estornado' })
    expect(chamou('POST', `/payments/${p.parcelas[0]}/refund`).length,
      'estornou a 1ª parcela em vez do parcelamento').toBe(0)
    const devolver = chamou('POST', `/installments/${p.installment}/refund`)
    expect(devolver).toHaveLength(1)
    expect(devolver[0].corpo, 'estorno total do parcelamento vai SEM value').toEqual({})
    expect(await pedido(p.id)).toMatchObject({ status: 'estornado', refunded_cents: 6000 })
  })

  it('pedido antigo, sem o id gravado: pergunta à cobrança, estorna o parcelamento e grava o id', async () => {
    const p = await pedidoAsaas({ status: 'pago', parcelas: 3, totalCents: 6000, gravarParcelamento: false,
      statusNoGateway: 'CONFIRMED' })
    const [job] = await q<any>(SQL_ENFILEIRA_ESTORNO_DE_UM_PEDIDO, [p.id, 'arrependimento', null, null])
    const r = await processarUmEstorno('teste-zzar', job.id)
    expect(r, r?.erro).toMatchObject({ ok: true, status: 'estornado' })
    expect(chamou('GET', `/payments/${p.parcelas[0]}`), 'não perguntou o parcelamento à cobrança').toHaveLength(1)
    expect(chamou('POST', `/installments/${p.installment}/refund`)).toHaveLength(1)
    expect(chamou('POST', `/payments/${p.parcelas[0]}/refund`)).toHaveLength(0)
    expect((await pedido(p.id)).asaas_installment_id).toBe(p.installment)
  })

  it('o que FALTA devolver, menor que o total, vai como estorno parcial do parcelamento (com value)', async () => {
    const p = await pedidoAsaas({ status: 'pago', parcelas: 3, totalCents: 6000, statusNoGateway: 'CONFIRMED' })
    await q(`UPDATE orders SET status = 'estornado_parcial', refunded_cents = 1000 WHERE id = $1`, [p.id])
    const [job] = await q<any>(SQL_ENFILEIRA_ESTORNO_DE_UM_PEDIDO, [p.id, 'arrependimento', null, null])
    await processarUmEstorno('teste-zzar', job.id)
    expect(chamou('POST', `/installments/${p.installment}/refund`)[0]?.corpo).toEqual({ value: 50 })
  })

  it('a retentativa confere TODAS as parcelas: o parcelamento já estornado não sai de novo', async () => {
    const p = await pedidoAsaas({ status: 'pago', parcelas: 3, totalCents: 6000, statusNoGateway: 'CONFIRMED' })
    for (const x of p.parcelas) estornarNoDuble(x, null) // saiu numa tentativa que não deixou recibo
    const [job] = await q<any>(SQL_ENFILEIRA_ESTORNO_DE_UM_PEDIDO, [p.id, 'arrependimento', null, null])
    await q(`UPDATE refund_jobs SET attempts = 1 WHERE id = $1`, [job.id]) // a reserva faz 2: é retentativa
    const r = await processarUmEstorno('teste-zzar', job.id)
    expect(r, r?.erro).toMatchObject({ ok: true, status: 'estornado', adotado: true })
    expect(chamadas.filter((c) => c.metodo === 'POST'), 'mandou o dinheiro de novo').toEqual([])
    expect(chamou('GET', '/payments')[0]?.busca).toContain(`installment=${p.installment}`)
  })

  it('estorno PENDING no banco: não é devolvido, mas também não se pede de novo', async () => {
    const p = await pedidoAsaas({ status: 'pago', parcelas: 3, totalCents: 6000, statusNoGateway: 'CONFIRMED' })
    for (const x of p.parcelas) estornarNoDuble(x, null, 'PENDING')
    const [job] = await q<any>(SQL_ENFILEIRA_ESTORNO_DE_UM_PEDIDO, [p.id, 'arrependimento', null, null])
    await q(`UPDATE refund_jobs SET attempts = 1 WHERE id = $1`, [job.id])
    const r = await processarUmEstorno('teste-zzar', job.id)
    expect(r?.ok).toBe(false)
    expect(r?.erro).toMatch(/ainda está processando/)
    expect(chamadas.filter((c) => c.metodo === 'POST'), 'pediu de novo um estorno que está a caminho').toEqual([])
    expect((await pedido(p.id)).status, 'deu por devolvido um estorno PENDING').toBe('pago')
  })

  it('a cobrança do pedido EXPIRADO apaga o parcelamento inteiro (DELETE /installments)', async () => {
    const p = await pedidoAsaas({ status: 'expirado', parcelas: 3, totalCents: 6000 })
    const r = await A.cancelarCobrancasDeExpirados()
    expect(r.find((x) => x.pedidoId === p.id)).toMatchObject({ ok: true })
    expect(chamou('DELETE', `/installments/${p.installment}`)).toHaveLength(1)
    expect(chamou('DELETE', `/payments/${p.parcelas[0]}`), 'apagou só a 1ª parcela').toHaveLength(0)
    expect(p.parcelas.every((x) => cobrancas.get(x).deleted)).toBe(true)
  })
})

describe('P0-1 · webhook: o estorno do parcelamento chega PARCELA POR PARCELA', () => {
  it('soma as parcelas: 1/3 é estorno parcial, as três são o estorno total', async () => {
    const p = await pedidoAsaas({ parcelas: 3, totalCents: 6000 })
    const parcela = (i: number) => cobrancas.get(p.parcelas[i])
    // a compra no cartão: a parcela 1 confirmada emite (o banco autorizou a compra inteira)
    Object.assign(parcela(0), { status: 'CONFIRMED' })
    expect((await entregar('PAYMENT_CONFIRMED', parcela(0))).status).toBe(200)
    expect((await pedido(p.id)).status).toBe('pago')
    expect(await ingressos(p.id)).toBe(1)

    estornarNoDuble(p.parcelas[0], null)
    await entregar('PAYMENT_REFUNDED', parcela(0))
    expect(await pedido(p.id), 'a 1ª parcela desfez o pedido inteiro').toMatchObject({
      status: 'estornado_parcial', refunded_cents: 2000 })
    expect(await ingressos(p.id), 'cancelou o ingresso com 2/3 do dinheiro ainda na conta').toBe(1)

    // a parcela 2 chega SEM externalReference: quem liga ela ao pedido é o parcelamento
    estornarNoDuble(p.parcelas[1], null)
    const sem = await entregar('PAYMENT_REFUNDED', { ...parcela(1), externalReference: null })
    expect(sem.corpo).not.toMatchObject({ aviso: 'pedido não encontrado' })
    expect(await pedido(p.id)).toMatchObject({ status: 'estornado_parcial', refunded_cents: 4000 })

    // reentrega da parcela 1: não infla
    await entregar('PAYMENT_REFUNDED', parcela(0))
    expect((await pedido(p.id)).refunded_cents).toBe(4000)

    estornarNoDuble(p.parcelas[2], null)
    await entregar('PAYMENT_REFUNDED', parcela(2))
    expect(await pedido(p.id)).toMatchObject({ status: 'estornado', refunded_cents: 6000 })
    expect(await ingressos(p.id)).toBe(0)
  })
})

/* ======================================================= P0-2 · a rede de baixo */

describe('P0-2 · o cartão pago sem aviso vira ingresso pela varredura', () => {
  it('pergunta ao Asaas, aplica pelo caminho do webhook, e não emite duas vezes', async () => {
    process.env.PAGAMENTO_SIMULADO = '0'
    const pago = await pedidoAsaas({ minutosAtras: 10, statusNoGateway: 'CONFIRMED' })
    const novo = await pedidoAsaas({ minutosAtras: 1, statusNoGateway: 'CONFIRMED' })
    const r = await A.varrerCobrancasDoAsaas({ limite: 500 })
    expect(r.find((d) => d.pedidoId === pago.id)).toMatchObject({ ok: true, aplicado: true, statusNoGateway: 'CONFIRMED' })
    expect((await pedido(pago.id)).status).toBe('pago')
    expect(await ingressos(pago.id)).toBe(1)
    expect(chamou('GET', `/payments/${novo.pay}`), 'perguntou pelo pedido de 1 minuto (o aviso ainda pode chegar)')
      .toHaveLength(0)
    const linha = await linhaDoEvento(`poll:${pago.pay}:CONFIRMED`)
    expect(linha.processed_at).not.toBeNull()

    // a mesma notícia de novo (outra rodada, outra instância): nada muda
    const de_novo = await A.aplicarCobrancaConsultada({ pedidoId: pago.id, cobranca: cobrancas.get(pago.pay) })
    expect(de_novo).toMatchObject({ ok: true, resultado: { repetido: true } })
    expect(await ingressos(pago.id)).toBe(1)
    expect(Number((await q1<any>(`SELECT count(*)::int AS n FROM payment_events WHERE gateway_event_id = $1`,
      [`poll:${pago.pay}:CONFIRMED`]))!.n)).toBe(1)
  })

  it('para na primeira falha passageira (429): não insiste no limite estourado', async () => {
    process.env.PAGAMENTO_SIMULADO = '0'
    await pedidoAsaas({ minutosAtras: 10 })
    await pedidoAsaas({ minutosAtras: 10 })
    modo = '429'
    const r = await A.varrerCobrancasDoAsaas({ limite: 500 })
    expect(chamadas.length, 'seguiu perguntando com o 429 na cara').toBe(1)
    expect(r[r.length - 1]).toMatchObject({ ok: false, passageira: true })
    expect(r[r.length - 1].erro).toMatch(/limite de requisições.*60 s/)
  })

  it('o cancelamento que descobre a cobrança PAGA aplica (refaz a reserva) em vez de só anotar', async () => {
    process.env.PAGAMENTO_SIMULADO = '0'
    const p = await pedidoAsaas({ status: 'expirado', statusNoGateway: 'CONFIRMED' })
    const r = await A.cancelarCobrancasDeExpirados()
    expect(r.find((x) => x.pedidoId === p.id)).toMatchObject({ ok: true })
    expect((await pedido(p.id)).status, 'o comprador pagou e ficou sem ingresso').toBe('pago')
    expect(await ingressos(p.id)).toBe(1)
    expect(await trilha(p.id, 'cobranca_paga_no_vao')).toHaveLength(1)
    // resolvido: a próxima passada não tenta cancelar de novo
    chamadas = []
    await A.cancelarCobrancasDeExpirados()
    expect(chamou('DELETE', `/payments/${p.pay}`)).toHaveLength(0)
  })
})

describe('P0-2 · saúde: o webhook desligado do lado do Asaas é crítico', () => {
  const nossa = (extra: any = {}) => ({ id: 'wh_1', url: 'http://127.0.0.1:3124/api/webhooks/asaas',
    enabled: true, interrupted: false, ...extra })
  const meu = (problemas: any[]) => problemas.filter((p) => p.item === 'webhook do Asaas' && /ZZ Asaas Redondo/.test(p.frase))

  it.each([
    ['fila INTERROMPIDA (15 falhas seguidas)', [nossa({ interrupted: true })], /INTERROMPIDA/],
    ['webhook desativado', [nossa({ enabled: false })], /DESATIVADO/],
    ['sem webhook pra nossa rota', [{ id: 'x', url: 'https://outro.sistema/hook', enabled: true }], /não tem webhook/],
  ])('%s → crítico em /api/saude', async (_nome, lista, frase) => {
    A.usarConsultaDeWebhooks(async (cfg) => (cfg.apiKey === CHAVE ? lista : [nossa()]))
    const { corpo } = await medir()
    const achados = meu(corpo.problemas)
    expect(achados).toHaveLength(1)
    expect(achados[0]).toMatchObject({ critico: true })
    expect(achados[0].frase).toMatch(frase)
  })

  it('ligado e sem interrupção: nada a dizer — e a resposta fica guardada uns minutos (cota)', async () => {
    let perguntas = 0
    A.usarConsultaDeWebhooks(async (cfg) => { if (cfg.apiKey === CHAVE) perguntas++; return [nossa()] })
    expect(meu((await medir()).corpo.problemas)).toEqual([])
    await medir()
    expect(perguntas, 'perguntou ao Asaas a cada medida').toBe(1)
  })
})

/* ======================================================= P1-1 · gravou, 200 */

describe('P1-1 · o webhook que gravou responde 200, e não espera a linha travada pra sempre', () => {
  it('linha do pedido travada por outra transação: desiste em ~7 s, 200, e o reprocessador termina', async () => {
    const p = await pedidoAsaas({ statusNoGateway: 'CONFIRMED' })
    const outra = await db().connect()
    await outra.query('BEGIN')
    // a trava de um UPDATE comum (a fila de estorno gravando, um cancelamento no painel): segura o
    // `FOR UPDATE` do processamento, mas não o INSERT do registro (a chave estrangeira só pede KEY SHARE)
    await outra.query('SELECT id FROM orders WHERE id = $1 FOR NO KEY UPDATE', [p.id])
    // rede de segurança: sem o prazo, a entrega ficaria esperando — solta aos 12 s pra o teste terminar
    const solta = setTimeout(() => { outra.query('ROLLBACK').catch(() => {}) }, 12_000)
    const inicio = Date.now()
    const r = await entregar('PAYMENT_CONFIRMED', cobrancas.get(p.pay))
    const levou = Date.now() - inicio
    clearTimeout(solta)
    await outra.query('ROLLBACK').catch(() => {})
    outra.release()

    expect(r.status, 'falha DEPOIS de gravar respondeu erro — 15 seguidas pausam a fila do Asaas').toBe(200)
    expect(levou, 'a entrega esperou a linha travada além do prazo do Asaas (10 s)').toBeLessThan(9_000)
    const linha = await linhaDoEvento(r.chave)
    expect(linha.processed_at).toBeNull()
    expect(linha.attempts).toBe(1)
    expect(linha.error).toMatch(/statement timeout/)

    const feito = await A.reprocessarEntregasPendentes({ id: (await q1<any>(
      `SELECT id FROM payment_events WHERE gateway_event_id = $1`, [r.chave]))!.id })
    expect(feito[0]).toMatchObject({ ok: true, resolvido: true })
    expect((await pedido(p.id)).status).toBe('pago')
  }, 30_000)

  it('o próprio REGISTRO preso (FOR UPDATE na linha do pedido): 500 em ~5 s, sem linha — a reentrega é a cópia', async () => {
    const p = await pedidoAsaas({ statusNoGateway: 'CONFIRMED' })
    const outra = await db().connect()
    await outra.query('BEGIN')
    await outra.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [p.id])
    const solta = setTimeout(() => { outra.query('ROLLBACK').catch(() => {}) }, 12_000)
    const inicio = Date.now()
    const r = await entregar('PAYMENT_CONFIRMED', cobrancas.get(p.pay)).catch((e) => ({ status: 500, erro: e, chave: '' }))
    const levou = Date.now() - inicio
    clearTimeout(solta)
    await outra.query('ROLLBACK').catch(() => {})
    outra.release()
    expect(levou, 'o INSERT esperou a linha travada além do prazo do Asaas').toBeLessThan(8_000)
    expect(r.status, 'sem linha gravada, só a reentrega guarda o aviso: tem que ser erro').not.toBe(200)
  }, 30_000)
})

/* ======================================================= P1-2 / P1-3 */

describe('P1-2 · cliente da conta velha reaproveitado', () => {
  it('o Asaas recusa o cliente guardado: acha/cria nesta conta UMA vez e cobra', async () => {
    const email = `zzar.velho.${Date.now()}@teste.invalido`
    const documento = cpf()
    await q(`INSERT INTO customers (org_id, name, email, document, asaas_customer_id)
             VALUES ($1, 'Ana Maria de Teste', $2, $3, 'cus_do_sandbox_velho')`, [orgId, email, documento])
    const r = await comprar({ forma: 'credito', email, documento })
    expect(r.status, r.recado).toBe(200)
    expect(chamou('POST', '/payments').map((c) => c.corpo.customer)[0]).toBe('cus_do_sandbox_velho')
    expect(chamou('POST', '/payments')).toHaveLength(2)
    const c = await q1<any>(`SELECT asaas_customer_id FROM customers WHERE org_id = $1 AND email = $2`, [orgId, email])
    expect(c!.asaas_customer_id).not.toBe('cus_do_sandbox_velho')
    expect(clientes.has(c!.asaas_customer_id)).toBe(true)
  })
})

describe('P1-3 · a chave do Asaas é conferida NA FONTE antes de gravar', () => {
  let painelOrg: string, dono: string
  beforeAll(async () => {
    process.env.EQUIPE_DA_PLATAFORMA = 'dono@zzar'
    painelOrg = (await q1<any>(`INSERT INTO organizations (name, slug)
      VALUES ('ZZ Asaas Painel', 'zz-asaas-painel-' || gen_random_uuid()) RETURNING id`))!.id
    dono = (await q1<any>(`INSERT INTO users (org_id, name, email, password_hash, role, papel)
      VALUES ($1, 'Dono ZZ', 'dono.zzar.' || gen_random_uuid() || '@teste.invalido', 'x', 'master', 'master')
      RETURNING id`, [painelOrg]))!.id
    await q(`INSERT INTO customers (org_id, name, email, asaas_customer_id)
             VALUES ($1, 'Cliente Velho', 'velho.zzar@teste.invalido', 'cus_da_conta_velha')`, [painelOrg])
  })
  afterAll(async () => {
    if (ENV_ANTES.EQUIPE_DA_PLATAFORMA === undefined) delete process.env.EQUIPE_DA_PLATAFORMA
    else process.env.EQUIPE_DA_PLATAFORMA = ENV_ANTES.EQUIPE_DA_PLATAFORMA
    await q(`DELETE FROM organizations WHERE id = $1`, [painelOrg])
  })
  const salvar = async (corpo: any) => {
    const ev = requisicao('/api/admin/organizacao', corpo, {},
      { sessao: { orgId: painelOrg, usuarioId: dono, email: 'dono@zzar' }, papel: 'master' })
    ev.method = 'PATCH'; ev.node.req.method = 'PATCH'
    try { return { status: 200, corpo: await (salvarOrganizacao as any)(ev) } } catch (e: any) {
      if (!e?.statusCode) throw e
      return { status: e.statusCode as number, recado: e.statusMessage as string }
    }
  }
  const chaveGravada = async () =>
    (await q1<any>(`SELECT asaas_api_key IS NOT NULL AS tem FROM organizations WHERE id = $1`, [painelOrg]))!.tem

  it('chave que o Asaas recusa (401): 422 com a frase, e NADA gravado', async () => {
    process.env.PAGAMENTO_SIMULADO = '0'
    const r = await salvar({ chaveAsaas: '$aact_hmlg_zz_chave_errada_000000000000000000009', ambienteAsaas: 'sandbox' })
    expect(r.status).toBe(422)
    expect(r.recado).toMatch(/não aceitou esta chave/)
    expect(await chaveGravada()).toBe(false)
  })

  it('Asaas fora na hora de salvar: não grava às cegas', async () => {
    process.env.PAGAMENTO_SIMULADO = '0'
    modo = 'fora'
    const r = await salvar({ chaveAsaas: CHAVE, ambienteAsaas: 'sandbox' })
    expect(r.status).toBe(422)
    expect(r.recado).toMatch(/Nada foi salvo/)
    expect(await chaveGravada()).toBe(false)
  })

  it('chave boa: grava — e o cliente da conta velha é esquecido (o checkout acha/cria na nova)', async () => {
    process.env.PAGAMENTO_SIMULADO = '0'
    const r = await salvar({ chaveAsaas: CHAVE, ambienteAsaas: 'sandbox' })
    expect(r.status, r.recado).toBe(200)
    expect(chamadas.map((c) => `${c.metodo} ${c.caminho}`)).toEqual(['GET /customers'])
    expect(await chaveGravada()).toBe(true)
    const c = await q1<any>(`SELECT asaas_customer_id FROM customers WHERE org_id = $1`, [painelOrg])
    expect(c!.asaas_customer_id, 'o id do cliente da conta velha continuou valendo').toBeNull()
  })
})

/* ======================================================= P1-4 · Pix sem QR */

describe('P1-4 · Pix do plano B que nasceu sem QR', () => {
  const ler = async (id: string) => (lerPedido as any)({
    method: 'GET', path: `/api/pedido/${id}`, context: { params: { id } },
    node: { req: { method: 'GET', url: `/api/pedido/${id}`, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
            res: { setHeader() {}, getHeader() {} } },
  })

  it('a consulta da tela pergunta o QR de novo, grava, e devolve o copia e cola', async () => {
    const p = await pedidoAsaas({ forma: 'pix', invoice: true })
    const r = await ler(p.id)
    expect(r.pagamento.pixPayload, 'a tela ficaria em "QR sendo gerado" pra sempre').toBe(`00020126zz-${p.pay}`)
    expect(r.pagamento.pixQrBase64).toBe('iVBORzzqr')
    expect((await pedido(p.id)).pix_payload).toBe(`00020126zz-${p.pay}`)
  })

  it('com freio: no máximo uma pergunta a cada 15 s por pedido; e a fatura segue de saída', async () => {
    const p = await pedidoAsaas({ forma: 'pix', invoice: true })
    qrPronto = false
    const r = await ler(p.id)
    expect(r.pagamento.pixPayload).toBeNull()
    expect(r.pagamento.linkFatura).toBe(`https://sandbox.asaas.com/i/${p.pay}`)
    await ler(p.id)
    await ler(p.id)
    expect(chamou('GET', `/payments/${p.pay}/pixQrCode`)).toHaveLength(1)
  })
})

/* ============================================================================ P2 */

describe('P2 · bordas do Asaas', () => {
  it('Asaas pendurado: a chamada desiste no prazo (sem ficar presa no socket)', async () => {
    process.env.ASAAS_PRAZO_MS = '200'
    const p = await pedidoAsaas({})
    modo = 'lento'
    const inicio = Date.now()
    const r = await A.buscarCobranca({ apiKey: CHAVE }, p.pay).then(() => 'respondeu', (e) => e)
    expect(Date.now() - inicio, 'esperou o Asaas pendurado').toBeLessThan(1_000)
    expect(r).toBeInstanceOf(Error)
    expect(A.falhaPassageiraDoAsaas(r)).toBe(true)
  })

  it('429: erro passageiro com o RateLimit-Reset na frase', async () => {
    modo = '429'
    const e = await A.buscarCobranca({ apiKey: CHAVE }, 'pay_qualquer').catch((x) => x)
    expect(e).toBeInstanceOf(A.ErroAsaas)
    expect(e.status).toBe(429)
    expect(e.message).toMatch(/limite de requisições.*60 s/)
    expect(A.falhaPassageiraDoAsaas(e)).toBe(true)
    expect(A.falhaPassageiraDoAsaas(new A.ErroAsaas(400, {}, 'recusa'))).toBe(false)
  })

  it('só estorno DONE conta como devolvido', () => {
    expect(A.valorEstornadoCents({ refundedValue: 50, refunds: [{ value: 50, status: 'PENDING' }] }),
      'contou um estorno que ainda pode ser CANCELLED').toBeNull()
    expect(A.valorEstornadoCents({ refunds: [{ value: 20, status: 'DONE' }, { value: 30, status: 'PENDING' },
      { value: 10, status: 'CANCELLED' }] })).toBe(2000)
    // payload sem status por estorno: o acumulado do gateway
    expect(A.valorEstornadoCents({ refundedValue: 12.5 })).toBe(1250)
  })

  it('pago com DÉBITO pela fatura: o pedido passa a dizer débito', async () => {
    const p = await pedidoAsaas({})
    await entregar('PAYMENT_RECEIVED', { ...cobrancas.get(p.pay), status: 'RECEIVED', billingType: 'DEBIT_CARD' })
    expect(await pedido(p.id)).toMatchObject({ status: 'pago', payment_method: 'debito' })
  })

  it('vencimento na data do PARQUE, mesmo com o servidor em UTC', () => {
    process.env.TZ = 'UTC'
    // 23:48 de 20/09 em Itapetinga = 02:48 de 21/09 em UTC
    const noite = new Date('2026-09-21T02:48:00Z')
    expect(A.vencimentoEmDias(1, noite), 'o servidor em UTC deu um dia a mais de prazo').toBe('2026-09-21')
    expect(A.vencimentoEmDias(0, noite)).toBe('2026-09-20')
    expect(A.vencimentoEmDias(1, new Date('2026-12-31T15:00:00Z'))).toBe('2027-01-01')
  })

  it('cobrança RESTAURADA com o pedido já desfeito: pendência visível, sem emitir', async () => {
    const vivo = await pedidoAsaas({})
    const r1 = await entregar('PAYMENT_RESTORED', cobrancas.get(vivo.pay))
    expect((await linhaDoEvento(r1.chave)).processed_at, 'esperando pagamento: nada a fazer, dá baixa').not.toBeNull()

    const morto = await pedidoAsaas({ status: 'expirado' })
    const r2 = await entregar('PAYMENT_RESTORED', cobrancas.get(morto.pay))
    expect(r2.status).toBe(200)
    const linha = await linhaDoEvento(r2.chave)
    expect(linha.processed_at, 'a cobrança voltou a ser pagável e ninguém ficou sabendo').toBeNull()
    expect(linha.error).toMatch(/RESTAURADA/)
    expect(await trilha(morto.id, 'cobranca_restaurada')).toHaveLength(1)
    expect((await pedido(morto.id)).status).toBe('expirado')
    expect(await ingressos(morto.id)).toBe(0)
  })

  it('"recebido em dinheiro" DESFEITO no painel: o pedido é desfeito (expirado) e o ingresso cai', async () => {
    const p = await pedidoAsaas({})
    await entregar('PAYMENT_RECEIVED_IN_CASH', { ...cobrancas.get(p.pay), status: 'RECEIVED_IN_CASH' })
    expect((await pedido(p.id)).status).toBe('pago')
    expect(await ingressos(p.id)).toBe(1)
    const vendidos = Number((await q1<any>(`SELECT sold FROM lots WHERE id = $1`, [lotId]))!.sold)

    await entregar('PAYMENT_RECEIVED_IN_CASH_UNDONE', { ...cobrancas.get(p.pay), status: 'PENDING' })
    expect((await pedido(p.id)).status, 'o ingresso seguiu valendo sem o dinheiro').toBe('expirado')
    expect(await ingressos(p.id)).toBe(0)
    expect(Number((await q1<any>(`SELECT sold FROM lots WHERE id = $1`, [lotId]))!.sold)).toBe(vendidos - 1)
    expect(await trilha(p.id, 'recebimento_em_dinheiro_desfeito')).toHaveLength(1)
  })

  it('callback da fatura: desligado por padrão; com ASAAS_CALLBACK_LIGADO=1 vai a volta pro ingresso', async () => {
    const r = await comprar({ forma: 'credito' })
    expect(r.status, r.recado).toBe(200)
    expect(chamou('POST', '/payments')[0].corpo.callback).toBeUndefined()
    chamadas = []
    process.env.ASAAS_CALLBACK_LIGADO = '1'
    const r2 = await comprar({ forma: 'credito' })
    expect(r2.status, r2.recado).toBe(200)
    expect(chamou('POST', '/payments')[0].corpo.callback).toEqual({
      successUrl: expect.stringMatching(new RegExp(`/ingressos/${r2.corpo.pedido}$`)), autoRedirect: true })
  })
})
