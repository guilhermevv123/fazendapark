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
    // desde o painel em formato chat (a42dbe1) o canal é um grupo de botões, não um select
    const canal = page.getByRole('group', { name: 'Canal' })
    const lista = page.locator('[data-parte="chat-conversas"]')
    await canal.getByRole('button', { name: 'Instagram' }).click()
    await lista.getByRole('button', { name: /querem comprar/i }).click()
    await page.getByRole('searchbox', { name: /buscar conversa/i }).fill('ingresso')
    await expect(page).toHaveURL(/canal=instagram/)
    await expect(page).toHaveURL(/recorte=compra/)
    await expect(page).toHaveURL(/q=ingresso/)
    await page.reload()
    await hidratada(page)
    await expect(canal.getByRole('button', { name: 'Instagram' })).toHaveAttribute('aria-pressed', 'true')
    await expect(lista.getByRole('button', { name: /querem comprar/i })).toHaveClass(/chip-ativo/)
    await expect(page.getByRole('searchbox', { name: /buscar conversa/i })).toHaveValue('ingresso')
    // opção B: volta pro WhatsApp e limpa — a URL tem que mudar junto
    await canal.getByRole('button', { name: 'WhatsApp' }).click()
    await expect(page).toHaveURL(/canal=whatsapp/)
    await canal.getByRole('button', { name: 'Todas' }).click()
    await page.getByRole('searchbox', { name: /buscar conversa/i }).fill('')
    // o "Todas" do recorte (chip), não o do canal (botão com aria-pressed)
    await lista.locator('button.chip, button.chip-ativo').filter({ hasText: /^\s*Todas/ }).click()
    await expect(page).not.toHaveURL(/canal=|recorte=|q=/)
  })

  test('abrir uma conversa: bolhas, resumo e F5 com ela aberta', async ({ page }) => {
    await page.goto('/admin/agentes')
    await hidratada(page)
    if (await page.getByText(/painel ainda não ligado|não consegui ler/i).count()) test.skip(true, 'automação fora do ar')
    const primeira = page.getByRole('button', { name: /^abrir conversa com/i }).first()
    if (!(await primeira.count())) test.skip(true, 'nenhuma conversa nos últimos 7 dias')
    await primeira.click()
    const aberta = page.locator('[data-parte="conversa-aberta"]')
    await expect(aberta.locator('[data-parte="nome-aberto"]')).toBeVisible()
    await expect(page).toHaveURL(/contato=/)
    await expect(aberta.locator('[data-parte="bolha-cliente"], [data-parte="bolha-sofia"]').first()).toBeVisible()
    await expect(aberta.locator('[data-parte="so-leitura"]')).toBeVisible()
    await page.reload()
    await hidratada(page)
    await expect(page.locator('[data-parte="conversa-aberta"] [data-parte="nome-aberto"]')).toBeVisible()
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

/**
 * Inteligência (05/10): Base de conhecimento e Promoções. A Base fala com a MESMA automação do
 * Atendimento IA (a de produção, no .env.e2e) — aqui só se LÊ; salvar mudaria o que os robôs dizem
 * pros clientes de verdade. Promoções grava no banco de teste e volta ao que era.
 */
test.describe('Inteligência · master', () => {
  test.use({ storageState: sessao('master') })

  test('Base de conhecimento abre: formulário, lista (ou vazia) e o "Assim a Sofia lê agora"', async ({ page }) => {
    await page.goto('/admin/inteligencia/base')
    await hidratada(page)
    await expect(page.getByRole('heading', { name: 'Base de conhecimento', level: 1 })).toBeVisible()
    if (await page.getByText(/não consegui ler|não está ligad/i).count()) test.skip(true, 'automação fora do ar')
    await expect(page.locator('[data-parte="itens-base"], [data-parte="base-vazia"]').first()).toBeVisible()
    await expect(page.locator('[data-parte="robos-veem"]')).toBeVisible()
    await page.locator('[data-parte="nova-informacao"]').click()
    await expect(page.locator('[data-parte="form-base"]')).toBeVisible()
  })

  test('Promoções: ligar sem vigência é recusado; com vigência grava, mostra o regulamento e sobrevive ao F5', async ({ page }) => {
    const antes = await (await page.request.get('/api/admin/inteligencia/promocoes')).json()
    try {
      await page.goto('/admin/inteligencia/promocoes')
      await hidratada(page)
      await expect(page.getByRole('heading', { name: 'Promoções', level: 1 })).toBeVisible()
      await page.locator('[data-parte="ligar-promocao"]').check()
      await page.locator('#p-inicio').fill('')
      await page.locator('#p-fim').fill('')
      await page.locator('[data-parte="salvar-promocao"]').click()
      await expect(page.getByText(/vigência/i).first()).toBeVisible()
      await page.locator('#p-inicio').fill('2026-10-01')
      await page.locator('#p-fim').fill('2026-12-31')
      await page.locator('#p-ret').fill('3')
      await expect(page.locator('[data-parte="regulamento"]')).toContainText('3 retornos')
      await page.locator('[data-parte="salvar-promocao"]').click()
      await expect(page.locator('[data-parte="recado-promocao"]')).toBeVisible()
      await page.reload()
      await hidratada(page)
      await expect(page.locator('[data-parte="ligar-promocao"]')).toBeChecked()
      await expect(page.locator('#p-ret')).toHaveValue('3')
      await expect(page.locator('[data-parte="situacao-promocao"]')).toHaveClass(/selo-ok/)
    } finally {
      const p = antes.programa
      await page.request.post('/api/admin/inteligencia/promocoes', { data: { ...p, ativo: false } })
    }
  })
})

for (const papel of ['financeiro', 'operacao', 'portaria'] as const) {
  test.describe(`${papel} não vê as conversas`, () => {
    test.use({ storageState: sessao(papel) })
    test(`${papel}: rota 403 e item fora do menu`, async ({ page }) => {
      for (const rota of ['/api/admin/agentes', '/api/admin/inteligencia/base', '/api/admin/inteligencia/promocoes']) {
        expect((await page.request.get(rota)).status(), rota).toBe(403)
      }
      await page.goto('/admin')
      for (const href of ['/admin/agentes', '/admin/inteligencia/base', '/admin/inteligencia/promocoes']) {
        await expect(page.locator(`#menu-lateral a[href="${href}"]`), href).toHaveCount(0)
      }
    })
  })
}
