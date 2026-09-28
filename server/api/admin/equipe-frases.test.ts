/**
 * equipe-frases.test.ts — CFG-04 na Equipe: a recusa diz QUAL campo e o que fazer.
 *
 * Antes, `POST`/`PATCH /api/admin/equipe` devolviam 400 "Dados inválidos" pra qualquer campo — e o
 * caso mais comum nem era erro: o espaço que o celular põe depois do e-mail autocompletado. Agora o
 * e-mail é aparado (e minúsculo) ANTES da conferência de formato, e o resto volta com o nome do
 * campo como a tela escreve.
 *
 * Fixture própria (organização `zz-equipe-frases-*`), apagada no `afterAll`.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'
import { db, q, q1 } from '../../utils/db'

const BASE = BASE_DE_TESTE
const ORG = randomUUID()
const SLUG = `zz-equipe-frases-${ORG.slice(0, 8)}`
const MESTRE = `equipe.frases.${ORG.slice(0, 8)}@teste.invalido`
const NOVO = `nova.pessoa.${ORG.slice(0, 8)}@teste.invalido`

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function bater(metodo: 'POST' | 'PATCH', corpo: unknown) {
  const r = await fetch(`${BASE}/api/admin/equipe`, {
    method: metodo, headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(corpo),
  })
  const json = await r.json().catch(() => ({}))
  return { status: r.status, json, msg: String(json.statusMessage ?? '') }
}

async function apagar() {
  const c = await db().connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL auditoria.expurgo = 'liberado'`)
    await c.query(`DELETE FROM audit_log WHERE org_id IN (SELECT id FROM organizations WHERE slug LIKE 'zz-equipe-frases-%')`)
    await c.query(`DELETE FROM organizations WHERE slug LIKE 'zz-equipe-frases-%'`)
    await c.query('COMMIT')
  } finally {
    try { await c.query('ROLLBACK') } catch { /* já fechou */ }
    c.release()
  }
}

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/equipe-frases.test.ts', sonda)
  if (!sonda.noAr) return
  await apagar()
  await q(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'ZZ Equipe Frases', $2)`, [ORG, SLUG])
  await q(`INSERT INTO users (org_id, name, email, password_hash, papel, role)
           SELECT $1, 'Mestre Frases', $2, password_hash, 'master', 'master' FROM users WHERE email = 'dono@fazendapark.com.br'`,
    [ORG, MESTRE])
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: MESTRE, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 60_000)

afterAll(async () => {
  if (sonda.noAr) await apagar()
  await db().end()
})

describe('Dar acesso (POST) — CFG-04', () => {
  it('e-mail com espaço no fim (o autocompletar do celular) é aceito, aparado e minúsculo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await bater('POST', { nome: 'Pessoa Nova', email: `  ${NOVO.toUpperCase()} `, papel: 'portaria' })
    expect(r.status, r.msg).toBe(200)
    expect(r.json.usuario.email).toBe(NOVO)
    expect(await q1<any>(`SELECT email FROM users WHERE org_id = $1 AND email = $2`, [ORG, NOVO])).toBeTruthy()
  })

  it('e-mail sem formato diz o campo e o que fazer — não "Dados inválidos"', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await bater('POST', { nome: 'Outra Pessoa', email: 'isto-nao-e-email', papel: 'portaria' })
    expect(r.status).toBe(400)
    expect(r.msg).toBe('E-mail: formato errado — confira o endereço (ex.: pessoa@empresa.com.br)')
  })

  it('nome curto e papel que não existe também dizem o campo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect((await bater('POST', { nome: 'A', email: 'a@zz.teste.invalido', papel: 'portaria' })).msg)
      .toBe('Nome: precisa de pelo menos 2 caractere(s)')
    expect((await bater('POST', { nome: 'Alguém', email: 'b@zz.teste.invalido', papel: 'dono' })).msg)
      .toBe('Papel: opção que não existe')
  })
})

describe('Mudar acesso (PATCH) — CFG-04', () => {
  it('papel que não existe e pessoa sem id dizem o campo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const alvo = await q1<{ id: string }>(`SELECT id FROM users WHERE org_id = $1 AND email = $2`, [ORG, NOVO])
    const r = await bater('PATCH', { id: alvo!.id, papel: 'dono' })
    expect(r.status).toBe(400)
    expect(r.msg).toBe('Papel: opção que não existe')
    expect((await bater('PATCH', { papel: 'operacao' })).msg).toBe('Pessoa: não pode ficar vazio')
  })
})
