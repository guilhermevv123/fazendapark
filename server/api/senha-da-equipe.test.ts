/**
 * "Esqueci a senha" da EQUIPE (051), por HTTP — do jeito que o login do painel e da portaria usam,
 * lendo o e-mail que o servidor de teste grava em disco (transporte simulado).
 *
 * Dono, 09/10: "coloca o esqueci a senha em tudo, mesmo na portaria e no admin". Prova:
 *  1. o pedido responde IGUAL pra e-mail que existe e que não existe — e só o que existe recebe;
 *  2. o link abre a tela (vale, com o primeiro nome), a senha curta não queima o link;
 *  3. a senha nova grava, tira a provisória, derruba as sessões velhas e já entra; volta pra portaria;
 *  4. a senha velha morre; o link não serve duas vezes; um link novo aposenta o anterior;
 *  5. acesso desativado não recebe link.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { q, q1 } from '../utils/db'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../scripts/test-setup'

const BASE = process.env.BASE_TESTE ?? BASE_DE_TESTE
const MARCA = `zzeq${Date.now().toString(36)}`
const PASTA = process.env.EMAIL_PASTA_SIMULADO || join(tmpdir(), 'diamond-tickets-envios')
const EMAIL = `${MARCA}.porteira@exemplo.com`
const EMAIL_INATIVO = `${MARCA}.inativo@exemplo.com`
const SENHA_VELHA = 'Provisoria-Velha-1'
let orgId = ''
let usuarioId = ''
let sonda: Sonda

async function chamar(metodo: string, rota: string, body?: unknown, cookie = '') {
  const r = await fetch(`${BASE}${rota}`, {
    method: metodo,
    headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const sessao = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]!).find((c) => c.startsWith('dt_sessao=')) ?? ''
  const corpo = await r.json().catch(() => ({})) as any
  return { status: r.status, corpo, recado: corpo.statusMessage ?? corpo.message ?? '', sessao }
}

async function emailsPara(email: string): Promise<{ assunto: string; texto: string }[]> {
  const chave = email.replace(/[^a-zA-Z0-9]/g, '_')
  const nomes = (await readdir(PASTA).catch(() => [] as string[])).filter((n) => n.includes(chave)).sort().reverse()
  const saida = []
  for (const n of nomes) {
    const bruto = await readFile(join(PASTA, n), 'utf8')
    const assunto = Buffer.from(/Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(bruto)?.[1] ?? '', 'base64').toString('utf8')
    const b64 = /Content-Type: text\/plain; charset=UTF-8\r?\nContent-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n--/.exec(bruto)?.[1] ?? ''
    saida.push({ assunto, texto: Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8') })
  }
  return saida
}
const tokenDo = (texto: string) => decodeURIComponent(/\/redefinir-senha\?t=([A-Za-z0-9_%-]+)/.exec(texto)?.[1] ?? '')

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu', BASE)
  anunciarPulo('senha-da-equipe.test.ts', sonda)
  if (!sonda.noAr) return
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug) VALUES ('ZZ Equipe Senha', $1) RETURNING id`,
    [`${MARCA}-org`]))!.id
  const hash = await bcrypt.hash(SENHA_VELHA, 10)
  usuarioId = (await q1<any>(
    `INSERT INTO users (org_id, name, email, password_hash, role, papel, senha_provisoria)
     VALUES ($1, 'Gisele Teste Porteira', $2, $3, 'operacional', 'operacao', true) RETURNING id`, [orgId, EMAIL, hash]))!.id
  await q(`INSERT INTO users (org_id, name, email, password_hash, role, papel, active)
           VALUES ($1, 'Desligado Teste', $2, $3, 'portaria', 'portaria', false)`, [orgId, EMAIL_INATIVO, hash])
})

afterAll(async () => {
  if (orgId) {
    await q(`DELETE FROM users WHERE org_id = $1`, [orgId])
    await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  }
})

describe('esqueci a senha da equipe (051)', () => {
  it('a resposta é a mesma pra e-mail que existe e que não existe; só o que existe recebe', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const sim = await chamar('POST', '/api/auth/esqueci', { email: ` ${EMAIL.toUpperCase()} `, de: '/portaria' })
    const nao = await chamar('POST', '/api/auth/esqueci', { email: `${MARCA}.ninguem@exemplo.com` })
    const inativo = await chamar('POST', '/api/auth/esqueci', { email: EMAIL_INATIVO })
    expect(sim.status, sim.recado).toBe(200)
    expect(nao.corpo).toEqual(sim.corpo)
    expect(inativo.corpo).toEqual(sim.corpo)
    const [m] = await emailsPara(EMAIL)
    expect(m?.assunto).toContain('senha nova')
    expect(m?.texto).toMatch(/de=%2Fportaria/)
    expect(await emailsPara(`${MARCA}.ninguem@exemplo.com`)).toEqual([])
    expect(await emailsPara(EMAIL_INATIVO), 'acesso desativado recebeu link').toEqual([])
    const ruim = await chamar('POST', '/api/auth/esqueci', { email: 'fulano@gmail.-' })
    expect(ruim.status).toBe(400)
  })

  it('o link vale, senha curta não queima; a nova grava, tira a provisória e já entra', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    // uma sessão aberta antes, com a senha velha: tem que cair
    const antes = await chamar('POST', '/api/auth/entrar', { email: EMAIL, senha: SENHA_VELHA })
    expect(antes.corpo.trocarSenha).toBe(true)
    const token = tokenDo((await emailsPara(EMAIL))[0]!.texto)
    expect(token.length).toBeGreaterThan(20)

    expect((await chamar('GET', `/api/auth/redefinir?t=${encodeURIComponent(token)}`)).corpo)
      .toEqual({ valido: true, nome: 'Gisele' })
    const curta = await chamar('POST', '/api/auth/redefinir', { token, senha: '123' })
    expect(curta.status).toBe(422)

    const ok = await chamar('POST', '/api/auth/redefinir', { token, senha: 'Minha-Senha-Nova-9', de: '/portaria' })
    expect(ok.status, ok.recado).toBe(200)
    expect(ok.corpo).toMatchObject({ ok: true, destino: '/portaria' })
    expect(ok.sessao, 'não entrou depois de salvar').not.toBe('')
    const eu = await chamar('GET', '/api/auth/eu', undefined, ok.sessao)
    expect(eu.corpo.usuario?.trocarSenha).toBe(false)
    const velha = await chamar('GET', '/api/auth/eu', undefined, antes.sessao)
    expect(velha.corpo.usuario ?? null, 'a sessão de antes continuou viva').toBeNull()

    expect((await chamar('POST', '/api/auth/entrar', { email: EMAIL, senha: SENHA_VELHA })).status).toBe(401)
    const nova = await chamar('POST', '/api/auth/entrar', { email: EMAIL, senha: 'Minha-Senha-Nova-9' })
    expect(nova.corpo).toMatchObject({ ok: true, trocarSenha: false })

    const deNovo = await chamar('POST', '/api/auth/redefinir', { token, senha: 'Outra-Senha-123' })
    expect(deNovo.status, 'o link serviu duas vezes').toBe(410)
    const audit = await q1<any>(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'senha_redefinida_por_email'`, [usuarioId])
    expect(audit.n).toBe(1)
  })

  it('pedir um link novo aposenta o anterior; destino de fora vira o painel', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    await chamar('POST', '/api/auth/esqueci', { email: EMAIL, de: 'https://golpe.example/x' })
    const primeiro = tokenDo((await emailsPara(EMAIL))[0]!.texto)
    expect((await emailsPara(EMAIL))[0]!.texto).toMatch(/de=%2Fadmin/)
    await chamar('POST', '/api/auth/esqueci', { email: EMAIL })
    const segundo = tokenDo((await emailsPara(EMAIL))[0]!.texto)
    expect(segundo).not.toBe(primeiro)
    expect((await chamar('GET', `/api/auth/redefinir?t=${encodeURIComponent(primeiro)}`)).corpo.valido).toBe(false)
    expect((await chamar('GET', `/api/auth/redefinir?t=${encodeURIComponent(segundo)}`)).corpo.valido).toBe(true)
  })
})
