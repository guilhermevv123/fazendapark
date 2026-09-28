/**
 * B03 · B04 · B15 — o freio LIGADO nas portas públicas: a rota de verdade,
 * rodando no processo do teste.
 *
 * `server/utils/sessao-freio.test.ts` prova a CONTA do balde (janela, peso,
 * regra do ambiente, IP atrás do proxy). Isto prova a FIAÇÃO: que
 * `/api/checkout`, `/api/cupom/conferir` e `/api/pedido/:código` chamam o
 * balde certo, no ponto certo. Um `frearPortaPublica` apagado de uma rota
 * passa em todos os testes de balde e deixa a porta aberta — é o caso que só
 * este arquivo enxerga.
 *
 * A requisição chega de um IP da internet (203.0.113.x — faixa reservada pra
 * documentação) pelo SOCKET, sem proxy e sem cabeçalho: é o caminho em que o
 * IP é o da pessoa em qualquer configuração. Os limites vêm baixos pelo
 * ambiente (`FREIO_*=N/600`), o mesmo caminho que produção usa pra ajustar.
 *
 * Fixture própria (organização ZZ), apagada no fim. Não precisa de servidor.
 */
import { randomUUID } from 'node:crypto'
import { createError, getRequestHeader, getRouterParam, readBody, setResponseHeader } from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1 } from '../utils/db'
import { esvaziarFreioPublico } from '../utils/sessao'

const G = globalThis as any
G.defineEventHandler ??= (h: any) => h
G.createError ??= createError
G.readBody ??= readBody
G.getRouterParam ??= getRouterParam
G.getRequestHeader ??= getRequestHeader
G.setResponseHeader ??= setResponseHeader
const { default: checkout } = await import('./checkout.post')
const { default: conferirCupom } = await import('./cupom/conferir.post')
const { default: consultarPedido } = await import('./pedido/[id].get')

let orgId: string, eventId: string, lotId: string, slug: string
let ipDaVez = 0
/** um IP da internet por caso — o balde de um não vaza pro outro */
const novoIp = () => `203.0.113.${(++ipDaVez % 250) + 1}`

function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

/** Uma requisição pro h3, vinda de `ip` pelo socket. */
function requisicao(ip: string, metodo: string, caminho: string, corpo?: any, params: Record<string, string> = {}) {
  const cabecalhos: Record<string, string> = {}
  return {
    method: metodo, path: caminho, context: { params },
    node: {
      req: { method: metodo, url: caminho, headers: corpo ? { 'content-type': 'application/json' } : {},
             body: corpo ? JSON.stringify(corpo) : undefined, socket: { remoteAddress: ip } },
      res: { setHeader(k: string, v: string) { cabecalhos[k.toLowerCase()] = v }, getHeader(k: string) { return cabecalhos[k.toLowerCase()] } },
    },
    cabecalhos,
  } as any
}

/** Chama a rota e devolve o status (200 quando respondeu corpo) e o que veio. */
async function chamar(rota: any, ev: any): Promise<{ status: number; corpo?: any; data?: any }> {
  try {
    return { status: 200, corpo: await rota(ev) }
  } catch (e: any) {
    if (!e?.statusCode) throw e
    return { status: e.statusCode, data: e.data }
  }
}

const ENV_ANTES: Record<string, string | undefined> = {}
function limites(v: Record<string, string>) {
  for (const [k, valor] of Object.entries(v)) {
    if (!(k in ENV_ANTES)) ENV_ANTES[k] = process.env[k]
    process.env[k] = valor
  }
}

beforeAll(async () => {
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug)
    VALUES ('ZZ Freio das Portas', 'zz-freio-portas-' || gen_random_uuid()) RETURNING id`))!.id
  slug = `zz-freio-portas-${randomUUID().slice(0, 8)}`
  eventId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps)
     VALUES ($1,'ZZ Freio das Portas',$2,'ativo', now() + interval '10 days', now() + interval '11 days', 0)
     RETURNING id`, [orgId, slug]))!.id
  const setor = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1,'Pista') RETURNING id`, [eventId]))!.id
  // lote de R$ 0: o pedido fecha no próprio checkout, sem gateway nenhum
  lotId = (await q1<any>(`INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
    VALUES ($1,'Lote grátis',0,500,10,'{online}') RETURNING id`, [setor]))!.id
})

afterEach(() => {
  esvaziarFreioPublico()
  for (const [k, v] of Object.entries(ENV_ANTES)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
    delete ENV_ANTES[k]
  }
})

afterAll(async () => {
  await q(`DELETE FROM tickets WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [orgId])
  await q(`DELETE FROM orders WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM customers WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

describe('B03 · /api/checkout', () => {
  it('o balde de PEDIDOS é conferido antes de qualquer trabalho: o 4º (limite 3) leva 429', async () => {
    // trava: `frearPortaPublica(event, 'checkout')` no topo da rota
    limites({ FREIO_CHECKOUT: '3/600' })
    const ip = novoIp()
    // corpo torto de propósito: o freio vem ANTES da validação (o script que
    // martela não precisa acertar o formato pra gastar a porta)
    for (let i = 0; i < 3; i++) {
      expect((await chamar(checkout, requisicao(ip, 'POST', '/api/checkout', { eventSlug: slug }))).status).toBe(400)
    }
    const r = await chamar(checkout, requisicao(ip, 'POST', '/api/checkout', { eventSlug: slug }))
    expect(r.status, 'o script seguiu batendo no checkout').toBe(429)
    expect(r.data).toMatchObject({ tipo: 'freio', freio: 'checkout' })
    // outro endereço segue comprando
    expect((await chamar(checkout, requisicao(novoIp(), 'POST', '/api/checkout', { eventSlug: slug }))).status).toBe(400)
  })

  it('o balde de INGRESSOS conta o que foi reservado: 3 + 2 num limite de 4 leva 429', async () => {
    // trava: `marcarNoFreio(event, 'checkout_ingressos', ingressosPedidos)` depois da reserva
    limites({ FREIO_CHECKOUT_INGRESSOS: '4/600', FREIO_CHECKOUT: '0' })
    const ip = novoIp()
    const compra = (quantidade: number) => chamar(checkout, requisicao(ip, 'POST', '/api/checkout', {
      eventSlug: slug, itens: [{ lotId, quantidade }],
      comprador: { nome: 'Maria de Teste', email: `freio.${randomUUID().slice(0, 8)}@teste.invalido`, documento: cpf() },
    }))
    const primeira = await compra(3)
    expect(primeira.status, JSON.stringify(primeira)).toBe(200)
    expect(primeira.corpo?.status).toBe('pago')
    const segunda = await compra(2)
    expect(segunda.status, 'sessenta lugares presos por um script não tinham freio').toBe(429)
    expect(segunda.data).toMatchObject({ freio: 'checkout_ingressos' })
  })
})

describe('B04 · /api/cupom/conferir', () => {
  const conferir = (ip: string, codigo: string) =>
    chamar(conferirCupom, requisicao(ip, 'POST', '/api/cupom/conferir', { eventSlug: slug, codigo }))

  it('código que NÃO existe enche o balde do dicionário: o 4º (limite 3) leva 429', async () => {
    // trava: `marcarNoFreio(event, 'cupom_errado')` no `inexistente`
    limites({ FREIO_CUPOM_ERRADO: '3/600', FREIO_CUPOM: '0' })
    const ip = novoIp()
    for (let i = 0; i < 3; i++) {
      const r = await conferir(ip, `ZZNAOEXISTE${i}`)
      expect(r.status).toBe(200)
      expect(r.corpo).toMatchObject({ ok: false, motivo: 'inexistente' })
    }
    const r = await conferir(ip, 'ZZNAOEXISTE9')
    expect(r.status, 'dicionário de cupom sem freio').toBe(429)
    expect(r.data).toMatchObject({ freio: 'cupom_errado' })
  })

  it('conferência em geral também tem teto: o 4º (limite 3) leva 429', async () => {
    // trava: `frearPortaPublica(event, 'cupom')` no topo da rota
    limites({ FREIO_CUPOM: '3/600', FREIO_CUPOM_ERRADO: '0' })
    const ip = novoIp()
    for (let i = 0; i < 3; i++) expect((await conferir(ip, `ZZQUALQUER${i}`)).status).toBe(200)
    const r = await conferir(ip, 'ZZQUALQUER9')
    expect(r.status).toBe(429)
    expect(r.data).toMatchObject({ freio: 'cupom' })
  })
})

describe('B15 · /api/pedido/:código', () => {
  const consultar = (ip: string, id: string) =>
    chamar(consultarPedido, requisicao(ip, 'GET', `/api/pedido/${id}`, undefined, { id }))

  it('código que não existe enche o balde: o 4º (limite 3) leva 429', async () => {
    // trava: `marcarNoFreio(event, 'pedido_404')` no 404, e o `conferirFreio` antes da consulta
    limites({ FREIO_PEDIDO_404: '3/600' })
    const ip = novoIp()
    for (let i = 0; i < 3; i++) expect((await consultar(ip, `PED-ZZFR-NAO${i}`)).status).toBe(404)
    const r = await consultar(ip, 'PED-ZZFR-NAO9')
    expect(r.status, 'código de pedido chutável sem freio').toBe(429)
    expect(r.data).toMatchObject({ freio: 'pedido_404' })
  })

  it('a consulta pelo UUID (o relógio da cobrança, a cada 4 s) não entra no balde', async () => {
    limites({ FREIO_PEDIDO_404: '1/600' })
    const ip = novoIp()
    for (let i = 0; i < 5; i++) {
      expect((await consultar(ip, randomUUID())).status, 'frear o UUID derrubaria o relógio de quem paga').toBe(404)
    }
  })
})
