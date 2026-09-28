/**
 * Aba Público: faixa etária e cidade de quem informou; o aviso só com o que não é perguntado
 * (ADM-32, 27/09).
 *
 * A aba dizia "Não dá pra mostrar data de nascimento, gênero, endereço: o checkout não pergunta" —
 * e o checkout pergunta nascimento e endereço (cadastro do 027, opcionais). Agora a rota devolve a
 * faixa etária (idade no dia do evento) e a cidade de quem respondeu, com quantos responderam, e o
 * `naoColetado` fica só com gênero. Sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/evento/publico-cadastro', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.publico.${MARCA}@teste.invalido`

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../utils/db')
  return q<any>(texto, par)
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/evento/[id]/publico-cadastro.test.ts', sonda)
  if (!sonda.noAr) return
  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZB PUBLICO ${MARCA_MAIUSCULA}`, `zzb-publico-${MARCA}`])
  // o evento é num dia fixo: a idade é contada NESSE dia, não no dia em que a suíte roda
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status, timezone)
     VALUES ($1,$2,$3,$4, '2027-01-10T12:00:00Z', '2027-01-10T20:00:00Z', 1000, 'ativo', 'America/Bahia')`,
    [EVENTO, ORG, `ZZB PUBLICO ${MARCA_MAIUSCULA}`, `zzb-publico-ev-${MARCA}`])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZB Dono', $3, password_hash, 'master' FROM users WHERE email = 'dono@fazendapark.com.br'`,
    [USUARIO, ORG, EMAIL])
  // quatro compradores: 17 anos no dia (faz 18 no dia seguinte), 24, 60 — e um sem nascimento nem cidade.
  // Venda de balcão: pedido online pago com comprador cai na fila de envio de ingresso por e-mail.
  const compradores: [string, string | null, string | null, string | null][] = [
    ['a', '2009-01-11', 'VITÓRIA DA CONQUISTA ', 'BA'],
    ['b', '2002-06-01', 'vitória da conquista', 'BA'],
    ['c', '1966-01-10', 'Salvador', 'BA'],
    ['d', null, null, null],
  ]
  for (const [n, nascimento, cidade, uf] of compradores) {
    const [c] = await sql(
      `INSERT INTO customers (org_id, name, email, birth_date, city, state)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ORG, `ZZB ${n}`, `zzb.${n}.${MARCA}@teste.invalido`, nascimento, cidade, uf])
    await sql(
      `INSERT INTO orders (org_id, event_id, customer_id, code, status, channel, face_cents, fee_cents,
                           platform_cents, discount_cents, total_cents, paid_at)
       VALUES ($1,$2,$3,$4,'pago','bilheteria',1000,0,100,0,1000, now())`,
      [ORG, EVENTO, c.id, `ZZB-${MARCA_MAIUSCULA}-${n}`])
  }
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 240_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('aba Público: o que o checkout pergunta aparece, com quantos responderam', () => {
  it('faixa etária no dia do evento, cidade agrupada, e o aviso só com gênero', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE}/api/admin/evento/${EVENTO}/publico`, { headers: { cookie, origin: BASE } })
    expect(r.status).toBe(200)
    const p = await r.json()
    expect(p.pessoas.compradores).toBe(4)
    expect(p.idades.informaram, 'quem não informou entrou numa faixa').toBe(3)
    const faixas = Object.fromEntries(p.idades.faixas.map((f: any) => [f.faixa, f.pessoas]))
    expect(faixas, 'a idade não é a do dia do evento').toEqual({
      'Até 17 anos': 1, '18 a 24': 1, '25 a 34': 0, '35 a 44': 0, '45 a 59': 0, '60 ou mais': 1 })
    expect(p.cidades.informaram).toBe(3)
    expect(p.cidades.top, '"VITÓRIA DA CONQUISTA " e "vitória da conquista" viraram duas cidades').toEqual([
      { cidade: 'Vitória Da Conquista', uf: 'BA', pessoas: 2 },
      { cidade: 'Salvador', uf: 'BA', pessoas: 1 },
    ])
    expect(p.naoColetado, 'o aviso diz que o checkout não pergunta o que ele pergunta').toEqual(['gênero'])
  }, 120_000)
})
