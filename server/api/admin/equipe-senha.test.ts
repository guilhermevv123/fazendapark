/**
 * equipe-senha.test.ts — senha, equipe e o autor da auditoria (achados de QA, 22/09).
 *
 *  1. **"Nova senha" na própria linha trancava o master fora.** O PATCH
 *     sorteava a senha e revogava TODAS as sessões do alvo, inclusive a de
 *     quem clicou; o refresh voltava 401 e a senha sorteada sumia da tela.
 *     Agora o servidor recusa (422) e a sessão continua de pé.
 *  2. **Não existia troca da própria senha.** `POST /api/auth/senha`: exige
 *     sessão e origem, confere a atual, mínimo 8, diferente da atual, derruba
 *     as OUTRAS sessões e mantém esta.
 *  3. **Auditoria sem autor.** Equipe (criar/editar) e organização gravavam
 *     `audit_log` sem `user_id`/`actor_email`. E sem senha nem chave no log.
 *  4. **Nome só com espaços passava** (zod `min(2)` antes do trim).
 *
 * Fixture própria (organização e pessoas `zzqa...@teste.invalido`, hash
 * copiado do dono — o teste não conhece nem gera senha de conta real),
 * apagada no fim. Servidor de teste fora do ar: PULA.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'
import { db, q, q1 } from '../../utils/db'

const BASE = BASE_DE_TESTE
const SENHA_DO_SEED = 'diamond123'
const PRAZO = 30_000

const ORG = randomUUID()
const marca = ORG.slice(0, 8)
const PESSOAS = {
  master: { id: randomUUID(), email: `zzqa.senha.master.${marca}@teste.invalido`, papel: 'master', role: 'master' },
  master2: { id: randomUUID(), email: `zzqa.senha.master2.${marca}@teste.invalido`, papel: 'master', role: 'master' },
  alvo: { id: randomUUID(), email: `zzqa.senha.alvo.${marca}@teste.invalido`, papel: 'operacao', role: 'operacional' },
  trocador: { id: randomUUID(), email: `zzqa.senha.trocador.${marca}@teste.invalido`, papel: 'operacao', role: 'operacional' },
} as const
const EMAIL_CRIADO = `zzqa.senha.criado.${marca}@teste.invalido`
const TODOS_EMAILS = [...Object.values(PESSOAS).map((p) => p.email), EMAIL_CRIADO]

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }

async function entrar(email: string, senha = SENHA_DO_SEED): Promise<string> {
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const r = await fetch(`${BASE}/api/auth/entrar`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, senha }),
    })
    // 5xx = `nuxt dev` reiniciando porque alguém salvou arquivo; tenta de novo
    if (r.status >= 500) { await new Promise((ok) => setTimeout(ok, 700 * tentativa)); continue }
    if (!r.ok) throw new Error(`login de ${email} falhou (${r.status})`)
    return (r.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
  }
  throw new Error(`login de ${email}: servidor respondendo 5xx`)
}

async function bater(cookie: string, rota: string, metodo = 'GET', corpo?: unknown,
  origem: string | null = BASE) {
  const headers: Record<string, string> = { cookie, 'content-type': 'application/json' }
  if (origem) headers.origin = origem
  const r = await fetch(`${BASE}${rota}`, {
    method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo),
  })
  const json = await r.json().catch(() => ({}))
  return { status: r.status, json, msg: json.statusMessage ?? json.message ?? '' }
}

const quemSouEu = async (cookie: string) =>
  (await bater(cookie, '/api/auth/eu')).json?.usuario?.email ?? null

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/equipe-senha.test.ts', sonda)
  if (!sonda.noAr) return

  // restos de rodada que caiu no meio
  await q(`DELETE FROM organizations WHERE slug LIKE 'zzqa-senha-%' AND created_at < now() - interval '30 minutes'`)

  await q(`INSERT INTO organizations (id, name, slug) VALUES ($1,'ZZQA Senha',$2)`,
    [ORG, `zzqa-senha-${marca}`])
  for (const p of Object.values(PESSOAS)) {
    await q(
      `INSERT INTO users (id, org_id, name, email, password_hash, papel, role)
       SELECT $1, $2, $3, $4, password_hash, $5, $6 FROM users WHERE email = 'dono@fazendapark.com.br'`,
      [p.id, ORG, `ZZQA ${p.papel}`, p.email, p.papel, p.role])
  }
}, 60_000)

afterAll(async () => {
  if (sonda.noAr) {
    // audit_log é só de acrescentar (trigger recusa DELETE): as linhas desta
    // fixtura ficam, como as dos outros arquivos — sem FK, não seguram nada.
    await q(`DELETE FROM users WHERE org_id = $1`, [ORG])
    await q(`DELETE FROM organizations WHERE id = $1`, [ORG])
    await q(`DELETE FROM login_attempts WHERE email = ANY($1::text[])`, [TODOS_EMAILS])
  }
  await db().end()
})

describe('Nova senha na equipe', () => {
  it('o master NÃO sorteia a própria senha — e continua logado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const cookie = await entrar(PESSOAS.master.email)

    const r = await bater(cookie, '/api/admin/equipe', 'PATCH', { id: PESSOAS.master.id, novaSenha: true })
    // ← sem a trava, 200: a sessão de quem clicou morria junto com a senha na tela
    expect(r.status, r.msg).toBe(422)
    expect(r.msg).toBe("Pra trocar a sua senha, use 'Trocar senha' no menu da conta.")
    expect(await quemSouEu(cookie), 'a sessão do master caiu').toBe(PESSOAS.master.email)

    const aindaEntra = await bater(cookie, '/api/admin/equipe')
    expect(aindaEntra.status).toBe(200)
  }, PRAZO)

  it('Nova senha de OUTRA pessoa sorteia, derruba a sessão dela e audita com autor, sem a senha', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const cookie = await entrar(PESSOAS.master.email)
    const doAlvo = await entrar(PESSOAS.alvo.email)

    const r = await bater(cookie, '/api/admin/equipe', 'PATCH', { id: PESSOAS.alvo.id, novaSenha: true })
    expect(r.status, r.msg).toBe(200)
    expect(r.json.senhaProvisoria).toMatch(/^[A-Za-z2-9]{14}$/)
    expect(await quemSouEu(doAlvo), 'a sessão antiga do alvo ficou de pé').toBeNull()
    expect(await quemSouEu(cookie)).toBe(PESSOAS.master.email)

    const linha = await q1<any>(
      `SELECT user_id, actor_email, before, after::text AS after FROM audit_log
        WHERE org_id = $1 AND entity = 'usuario' AND entity_id = $2 AND action = 'editado'
        ORDER BY id DESC LIMIT 1`, [ORG, PESSOAS.alvo.id])
    // ← com o INSERT cru, user_id e actor_email NULL
    expect(linha?.user_id, 'auditoria sem autor').toBe(PESSOAS.master.id)
    expect(linha?.actor_email).toBe(PESSOAS.master.email)
    expect(linha?.after).toContain('senhaTrocada')
    expect(linha?.after, 'a senha sorteada foi parar no log').not.toContain(r.json.senhaProvisoria)
  }, PRAZO)

  it('criar acesso: nome só com espaços é recusado; o válido audita com autor', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const cookie = await entrar(PESSOAS.master.email)

    const vazio = await bater(cookie, '/api/admin/equipe', 'POST',
      { nome: '    ', email: EMAIL_CRIADO, papel: 'portaria' })
    // ← com `min(2)` antes do trim, 200 e um acesso sem nome
    expect(vazio.status, vazio.msg).toBe(400)

    const ok = await bater(cookie, '/api/admin/equipe', 'POST',
      { nome: '  Pessoa Criada  ', email: EMAIL_CRIADO, papel: 'portaria' })
    expect(ok.status, ok.msg).toBe(200)
    expect(ok.json.usuario.nome).toBe('Pessoa Criada')

    const linha = await q1<any>(
      `SELECT user_id, actor_email, after::text AS after FROM audit_log
        WHERE org_id = $1 AND entity = 'usuario' AND entity_id = $2 AND action = 'criado'`,
      [ORG, ok.json.usuario.id])
    expect(linha?.user_id).toBe(PESSOAS.master.id)
    expect(linha?.actor_email).toBe(PESSOAS.master.email)
    expect(linha?.after).not.toContain(ok.json.senhaProvisoria)
  }, PRAZO)

  it('renomear alguém com espaços é recusado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const cookie = await entrar(PESSOAS.master.email)
    const r = await bater(cookie, '/api/admin/equipe', 'PATCH', { id: PESSOAS.master2.id, nome: '   ' })
    expect(r.status, r.msg).toBe(400)
  }, PRAZO)
})

describe('organização: autor na auditoria e nome sem espaços', () => {
  it('nome só com espaços é recusado; a edição válida audita com autor', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const cookie = await entrar(PESSOAS.master.email)

    const vazio = await bater(cookie, '/api/admin/organizacao', 'PATCH', { nome: '   ' })
    expect(vazio.status, vazio.msg).toBe(400)

    const ok = await bater(cookie, '/api/admin/organizacao', 'PATCH', { documento: '12345678000199' })
    expect(ok.status, ok.msg).toBe(200)

    const linha = await q1<any>(
      `SELECT user_id, actor_email, before, after FROM audit_log
        WHERE org_id = $1 AND entity = 'organizacao' AND action = 'editada'
        ORDER BY id DESC LIMIT 1`, [ORG])
    expect(linha?.user_id, 'auditoria da organização sem autor').toBe(PESSOAS.master.id)
    expect(linha?.actor_email).toBe(PESSOAS.master.email)
    expect(linha?.after).toMatchObject({ documento: '12345678000199' })
    expect(linha?.before).toMatchObject({ documento: null })
  }, PRAZO)
})

describe('POST /api/auth/senha — trocar a própria senha', () => {
  it('sem sessão: 401', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await bater('', '/api/auth/senha', 'POST', { atual: SENHA_DO_SEED, nova: 'outra-senha-1' })
    expect(r.status).toBe(401)
  }, PRAZO)

  it('de outro site: 403, e a senha não muda', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const cookie = await entrar(PESSOAS.trocador.email)
    const r = await bater(cookie, '/api/auth/senha', 'POST',
      { atual: SENHA_DO_SEED, nova: 'outra-senha-1' }, 'https://malicioso.invalido')
    expect(r.status).toBe(403)
    expect(await quemSouEu(await entrar(PESSOAS.trocador.email))).toBe(PESSOAS.trocador.email)
  }, PRAZO)

  it('recusa senha atual errada, nova curta e nova igual à atual', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const cookie = await entrar(PESSOAS.trocador.email)

    const errada = await bater(cookie, '/api/auth/senha', 'POST', { atual: 'nao-e-esta', nova: 'outra-senha-1' })
    expect(errada.status).toBe(422)
    expect(errada.msg).toBe('A senha atual não confere.')

    const curta = await bater(cookie, '/api/auth/senha', 'POST', { atual: SENHA_DO_SEED, nova: '1234567' })
    expect(curta.status).toBe(422)
    expect(curta.msg).toMatch(/pelo menos 8/)

    const igual = await bater(cookie, '/api/auth/senha', 'POST', { atual: SENHA_DO_SEED, nova: SENHA_DO_SEED })
    expect(igual.status).toBe(422)
    expect(igual.msg).toMatch(/diferente da atual/)

    // e a sessão segue viva depois dos três erros
    expect(await quemSouEu(cookie)).toBe(PESSOAS.trocador.email)
    await q(`DELETE FROM login_attempts WHERE email = $1`, [PESSOAS.trocador.email])
  }, PRAZO)

  it('troca: mantém ESTA sessão, derruba as outras, a nova senha entra e a velha não, audita sem senha', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const aqui = await entrar(PESSOAS.trocador.email)
    const noCelular = await entrar(PESSOAS.trocador.email)
    const NOVA = `zzqa-nova-${marca}`

    const r = await bater(aqui, '/api/auth/senha', 'POST', { atual: SENHA_DO_SEED, nova: NOVA })
    expect(r.status, r.msg).toBe(200)
    expect(r.json.sessoesEncerradas).toBeGreaterThanOrEqual(1)

    expect(await quemSouEu(aqui), 'quem trocou a senha foi jogado pro login').toBe(PESSOAS.trocador.email)
    expect(await quemSouEu(noCelular), 'a sessão do outro aparelho ficou de pé').toBeNull()

    expect(await quemSouEu(await entrar(PESSOAS.trocador.email, NOVA))).toBe(PESSOAS.trocador.email)
    await expect(entrar(PESSOAS.trocador.email, SENHA_DO_SEED)).rejects.toThrow(/401/)

    const linha = await q1<any>(
      `SELECT user_id, actor_email, after::text AS after FROM audit_log
        WHERE org_id = $1 AND action = 'senha_trocada' AND entity_id = $2
        ORDER BY id DESC LIMIT 1`, [ORG, PESSOAS.trocador.id])
    expect(linha?.user_id).toBe(PESSOAS.trocador.id)
    expect(linha?.actor_email).toBe(PESSOAS.trocador.email)
    expect(linha?.after, 'a senha nova foi parar no log').not.toContain(NOVA)
  }, PRAZO)
})
