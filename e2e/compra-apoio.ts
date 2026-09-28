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
  await expect(page.locator('#nome')).toBeVisible()
}

export interface Dados { nome?: string; email?: string; cpf?: string; nascimento?: string; cidade?: string; estado?: string }

export async function preencherDados(page: Page, d: Dados = {}) {
  await page.locator('#nome').fill(d.nome ?? 'Cliente do Teste Ponta a Ponta')
  await page.locator('#email').fill(d.email ?? `cliente.e2e.${Date.now()}@teste.invalido`)
  await page.locator('#cpf').fill(d.cpf ?? cpfDeTeste())
  await page.locator('#tel').fill('73998260963')
  await page.locator('#nascimento').fill(d.nascimento ?? '25/12/1990')
  await page.locator('#cidade').fill(d.cidade ?? 'Ubatã')
  await page.locator('#estado').selectOption(d.estado ?? 'BA')
}

export const botaoPagar = (page: Page) => page.getByRole('button', { name: /^Pagar com (PIX|cartão)$/ })

/** Soma do resumo do carrinho na tela de pagamento (o total que a pessoa viu). */
export async function totalDoResumo(page: Page) {
  const texto = await page.locator('section').filter({ hasText: 'Total' }).first().innerText()
  const m = texto.match(/Total[\s\S]*?(R\$\s?[\d.]+,\d{2})/)
  if (!m) throw new Error(`total não encontrado no resumo: ${texto.slice(0, 300)}`)
  return centavos(m[1])
}
