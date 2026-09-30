/**
 * conta-recuperacao.test.ts — "esqueci a senha" e "confirmar o e-mail" da conta do cliente (035),
 * pela HTTP, lendo o e-mail que o servidor de teste grava em disco (transporte simulado).
 *
 * O que cada caso trava:
 *   · criar a conta manda o link de confirmação; o link confirma UMA vez; trocar o e-mail volta a
 *     "não confirmado" e o link velho não confirma o novo;
 *   · "esqueci a senha" responde IGUAL pra conta que existe e pra que não existe (e só a que existe
 *     recebe e-mail);
 *   · senha fraca NÃO queima o link; a senha boa troca, derruba as outras sessões, já entra, e o
 *     link não vale uma segunda vez; a senha velha para de entrar;
 *   · pedir um link novo aposenta o anterior; link vencido é 410;
 *   · mais de 3 links por hora: a resposta continua a mesma, mas nenhum e-mail novo sai.
 *
 * Fixture própria (organização ZZ), apagada no fim. Sem servidor no ar, PULA.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1 } from '../utils/db'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../scripts/test-setup'

const BASE = process.env.BASE_TESTE ?? BASE_DE_TESTE
const MARCA = `zzrec${Date.now().toString(36)}`
const SLUG = `${MARCA}-evento`
const PASTA = process.env.EMAIL_PASTA_SIMULADO || join(tmpdir(), 'diamond-tickets-envios')
let orgId = ''
let sonda: Sonda

function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}
const novaPessoa = () => {
  const c = cpf()
  return { nome: 'Maria Recupera Teste', cpf: c, email: `${MARCA}.${c}@exemplo.com`, telefone: '73998260963',
    senha: 'senha-antiga-9', evento: SLUG }
}

function navegador() {
  let cookie = ''
  const chamar = async (metodo: string, rota: string, body?: unknown) => {
    const r = await fetch(`${BASE}${rota}`, {
      method: metodo,
      headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [par] = c.split(';')
      if (par!.startsWith('dt_cliente=')) cookie = par!.endsWith('=') ? '' : par!
    }
    const corpo = await r.json().catch(() => ({}))
    return { status: r.status, corpo, recado: corpo.statusMessage ?? corpo.message ?? '' }
  }
  return { chamar }
}

/** Os e-mails simulados pra este endereço, do mais novo pro mais velho, já decodificados. */
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
const tokenDo = (texto: string, caminho: string) =>
  decodeURIComponent(new RegExp(`${caminho}\\?t=([A-Za-z0-9_%-]+)`).exec(texto)?.[1] ?? '')

async function criar(n = navegador(), p = novaPessoa()) {
  const r = await n.chamar('POST', '/api/conta/criar', p)
  expect(r.status, r.recado).toBe(200)
  return { n, p }
}

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu', BASE)
  anunciarPulo('conta-recuperacao.test.ts', sonda)
  orgId = (await q1<any>(
    `INSERT INTO organizations (name, slug) VALUES ('ZZ Recuperação', $1) RETURNING id`, [`${MARCA}-org`]))!.id
  await q(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online)
     VALUES ($1, 'ZZ Evento da Recuperação', $2, 'ativo', now() + interval '10 days', now() + interval '11 days', 0, 'repassar')`,
    [orgId, SLUG])
})

afterAll(async () => {
  if (orgId) {
    await q(`DELETE FROM customer_accounts WHERE org_id = $1`, [orgId])
    await q(`DELETE FROM events WHERE org_id = $1`, [orgId])
    await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  }
  await db().end()
})

describe('confirmar o e-mail (035)', { timeout: 20_000 }, () => {
  it('criar manda o link; o link confirma uma vez; a conta passa a dizer "confirmado"', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { n, p } = await criar()
    expect((await n.chamar('GET', `/api/conta/eu?evento=${SLUG}`)).corpo.conta.emailConfirmado).toBe(false)
    const [m] = await emailsPara(p.email)
    expect(m?.assunto).toContain('Confirme o seu e-mail')
    const token = tokenDo(m!.texto, '/conta/confirmar-email')
    expect(token.length).toBeGreaterThan(20)
    // sem estar logado (outro aparelho) confirma do mesmo jeito
    const r = await navegador().chamar('POST', '/api/conta/email/confirmar', { token })
    expect(r.status, r.recado).toBe(200)
    expect((await n.chamar('GET', `/api/conta/eu?evento=${SLUG}`)).corpo.conta.emailConfirmado).toBe(true)
    expect((await navegador().chamar('POST', '/api/conta/email/confirmar', { token })).status, 'o link valeu duas vezes').toBe(410)
  })

  it('trocar o e-mail volta a "não confirmado", e o link do e-mail velho não confirma o novo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { n, p } = await criar()
    const velho = tokenDo((await emailsPara(p.email))[0]!.texto, '/conta/confirmar-email')
    const novoEmail = `${MARCA}.novo.${p.cpf}@exemplo.com`
    const r = await n.chamar('PATCH', '/api/conta/eu', { ...p, email: novoEmail })
    expect(r.status, r.recado).toBe(200)
    expect(r.corpo.conta.emailConfirmado).toBe(false)
    expect((await navegador().chamar('POST', '/api/conta/email/confirmar', { token: velho })).status).toBe(410)
    const doNovo = tokenDo((await emailsPara(novoEmail))[0]!.texto, '/conta/confirmar-email')
    expect((await navegador().chamar('POST', '/api/conta/email/confirmar', { token: doNovo })).status).toBe(200)
  })
})

describe('esqueci a senha (035)', { timeout: 20_000 }, () => {
  it('a resposta é a MESMA pra conta que existe e pra que não existe', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { p } = await criar()
    const existe = await navegador().chamar('POST', '/api/conta/senha/esqueci', { login: p.cpf, evento: SLUG })
    const inventado = cpf()
    const naoExiste = await navegador().chamar('POST', '/api/conta/senha/esqueci', { login: inventado, evento: SLUG })
    expect(existe.status).toBe(200)
    expect(naoExiste.status).toBe(200)
    expect(naoExiste.corpo).toEqual(existe.corpo)
    expect((await emailsPara(p.email))[0]?.assunto).toContain('Redefinir a sua senha')
    expect(await emailsPara(`${MARCA}.${inventado}@exemplo.com`)).toEqual([])
  })

  it('senha fraca não queima o link; a boa troca, derruba as outras sessões, já entra e não vale de novo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { n: outroAparelho, p } = await criar()
    await navegador().chamar('POST', '/api/conta/senha/esqueci', { login: p.email, evento: SLUG })
    const token = tokenDo((await emailsPara(p.email))[0]!.texto, '/conta/redefinir')
    expect((await navegador().chamar('GET', `/api/conta/senha/link?t=${encodeURIComponent(token)}`)).corpo.valido).toBe(true)

    const aqui = navegador()
    const fraca = await aqui.chamar('POST', '/api/conta/senha/redefinir', { token, senha: p.cpf })
    expect(fraca.status).toBe(400)
    expect((await navegador().chamar('GET', `/api/conta/senha/link?t=${encodeURIComponent(token)}`)).corpo.valido,
      'a senha recusada gastou o link').toBe(true)

    const boa = await aqui.chamar('POST', '/api/conta/senha/redefinir', { token, senha: 'senha-nova-do-teste-7' })
    expect(boa.status, boa.recado).toBe(200)
    expect((await aqui.chamar('GET', `/api/conta/eu?evento=${SLUG}`)).corpo.conta?.cpf, 'não entrou depois de trocar').toBe(p.cpf)
    // quem abriu o link provou o e-mail
    expect((await aqui.chamar('GET', `/api/conta/eu?evento=${SLUG}`)).corpo.conta.emailConfirmado).toBe(true)
    expect((await outroAparelho.chamar('GET', `/api/conta/eu?evento=${SLUG}`)).corpo.conta, 'a sessão antiga sobreviveu').toBeNull()
    expect((await aqui.chamar('POST', '/api/conta/senha/redefinir', { token, senha: 'outra-senha-boa-8' })).status).toBe(410)

    const velha = await navegador().chamar('POST', '/api/conta/entrar', { login: p.cpf, senha: p.senha, evento: SLUG })
    expect(velha.status, 'a senha velha continuou entrando').toBe(401)
    const nova = await navegador().chamar('POST', '/api/conta/entrar', { login: p.cpf, senha: 'senha-nova-do-teste-7', evento: SLUG })
    expect(nova.status, nova.recado).toBe(200)
  })

  it('link novo aposenta o anterior; link vencido é 410', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { p } = await criar()
    await navegador().chamar('POST', '/api/conta/senha/esqueci', { login: p.cpf, evento: SLUG })
    const primeiro = tokenDo((await emailsPara(p.email))[0]!.texto, '/conta/redefinir')
    await navegador().chamar('POST', '/api/conta/senha/esqueci', { login: p.cpf, evento: SLUG })
    const segundo = tokenDo((await emailsPara(p.email))[0]!.texto, '/conta/redefinir')
    expect(segundo).not.toBe(primeiro)
    expect((await navegador().chamar('POST', '/api/conta/senha/redefinir', { token: primeiro, senha: 'senha-nova-do-teste-7' })).status).toBe(410)
    await q(`UPDATE customer_account_tokens SET expires_at = now() - interval '1 minute'
              WHERE account_id = (SELECT id FROM customer_accounts WHERE org_id = $1 AND document = $2)
                AND purpose = 'redefinir_senha' AND used_at IS NULL`, [orgId, p.cpf])
    expect((await navegador().chamar('POST', '/api/conta/senha/redefinir', { token: segundo, senha: 'senha-nova-do-teste-7' })).status).toBe(410)
  })

  it('mais de 3 links por hora: a resposta não muda, mas nenhum e-mail novo sai', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { p } = await criar()
    for (let i = 0; i < 5; i++) {
      expect((await navegador().chamar('POST', '/api/conta/senha/esqueci', { login: p.cpf, evento: SLUG })).status).toBe(200)
    }
    const deSenha = (await emailsPara(p.email)).filter((m) => m.assunto.includes('Redefinir'))
    expect(deSenha.length).toBe(3)
  })

  it('CPF ou e-mail torto no "esqueci" volta 400 com o campo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await navegador().chamar('POST', '/api/conta/senha/esqueci', { login: '123', evento: SLUG })
    expect(r.status).toBe(400)
    expect(r.corpo.data?.campo).toBe('login')
  })
})
