/**
 * Ajudantes da compra do cliente — usados pela bateria do computador (compra.e2e.ts) e pela do
 * celular (compra.celular.e2e.ts), pra os dois roteiros fazerem a compra do MESMO jeito.
 */
import { expect, type Page } from '@playwright/test'
import { EVENTO_SEED, centavos, hidratada } from './apoio'

export const SLUG = EVENTO_SEED.slug

/** CPF sintético que passa no dígito verificador (o mesmo cálculo do checkout). */
export function cpfDeTeste() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  if (d.every((n) => n === d[0])) d[0] = (d[0] + 1) % 10
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

/** O botão "+" de uma linha da vitrine — o `aria-label` diz o tipo; o setor desempata. */
export function mais(page: Page, tipo: string, n = 0) {
  return page.getByRole('button', { name: `Adicionar um ${tipo}` }).nth(n)
}
export function menos(page: Page, tipo: string, n = 0) {
  return page.getByRole('button', { name: `Remover um ${tipo}` }).nth(n)
}

export async function abrirVitrine(page: Page) {
  await page.goto(`/e/${SLUG}`)
  await hidratada(page)
  await expect(page.getByRole('button', { name: /Adicionar um Inteira/ }).first()).toBeVisible()
}

/** O botão que leva ao pagamento — no computador é o do resumo; no celular, o da barra de baixo. */
export const botaoIrPagar = (page: Page) =>
  page.getByRole('button', { name: /^(Ir para pagamento|Pagar)$/ }).filter({ visible: true }).first()

export async function irParaPagamento(page: Page) {
  await botaoIrPagar(page).click()
  await expect(page).toHaveURL(new RegExp(`/e/${SLUG}/pagamento`))
  await hidratada(page)
  await expect(page.locator('[data-parte="avancar"]')).toBeVisible()
}

/**
 * A senha das contas de cliente que os testes criam (034). Só existe no banco `_e2e` — cada teste
 * cria uma conta nova, com CPF e e-mail sorteados.
 */
export const SENHA_DE_TESTE = 'senha-do-e2e-2026'

export interface Dados { nome?: string; email?: string; cpf?: string; telefone?: string; cidade?: string; estado?: string }

/**
 * Cria a conta do cliente pela API, no MESMO navegador (o `page.request` divide os cookies com a
 * página): a sessão vale na tela sem passar pela janela de criar conta. Devolve o que foi mandado
 * e a resposta — quem quer testar a recusa olha o `status`.
 */
export async function criarConta(page: Page, d: Dados = {}) {
  const corpo = {
    nome: d.nome ?? 'Cliente do Teste Ponta a Ponta',
    email: d.email ?? `cliente.e2e.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@teste.invalido`,
    cpf: d.cpf ?? cpfDeTeste(),
    telefone: d.telefone ?? '73998260963',
    senha: SENHA_DE_TESTE,
    endereco: d.cidade ? { cidade: d.cidade, estado: d.estado ?? 'BA' } : null,
    evento: SLUG,
  }
  const r = await page.request.post('/api/conta/criar', { data: corpo })
  return { corpo, status: r.status(), resposta: await r.json().catch(() => ({})) }
}

/**
 * O que era "preencher o formulário do comprador": agora é ENTRAR (034). Cria a conta e recarrega o
 * pagamento — o carrinho mora no sessionStorage e continua; a tela passa a mostrar "Seus dados".
 */
export async function preencherDados(page: Page, d: Dados = {}) {
  const c = await criarConta(page, d)
  expect(c.status, JSON.stringify(c.resposta)).toBe(200)
  await page.reload()
  await hidratada(page)
  await expect(page.locator('[data-parte="seus-dados"]')).toBeVisible()
  return c.corpo
}

/** O botão do passo 2 (Pix, crédito ou débito). */
export const botaoPagar = (page: Page) => page.locator('[data-parte="pagar"]')

/** Do passo 1 ("Avançar") até o pedido criado, na forma escolhida. */
export async function pagar(page: Page, forma: 'pix' | 'credito' | 'debito' = 'pix', parcelas?: string) {
  await page.locator('[data-parte="avancar"]').click()
  await expect(page.getByRole('heading', { name: 'Como você quer pagar?' })).toBeVisible()
  if (forma !== 'pix') await page.locator(`[data-forma="${forma}"]`).click()
  if (parcelas) await page.locator('#parcelas').selectOption(parcelas)
  await botaoPagar(page).click()
}

/** Soma do resumo do carrinho na tela de pagamento (o total que a pessoa viu). */
export async function totalDoResumo(page: Page) {
  const texto = await page.locator('section').filter({ hasText: 'Total' }).first().innerText()
  const m = texto.match(/Total[\s\S]*?(R\$\s?[\d.]+,\d{2})/)
  if (!m) throw new Error(`total não encontrado no resumo: ${texto.slice(0, 300)}`)
  return centavos(m[1])
}
