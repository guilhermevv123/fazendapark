/**
 * organizacao-ambiente.test.ts — ORG-01 (P0): o ambiente do Asaas na tela é o que cobra de verdade.
 *
 * Antes: com a chave de SANDBOX gravada, o PATCH aceitava `{ ambienteAsaas: 'production' }` sem
 * chave nova — o selo passava a dizer PRODUÇÃO e o checkout seguia gerando PIX de sandbox. O avesso
 * (chave de produção, select em "Testes — ninguém é cobrado") cobrava de verdade com a tela
 * jurando que não.
 *
 * O caso vai pela ROTA de verdade (sessão de master de uma organização própria), e confere o banco
 * depois da recusa — "422 na resposta" com o UPDATE gravado mesmo assim seria o pior dos mundos.
 *
 * Mutação conferida: arrancando o bloco `recusaDeAmbiente` do PATCH, os dois primeiros casos ficam
 * vermelhos (200 no lugar de 422, e o banco muda); devolvendo `asaas_env` cru no GET, o último fica.
 *
 * As chaves são de mentira (só o formato). A organização não tem pedido nenhum, então nenhuma fila
 * de fundo chega a falar com o Asaas por causa dela. Fixture própria, apagada no `afterAll`.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'
import { db, q, q1 } from '../../utils/db'

const BASE = BASE_DE_TESTE
const ORG = randomUUID()
const EMAIL = 'organizacao.ambiente.master@teste.invalido'
const PROD = '$aact_prod_000000000000000000000000TESTE'
const HMLG = '$aact_hmlg_000000000000000000000000TESTE'

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function patch(corpo: Record<string, unknown>) {
  const r = await fetch(`${BASE}/api/admin/organizacao`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify(corpo),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) }
}
async function get(rota: string) {
  const r = await fetch(`${BASE}${rota}`, { headers: { cookie } })
  expect(r.status, rota).toBe(200)
  return r.json()
}
const gravado = () => q1<any>(`SELECT asaas_env, asaas_api_key FROM organizations WHERE id = $1`, [ORG])
const gravar = (chave: string | null, ambiente: string) =>
  q(`UPDATE organizations SET asaas_api_key = $2, asaas_env = $3 WHERE id = $1`, [ORG, chave, ambiente])

/** `audit_log` é só-escrita por gatilho: apagar a fixture exige a licença na MESMA transação */
async function apagarOrganizacoes(onde: string, par: any[] = []) {
  const c = await db().connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL auditoria.expurgo = 'liberado'`)
    await c.query(`DELETE FROM audit_log WHERE org_id IN (SELECT id FROM organizations WHERE ${onde})`, par)
    await c.query(`DELETE FROM organizations WHERE ${onde}`, par)
    await c.query('COMMIT')
  } finally {
    try { await c.query('ROLLBACK') } catch { /* já fechou */ }
    c.release()
  }
}

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/organizacao-ambiente.test.ts', sonda)
  if (!sonda.noAr) return
  // resto de rodada que caiu: o mesmo e-mail em duas organizações faz o login recusar
  await apagarOrganizacoes(`slug LIKE 'zz-org-ambiente-%'`)
  await q(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'ZZ Ambiente', $2)`,
    [ORG, `zz-org-ambiente-${ORG.slice(0, 8)}`])
  await q(
    `INSERT INTO users (org_id, name, email, password_hash, papel, role)
     SELECT $1, 'Master Ambiente', $2, password_hash, 'master', 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'`, [ORG, EMAIL])
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0])
    .find((c) => c.startsWith('dt_sessao=')) ?? ''
  expect(cookie, 'o login do master da fixture não devolveu sessão').not.toBe('')
}, 60_000)

afterAll(async () => {
  if (sonda.noAr) await apagarOrganizacoes('id = $1', [ORG])
  await db().end()
})

describe('ORG-01 — trocar só o select não muda para onde a cobrança vai, então é recusado', () => {
  it('chave de sandbox gravada + "Produção" sem chave nova → 422 e o banco não muda', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    await gravar(HMLG, 'sandbox')
    const r = await patch({ ambienteAsaas: 'production' })
    expect(r.status).toBe(422)
    expect(r.corpo.statusMessage).toMatch(/não é de produção/)
    expect(await gravado()).toMatchObject({ asaas_env: 'sandbox', asaas_api_key: HMLG })
  })

  it('chave de produção gravada + "Testes (sandbox)" → 422 (a variante que cobra de verdade)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    await gravar(PROD, 'production')
    const r = await patch({ ambienteAsaas: 'sandbox' })
    expect(r.status).toBe(422)
    expect(r.corpo.statusMessage).toMatch(/é de PRODUÇÃO/)
    expect(await gravado()).toMatchObject({ asaas_env: 'production', asaas_api_key: PROD })
  })

  it('a troca com a chave do ambiente novo junto passa, e a chave não volta em resposta nenhuma', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    await gravar(HMLG, 'sandbox')
    const r = await patch({ ambienteAsaas: 'production', chaveAsaas: PROD })
    expect(r.status).toBe(200)
    expect(await gravado()).toMatchObject({ asaas_env: 'production', asaas_api_key: PROD })
    const org = await get('/api/admin/organizacao')
    expect(JSON.stringify(org)).not.toContain(PROD)
    expect(org).toMatchObject({ ambienteEfetivo: 'production', ambienteDivergente: false })
    // e a Auditoria diz que a chave foi TROCADA — sem o valor (matriz: "Auditoria — sem vazar chave")
    const linha = await q1<any>(
      `SELECT before, after FROM audit_log WHERE org_id = $1 AND entity = 'organizacao' AND action = 'editada'
        ORDER BY created_at DESC, id DESC LIMIT 1`, [ORG])
    expect(linha?.after?.chaveAsaas).toBe('trocada')
    expect(JSON.stringify(linha)).not.toContain(PROD)
    expect(JSON.stringify(linha)).not.toContain(HMLG)
  })

  it('salvar só o nome de uma organização já divergente não é bloqueado (a tela grita, não trava)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    await gravar(PROD, 'sandbox')
    const r = await patch({ nome: 'ZZ Ambiente Renomeada' })
    expect(r.status).toBe(200)
  })

  it('banco já divergente: o GET das duas telas mostra o ambiente EFETIVO e avisa a divergência', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    await gravar(PROD, 'sandbox')
    const org = await get('/api/admin/organizacao')
    expect(org).toMatchObject({ ambienteAsaas: 'sandbox', ambienteEfetivo: 'production', ambienteDivergente: true })
    const [linha] = await get('/api/admin/organizacoes')
    expect(linha).toMatchObject({ ambienteEfetivo: 'production', ambienteDivergente: true })
    expect(JSON.stringify(linha)).not.toContain(PROD)
  })
})
