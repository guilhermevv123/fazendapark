/**
 * O checkout diante do gateway — a ROTA rodando no processo do teste, com o
 * `fetch` do Asaas trocado por um dublê. Nenhuma chamada sai da máquina.
 *
 * Por que no processo e não pela HTTP: o servidor de dev roda com o gateway
 * simulado ligado, e o que se prova aqui é justamente o caminho SEM simulado —
 * sem chave, com chave de teste em produção, e com o Asaas respondendo.
 *
 *  · PROD-06: sem jeito de cobrar online, a recusa sai ANTES de reservar
 *    estoque e de gravar cadastro (era no último clique, depois dos dois).
 *    Pedido com cupom que zera segue sem gateway.
 *  · B12: recusa do Asaas a um DADO do comprador → 422 com o campo e a frase
 *    (era 502 "Tente de novo", que dava o mesmo a cada tentativa), e o
 *    estoque volta na hora.
 *  · B12: celular em `mobilePhone`, fixo em `phone`.
 *  · B08: o link da fatura fica gravado no pedido.
 */
import { randomUUID } from 'node:crypto'
import { createError, readBody } from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { db, q, q1 } from '../utils/db'

;(globalThis as any).defineEventHandler ??= (h: any) => h
;(globalThis as any).createError ??= createError
;(globalThis as any).readBody ??= readBody
const { default: checkout } = await import('./checkout.post')

const CHAVE_TESTE = '$aact_hmlg_000ZZdublêDoTesteDoCheckout'
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
const novoEmail = () => `checkout.gateway.${Date.now()}.${++contador}@teste.invalido`

/** Uma requisição de verdade pro h3, vinda da própria máquina (fora do freio por IP). */
function requisicao(corpo: any) {
  return {
    method: 'POST', path: '/api/checkout', context: {},
    node: {
      req: { method: 'POST', url: '/api/checkout', headers: { 'content-type': 'application/json' },
             body: JSON.stringify(corpo), socket: { remoteAddress: '127.0.0.1' } },
      res: { setHeader() {}, getHeader() {} },
    },
  } as any
}

async function comprar(extra: { email?: string; telefone?: string; cupom?: string; forma?: string } = {}) {
  const email = extra.email ?? novoEmail()
  try {
    const corpo = await (checkout as any)(requisicao({
      eventSlug: slug,
      itens: [{ lotId, quantidade: 2 }],
      comprador: { nome: 'Maria de Teste', email, documento: cpf(),
        ...(extra.telefone ? { telefone: extra.telefone } : {}) },
      forma: extra.forma ?? 'pix',
      ...(extra.cupom ? { cupom: extra.cupom } : {}),
    }))
    return { status: 200, corpo, email }
  } catch (e: any) {
    if (!e?.statusCode) throw e
    return { status: e.statusCode as number, recado: e.statusMessage as string, data: e.data, email }
  }
}

// ---- o dublê do Asaas ------------------------------------------------------
type Chamada = { metodo: string; caminho: string; corpo: any }
let chamadas: Chamada[] = []
let responder: (c: Chamada) => { status: number; json: any } = () => ({ status: 500, json: null })

const reservados = async () => Number((await q1<any>(`SELECT reserved FROM lots WHERE id = $1`, [lotId]))!.reserved)
const pedidosDo = (email: string) => q<any>(
  `SELECT o.status, o.invoice_url, o.pix_payload FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE c.org_id = $1 AND c.email = $2`, [orgId, email])
const clienteExiste = async (email: string) =>
  !!(await q1<any>(`SELECT 1 FROM customers WHERE org_id = $1 AND email = $2`, [orgId, email]))

const ENV = { NODE_ENV: process.env.NODE_ENV, PAGAMENTO_SIMULADO: process.env.PAGAMENTO_SIMULADO }

beforeAll(async () => {
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    const u = new URL(url)
    const chamada = { metodo: init?.method ?? 'GET', caminho: u.pathname.replace(/^\/v3/, '') + u.search,
      corpo: init?.body ? JSON.parse(init.body) : null }
    chamadas.push(chamada)
    const r = responder(chamada)
    return new Response(r.json == null ? '' : JSON.stringify(r.json), { status: r.status })
  })
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug, asaas_env)
    VALUES ('ZZ Checkout Gateway', 'zz-checkout-gateway-' || gen_random_uuid(), 'sandbox') RETURNING id`))!.id
  slug = `zz-checkout-gateway-${Date.now()}`
  eventId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online)
     VALUES ($1,'ZZ Checkout Gateway',$2,'ativo', now() + interval '10 days', now() + interval '11 days',
             1000, 'repassar') RETURNING id`, [orgId, slug]))!.id
  const setor = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1,'Pista') RETURNING id`,
    [eventId]))!.id
  lotId = (await q1<any>(`INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
    VALUES ($1,'Lote',5000,200,10,'{online}') RETURNING id`, [setor]))!.id
  await q(`INSERT INTO promo_codes (event_id, code, kind, value, max_uses, max_per_customer)
           VALUES ($1,'ZZTUDO','percentual',10000,100,100), ($1,'ZZMETADE','percentual',5000,100,100)`,
    [eventId])
})

afterEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  chamadas = []
  responder = () => ({ status: 500, json: null })
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await q(`DELETE FROM tickets WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [orgId])
  await q(`DELETE FROM orders WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM customers WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

async function semGateway(chave: string | null, nodeEnv = 'development') {
  process.env.PAGAMENTO_SIMULADO = '0'
  process.env.NODE_ENV = nodeEnv
  await q(`UPDATE organizations SET asaas_api_key = $2 WHERE id = $1`, [orgId, chave])
}

describe('PROD-06 · sem jeito de cobrar, a recusa sai antes do estoque e do cadastro', () => {
  it('sem chave do Asaas: 503 com o motivo, e nada foi reservado nem gravado', async () => {
    await semGateway(null)
    const antes = await reservados()
    const r = await comprar()
    expect(r.status).toBe(503)
    expect(r.data).toEqual({ tipo: 'pagamento_indisponivel', motivo: 'sem_chave' })
    expect(r.recado).toMatch(/bilheteria/)
    expect(await reservados(), 'o estoque foi reservado pra uma venda que não tinha como cobrar').toBe(antes)
    expect(await clienteExiste(r.email), 'o cadastro foi gravado antes da recusa').toBe(false)
    expect(chamadas).toEqual([])
  })

  it('chave de TESTE em produção: 503 chave_de_teste, sem gerar PIX que nenhum banco paga', async () => {
    await semGateway(CHAVE_TESTE, 'production')
    const r = await comprar()
    expect(r.status).toBe(503)
    expect(r.data).toEqual({ tipo: 'pagamento_indisponivel', motivo: 'chave_de_teste' })
    expect(await clienteExiste(r.email)).toBe(false)
    expect(chamadas, 'o checkout falou com o Asaas usando chave de teste em produção').toEqual([])
  })

  it('cupom que zera o pedido não precisa de gateway: a venda segue', async () => {
    await semGateway(null)
    await q(`UPDATE events SET fee_bps = 0 WHERE id = $1`, [eventId])
    try {
      const r = await comprar({ cupom: 'ZZTUDO' })
      expect(r.status, r.recado).toBe(200)
      expect(r.corpo).toMatchObject({ status: 'pago', totalCents: 0 })
    } finally {
      await q(`UPDATE events SET fee_bps = 1000 WHERE id = $1`, [eventId])
    }
  })

  it('cupom que NÃO zera: recusado depois do cupom, com o estoque devolvido', async () => {
    await semGateway(null)
    const antes = await reservados()
    const r = await comprar({ cupom: 'ZZMETADE' })
    expect(r.status).toBe(503)
    expect(r.data).toMatchObject({ tipo: 'pagamento_indisponivel', motivo: 'sem_chave' })
    expect(await reservados()).toBe(antes)
    expect((await pedidosDo(r.email)).map((o) => o.status)).toEqual(['falhou'])
  })
})

describe('B12 · recusa do Asaas a um dado do comprador', () => {
  it('celular recusado: 422 com o campo e a frase do gateway, e o estoque volta', async () => {
    await semGateway(CHAVE_TESTE)
    responder = (c) => c.metodo === 'GET' && c.caminho.startsWith('/customers')
      ? { status: 200, json: { data: [] } }
      : c.metodo === 'POST' && c.caminho === '/customers'
        ? { status: 400, json: { errors: [{ code: 'invalid_mobilePhone', description: 'O celular informado é inválido.' }] } }
        : { status: 500, json: null }
    const antes = await reservados()
    const r = await comprar({ telefone: '(73) 99826-0963' })
    expect(r.status, r.recado).toBe(422)
    expect(r.data).toEqual({ tipo: 'cadastro', campo: 'telefone', origem: 'gateway' })
    expect(r.recado).toBe('O sistema de pagamento recusou o celular (O celular informado é inválido). '
      + 'Corrija e tente de novo.')
    expect(await reservados()).toBe(antes)
    expect((await pedidosDo(r.email)).map((o) => o.status)).toEqual(['falhou'])
  })

  it('erro do gateway que não é do comprador continua 502 "tente de novo"', async () => {
    await semGateway(CHAVE_TESTE)
    responder = () => ({ status: 503, json: null })
    const r = await comprar()
    expect(r.status).toBe(502)
  })
})

describe('B12 + B08 · o caminho que dá certo', () => {
  function asaasQueAceita() {
    responder = (c) => {
      if (c.metodo === 'GET' && c.caminho.startsWith('/customers')) return { status: 200, json: { data: [] } }
      if (c.metodo === 'POST' && c.caminho === '/customers') return { status: 200, json: { id: 'cus_zz' } }
      if (c.metodo === 'POST' && c.caminho === '/payments') {
        return { status: 200, json: { id: `pay_zz_${randomUUID()}`, invoiceUrl: 'https://sandbox.asaas.com/i/zzfatura' } }
      }
      if (c.caminho.endsWith('/pixQrCode')) return { status: 200, json: { payload: '00020126zz', encodedImage: 'iVBORzz' } }
      return { status: 500, json: null }
    }
  }

  it('fixo vai em phone, celular em mobilePhone', async () => {
    await semGateway(CHAVE_TESTE)
    asaasQueAceita()
    await comprar({ telefone: '(73) 3421-0000' })
    const fixo = chamadas.find((c) => c.metodo === 'POST' && c.caminho === '/customers')!.corpo
    expect(fixo.phone).toBe('7334210000')
    expect(fixo.mobilePhone).toBeUndefined()

    chamadas = []
    await comprar({ telefone: '(73) 99826-0963' })
    const cel = chamadas.find((c) => c.metodo === 'POST' && c.caminho === '/customers')!.corpo
    expect(cel.mobilePhone).toBe('73998260963')
    expect(cel.phone).toBeUndefined()
  })

  it('cartão: o link da fatura volta na resposta E fica gravado no pedido', async () => {
    await semGateway(CHAVE_TESTE)
    asaasQueAceita()
    const r = await comprar({ forma: 'credito' })
    expect(r.status, r.recado).toBe(200)
    expect(r.corpo.pagamento.linkFatura).toBe('https://sandbox.asaas.com/i/zzfatura')
    const [o] = await pedidosDo(r.email)
    expect(o.invoice_url, 'quem fecha a aba do cartão perde o único caminho pra pagar').toBe(
      'https://sandbox.asaas.com/i/zzfatura')
  })

  it('PIX: QR e fatura gravados', async () => {
    await semGateway(CHAVE_TESTE)
    asaasQueAceita()
    const r = await comprar()
    expect(r.status, r.recado).toBe(200)
    const [o] = await pedidosDo(r.email)
    expect(o).toMatchObject({ status: 'aguardando_pagamento', pix_payload: '00020126zz',
      invoice_url: 'https://sandbox.asaas.com/i/zzfatura' })
  })
})
