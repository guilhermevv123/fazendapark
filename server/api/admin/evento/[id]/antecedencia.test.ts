/**
 * "Quando a venda acontece" medido contra o DIA DO INGRESSO (ADM-62, 27/09).
 *
 * A antecedência era `GREATEST(0, início do EVENTO − dia do pagamento)`. Num parque que abre todo
 * fim de semana (evento começou há 5 dias, sessões até o fim do ano), a venda de hoje pro sábado
 * daqui a 20 dias caía em "Últimos 3 dias" — o gráfico dizia que tudo vendeu na última hora.
 * Agora a régua é a sessão do item do pedido; pedido sem dia segue contra o início do evento.
 * Sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/evento/antecedencia', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const SETOR = id(4)
const LOTE = id(5)
const DAQUI_20 = id(6)
const DAQUI_2 = id(7)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.antecedencia.${MARCA}@teste.invalido`

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../utils/db')
  return q<any>(texto, par)
}

async function pedidoPago(n: number, sessao: string | null) {
  const pedido = id(100 + n)
  await sql(
    `INSERT INTO orders (id, org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                         discount_cents, total_cents, paid_at)
     VALUES ($1,$2,$3,$4,'pago','online',1000,0,100,0,1000, now())`,
    [pedido, ORG, EVENTO, `ZZA-${MARCA_MAIUSCULA}-${n}`])
  await sql(
    `INSERT INTO order_items (order_id, lot_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents, session_id)
     VALUES ($1,$2,1,1000,0,1000,$3)`, [pedido, LOTE, sessao])
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/evento/[id]/antecedencia.test.ts', sonda)
  if (!sonda.noAr) return
  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZA ANTECEDENCIA ${MARCA_MAIUSCULA}`, `zza-ant-${MARCA}`])
  // o parque já abriu (há 5 dias) e segue com datas até daqui a 60
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status, timezone)
     VALUES ($1,$2,$3,$4, now() - interval '5 days', now() + interval '60 days', 1000, 'ativo', 'America/Bahia')`,
    [EVENTO, ORG, `ZZA ANTECEDENCIA ${MARCA_MAIUSCULA}`, `zza-ant-ev-${MARCA}`])
  await sql(
    `INSERT INTO event_sessions (id, event_id, starts_at, ends_at, title)
     VALUES ($1,$3, now() + interval '20 days', now() + interval '20 days 8 hours', 'Daqui a 20'),
            ($2,$3, now() + interval '2 days',  now() + interval '2 days 8 hours',  'Daqui a 2')`,
    [DAQUI_20, DAQUI_2, EVENTO])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZA SETOR')`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity) VALUES ($1,$2,'ZZA LOTE',1000,100)`,
    [LOTE, SETOR])
  await pedidoPago(1, DAQUI_20)
  await pedidoPago(2, DAQUI_2)
  await pedidoPago(3, null)     // sem dia: medido contra o início do evento (que já passou) → 0
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZA Dono', $3, password_hash, 'master' FROM users WHERE email = 'dono@fazendapark.com.br'`,
    [USUARIO, ORG, EMAIL])
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 240_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE event_id = $1)`, [EVENTO])
  await sql(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('antecedência pelo dia do ingresso (ADM-62)', () => {
  it('a venda de hoje pro sábado daqui a 20 dias é "20 dias antes", não "última hora"', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie, 'login falhou').toBeTruthy()
    const r = await (await fetch(`${BASE}/api/admin/evento/${EVENTO}/relatorios`,
      { headers: { cookie, origin: BASE } })).json() as any
    const porDias = Object.fromEntries(r.antecedencia.map((a: any) => [a.dias, a.pedidos]))
    // a data fica entre 19 e 20 conforme a hora do dia no fuso do evento; o que não pode é 0
    const vinte = (porDias[20] ?? 0) + (porDias[19] ?? 0)
    expect(vinte, `a venda pro dia daqui a 20 caiu em "última hora": ${JSON.stringify(r.antecedencia)}`).toBe(1)
    expect((porDias[2] ?? 0) + (porDias[1] ?? 0), 'a venda pro dia daqui a 2').toBe(1)
    expect(porDias[0], 'o pedido sem dia continua medido contra o início do evento').toBe(1)
  }, 60_000)
})
