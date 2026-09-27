/**
 * A compra no CELULAR (Pixel 7 emulado) — é por onde a maioria do público compra.
 *
 * No telefone o resumo do carrinho vira a barra fixa de baixo, com o botão "Pagar"; o formulário
 * é uma coluna só e o teclado numérico aparece nos campos de número. Cada caso aqui é a versão de
 * celular de um caminho que a bateria do computador também faz.
 */
import { expect, test } from '@playwright/test'
import { hidratada, travaDeBase, vigiar } from './apoio'
import { SLUG, abrirVitrine, botaoPagar, irParaPagamento, mais, preencherDados } from './compra-apoio'

travaDeBase()

test.describe('compra no celular', () => {
  test('a barra de baixo aparece com o total e o "Pagar" leva ao pagamento', async ({ page }) => {
    const problemas = vigiar(page)
    await abrirVitrine(page)
    const pagarNaBarra = page.getByRole('button', { name: /^Pagar$/ })
    await expect(pagarNaBarra).toHaveCount(0)
    await mais(page, 'Inteira').click()
    await expect(pagarNaBarra).toBeVisible()
    await expect(page.getByText('1 ingresso', { exact: true }).first()).toBeVisible()
    // alvo de toque: o dono pediu coisa grande no celular (≥ 40 px)
    const caixa = await pagarNaBarra.boundingBox()
    expect(caixa?.height ?? 0).toBeGreaterThanOrEqual(40)
    const maisCaixa = await mais(page, 'Inteira').boundingBox()
    expect(maisCaixa?.height ?? 0).toBeGreaterThanOrEqual(40)
    await pagarNaBarra.click()
    await expect(page).toHaveURL(new RegExp(`/e/${SLUG}/pagamento`))
    expect(problemas).toEqual([])
  })

  test('nenhuma tela da compra rola pro lado', async ({ page }) => {
    await abrirVitrine(page)
    const larguraVitrine = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(larguraVitrine).toBeLessThanOrEqual(0)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    const larguraPagamento = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(larguraPagamento).toBeLessThanOrEqual(0)
  })

  test('campos de número abrem o teclado numérico', async ({ page }) => {
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    for (const id of ['cpf', 'tel', 'nascimento', 'cep']) {
      await expect(page.locator(`#${id}`), `#${id}`).toHaveAttribute('inputmode', 'numeric')
    }
    await expect(page.locator('#email')).toHaveAttribute('type', 'email')
  })

  test('PIX de ponta a ponta no celular: cobrança, F5, pagamento simulado e o ingresso na tela', async ({ page }) => {
    const problemas = vigiar(page)
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await preencherDados(page)
    const [resposta] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/checkout') && r.request().method() === 'POST'),
      botaoPagar(page).click(),
    ])
    const codigo: string = (await resposta.json()).pedido
    await expect(page.getByRole('heading', { name: 'Pague com PIX' })).toBeVisible()
    // o QR cabe na tela do telefone sem rolar pro lado
    const qr = await page.getByAltText('QR Code do PIX').boundingBox()
    expect((qr?.x ?? 0) + (qr?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.reload()
    await hidratada(page)
    await expect(page.getByText(codigo).first()).toBeVisible()
    await page.getByRole('button', { name: 'Simular pagamento recebido' }).click()
    await expect(page.getByRole('heading', { name: 'Ingressos emitidos' })).toBeVisible()
    await expect.poll(() => page.getByAltText(/QR do ingresso/).first()
      .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
    expect(problemas).toEqual([])
  })
})
