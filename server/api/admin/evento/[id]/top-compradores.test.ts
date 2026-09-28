/**
 * "Quem mais comprou" pela mesma régua no painel e em relatórios (ADM-63, 27/09).
 *
 * Relatórios ordenava por gasto; a aba Público do painel, por ingressos. Mesmo título, duas
 * respostas: o grupo que levou 5 ingressos de R$ 10 aparecia na frente de quem deixou R$ 500
 * num ingresso só. Agora as duas ordenam por gasto (cobrado − devolvido), desempate por ingressos.
 * Sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/evento/top-compradores', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const SETOR = id(4)
const LOTE = id(5)
const GRUPO = id(6)
const VIP = id(7)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.top.${MARCA}@teste.invalido`

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../utils/db')
  return q<any>(texto, par)
}
const json = async (rota: string) =>
  (await fetch(`${BASE}${rota}`, { headers: { cookie, origin: BASE } })).json() as Promise<any>

async function pedido(n: number, cliente: string, totalCents: number, ingressos: number) {
  const pedidoId = id(100 + n)
  await sql(
    `INSERT INTO orders (id, org_id, event_id, customer_id, code, status, channel, face_cents, fee_cents,
                         platform_cents, discount_cents, total_cents, paid_at)
     VALUES ($1,$2,$3,$4,$5,'pago','online',$6,0,0,0,$6, now())`,
    [pedidoId, ORG, EVENTO, cliente, `ZZT-${MARCA_MAIUSCULA}-${n}`, totalCents])
  for (let i = 0; i < ingressos; i++) {
    await sql(
      `INSERT INTO tickets (org_id, event_id, sector_id, lot_id, order_id, code, qr_secret, status)
       VALUES ($1,$2,$3,$4,$5,$6,'zzt','valido')`,
      [ORG, EVENTO, SETOR, LOTE, pedidoId, `ZZT-${MARCA_MAIUSCULA}-${n}-${i}`])
  }
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/evento/[id]/top-compradores.test.ts', sonda)
  if (!sonda.noAr) return
  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZT TOP ${MARCA_MAIUSCULA}`, `zzt-top-${MARCA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,$3,$4, now() + interval '5 days', now() + interval '6 days', 1000, 'ativo')`,
    [EVENTO, ORG, `ZZT TOP ${MARCA_MAIUSCULA}`, `zzt-top-ev-${MARCA}`])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZT SETOR')`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity) VALUES ($1,$2,'ZZT LOTE',1000,100)`,
    [LOTE, SETOR])
  await sql(`INSERT INTO customers (id, org_id, name, email)
             VALUES ($1,$3,'ZZT Grupo','zzt.grupo.${MARCA}@teste.invalido'),
                    ($2,$3,'ZZT Vip','zzt.vip.${MARCA}@teste.invalido')`, [GRUPO, VIP, ORG])
  await pedido(1, GRUPO, 5_000, 5)     // 5 ingressos, R$ 50
  await pedido(2, VIP, 50_000, 1)      // 1 ingresso, R$ 500
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZT Dono', $3, password_hash, 'master' FROM users WHERE email = 'dono@fazendapark.com.br'`,
    [USUARIO, ORG, EMAIL])
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 240_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM tickets WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM customers WHERE org_id = $1`, [ORG])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('quem mais comprou (ADM-63)', () => {
  it('painel e relatórios põem na frente quem mais deixou no evento, na mesma ordem', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie, 'login falhou').toBeTruthy()
    const [rel, pub] = await Promise.all([
      json(`/api/admin/evento/${EVENTO}/relatorios`),
      json(`/api/admin/evento/${EVENTO}/publico`),
    ])
    const ordem = (l: any[]) => l.map((c: any) => c.nome)
    expect(ordem(rel.topCompradores)).toEqual(['ZZT Vip', 'ZZT Grupo'])
    expect(ordem(pub.topCompradores), 'a aba Público ordenou por ingressos: o grupo passou na frente')
      .toEqual(ordem(rel.topCompradores))
  }, 60_000)
})
