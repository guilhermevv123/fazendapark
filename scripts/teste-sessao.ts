/**
 * Login de verdade para os testes de HTTP.
 *
 * Os testes passam pelo mesmo porteiro que o navegador: pedem o cookie na
 * rota de login e o carregam em cada chamada. Um atalho aqui — uma variável
 * de ambiente que desliga a autenticação em teste, por exemplo — faria a
 * suíte exercitar um caminho que não existe em produção, e a primeira falha
 * real de permissão só apareceria com o sistema no ar.
 */
const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

/** Credenciais semeadas pelo scripts/seed.mjs. */
export const CONTAS = {
  master:   { email: 'dono@fazendapark.com.br', senha: 'diamond123' },
  portaria: { email: 'portaria@fazendapark.com.br', senha: 'diamond123' },
} as const

export type Conta = keyof typeof CONTAS

/** Faz login e devolve o valor do cabeçalho Cookie para as próximas chamadas. */
export async function entrar(conta: Conta = 'master'): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(CONTAS[conta]),
  })
  if (!r.ok) throw new Error(`login de teste falhou (${r.status}) — rodou o seed?`)

  const bruto = r.headers.getSetCookie?.() ?? []
  const sessao = bruto.map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao='))
  if (!sessao) throw new Error('login não devolveu o cookie de sessão')
  return sessao
}

/** fetch com o cookie e, para métodos que mudam estado, a origem certa. */
export function comSessao(cookie: string) {
  return (rota: string, init: RequestInit = {}) =>
    fetch(`${BASE}${rota}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: BASE, // o porteiro recusa origem de outro site em POST/PATCH/DELETE
        ...(init.headers ?? {}),
      },
    })
}
