/**
 * Participantes — "Já entraram" e o filtro "Transferido" (ADM-45, 27/09).
 *
 * "Já entraram" contava `tickets.status = 'usado'`, que é a TRAVA do QR e não o registro de
 * passagem: o passaporte de vários dias segue `valido` até o último dia (entra uma vez por dia) e
 * a entrada dele não aparecia; a portaria, o borderô e o histórico contam pelo livro de entradas
 * (`entries`). E o filtro "Transferido" nunca casava com nada: nenhum código grava
 * `status = 'transferido'` — a transferência só troca o titular.
 *
 * Aqui: A (válido, com passagem no livro), B (válido, sem passagem), C (transferência concluída).
 * Sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/evento/participantes', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const SETOR = id(4)
const LOTE = id(5)
const [A, B, C] = [id(6), id(7), id(8)]
const ENTRADA = id(9)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.participantes.${MARCA}@teste.invalido`

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

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/evento/[id]/participantes.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZP PARTICIPANTES ${MARCA_MAIUSCULA}`, `zzp-part-${MARCA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,$3,$4, now() - interval '1 day', now() + interval '2 days', 0, 'ativo')`,
    [EVENTO, ORG, `ZZP PARTICIPANTES ${MARCA_MAIUSCULA}`, `zzp-part-ev-${MARCA}`])
  await sql(`INSERT INTO sectors (id, event_id, name, sessions_covered) VALUES ($1,$2,'ZZP PASSAPORTE',3)`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity) VALUES ($1,$2,'ZZP LOTE',1000,10)`, [LOTE, SETOR])
  for (const [t, n] of [[A, 'A'], [B, 'B'], [C, 'C']]) {
    await sql(
      `INSERT INTO tickets (id, org_id, event_id, sector_id, lot_id, code, qr_secret, status, holder_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'valido',$8)`,
      [t, ORG, EVENTO, SETOR, LOTE, `ZZP-${MARCA_MAIUSCULA}-${n}`, `zzp-${MARCA}-${n}`, `Titular ${n}`])
  }
  // A passou na porta no dia 1 do passaporte: continua `valido`, e ENTROU
  await sql(
    `INSERT INTO entries (id, org_id, event_id, ticket_id, people, gate, device_id, offline)
     VALUES ($1,$2,$3,$4,1,'Portão A','zzp-tablet',false)`, [ENTRADA, ORG, EVENTO, A])
  // C mudou de titular por transferência concluída
  await sql(
    `INSERT INTO ticket_transfers (org_id, event_id, ticket_id, de_nome, para_nome, para_email, status, code, accepted_at)
     VALUES ($1,$2,$3,'Titular C','Nova Pessoa','nova@teste.invalido','concluido',$4, now())`,
    [ORG, EVENTO, C, `zzp-tr-${MARCA}`])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZP Dono', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'`, [USUARIO, ORG, EMAIL])
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

describe('participantes: "Já entrou" pelo livro e "Transferido" pela transferência', () => {
  it('entrou (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie, 'login falhou').toBeTruthy()
  })

  it('"Já entraram" conta a passagem do livro, não a trava do QR', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await get('/participantes')
    expect(r.status).toBe(200)
    expect(r.corpo.resumo.total).toBe(3)
    expect(r.corpo.resumo.entraram, 'o passaporte que entrou no dia 1 sumiu do "Já entraram"').toBe(1)
  }, 120_000)

  it('o filtro "Já entrou" traz quem passou na porta', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await get('/participantes?status=usado')
    expect(r.corpo.participantes.map((p: any) => p.id)).toEqual([A])
  }, 120_000)

  it('o filtro "Transferido" traz o ingresso que mudou de titular', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await get('/participantes?status=transferido')
    expect(r.corpo.participantes.map((p: any) => p.id), 'o filtro "Transferido" não casa com nada')
      .toEqual([C])
  }, 120_000)

  it('"Válido" continua sendo a situação do ingresso', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await get('/participantes?status=valido')
    expect(r.corpo.participantes.map((p: any) => p.id).sort()).toEqual([A, B, C].sort())
  }, 120_000)
})
