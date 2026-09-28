/**
 * Entrar e sair — a porta do painel, com cada variação que uma pessoa faz de verdade.
 */
import { expect, test } from '@playwright/test'
import { LOGINS, SENHA, entrarPeloFormulario, hidratada, sessao, vigiar } from './apoio'

test.describe('tela de entrada', () => {
  test('campos vazios não disparam o login (o navegador exige os dois)', async ({ page }) => {
    let chamou = 0
    page.on('request', (r) => { if (r.url().includes('/api/auth/entrar')) chamou++ })
    await page.goto('/entrar')
    await hidratada(page)
    await page.getByRole('button', { name: /^entrar$/i }).click()
    await page.waitForTimeout(500)
    expect(chamou).toBe(0)
    await expect(page).toHaveURL(/\/entrar/)
  })

  test('e-mail inexistente e senha errada dão a MESMA mensagem (não entrega quem existe)', async ({ page }) => {
    await entrarPeloFormulario(page, 'ninguem.e2e@exemplo.invalido', 'qualquer-coisa-1')
    const a = await page.getByRole('alert').textContent()
    await entrarPeloFormulario(page, LOGINS.master, 'senha-errada-e2e')
    const b = await page.getByRole('alert').textContent()
    expect(a?.trim()).toBeTruthy()
    expect(a?.trim()).toBe(b?.trim())
    await expect(page).toHaveURL(/\/entrar/)
  })

  test('digitou antes de a página terminar de carregar: o texto não some', async ({ page }) => {
    // A pessoa no celular com internet lenta digita assim que vê o campo. Se a hidratação do Vue
    // chega depois, o v-model escreve '' por cima do que ela digitou e o login vai vazio.
    await page.route('**/_nuxt/**', async (rota) => { await new Promise((r) => setTimeout(r, 1500)); await rota.continue() })
    await page.goto('/entrar', { waitUntil: 'commit' })
    await page.locator('#email').waitFor()
    await page.locator('#email').fill(LOGINS.master)
    await hidratada(page)
    await expect(page.locator('#email')).toHaveValue(LOGINS.master)
  })

  test('e-mail com espaço e maiúscula entra do mesmo jeito', async ({ page }) => {
    await entrarPeloFormulario(page, `  ${LOGINS.master.toUpperCase()}  `)
    await expect(page).toHaveURL(/\/admin/)
  })

  test('sem sessão, /admin manda pro login guardando o destino', async ({ page }) => {
    await page.goto('/admin/clientes')
    await expect(page).toHaveURL(/\/entrar\?de=%2Fadmin%2Fclientes|\/entrar\?de=\/admin\/clientes/)
    await hidratada(page)
    await page.getByPlaceholder(/@/).fill(LOGINS.master)
    await page.getByLabel(/senha/i).fill(SENHA)
    await page.getByRole('button', { name: /^entrar$/i }).click()
    await expect(page).toHaveURL(/\/admin\/clientes/)
  })

  for (const destino of ['https://exemplo.invalido/roubo', '//exemplo.invalido/roubo', '/\\exemplo.invalido/roubo']) {
    test(`destino de fora (${destino}) não vira redirecionador aberto`, async ({ page }) => {
      await page.goto(`/entrar?de=${encodeURIComponent(destino)}`)
      await hidratada(page)
      await page.getByPlaceholder(/@/).fill(LOGINS.master)
      await page.getByLabel(/senha/i).fill(SENHA)
      await page.getByRole('button', { name: /^entrar$/i }).click()
      // cai no painel desta casa — e SEM "Não foi possível entrar." (B27: a sessão já existia)
      await expect(page).toHaveURL(/\/admin/)
      expect(new URL(page.url()).host).toBe(new URL(test.info().project.use.baseURL!).host)
      await expect(page.getByRole('alert')).toHaveCount(0)
    })
  }

  test('duplo clique em Entrar manda UM pedido só', async ({ page }) => {
    let chamou = 0
    page.on('request', (r) => { if (r.url().includes('/api/auth/entrar') && r.method() === 'POST') chamou++ })
    await page.goto('/entrar')
    await hidratada(page)
    await page.getByPlaceholder(/@/).fill(LOGINS.master)
    await page.getByLabel(/senha/i).fill(SENHA)
    await page.getByRole('button', { name: /^entrar$/i }).dblclick()
    await expect(page).toHaveURL(/\/admin/)
    expect(chamou).toBe(1)
  })
})

test.describe('sessão', () => {
  test.use({ storageState: sessao('master') })

  test('F5 no painel mantém a pessoa logada', async ({ page }) => {
    const problemas = vigiar(page)
    await page.goto('/admin')
    await page.reload()
    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.getByRole('button', { name: /menu da sua conta/i })).toBeVisible()
    expect(problemas).toEqual([])
  })
})

test('Sair sai de verdade: o Voltar do navegador não devolve o painel', async ({ browser }) => {
  // contexto próprio — sair aqui não pode derrubar a sessão guardada dos outros casos
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await entrarPeloFormulario(page, LOGINS.master)
  await expect(page).toHaveURL(/\/admin/)
  await page.getByRole('button', { name: /menu da sua conta/i }).click()
  await page.getByRole('menuitem', { name: /sair/i }).click()
  await expect(page).toHaveURL(/\/entrar/)
  const eu = await (await page.request.get('/api/auth/eu')).json()
  expect(eu.usuario).toBeNull()
  // Voltar: o painel não pode reaparecer. O portão manda de novo pra /entrar (às vezes com um
  // redirecionamento no meio — por isso esperar a URL, não recarregar em cima dele).
  await page.goBack()
  await expect(page).toHaveURL(/\/entrar/)
  await expect(page.getByRole('button', { name: /menu da sua conta/i })).toHaveCount(0)
  // e entrar direto no endereço do painel, sem sessão, também cai no login
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/entrar/)
  await ctx.close()
})

test.describe('cada papel cai onde trabalha', () => {
  for (const [papel, email] of Object.entries(LOGINS)) {
    test(`${papel} entra e vê só o que pode`, async ({ browser }) => {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      const problemas = vigiar(page)
      await entrarPeloFormulario(page, email)
      await page.waitForURL(/\/admin/, { timeout: 30_000 })
      await page.waitForLoadState('networkidle')
      if (papel === 'portaria') {
        // a portaria só tem o leitor: cai nele (1 evento) ou na escolha do evento
        await expect(page).toHaveURL(/validacao|\/admin/)
        await expect(page.getByText(/nenhum evento aqui ainda/i)).toHaveCount(0)
      } else {
        await expect(page.getByRole('heading').first()).toBeVisible()
      }
      // nenhum item do menu leva a uma porta fechada
      const links = await page.locator('#menu-lateral a[href^="/admin"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))
      for (const href of links) {
        const r = await page.request.get(href!)
        expect(r.status(), `${papel} → ${href}`).toBeLessThan(400)
      }
      expect(problemas, `${papel}: erro no console/servidor`).toEqual([])
      await ctx.close()
    })
  }
})
