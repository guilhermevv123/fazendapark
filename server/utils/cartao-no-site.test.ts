/**
 * Cartão de crédito digitado NO SITE (dono, 05/10) — o checkout com o Asaas trocado por um dublê
 * (`fetch` do processo). Nenhuma chamada sai da máquina; os números são de TESTE públicos.
 *
 * O que se prova, e o que cada defeito custaria:
 *  · desligado (`CARTAO_NO_SITE`≠1): o cartão do corpo é IGNORADO — a cobrança sai como fatura;
 *  · ligado: `POST /payments` com creditCard + creditCardHolderInfo (CEP, número, telefone, CPF) +
 *    remoteIp; aprovado na hora (CONFIRMED) → o pedido já volta PAGO, com ingresso;
 *  · cartão torto (dígito verificador, vencido): 422 ANTES de reservar lugar e sem falar com o banco;
 *  · recusado pelo banco (400): 422 com o motivo, e o lugar volta;
 *  · sem resposta (prazo estourado): pergunta ao Asaas pela cobrança do pedido antes de desistir —
 *    achou, segue com ela (o cartão PODE ter sido cobrado); não achou, 502 e o lugar volta;
 *  · débito nunca leva cartão pela API (a doc não aceita);
 *  · o número do cartão não fica em lugar nenhum do banco (pedido, eventos, trilha).
 * Fixture própria (organização, evento, lote), apagada no fim.
 */
import { createError, getHeader, getQuery, getRequestHeader, getRouterParam, readBody, setResponseHeader } from 'h3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
;(globalThis as any).setHeader ??= setResponseHeader

const ENV_ANTES = {
  CARTAO_NO_SITE: process.env.CARTAO_NO_SITE, PAGAMENTO_SIMULADO: process.env.PAGAMENTO_SIMULADO,
  ASAAS_PRAZO_CARTAO_MS: process.env.ASAAS_PRAZO_CARTAO_MS,
}
delete process.env.PAGAMENTO_SIMULADO

const { db, q, q1 } = await import('./db')
const { default: checkout } = await import('../api/checkout.post')
const { default: cartaoLigado } = await import('../api/pagamento/cartao.get')

const CHAVE = '$aact_hmlg_zz_duble_cartao_no_site_000000000000000001'
const VISA = '4111111111111111'
const RECUSADO = '5184019740373151' // o "recusa" Mastercard do sandbox do Asaas

type Chamada = { metodo: string; caminho: string; busca: string; corpo: any; bruto: string }
let chamadas: Chamada[] = []
/** 'lento': cria a cobrança mas responde depois do prazo; 'lento-sem-criar': nem cria */
let modo: 'normal' | 'lento' | 'lento-sem-criar' = 'normal'
let seq = 0
const cobrancas = new Map<string, any>()

function responder(c: Chamada): { status: number; json: any } {
  if (c.caminho === '/customers' && c.metodo === 'POST') return { status: 200, json: { id: `cus_zzcs_${++seq}` } }
  if (c.caminho === '/customers') return { status: 200, json: { data: [] } }
  if (c.caminho === '/payments' && c.metodo === 'POST') {
    if (c.corpo?.creditCard?.number === RECUSADO) {
      return { status: 400, json: { errors: [{ code: 'invalid_creditCard', description: 'Transação não autorizada. Verifique os dados do cartão de crédito e tente novamente.' }] } }
    }
    if (modo === 'lento-sem-criar') return { status: 200, json: null }
    const id = `pay_zzcs_${++seq}`
    const p = { id, object: 'payment', status: c.corpo?.creditCard ? 'CONFIRMED' : 'PENDING', billingType: c.corpo.billingType,
      value: c.corpo.value ?? c.corpo.totalValue, externalReference: c.corpo.externalReference, deleted: false,
      invoiceUrl: `https://sandbox.asaas.com/i/${id}`, installment: null, customer: c.corpo.customer }
    cobrancas.set(id, p)
    return { status: 200, json: p }
  }
  if (c.caminho === '/payments' && c.metodo === 'GET') {
    const ref = new URLSearchParams(c.busca).get('externalReference')
    return { status: 200, json: { data: [...cobrancas.values()].filter((x) => x.externalReference === ref) } }
  }
  const m = c.caminho.match(/^\/payments\/([^/]+)$/)
  if (m && cobrancas.has(m[1]!)) return { status: 200, json: cobrancas.get(m[1]!) }
  return { status: 404, json: { errors: [{ code: 'not_found', description: 'não encontrado' }] } }
}

let orgId: string, eventId: string, lotId: string, slug: string
let contador = 0
function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => { const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11; return r === 10 ? 0 : r }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}
function requisicao(rota: string, corpo: any, metodo = 'POST') {
  return {
    method: metodo, path: rota, context: {},
    node: {
      req: { method: metodo, url: rota, headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
             body: corpo ? JSON.stringify(corpo) : undefined, socket: { remoteAddress: `10.55.${contador % 250}.${1 + (contador++ % 200)}` } },
      res: { setHeader() {}, getHeader() {} },
    },
  } as any
}
const cartao = (o: Record<string, any> = {}) => ({
  numero: VISA, titular: 'MARIA DA SILVA', mes: '12', ano: '2030', cvv: '123', cep: '45000-000', numeroEndereco: '123', ...o,
})
async function comprar(o: { forma?: 'credito' | 'debito'; cartao?: any } = {}) {
  try {
    const corpo = await (checkout as any)(requisicao('/api/checkout', {
      eventSlug: slug, itens: [{ lotId, quantidade: 1 }],
      comprador: { nome: 'Maria da Silva', email: `zzcs.${Date.now()}.${++contador}@teste.invalido`, documento: cpf(), telefone: '73998260963' },
      forma: o.forma ?? 'credito', parcelas: 1, cartao: o.cartao,
    }))
    return { status: 200, corpo }
  } catch (e: any) {
    if (!e?.statusCode) throw e
    return { status: e.statusCode as number, recado: e.statusMessage as string, tipo: e.data?.tipo, campo: e.data?.campo }
  }
}
const reservados = async () => Number((await q1<any>(`SELECT reserved FROM lots WHERE id = $1`, [lotId]))!.reserved)
const posts = () => chamadas.filter((c) => c.metodo === 'POST' && c.caminho === '/payments')

beforeAll(async () => {
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    const u = new URL(url)
    if (u.host !== 'api-sandbox.asaas.com' && u.host !== 'api.asaas.com') throw new Error(`o teste não fala com ${u.host}`)
    const c: Chamada = { metodo: init?.method ?? 'GET', caminho: u.pathname.replace(/^\/v3/, ''), busca: u.search,
      corpo: init?.body ? JSON.parse(init.body) : null, bruto: init?.body ?? '' }
    chamadas.push(c)
    const r = responder(c)
    const resposta = () => new Response(r.json == null ? '' : JSON.stringify(r.json), { status: r.status })
    if (modo === 'normal' || c.caminho !== '/payments' || c.metodo !== 'POST' || c.corpo?.creditCard?.number === RECUSADO) {
      return resposta()
    }
    return new Promise((ok, falha) => {
      const t = setTimeout(() => ok(resposta()), 5000)
      init?.signal?.addEventListener?.('abort', () => { clearTimeout(t); falha(init.signal.reason ?? new Error('aborted')) })
    })
  })
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug, asaas_api_key, asaas_env)
    VALUES ('ZZ Cartão no Site', 'zz-cartao-site-' || gen_random_uuid(), $1, 'sandbox') RETURNING id`, [CHAVE]))!.id
  slug = `zz-cartao-site-${Date.now()}`
  eventId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online)
     VALUES ($1, 'ZZ Cartão no Site', $2, 'ativo', now() + interval '10 days', now() + interval '11 days', 0, 'repassar')
     RETURNING id`, [orgId, slug]))!.id
  const setor = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1, 'Parque') RETURNING id`, [eventId]))!.id
  lotId = (await q1<any>(`INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
    VALUES ($1, 'Dia', 3000, 200, 10, '{online}') RETURNING id`, [setor]))!.id
})

// cada caso começa com a lista limpa: uma compra lenta do caso anterior não suja a conta deste
beforeEach(() => { chamadas = [] })
// a compra passa por banco, emissão e e-mail: com a máquina carregada, 5 s não bastam
vi.setConfig({ testTimeout: 20_000 })

afterEach(() => {
  chamadas = []; modo = 'normal'
  for (const k of ['CARTAO_NO_SITE', 'ASAAS_PRAZO_CARTAO_MS'] as const) {
    if (ENV_ANTES[k] === undefined) delete process.env[k]; else process.env[k] = ENV_ANTES[k]
  }
})

afterAll(async () => {
  vi.unstubAllGlobals()
  for (const [k, v] of Object.entries(ENV_ANTES)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  await q(`DELETE FROM payment_events WHERE external_id LIKE 'pay_zzcs_%' OR gateway_event_id LIKE 'poll:pay_zzcs_%'`)
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

describe('cartão no site · desligado', () => {
  it('o cartão do corpo é ignorado: a cobrança sai como fatura, sem dado de cartão', async () => {
    const r = await comprar({ cartao: cartao() })
    expect(r.status, r.recado).toBe(200)
    expect(posts()).toHaveLength(1)
    expect(posts()[0]!.corpo.creditCard).toBeUndefined()
    expect(r.corpo.pagamento.cartaoNoSite).toBe(false)
    expect(r.corpo.status).toBe('aguardando_pagamento')
  })
  it('a tela é avisada que está desligado', async () => {
    expect(await (cartaoLigado as any)({ ...requisicao(`/api/pagamento/cartao?evento=${slug}`, null, 'GET') })).toEqual({ ligado: false })
  })
})

describe('cartão no site · ligado (CARTAO_NO_SITE=1)', () => {
  it('a tela é avisada que está ligado (Asaas pronto na organização)', async () => {
    process.env.CARTAO_NO_SITE = '1'
    const ev = requisicao(`/api/pagamento/cartao?evento=${slug}`, null, 'GET')
    expect(await (cartaoLigado as any)(ev)).toEqual({ ligado: true })
  })

  it('aprovado: manda cartão + titular + IP ao Asaas e o pedido já volta PAGO, com ingresso', async () => {
    process.env.CARTAO_NO_SITE = '1'
    const r = await comprar({ cartao: cartao() })
    expect(r.status, r.recado).toBe(200)
    const corpo = posts()[0]!.corpo
    expect(corpo.billingType).toBe('CREDIT_CARD')
    expect(corpo.creditCard).toEqual({ holderName: 'MARIA DA SILVA', number: VISA, expiryMonth: '12', expiryYear: '2030', ccv: '123' })
    expect(corpo.creditCardHolderInfo).toMatchObject({ name: 'MARIA DA SILVA', postalCode: '45000000', addressNumber: '123', phone: '73998260963' })
    expect(corpo.creditCardHolderInfo.cpfCnpj).toMatch(/^\d{11}$/)
    expect(corpo.remoteIp).toBeTruthy()
    expect(r.corpo.status).toBe('pago')
    expect(r.corpo.pagamento.cartaoNoSite).toBe(true)
    const tickets = await q1<any>(`SELECT count(*)::int AS n FROM tickets t JOIN orders o ON o.id = t.order_id WHERE o.code = $1`, [r.corpo.pedido])
    expect(tickets!.n).toBe(1)
  })

  it('o número do cartão não fica em lugar nenhum do banco', async () => {
    process.env.CARTAO_NO_SITE = '1'
    const r = await comprar({ cartao: cartao({ numero: '5555555555554444', cvv: '987' }) })
    expect(r.status, r.recado).toBe(200)
    const pedido = (await q1<any>(`SELECT id FROM orders WHERE code = $1`, [r.corpo.pedido]))!.id
    const tudo = JSON.stringify([
      await q(`SELECT * FROM orders WHERE id = $1`, [pedido]),
      await q(`SELECT * FROM payment_events WHERE order_id = $1`, [pedido]),
      await q(`SELECT * FROM audit_log WHERE entity_id = $1`, [pedido]),
    ])
    expect(tudo).not.toContain('5555555555554444')
    expect(tudo).not.toContain('"987"')
  })

  it('cartão torto: 422 com o campo, ANTES de reservar lugar e sem falar com o banco', async () => {
    process.env.CARTAO_NO_SITE = '1'
    const antes = await reservados()
    const luhn = await comprar({ cartao: cartao({ numero: '4111111111111112' }) })
    expect(luhn).toMatchObject({ status: 422, tipo: 'cartao', campo: 'numero' })
    expect(luhn.recado).toMatch(/algum dígito está errado/)
    const vencido = await comprar({ cartao: cartao({ mes: '01', ano: '2020' }) })
    expect(vencido).toMatchObject({ status: 422, campo: 'validade' })
    const cep = await comprar({ cartao: cartao({ cep: '450' }) })
    expect(cep).toMatchObject({ status: 422, campo: 'cep' })
    expect(posts()).toHaveLength(0)
    expect(await reservados()).toBe(antes)
  })

  it('recusado pelo banco: 422 com o motivo e o lugar volta', async () => {
    process.env.CARTAO_NO_SITE = '1'
    const antes = await reservados()
    const r = await comprar({ cartao: cartao({ numero: RECUSADO }) })
    expect(r).toMatchObject({ status: 422, tipo: 'cartao_recusado' })
    expect(r.recado).toMatch(/Cartão não aprovado: Transação não autorizada/)
    expect(r.recado).not.toContain(RECUSADO)
    expect(await reservados()).toBe(antes)
  })

  it('sem resposta, mas o Asaas CRIOU: pergunta pela cobrança do pedido e segue com ela (não desfaz)', async () => {
    process.env.CARTAO_NO_SITE = '1'
    process.env.ASAAS_PRAZO_CARTAO_MS = '300'
    modo = 'lento'
    const r = await comprar({ cartao: cartao() })
    expect(r.status, r.recado).toBe(200)
    expect(chamadas.some((c) => c.metodo === 'GET' && c.caminho === '/payments' && c.busca.includes('externalReference'))).toBe(true)
    const o = await q1<any>(`SELECT status, asaas_payment_id FROM orders WHERE code = $1`, [r.corpo.pedido])
    expect(o!.asaas_payment_id).toMatch(/^pay_zzcs_/)
    expect(o!.status).toBe('pago') // a cobrança achada estava CONFIRMED
    expect(posts(), 'reenviou o cartão às cegas').toHaveLength(1)
  })

  it('sem resposta e nada criado: 502 dizendo pra conferir no banco, e o lugar volta', async () => {
    process.env.CARTAO_NO_SITE = '1'
    process.env.ASAAS_PRAZO_CARTAO_MS = '300'
    modo = 'lento-sem-criar'
    const antes = await reservados()
    const r = await comprar({ cartao: cartao() })
    expect(r).toMatchObject({ status: 502, tipo: 'cartao_sem_resposta' })
    expect(r.recado).toMatch(/Confira no app do seu banco/)
    expect(await reservados()).toBe(antes)
    expect(posts()).toHaveLength(1)
  })

  it('débito nunca leva o cartão pela API (a doc do Asaas não aceita): vai pela fatura', async () => {
    process.env.CARTAO_NO_SITE = '1'
    const r = await comprar({ forma: 'debito', cartao: cartao() })
    expect(r.status, r.recado).toBe(200)
    expect(posts()[0]!.corpo.creditCard).toBeUndefined()
    expect(r.corpo.pagamento.cartaoNoSite).toBe(false)
  })
})
