/**
 * Atendimento IA (/admin/agentes) — o painel do que a Sofia está conversando.
 *
 * Depende da automação (n8n) estar no ar e do AGENTES_API_* no .env.e2e. Sem isso, o caso
 * "painel sem configuração" é o que vale: a tela tem que DIZER que não está ligada, nunca
 * mostrar "nenhuma conversa" como se estivesse tudo calmo.
 */
import { expect, test } from '@playwright/test'
import { hidratada, sessao, vigiar } from './apoio'

test.describe('master', () => {
  test.use({ storageState: sessao('master') })

  test('abre com saúde, números e conversas', async ({ page }) => {
    const problemas = vigiar(page)
    await page.goto('/admin/agentes')
    await hidratada(page)
    await expect(page.getByRole('heading', { name: 'Atendimento IA' })).toBeVisible()
    const falhou = page.getByText(/painel ainda não ligado|não consegui ler o atendimento/i)
    if (await falhou.count()) test.skip(true, 'automação fora do ar ou não configurada nesta instância')
    // a lista de fluxos saiu da tela (30/09, pedido do dono): os alertas cobrem fluxo parado
    await expect(page.getByText('Fluxos da automação')).toHaveCount(0)
    await expect(page.getByText('Pessoas atendidas hoje')).toBeVisible()
    await expect(page.getByText(/Vitrine do site/i)).toBeVisible()
    await expect(page.getByRole('tab', { name: /conversas/i })).toBeVisible()
    expect(problemas).toEqual([])
  })

  test('filtros vão pra URL e sobrevivem ao F5', async ({ page }) => {
    await page.goto('/admin/agentes')
    await hidratada(page)
    if (await page.getByText(/painel ainda não ligado|não consegui ler/i).count()) test.skip(true, 'automação fora do ar')
    await page.getByRole('combobox', { name: 'Canal' }).selectOption('instagram')
    await page.getByRole('button', { name: /querem comprar/i }).click()
    await page.getByRole('searchbox', { name: /buscar conversa/i }).fill('ingresso')
    await expect(page).toHaveURL(/canal=instagram/)
    await expect(page).toHaveURL(/recorte=compra/)
    await expect(page).toHaveURL(/q=ingresso/)
    await page.reload()
    await hidratada(page)
    await expect(page.getByRole('combobox', { name: 'Canal' })).toHaveValue('instagram')
    await expect(page.getByRole('searchbox', { name: /buscar conversa/i })).toHaveValue('ingresso')
    // opção B: volta pro WhatsApp e limpa — a lista tem que mudar junto
    await page.getByRole('combobox', { name: 'Canal' }).selectOption('whatsapp')
    await expect(page).toHaveURL(/canal=whatsapp/)
    await page.getByRole('combobox', { name: 'Canal' }).selectOption('')
    await page.getByRole('searchbox', { name: /buscar conversa/i }).fill('')
    await page.getByRole('button', { name: /^todas/i }).click()
    await expect(page).not.toHaveURL(/canal=|recorte=|q=/)
  })

  test('abrir uma conversa: linha do tempo, resumo e F5 com ela aberta', async ({ page }) => {
    await page.goto('/admin/agentes')
    await hidratada(page)
    if (await page.getByText(/painel ainda não ligado|não consegui ler/i).count()) test.skip(true, 'automação fora do ar')
    const primeira = page.getByRole('button', { name: /^abrir conversa com/i }).first()
    if (!(await primeira.count())) test.skip(true, 'nenhuma conversa nos últimos 7 dias')
    await primeira.click()
    const gaveta = page.getByRole('dialog')
    await expect(gaveta).toBeVisible()
    await expect(page).toHaveURL(/contato=/)
    await expect(gaveta.getByText(/respostas/).first()).toBeVisible()
    await page.reload()
    await hidratada(page)
    await expect(page.getByRole('dialog')).toBeVisible()
    // Esc fecha e tira da URL
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page).not.toHaveURL(/contato=/)
  })

  test('aba Casos com filtro por tipo na URL', async ({ page }) => {
    await page.goto('/admin/agentes?aba=casos&tipo=reclamacao')
    await hidratada(page)
    if (await page.getByText(/painel ainda não ligado|não consegui ler/i).count()) test.skip(true, 'automação fora do ar')
    await expect(page.getByRole('tab', { name: /casos registrados/i })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: /^reclamação/i })).toHaveClass(/chip-ativo/)
  })

  test('contato inválido na URL da API é recusado com recado', async ({ page }) => {
    const r = await page.request.get('/api/admin/agentes/conversa?contato=%27%3B--')
    expect(r.status()).toBe(400)
    expect((await r.json()).statusMessage).toMatch(/contato inválido/i)
  })
})

for (const papel of ['financeiro', 'operacao', 'portaria'] as const) {
  test.describe(`${papel} não vê as conversas`, () => {
    test.use({ storageState: sessao(papel) })
    test(`${papel}: rota 403 e item fora do menu`, async ({ page }) => {
      const r = await page.request.get('/api/admin/agentes')
      expect(r.status()).toBe(403)
      await page.goto('/admin')
      await expect(page.locator('#menu-lateral a[href="/admin/agentes"]')).toHaveCount(0)
    })
  })
}
