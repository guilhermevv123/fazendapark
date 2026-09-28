/**
 * Apagar cupom e a recusa que diz o campo (ADM-37, ADM-36 — 27/09).
 *
 * ADM-37: a rota conferia `promo_codes.uses` (placar que o cancelamento desconta) e apagava numa
 * consulta à parte. Com o placar em 0, o cupom de um pedido PAGO era apagado — e o banco não
 * segura, `orders.promo_code_id` é `ON DELETE SET NULL`: o pedido perdia a origem do desconto em
 * silêncio. Agora a contagem sai de `orders`, com o cupom travado.
 *
 * ADM-36: as rotas do evento recusavam com "Dados inválidos", sem dizer o campo.
 *
 * Sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/evento/cupons', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const CUPOM_DO_PEDIDO = id(4)
const CUPOM_LIVRE = id(5)
const PEDIDO = id(6)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.cupons.${MARCA}@teste.invalido`

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../utils/db')
  return q<any>(texto, par)
}

async function chamar(rota: string, metodo: string, corpo?: any) {
  const r = await fetch(`${BASE}${rota}`, {
    method: metodo, headers: { cookie, origin: BASE, 'content-type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({} as any)) }
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/evento/[id]/cupons.test.ts', sonda)
  if (!sonda.noAr) return
  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZC CUPONS ${MARCA_MAIUSCULA}`, `zzc-cupons-${MARCA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,$3,$4, now() + interval '5 days', now() + interval '6 days', 1000, 'ativo')`,
    [EVENTO, ORG, `ZZC CUPONS ${MARCA_MAIUSCULA}`, `zzc-cupons-ev-${MARCA}`])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZC Dono', $3, password_hash, 'master' FROM users WHERE email = 'dono@fazendapark.com.br'`,
    [USUARIO, ORG, EMAIL])
  // o placar `uses` em 0 com um pedido PAGO apontando pro cupom: é o que o cancelamento de outro
  // pedido deixa (ele desconta o placar)
  await sql(`INSERT INTO promo_codes (id, event_id, code, kind, value, uses)
             VALUES ($1,$3,'COMPEDIDO','percentual',1000,0), ($2,$3,'LIVRE','percentual',1000,0)`,
    [CUPOM_DO_PEDIDO, CUPOM_LIVRE, EVENTO])
  await sql(
    `INSERT INTO orders (id, org_id, event_id, promo_code_id, code, status, channel, face_cents, fee_cents,
                         platform_cents, discount_cents, total_cents, paid_at)
     VALUES ($1,$2,$3,$4,$5,'pago','online',10000,0,1000,1000,9000, now())`,
    [PEDIDO, ORG, EVENTO, CUPOM_DO_PEDIDO, `ZZC-${MARCA_MAIUSCULA}`])
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 240_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('apagar cupom (ADM-37)', () => {
  it('entrou (senão nada abaixo prova nada)', (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie).toBeTruthy()
  })

  it('cupom de pedido pago não apaga, mesmo com o placar em zero — e o pedido não perde o desconto', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar(`/api/admin/evento/${EVENTO}/cupons`, 'DELETE', { id: CUPOM_DO_PEDIDO })
    expect(r.status, 'o cupom do pedido pago foi apagado').toBe(409)
    expect(r.corpo.statusMessage).toContain('1 pedido')
    const [p] = await sql(`SELECT promo_code_id FROM orders WHERE id = $1`, [PEDIDO])
    expect(p.promo_code_id, 'o pedido pago perdeu a origem do desconto').toBe(CUPOM_DO_PEDIDO)
  }, 60_000)

  it('cupom que ninguém usou apaga', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar(`/api/admin/evento/${EVENTO}/cupons`, 'DELETE', { id: CUPOM_LIVRE })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(await sql(`SELECT 1 FROM promo_codes WHERE id = $1`, [CUPOM_LIVRE])).toHaveLength(0)
  }, 60_000)
})

describe('a recusa diz o campo (ADM-36)', () => {
  it('cupom com desconto negativo: "Valor do desconto", não "Dados inválidos"', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar(`/api/admin/evento/${EVENTO}/cupons`, 'POST',
      { codigo: 'ZZNEG', tipo: 'percentual', valor: -5 })
    expect(r.status).toBe(400)
    expect(r.corpo.statusMessage, 'o operador não sabe o que corrigir').toMatch(/^Valor do desconto: /)
  }, 60_000)

  it('saque sem beneficiário diz qual campo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar(`/api/admin/evento/${EVENTO}/financeiro`, 'POST',
      { destinoTipo: 'pix', destino: 'chave@pix', valorCents: 100 })
    expect(r.status).toBe(400)
    expect(r.corpo.statusMessage).toMatch(/^Beneficiário: /)
  }, 60_000)

  it('a portaria: código lido curto demais diz que é o código', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar('/api/checkin', 'POST', { qr: 'AB', eventId: EVENTO })
    expect(r.status).toBe(400)
    expect(r.corpo.statusMessage).toMatch(/^Código lido: /)
  }, 60_000)
})
