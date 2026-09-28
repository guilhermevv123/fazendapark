/**
 * Ticket médio sem cortesia — o caso exato da auditoria (ADM-12, 27/09).
 *
 * Dez pedidos pagos de R$ 100 (um ingresso cada) e UMA emissão de 40 cortesias. A cortesia é
 * pedido vivo de R$ 0: entrava nas divisões, e o painel dizia R$ 90,91 por pedido, R$ 20,00 por
 * ingresso e "4.55 ingressos por pedido". O certo é R$ 100 / R$ 100 / 1 — nas DUAS telas.
 *
 * Uma venda que fechou em zero (lote grátis, cupom de 100%) fica de fora da média pelo mesmo
 * motivo, e está aqui também. Sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/evento/ticket-medio', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const SETOR = id(4)
const LOTE = id(5)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.ticket-medio.${MARCA}@teste.invalido`

const PAGOS = 10
const PRECO = 10_000
const CORTESIAS = 40

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../utils/db')
  return q<any>(texto, par)
}

async function get(rota: string) {
  const r = await fetch(`${BASE}/api/admin/evento/${EVENTO}${rota}`, { headers: { cookie, origin: BASE } })
  return { status: r.status, corpo: await r.json().catch(() => ({} as any)) }
}

async function pedido(codigo: string, canal: string, total: number, quantidade: number) {
  const [o] = await sql(
    `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                         discount_cents, total_cents, refunded_cents, paid_at, payment_method)
     VALUES ($1,$2,$3,'pago',$4,$5,0,0,0,$5,0, now() - interval '1 hour', $6) RETURNING id`,
    [ORG, EVENTO, codigo, canal, total, canal === 'cortesia' ? 'cortesia' : 'pix'])
  await sql(
    `INSERT INTO order_items (order_id, lot_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents)
     VALUES ($1,$2,$3,$4,0,$4)`, [o.id, LOTE, quantidade, quantidade ? total / quantidade : 0])
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/evento/[id]/ticket-medio.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZT TICKET ${MARCA_MAIUSCULA}`, `zzt-ticket-${MARCA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,$3,$4, now() + interval '5 days', now() + interval '6 days', 0, 'ativo')`,
    [EVENTO, ORG, `ZZT TICKET ${MARCA_MAIUSCULA}`, `zzt-ticket-ev-${MARCA}`])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZT SETOR')`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity) VALUES ($1,$2,'ZZT LOTE',$3,500)`,
    [LOTE, SETOR, PRECO])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZT Dono', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'`, [USUARIO, ORG, EMAIL])

  for (let i = 0; i < PAGOS; i++) await pedido(`ZZT-${MARCA_MAIUSCULA}-P${i}`, 'online', PRECO, 1)
  await pedido(`ZZT-${MARCA_MAIUSCULA}-CORTESIA`, 'cortesia', 0, CORTESIAS)
  // a venda que fechou em zero: não é cortesia, mas também não pagou nada
  await pedido(`ZZT-${MARCA_MAIUSCULA}-GRATIS`, 'online', 0, 2)

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 240_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('ticket médio: cortesia e venda de R$ 0 não entram na média', () => {
  it('entrou (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie, 'login falhou').toBeTruthy()
  })

  it('painel: R$ 100 por pedido, R$ 100 por ingresso, 10 pedidos pagantes, 1 ingresso cada', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { status, corpo } = await get('/dashboard')
    expect(status).toBe(200)
    const t = corpo.totais
    expect({
      porPedido: t.ticketMedioPorPedidoCents, porIngresso: t.ticketMedioPorIngressoCents,
      pagantes: t.pedidosPagantes, ingressosPorPedido: t.ingressosPorPedido,
    }, 'a cortesia entrou na divisão do ticket médio').toEqual({
      porPedido: PRECO, porIngresso: PRECO, pagantes: PAGOS, ingressosPorPedido: 1,
    })
    // o que saiu continua contado inteiro — só a média mudou de população
    expect(t.ingressos).toBe(PAGOS + CORTESIAS + 2)
    expect(t.cortesiasEmitidas).toBe(CORTESIAS)
    expect(t.pedidos, 'pedido vivo continua sendo pedido vivo (a contagem das outras telas)').toBe(PAGOS + 2)
    expect(t.pedidosSemCobranca).toBe(2)
  }, 120_000)

  it('relatórios: a mesma média, pela mesma régua', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { status, corpo } = await get('/relatorios')
    expect(status).toBe(200)
    const r = corpo.resumo
    expect({
      porPedido: r.ticketMedioPorPedidoCents, porIngresso: r.ticketMedioPorIngressoCents,
      apelidoPorPedido: r.ticketMedioCents, apelidoPorIngresso: r.porIngressoCents,
      ingressosPorPedido: r.ingressosPorPedido, pagantes: r.pedidosPagantes,
    }, 'relatórios dividiu pela cortesia').toEqual({
      porPedido: PRECO, porIngresso: PRECO, apelidoPorPedido: PRECO, apelidoPorIngresso: PRECO,
      ingressosPorPedido: 1, pagantes: PAGOS,
    })
  }, 120_000)
})
