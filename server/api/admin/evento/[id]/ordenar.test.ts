/**
 * Ordenar setores e lotes numa chamada só (ADM-41, 27/09).
 *
 * A tela mandava um PATCH pros setores e mais um por setor. A rede caindo depois do primeiro
 * deixava os setores gravados e os lotes não — a página de venda com uma ordem que ninguém
 * montou, e a tela dizendo "Não foi possível salvar a ordem". Agora `o: 'tudo'` leva a ordem
 * inteira e a rota grava tudo ou nada, conferindo cada lista contra o evento.
 *
 * Sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/evento/ordenar', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const S1 = id(4)
const S2 = id(5)
const L11 = id(6)
const L12 = id(7)
const L21 = id(8)
const L22 = id(9)
const OUTRO_EVENTO = id(10)
const SETOR_DE_FORA = id(11)
const LOTE_DE_FORA = id(12)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.ordenar.${MARCA}@teste.invalido`

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../utils/db')
  return q<any>(texto, par)
}

async function ordenar(corpo: any) {
  const r = await fetch(`${BASE}/api/admin/evento/${EVENTO}/ordenar`, {
    method: 'PATCH', headers: { cookie, origin: BASE, 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({} as any)) }
}

/** os ids na ordem gravada */
const ordemDosSetores = async () => (await sql(
  `SELECT id FROM sectors WHERE event_id = $1 ORDER BY sort_order, id`, [EVENTO])).map((r: any) => r.id)
const ordemDosLotes = async (setor: string) => (await sql(
  `SELECT id FROM lots WHERE sector_id = $1 ORDER BY sort_order, id`, [setor])).map((r: any) => r.id)

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/evento/[id]/ordenar.test.ts', sonda)
  if (!sonda.noAr) return
  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZO ORDENAR ${MARCA_MAIUSCULA}`, `zzo-ordenar-${MARCA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$3,$4,$5, now() + interval '5 days', now() + interval '6 days', 1000, 'ativo'),
            ($2,$3,$6,$7, now() + interval '5 days', now() + interval '6 days', 1000, 'ativo')`,
    [EVENTO, OUTRO_EVENTO, ORG, `ZZO ORDENAR ${MARCA_MAIUSCULA}`, `zzo-ordenar-ev-${MARCA}`,
     `ZZO OUTRO ${MARCA_MAIUSCULA}`, `zzo-outro-ev-${MARCA}`])
  await sql(`INSERT INTO sectors (id, event_id, name, sort_order)
             VALUES ($1,$4,'ZZO S1',1), ($2,$4,'ZZO S2',2), ($3,$5,'ZZO FORA',1)`,
    [S1, S2, SETOR_DE_FORA, EVENTO, OUTRO_EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity, sort_order)
             VALUES ($1,$6,'ZZO L11',1000,10,1), ($2,$6,'ZZO L12',1000,10,2),
                    ($3,$7,'ZZO L21',1000,10,1), ($4,$7,'ZZO L22',1000,10,2),
                    ($5,$8,'ZZO FORA',1000,10,1)`,
    [L11, L12, L21, L22, LOTE_DE_FORA, S1, S2, SETOR_DE_FORA])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZO Dono', $3, password_hash, 'master' FROM users WHERE email = 'dono@fazendapark.com.br'`,
    [USUARIO, ORG, EMAIL])
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

describe('a ordem inteira numa chamada: tudo ou nada', () => {
  it('entrou (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie).toBeTruthy()
  })

  it('setores e lotes de cada setor numa chamada só', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await ordenar({
      o: 'tudo', setores: [S2, S1],
      lotes: [{ setorId: S1, ids: [L12, L11] }, { setorId: S2, ids: [L22, L21] }],
    })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(await ordemDosSetores()).toEqual([S2, S1])
    expect(await ordemDosLotes(S1)).toEqual([L12, L11])
    expect(await ordemDosLotes(S2)).toEqual([L22, L21])
  }, 120_000)

  it('lote de outro evento no meio: 422 e NADA muda — nem os setores', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await ordenar({
      o: 'tudo', setores: [S1, S2],
      lotes: [{ setorId: S1, ids: [L11, L12] }, { setorId: S2, ids: [L21, LOTE_DE_FORA] }],
    })
    expect(r.status, JSON.stringify(r.corpo)).toBe(422)
    expect(await ordemDosSetores(), 'gravou os setores e recusou os lotes: ordem pela metade').toEqual([S2, S1])
    expect(await ordemDosLotes(S1)).toEqual([L12, L11])
  }, 120_000)

  it('lote de OUTRO setor do mesmo evento: 422', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await ordenar({ o: 'tudo', setores: [S2, S1], lotes: [{ setorId: S1, ids: [L11, L21] }] })
    expect(r.status).toBe(422)
    expect(await ordemDosLotes(S1)).toEqual([L12, L11])
  }, 120_000)

  it('setor de outro evento: 422', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await ordenar({ o: 'tudo', setores: [S1, SETOR_DE_FORA] })
    expect(r.status).toBe(422)
    expect(await ordemDosSetores()).toEqual([S2, S1])
  }, 120_000)

  it('id repetido: 422', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect((await ordenar({ o: 'tudo', setores: [S1, S1] })).status).toBe(422)
    expect((await ordenar({ o: 'tudo', setores: [S1, S2], lotes: [{ setorId: S1, ids: [L11, L11] }] })).status)
      .toBe(422)
  }, 120_000)

  it('a recusa diz o campo (ADM-36)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await ordenar({ o: 'tudo', setores: ['nao-e-uuid'] })
    expect(r.status).toBe(400)
    expect(r.corpo.statusMessage).toContain('Ordem dos setores')
  }, 120_000)

  it('as formas antigas (setor / lote) continuam valendo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect((await ordenar({ o: 'setor', ids: [S1, S2] })).status).toBe(200)
    expect(await ordemDosSetores()).toEqual([S1, S2])
    expect((await ordenar({ o: 'lote', setorId: S2, ids: [L21, L22] })).status).toBe(200)
    expect(await ordemDosLotes(S2)).toEqual([L21, L22])
  }, 120_000)
})
