/**
 * Teste do porteiro.
 *
 * O que ele guarda não é a tela de login — é a promessa de que **rota
 * administrativa nova nasce trancada**. O middleware tranca por prefixo, e o
 * teste abaixo percorre TODAS as rotas sob /api/admin que existem no
 * repositório: se alguém criar uma rota nova e ela responder sem sessão, este
 * teste fica vermelho sozinho, sem ninguém precisar lembrar de adicionar caso.
 *
 * Precisa do servidor de dev no ar. Sem ele, PULA em vez de falhar.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { comSessao, CONTAS, entrar } from '../../scripts/teste-sessao'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
const SLUG = 'conquista-park-4-edicao'

let noAr = false
beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/e/${SLUG}`, { signal: AbortSignal.timeout(2500) })).ok
  } catch { noAr = false }
})

/** Varre server/api/admin e devolve a URL de cada rota, com id de exemplo. */
function rotasAdmin(dir = join(process.cwd(), 'server/api/admin'), prefixo = '/api/admin') {
  const achados: { url: string; metodo: string }[] = []
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome)
    if (statSync(caminho).isDirectory()) {
      achados.push(...rotasAdmin(caminho, `${prefixo}/${nome.replace(/^\[.+\]$/, 'id-exemplo')}`))
      continue
    }
    if (!nome.endsWith('.ts') || nome.includes('.test.')) continue
    const m = nome.match(/^(.+?)\.(get|post|patch|delete|put)\.ts$/)
    if (!m) continue
    const arquivo = m[1] === 'index' ? '' : `/${m[1]}`
    achados.push({ url: prefixo + arquivo, metodo: m[2].toUpperCase() })
  }
  return achados
}

describe('porteiro das rotas administrativas', () => {
  it('nenhuma rota sob /api/admin responde sem sessão', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const rotas = rotasAdmin()
    expect(rotas.length, 'a varredura não achou rota nenhuma — o caminho mudou?')
      .toBeGreaterThan(3)

    const abertas: string[] = []
    for (const { url, metodo } of rotas) {
      const r = await fetch(`${BASE}${url}`, {
        method: metodo,
        headers: { 'content-type': 'application/json' },
        body: metodo === 'GET' ? undefined : '{}',
      })
      // 401 é o esperado. Qualquer outra coisa significa que a rota respondeu
      // (ou validou o corpo) ANTES de exigir login.
      if (r.status !== 401) abertas.push(`${metodo} ${url} → ${r.status}`)
    }
    expect(abertas, 'rota administrativa acessível sem login').toEqual([])
  })

  it('rota pública continua pública', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    for (const url of [`/api/e/${SLUG}`, '/api/eventos-publicos', '/api/auth/eu']) {
      expect((await fetch(`${BASE}${url}`)).status, url).toBe(200)
    }
  })

  it('senha errada e e-mail inexistente dão a MESMA resposta', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const tentar = (email: string, senha: string) =>
      fetch(`${BASE}/api/auth/entrar`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, senha }),
      }).then(async (r) => ({ status: r.status, msg: (await r.json()).statusMessage }))

    // e-mail aleatório para não esbarrar no freio de tentativas de outro teste
    const a = await tentar(CONTAS.master.email, 'senha-errada-' + Date.now())
    const b = await tentar(`nao-existe-${Date.now()}@teste.com`, 'x')

    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    expect(a.msg).toBe(b.msg) // ← senão a mensagem vira oráculo de quem tem conta
  })

  it('portaria não entra em rota de evento, mas entra na portaria', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const http = comSessao(await entrar('portaria'))

    const evento = await http('/api/admin/eventos')
    expect(evento.status).toBe(403)

    // no check-in ela passa do porteiro; o 400 é a validação do corpo vazio,
    // ou seja, chegou no handler.
    const portaria = await http('/api/checkin', { method: 'POST', body: '{}' })
    expect(portaria.status).toBe(400)
  })

  it('o segredo da sessão não fica em claro no banco', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const cookie = await entrar('master')
    const segredo = cookie.split('=')[1]

    const { q } = await import('../utils/db')
    const linhas = await q<any>(
      `SELECT token_hash FROM sessions WHERE revoked_at IS NULL
         AND created_at > now() - interval '1 minute'`)

    expect(linhas.length).toBeGreaterThan(0)
    for (const l of linhas) {
      expect(l.token_hash).not.toBe(segredo)
      expect(l.token_hash).toMatch(/^[0-9a-f]{64}$/) // sha-256 em hexadecimal
    }
  })

  it('sair revoga a sessão de verdade', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const cookie = await entrar('master')
    const http = comSessao(cookie)

    expect((await http('/api/admin/eventos')).status).toBe(200)
    await http('/api/auth/sair', { method: 'POST' })
    // o cookie continua na mão do cliente; o que morreu foi a sessão no banco
    expect((await http('/api/admin/eventos')).status).toBe(401)
  })

  it('recusa POST vindo de outra origem', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const cookie = await entrar('master')
    const r = await fetch(`${BASE}/api/admin/evento/id-exemplo/ingressos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://site-malicioso.com' },
      body: '{}',
    })
    expect(r.status).toBe(403)
  })
})
