/**
 * Apoio da bateria E2E — o que todo arquivo usa: a trava de endereço, os quatro logins e
 * ajudantes de tela. Nada aqui fala com o banco: o E2E só faz o que uma pessoa faz no navegador
 * (e, quando precisa preparar terreno, chama a MESMA API que a tela chamaria).
 */
import { expect, type Page } from '@playwright/test'

export const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3120'
export const SENHA = process.env.E2E_SENHA ?? 'diamond123'

export const LOGINS = {
  master: 'dono@fazendapark.com.br',
  financeiro: 'financeiro@fazendapark.com.br',
  operacao: 'operacao@fazendapark.com.br',
  portaria: 'portaria@fazendapark.com.br',
} as const
export type Papel = keyof typeof LOGINS
export const PAPEIS = Object.keys(LOGINS) as Papel[]

/** onde o `preparo` guarda o cookie de cada papel */
export const sessao = (p: Papel) => `e2e/.auth/${p}.json`

/** Evento que o seed de teste cria (id fixo — ver scripts/seed.mjs). */
export const EVENTO_SEED = { id: '3cd875a0-e230-448a-892b-d4cc840b1948', slug: 'conquista-park-4-edicao' }

/**
 * A bateria compra, cancela e estorna. Rodar contra o painel real (3100), contra o banco da suíte
 * (3101) ou contra a produção seria sujar dado de verdade — então nem começa.
 */
export function travaDeBase(base = BASE) {
  const u = new URL(base)
  if (['3100', '3101'].includes(u.port)) {
    throw new Error(`E2E recusado: ${base} é o painel real (3100) ou o da suíte vitest (3101). Use a 3120 (npm run dev:e2e).`)
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw new Error(`E2E recusado: ${base} não é máquina local — a bateria nunca roda contra produção.`)
  }
}

/** Nome que não colide com o de outra rodada (e que dá pra achar e apagar depois). */
export function unico(prefixo: string) {
  return `${prefixo} ${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
}

/**
 * A página terminou de HIDRATAR (o Vue assumiu o HTML do servidor)? Antes disso, o que se digita
 * num campo com v-model é apagado quando a hidratação chega — o E2E espera, a pessoa de verdade
 * não espera (ver o caso "digitou antes de carregar" em entrar.e2e.ts).
 */
export async function hidratada(page: Page, timeout = 120_000) {
  await page.waitForFunction(() => !!(document.querySelector('#__nuxt') as any)?.__vue_app__, null, { timeout })
}

/** Entra pelo formulário de verdade — é o caminho que a pessoa usa. */
export async function entrarPeloFormulario(page: Page, email: string, senha = SENHA) {
  await page.goto('/entrar')
  await hidratada(page)
  await page.getByPlaceholder(/@/).fill(email)
  await page.getByLabel(/senha/i).fill(senha)
  await page.getByRole('button', { name: /^entrar$/i }).click()
}

/** "R$ 1.234,56" → 123456 (centavos). Aceita o espaço fino que o toLocaleString põe. */
export function centavos(texto: string): number {
  const m = texto.replace(/ /g, ' ').match(/-?\s*R\$\s*([\d.]+,\d{2})/)
  if (!m) throw new Error(`sem valor em reais em: ${texto}`)
  return Math.round(Number(m[1].replace(/\./g, '').replace(',', '.')) * 100) * (texto.includes('-') ? -1 : 1)
}

/**
 * A página terminou de hidratar? O Nuxt marca o `#__nuxt` e o F5 no meio de uma tela só testa
 * alguma coisa se a primeira carga já tinha terminado.
 */
export async function pronta(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await expect(page.locator('#__nuxt')).toBeVisible()
}

/** Coleta erro de console e resposta 5xx durante o caso — tela "bonita" com 500 por baixo reprova. */
export function vigiar(page: Page) {
  const problemas: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|DevTools|\[vite\]|hydration/i.test(m.text())) problemas.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => problemas.push(`exceção: ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 500) problemas.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`) })
  return problemas
}
