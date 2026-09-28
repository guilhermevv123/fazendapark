/**
 * B08 na máquina · o cartão do gateway simulado tem "fatura", e ela paga.
 *
 * O simulado devolvia `invoiceUrl: null` pro cartão: a tela de pagamento e a
 * página do pedido caíam sempre no "o link do cartão não veio", e o caminho
 * que o B08 conserta (retomar o cartão de outro aparelho) não tinha como ser
 * exercitado — nem na mão, nem no E2E. Agora o link aponta pra
 * `/api/dev/fatura/<código>`, que confirma pela mesma emissão do webhook.
 *
 * Duas partes: no processo, a trava (sem simulado — e em produção — a rota é
 * 404); pela HTTP, o caminho inteiro contra o servidor de dev (que roda com o
 * simulado ligado). Sem servidor, a parte HTTP PULA.
 */
import { randomUUID } from 'node:crypto'
import { createError, getRouterParam, setResponseHeader } from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1 } from '../../utils/db'
import { anunciarPulo, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'

const G = globalThis as any
G.defineEventHandler ??= (h: any) => h
G.createError ??= createError
G.getRouterParam ??= getRouterParam
G.setResponseHeader ??= setResponseHeader
// o corpo vem do evento de mentira (`_corpo`), sem h3 ler stream nenhum
G.readBody ??= async (e: any) => e?._corpo ?? {}
const { default: verFatura } = await import('./fatura/[codigo].get')
const { default: pagarFatura } = await import('./fatura/[codigo].post')
const { default: pagarNaMaquina } = await import('./pagar.post')

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let orgId: string, slug: string, lotId: string
/** um pedido DO SIMULADO, em aberto: sem a trava, a rota abriria a fatura dele */
let codigoSimulado: string

function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

const ENV = { NODE_ENV: process.env.NODE_ENV, PAGAMENTO_SIMULADO: process.env.PAGAMENTO_SIMULADO }
afterEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeAll(async () => {
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug)
    VALUES ('ZZ Fatura Simulada', 'zz-fatura-simulada-' || gen_random_uuid()) RETURNING id`))!.id
  slug = `zz-fatura-simulada-${randomUUID().slice(0, 8)}`
  const eventId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps)
     VALUES ($1,'ZZ Fatura Simulada',$2,'ativo', now() + interval '10 days', now() + interval '11 days', 1000)
     RETURNING id`, [orgId, slug]))!.id
  const setor = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1,'Pista') RETURNING id`, [eventId]))!.id
  lotId = (await q1<any>(`INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
    VALUES ($1,'Lote',5000,50,10,'{online}') RETURNING id`, [setor]))!.id
  codigoSimulado = `PED-ZZFS-${randomUUID().slice(0, 4).toUpperCase()}`
  await q(`INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                               discount_cents, total_cents, payment_method, asaas_payment_id, expires_at)
           VALUES ($1,$2,$3,'aguardando_pagamento','online',5000,500,500,0,5500,'credito',
                   'sim_zzfs_' || gen_random_uuid(), now() + interval '20 minutes')`,
    [orgId, eventId, codigoSimulado])
  sonda = await sondarServidor('/api/eventos-publicos')
  anunciarPulo('server/api/dev/fatura-simulada.test.ts', sonda)
})

afterAll(async () => {
  await q(`DELETE FROM tickets WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [orgId])
  await q(`DELETE FROM orders WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM customers WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

describe('a trava: fatura simulada não existe fora da máquina', () => {
  const evento = (codigo: string) => ({ context: { params: { codigo } },
    node: { req: { headers: {} }, res: { setHeader() {}, getHeader() {} } } }) as any
  const status = async (f: any, codigo: string) => {
    try { await f(evento(codigo)); return 200 } catch (e: any) { return e?.statusCode }
  }
  // trava: o `if (!ligado()) throw 404` no topo das duas rotas — o pedido
  // abaixo é do simulado e está em aberto, então sem a trava a fatura abriria
  it('com o simulado ligado, a fatura de um pedido do simulado abre (o controle do caso)', async () => {
    process.env.PAGAMENTO_SIMULADO = '1'
    process.env.NODE_ENV = 'development'
    expect(await status(verFatura, codigoSimulado)).toBe(200)
  })
  it('sem PAGAMENTO_SIMULADO: 404 no GET e no POST', async () => {
    process.env.PAGAMENTO_SIMULADO = '0'
    expect(await status(verFatura, codigoSimulado)).toBe(404)
    expect(await status(pagarFatura, codigoSimulado)).toBe(404)
  })
  it('em produção, mesmo com a variável ligada: 404', async () => {
    process.env.PAGAMENTO_SIMULADO = '1'
    process.env.NODE_ENV = 'production'
    expect(await status(verFatura, codigoSimulado)).toBe(404)
    expect(await status(pagarFatura, codigoSimulado)).toBe(404)
    // e o pedido segue em aberto: nada foi pago por uma rota que não existe
    expect((await q1<any>(`SELECT status FROM orders WHERE code = $1`, [codigoSimulado]))!.status)
      .toBe('aguardando_pagamento')
  })
})

describe('matriz 133 · POST /api/dev/pagar também não existe fora da máquina', () => {
  const evento = (corpo: any) => ({ _corpo: corpo, context: { params: {} },
    node: { req: { headers: {} }, res: { setHeader() {}, getHeader() {} } } }) as any
  const status = async (corpo: any) => {
    try { await pagarNaMaquina(evento(corpo)); return 200 } catch (e: any) { return e?.statusCode }
  }
  // trava: o `if (!ligado()) throw 404` no topo de pagar.post.ts — sem ele, a chamada de
  // produção abaixo PAGARIA o pedido do simulado (emissão de verdade, ingresso na mão)
  it('com o simulado ligado, a porta existe (o controle: sem pedido é 400, não 404)', async () => {
    process.env.PAGAMENTO_SIMULADO = '1'
    process.env.NODE_ENV = 'development'
    expect(await status({})).toBe(400)
  })
  it('em produção, mesmo com a variável ligada: 404 — e o pedido segue em aberto', async () => {
    process.env.PAGAMENTO_SIMULADO = '1'
    process.env.NODE_ENV = 'production'
    expect(await status({ pedido: codigoSimulado })).toBe(404)
    expect((await q1<any>(`SELECT status FROM orders WHERE code = $1`, [codigoSimulado]))!.status)
      .toBe('aguardando_pagamento')
  })
})

describe('B08 · o cartão do simulado tem fatura, e ela paga pela emissão de verdade', () => {
  it('checkout no cartão → linkFatura guardado → a fatura abre → pagar emite os ingressos', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE}/api/checkout`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({
        eventSlug: slug, itens: [{ lotId, quantidade: 2 }], forma: 'credito', parcelas: 1,
        comprador: { nome: 'Maria de Teste', email: `fatura.${randomUUID().slice(0, 8)}@teste.invalido`, documento: cpf() },
      }),
    })
    expect(r.status, await r.clone().text()).toBe(200)
    const pedido = await r.json()
    expect(pedido.pagamento.linkFatura, 'o cartão do simulado continuava sem fatura')
      .toBe(`/api/dev/fatura/${pedido.pedido}`)

    // a página do pedido (qualquer aparelho) devolve o mesmo link
    const antes = await fetch(`${BASE}/api/pedido/${pedido.pedido}`).then((x) => x.json())
    expect(antes.pagamento?.linkFatura).toBe(pedido.pagamento.linkFatura)

    const pagina = await fetch(BASE + pedido.pagamento.linkFatura)
    expect(pagina.status).toBe(200)
    expect(pagina.headers.get('content-type')).toContain('text/html')
    expect(await pagina.text()).toContain(pedido.pedido)

    const pagou = await fetch(BASE + pedido.pagamento.linkFatura, { method: 'POST', headers: { origin: BASE } })
    expect(pagou.status).toBe(200)
    expect(await pagou.text()).toContain('Pagamento aprovado')
    const depois = await fetch(`${BASE}/api/pedido/${pedido.pedido}`).then((x) => x.json())
    expect(depois.status).toBe('pago')
    expect(depois.ingressos).toHaveLength(2)
  })

  it('PIX não ganha fatura (o link é só do cartão)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE}/api/checkout`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({
        eventSlug: slug, itens: [{ lotId, quantidade: 1 }], forma: 'pix',
        comprador: { nome: 'Maria de Teste', email: `fatura.pix.${randomUUID().slice(0, 8)}@teste.invalido`, documento: cpf() },
      }),
    }).then((x) => x.json())
    expect(r.pagamento.linkFatura).toBeNull()
    expect(r.pagamento.pixPayload).toBeTruthy()
  })
})
