/**
 * organizacao-recebimento.test.ts — o recebimento (Asaas e Mercado Pago) é da equipe da plataforma
 * (ordem do dono, 05/10), pela ROTA de verdade.
 *
 *   · master do parque (fora de `EQUIPE_DA_PLATAFORMA`): mexer em chave, ambiente, carteira, token
 *     ou assinatura do MP é 403 e o banco não muda; o cadastro (nome) continua salvando; o GET não
 *     devolve fim de chave, conta do MP nem endereço de webhook;
 *   · master da equipe: salva a chave e vê o fim dela.
 *
 * O servidor de teste (.env.e2e) roda com `EQUIPE_DA_PLATAFORMA=@teste.invalido`: o master da equipe
 * é `@teste.invalido`, o do parque é `@cliente.invalido`. Fixture própria, apagada no `afterAll`.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'
import { db, q, q1 } from '../../utils/db'

const BASE = BASE_DE_TESTE
const ORG = randomUUID()
const EQUIPE = 'organizacao.recebimento.equipe@teste.invalido'
const CLIENTE = 'organizacao.recebimento.parque@cliente.invalido'
const HMLG = '$aact_hmlg_000000000000000000000000RECEB'

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
const cookies: Record<string, string> = {}

async function entrar(email: string) {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha: 'diamond123' }),
  })
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}
async function patch(quem: string, corpo: Record<string, unknown>) {
  const r = await fetch(`${BASE}/api/admin/organizacao`, {
    method: 'PATCH',
    headers: { cookie: cookies[quem]!, 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify(corpo),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) }
}
async function get(quem: string) {
  const r = await fetch(`${BASE}/api/admin/organizacao`, { headers: { cookie: cookies[quem]! } })
  expect(r.status).toBe(200)
  return r.json()
}
const gravado = () => q1<any>(
  `SELECT name, asaas_env, asaas_api_key, asaas_wallet, mp_access_token FROM organizations WHERE id = $1`, [ORG])

/** `audit_log` é só-escrita por gatilho: apagar a fixture exige a licença na MESMA transação */
async function apagarOrganizacoes(onde: string, par: any[] = []) {
  const c = await db().connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL auditoria.expurgo = 'liberado'`)
    await c.query(`DELETE FROM audit_log WHERE org_id IN (SELECT id FROM organizations WHERE ${onde})`, par)
    await c.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE org_id IN (SELECT id FROM organizations WHERE ${onde}))`, par)
      .catch(() => {})
    await c.query(`DELETE FROM users WHERE org_id IN (SELECT id FROM organizations WHERE ${onde})`, par)
    await c.query(`DELETE FROM organizations WHERE ${onde}`, par)
    await c.query('COMMIT')
  } finally {
    try { await c.query('ROLLBACK') } catch { /* já fechou */ }
    c.release()
  }
}

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/organizacao-recebimento.test.ts', sonda)
  if (!sonda.noAr) return
  await apagarOrganizacoes(`slug LIKE 'zz-org-recebimento-%'`)
  await q(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'ZZ Recebimento', $2)`,
    [ORG, `zz-org-recebimento-${ORG.slice(0, 8)}`])
  for (const email of [EQUIPE, CLIENTE]) {
    await q(
      `INSERT INTO users (org_id, name, email, password_hash, papel, role)
       SELECT $1, 'Master Recebimento', $2, password_hash, 'master', 'master'
         FROM users WHERE email = 'dono@fazendapark.com.br'`, [ORG, email])
    cookies[email] = await entrar(email)
    expect(cookies[email], `o login de ${email} não devolveu sessão`).not.toBe('')
  }
}, 60_000)

afterAll(async () => {
  if (sonda.noAr) await apagarOrganizacoes('id = $1', [ORG])
  await db().end()
})

describe('recebimento é da equipe da plataforma (05/10)', () => {
  it('a equipe salva a chave do Asaas e vê o fim dela', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await patch(EQUIPE, { chaveAsaas: HMLG, ambienteAsaas: 'sandbox' })
    expect(r.status, `${r.corpo.statusMessage} — o servidor de teste tem EQUIPE_DA_PLATAFORMA=@teste.invalido?`).toBe(200)
    expect((await gravado())!.asaas_api_key).toBe(HMLG)
    const org = await get(EQUIPE)
    expect(org).toMatchObject({ podeConfigurarRecebimento: true, chaveFinal: HMLG.slice(-6) })
  })

  it('o master do parque leva 403 em toda credencial de recebimento, e o banco não muda', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const antes = await gravado()
    for (const corpo of [
      { chaveAsaas: '$aact_hmlg_111111111111111111111111OUTRA' },
      { ambienteAsaas: 'production' },
      { carteiraAsaas: 'carteira-qualquer' },
      { tokenMercadoPago: 'APP_USR-0000000000000000000000000000' },
      { segredoMercadoPago: 'segredo-de-teste-123456' },
      { chaveAsaas: null },
    ]) {
      const r = await patch(CLIENTE, corpo)
      expect(r.status, JSON.stringify(corpo)).toBe(403)
      expect(r.corpo.statusMessage).toMatch(/equipe da plataforma/)
    }
    expect(await gravado()).toEqual(antes)
  })

  it('o master do parque continua salvando o cadastro', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await patch(CLIENTE, { nome: 'ZZ Recebimento Renomeada' })
    expect(r.status, r.corpo.statusMessage).toBe(200)
    expect((await gravado())!.name).toBe('ZZ Recebimento Renomeada')
  })

  it('o GET do parque diz o estado e esconde fim de chave, conta do MP e endereço de aviso', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const org = await get(CLIENTE)
    expect(org.podeConfigurarRecebimento).toBe(false)
    expect(org.temChave).toBe(true)
    expect(org.chaveFinal).toBeNull()
    expect(org.carteiraAsaas).toBeNull()
    expect(org.mercadoPago).toMatchObject({ tokenFinal: null, contaId: null, urlDoAviso: null })
    expect(JSON.stringify(org)).not.toContain(HMLG.slice(-6))
  })
})
