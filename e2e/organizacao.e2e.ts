/**
 * organizacao.e2e.ts — o painel da ORGANIZAÇÃO no navegador de verdade (frota F2, 27/09).
 *
 * Um caso por conserto visível e por painel novo da auditoria `auditoria-admin-organizacao`:
 * menu e trilha por papel, trilho no teclado, gaveta do celular, Sair sem rede, Eventos, Visão
 * geral, Financeiro, Dados e cobrança (e o site que lê o que o master preenche), Equipe, Clientes,
 * Auditoria, Organização, Reconciliação e Filas. Onde a tela mostra número, o caso compara com a
 * MESMA rota que a tela chamou (o número da tela = o número da API).
 *
 *   E2E_BASE=http://127.0.0.1:3122 npx playwright test e2e/organizacao.e2e.ts
 *
 * Efeitos que ficam no banco de E2E (nunca no real — `travaDeBase`): um evento "ZZE2E …" criado
 * pela operação no assistente, linhas de auditoria (exportação de clientes, criação do evento) e
 * uma conferência registrada na Reconciliação. Os dados da empresa preenchidos no caso do site
 * são apagados no fim do próprio caso. Nenhum saque é enviado, nenhum papel é trocado.
 *
 * Rodada de 28/09 (a "lista de um tudo" da matriz): menu da conta, três pontos, busca estranha,
 * vazio com "Mostrar todos", assistente no celular e pela URL do financeiro, Voltar do navegador,
 * "atualizando…", Financeiro por evento, edição pendente em Dados e cobrança (menu e fechar a aba),
 * Salvar no pé do celular, paginação e ficha de Clientes, relógio das Filas e a varredura de 375 px.
 * Nenhum desses grava nada: a edição pendente nunca é salva e o assistente do celular não publica.
 */
import { expect, test, type Page } from '@playwright/test'
import { BASE, EVENTO_SEED, LOGINS, SENHA, centavos, entrarPeloFormulario, hidratada, sessao, travaDeBase, unico, vigiar } from './apoio'

test.beforeAll(() => travaDeBase(BASE))

/**
 * Abre e espera hidratar. O `nuxt dev` às vezes reotimiza dependência e RECARREGA a página no meio
 * da primeira carga (o próprio preparo documenta): quando a hidratação não chega em 60 s, recarrega
 * uma vez — o que se mede é a tela, não o humor do compilador.
 */
async function abrir(page: Page, caminho: string) {
  await page.goto(caminho)
  try {
    await hidratada(page, 60_000)
  } catch {
    await page.reload()
    await hidratada(page)
  }
  await page.waitForLoadState('networkidle').catch(() => {})
}
async function api(page: Page, caminho: string) {
  const r = await page.request.get(caminho)
  expect(r.status(), `${caminho} respondeu ${r.status()}`).toBe(200)
  return r.json()
}
const kpi = (page: Page, chave: string) => page.locator(`[data-kpi="${chave}"] [data-parte="kpi-valor"]`)
const menu = (page: Page) => page.locator('nav[aria-label="Menu do painel"]')
const trilha = (page: Page) => page.locator('nav[aria-label="Onde você está"]')
const textoDaTrilha = async (page: Page) => (await trilha(page).innerText()).replace(/\s*\/\s*/g, ' / ').trim()

/** o trilho do desktop abre no hover (e no foco): recolhido, os filhos dos grupos nem se desenham */
async function abrirTrilho(page: Page) {
  await page.locator('#menu-lateral').hover()
}
async function abrirGrupos(page: Page) {
  await abrirTrilho(page)
  const fechado = menu(page).locator('button[aria-expanded="false"]')
  for (let i = 0; i < 6 && await fechado.count(); i++) await fechado.first().click()
}
async function nomesDoMenu(page: Page) {
  await abrirGrupos(page)
  return (await menu(page).locator('a, button').allInnerTexts()).map((t) => t.trim()).filter(Boolean)
}

/* ====================================================== menu e trilha por papel */

test.describe('menu por papel (layout)', () => {
  test.describe('master', () => {
    test.use({ storageState: sessao('master') })
    test('menu do master: quatro assuntos, "Dados e cobrança" com o nome do h1, e nenhum clique dá 403', async ({ page }) => {
      const problemas = vigiar(page)
      await abrir(page, '/admin')
      const nomes = await nomesDoMenu(page)
      for (const n of ['Eventos', 'Clientes', 'Relatórios', 'Visão geral', 'Financeiro', 'Configurações', 'Dados e cobrança', 'Organização', 'Equipe']) {
        expect(nomes, n).toContain(n)
      }
      expect(nomes).not.toContain('Geral e cobrança')
      for (const [link, h1] of [['Visão geral', 'Visão geral'], ['Financeiro', 'Financeiro'], ['Dados e cobrança', 'Dados e cobrança'], ['Organização', 'Organização'], ['Equipe', 'Equipe'], ['Clientes', 'Clientes']]) {
        await abrirGrupos(page)
        await menu(page).getByRole('link', { name: link, exact: true }).click()
        await hidratada(page)
        await expect(page.locator('h1')).toHaveText(h1)
        // proposta 17: um nome só por tela — menu, h1 e aba
        await expect(page).toHaveTitle(new RegExp(h1))
      }
      expect(problemas).toEqual([])
    })

    test('NAV-02/NAV-03: em Financeiro a trilha começa no assunto e o grupo Relatórios acende', async ({ page }) => {
      await abrir(page, '/admin/financeiro')
      expect(await textoDaTrilha(page)).toBe('RELATÓRIOS / FINANCEIRO')
      await expect(menu(page).locator('button[aria-expanded]', { hasText: 'Relatórios' })).toHaveAttribute('data-aceso', 'sim')
      await abrirTrilho(page)
      await expect(menu(page).getByRole('link', { name: 'Financeiro', exact: true })).toHaveAttribute('aria-current', 'page')
      await abrir(page, '/admin/configuracoes')
      expect(await textoDaTrilha(page)).toBe('CONFIGURAÇÕES / DADOS E COBRANÇA')
      await abrir(page, '/admin/clientes')
      expect(await textoDaTrilha(page)).toBe('CLIENTES')
    })

    test('NAV-01: só no teclado, o foco na lateral abre o trilho e os filhos dos grupos ficam alcançáveis', async ({ page }) => {
      await abrir(page, '/admin/financeiro')
      await page.locator('#menu-lateral a').first().focus()
      await page.keyboard.press('Tab')
      const filho = page.locator('#menu-lateral li ul a', { hasText: 'Visão geral' })
      await expect(filho).toBeVisible()
      await filho.focus()
      await page.keyboard.press('Enter')
      await expect(page).toHaveURL(/\/admin\/relatorios$/)
    })

    test('ADM-56: dentro do evento a trilha tem o nome dele e o selo da situação', async ({ page }) => {
      await abrir(page, `/admin/evento/${EVENTO_SEED.id}/vendas`)
      const resumo = await api(page, `/api/admin/evento/${EVENTO_SEED.id}/resumo`)
      expect(await textoDaTrilha(page)).toBe(`EVENTOS / ${resumo.nome.toUpperCase()} / VENDAS`)
      await expect(page.locator('header span.selo-ok', { hasText: 'PUBLICADO' })).toBeVisible()
    })

    test('NAV-04: Sair sem rede avisa que NÃO saiu, e a sessão continua', async ({ page, context }) => {
      await abrir(page, '/admin')
      await page.getByRole('button', { name: 'Menu da sua conta' }).click()
      await context.setOffline(true)
      try {
        await page.locator('[data-acao="sair"]').click()
        await expect(page.locator('[data-parte="erro-ao-sair"]')).toContainText('Não consegui sair agora')
        await expect(page).toHaveURL(/\/admin$/)
      } finally {
        await context.setOffline(false)
      }
      expect((await api(page, '/api/auth/eu')).usuario?.email).toBe(LOGINS.master)
    })

    test('troca de senha: erros na tela antes de enviar, e a atual errada volta do servidor sem sair', async ({ page }) => {
      await abrir(page, '/admin')
      await page.getByRole('button', { name: 'Menu da sua conta' }).click()
      await page.getByRole('menuitem', { name: 'Trocar senha' }).click()
      const painel = page.locator('[data-parte="modal-lateral"]')
      await expect(painel).toBeVisible()
      let envios = 0
      page.on('request', (r) => { if (r.url().endsWith('/api/auth/senha')) envios++ })
      await painel.locator('#senha-atual').fill('senha-que-nao-e')
      await painel.locator('#senha-nova').fill('curta7c')
      await painel.locator('#senha-confirma').fill('curta7c')
      await painel.getByRole('button', { name: 'Trocar senha' }).click()
      // 7 caracteres: o próprio campo (minlength=8) segura, com o balão do navegador — nada é enviado
      expect(await painel.locator('#senha-nova').evaluate((el: HTMLInputElement) => el.validity.tooShort)).toBe(true)
      expect(envios, 'a senha curta foi pro servidor').toBe(0)
      await painel.locator('#senha-nova').fill('outra-senha-longa-1')
      await painel.locator('#senha-confirma').fill('outra-senha-longa-2')
      await painel.getByRole('button', { name: 'Trocar senha' }).click()
      await expect(painel.getByRole('alert')).toContainText('A confirmação não é igual à nova senha')
      await painel.locator('#senha-confirma').fill('outra-senha-longa-1')
      await painel.getByRole('button', { name: 'Trocar senha' }).click()
      await expect(painel.getByRole('alert')).toContainText('A senha atual não confere')
      expect(envios).toBe(1)
      // NAV-05 no painel: Esc fecha
      await page.keyboard.press('Escape')
      await expect(painel).toHaveCount(0)
      expect((await api(page, '/api/auth/eu')).usuario?.email).toBe(LOGINS.master)
    })

    test('menu da conta: nome, e-mail e o acesso; fecha no Esc e no clique fora — e o topo sem sino, com o Suporte', async ({ page }) => {
      await abrir(page, '/admin')
      const eu = await api(page, '/api/auth/eu')
      const botao = page.getByRole('button', { name: 'Menu da sua conta' })
      const conta = page.locator('[role="menu"]').filter({ hasText: 'Trocar senha' })
      await botao.click()
      await expect(conta).toBeVisible()
      await expect(conta).toContainText(eu.usuario.nome)
      await expect(conta).toContainText(LOGINS.master)
      await expect(conta).toContainText(`acesso: ${eu.usuario.papelRotulo}`)
      await page.keyboard.press('Escape')
      await expect(conta).toHaveCount(0)
      await botao.click()
      await expect(conta).toBeVisible()
      await page.mouse.click(900, 650) // fora do menu: o véu pega o clique
      await expect(conta).toHaveCount(0)
      await expect(botao).toHaveAttribute('aria-expanded', 'false')
      // o sino saiu em 22/09 (era botão sem ação nenhuma); o Suporte fica, pra quem abre a tela
      const topo = page.locator('header[data-parte="topo"]')
      await expect(topo.locator('[aria-label*="otifica" i], [aria-label*="sino" i]')).toHaveCount(0)
      await expect(topo.locator('a[href="/admin/suporte"]')).toHaveCount(1)
    })
  })

  test.describe('financeiro', () => {
    test.use({ storageState: sessao('financeiro') })
    test('menu do financeiro: Eventos e Relatórios (Visão geral, Financeiro) — sem Clientes nem Configurações', async ({ page }) => {
      await abrir(page, '/admin/relatorios')
      const nomes = await nomesDoMenu(page)
      expect(nomes).toEqual(expect.arrayContaining(['Eventos', 'Relatórios', 'Visão geral', 'Financeiro']))
      for (const fora of ['Clientes', 'Configurações', 'Equipe', 'Dados e cobrança']) expect(nomes, fora).not.toContain(fora)
      // trilha: o assunto é link pra quem abre
      await expect(trilha(page).getByRole('link')).toHaveCount(0) // na Visão geral, o próprio assunto é a tela
      await abrir(page, '/admin/financeiro')
      await expect(trilha(page).getByRole('link', { name: 'RELATÓRIOS' })).toHaveAttribute('href', '/admin/relatorios')
      await expect(page.locator('header[data-parte="topo"] a[href="/admin/suporte"]')).toHaveCount(1)
      // dentro do evento, EVENTOS é link (a lista ele abre)
      await abrir(page, `/admin/evento/${EVENTO_SEED.id}/dashboard`)
      await expect(trilha(page).getByRole('link', { name: 'EVENTOS' })).toHaveAttribute('href', '/admin')
    })

    test('três pontos do evento: só Dashboard e Relatórios (as telas que ele abre)', async ({ page }) => {
      await abrir(page, '/admin')
      await page.getByRole('button', { name: 'Mais ações deste evento' }).first().click()
      const itens = (await page.locator('li[data-evento] [role="menu"] [role="menuitem"]').allInnerTexts()).map((t) => t.trim())
      expect(itens.sort()).toEqual(['Dashboard', 'Relatórios'])
    })

    test('matriz "Financeiro pela URL": abrir Criar evento mostra a recusa na entrada, sem passo pra preencher', async ({ page }) => {
      await abrir(page, '/admin/evento/novo')
      const aviso = page.locator('[data-parte="sem-acesso-criar"]')
      await expect(aviso).toContainText('Criar evento não é do seu acesso')
      await expect(aviso).toContainText('Seu acesso é de Financeiro')
      await expect(page.locator('#nome')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Prosseguir' })).toHaveCount(0)
      expect(await textoDaTrilha(page)).toBe('EVENTOS / CRIAR EVENTO')
    })
  })

  test.describe('operação', () => {
    test.use({ storageState: sessao('operacao') })
    test('menu da operação: só Eventos; sem dinheiro nenhum na lista (EVT-02)', async ({ page }) => {
      await abrir(page, '/admin')
      const nomes = await nomesDoMenu(page)
      expect(nomes).toContain('Eventos')
      for (const fora of ['Clientes', 'Relatórios', 'Financeiro', 'Configurações']) expect(nomes, fora).not.toContain(fora)
      // a faixa de números saiu da lista (28/09: "vai ser tudo em relatórios") — e dinheiro nenhum
      await expect(page.locator('[data-parte="faixa-do-dia"]')).toHaveCount(0)
      await expect(kpi(page, 'liquido-30')).toHaveCount(0)
      await expect(page.locator('header[data-parte="topo"] a[href="/admin/suporte"]')).toHaveCount(1)
      await page.getByRole('button', { name: 'Mais ações deste evento' }).first().click()
      const itens = (await page.locator('li[data-evento] [role="menu"] [role="menuitem"]').allInnerTexts()).map((t) => t.trim())
      expect(itens.sort()).toEqual(['Configurações', 'Validação e acessos'])
      await page.keyboard.press('Escape')
      // e a rota não manda o caixa pra ela
      const eventos = await api(page, '/api/admin/eventos')
      expect(eventos.length).toBeGreaterThan(0)
      for (const e of eventos) {
        expect(e.cobradoCents, `o evento ${e.nome} chegou com o caixa pra operação`).toBeUndefined()
        expect(e.liquidoCents).toBeUndefined()
      }
    })

    test('GER-01: a operação abrindo o Financeiro pela URL lê o motivo, sem "Tentar de novo"', async ({ page }) => {
      await page.goto('/admin/financeiro')
      await hidratada(page)
      await expect(page.locator('body')).toContainText(/não (é do seu acesso|inclui)|Seu acesso/i)
      await expect(page.locator('[data-acao="tentar-de-novo"]')).toHaveCount(0)
    })
  })

  test.describe('portaria', () => {
    test.use({ storageState: sessao('portaria') })
    test('portaria: no painel o menu diz o porquê; no leitor, sem "Voltar aos eventos" e sem EVENTOS como link (ADM-56)', async ({ page }) => {
      await abrir(page, '/admin')
      // o que a tela oferece segue a rota do leitor: um → vai direto pra ele; vários → um botão por
      // evento; nenhum → a frase. Com UM (a base da bateria: só o evento de exemplo está à venda) a
      // portaria nem fica no /admin, e a frase do menu é de quem fica — ela mora no teste de tela
      // (telas.test.ts). Este caso passava só no banco da frota F2, que tinha sobra de outras rodadas.
      const destino = await api(page, '/api/portaria/destino')
      if (destino.eventos.length === 1) {
        await expect(page).toHaveURL(new RegExp(`/admin/evento/${destino.eventos[0].id}/validacao`))
      } else {
        await expect(menu(page)).toContainText('Seu acesso é só o leitor de entrada')
        if (destino.eventos.length > 1) {
          for (const e of destino.eventos) await expect(page.locator(`a[href="/admin/evento/${e.id}/validacao"]`).first()).toBeVisible()
        } else {
          await expect(page.getByText('Nenhum evento com leitor aberto agora')).toBeVisible()
        }
        await expect(page.getByText('Nenhum evento aqui ainda')).toHaveCount(0)
      }
      await abrir(page, `/admin/evento/${EVENTO_SEED.id}/validacao`)
      expect(await nomesDoMenu(page)).toEqual(['Validação e acessos', 'Leitor de entrada'])
      await expect(page.getByText('Voltar aos eventos')).toHaveCount(0)
      await expect(trilha(page).getByRole('link')).toHaveCount(0)
      await expect(page.getByRole('link', { name: 'Suporte' })).toHaveCount(0)
    })
  })

  test('Sair (caminho feliz): vai pro /entrar, o /admin volta pro login com o ?de= — e entrar de novo devolve à tela', async ({ browser }) => {
    // sessão NOVA: sair com a sessão guardada derrubaria os outros casos
    const ctx = await browser.newContext({ baseURL: BASE })
    const page = await ctx.newPage()
    try {
      await entrarPeloFormulario(page, LOGINS.master, SENHA)
      await expect(page).toHaveURL(/\/admin/, { timeout: 30_000 })
      await hidratada(page)
      await page.getByRole('button', { name: 'Menu da sua conta' }).click()
      await page.locator('[data-acao="sair"]').click()
      await expect(page).toHaveURL(/\/entrar/, { timeout: 30_000 })
      await page.goto('/admin/financeiro')
      await expect(page).toHaveURL(/\/entrar\?de=%2Fadmin%2Ffinanceiro|\/entrar\?de=\/admin\/financeiro/)
      await hidratada(page)
      await page.getByPlaceholder(/@/).fill(LOGINS.master)
      await page.getByLabel(/senha/i).fill(SENHA)
      await page.getByRole('button', { name: /^entrar$/i }).click()
      await expect(page).toHaveURL(/\/admin\/financeiro$/, { timeout: 30_000 })
    } finally {
      await ctx.close()
    }
  })
})

/* ================================================================ gaveta do celular */

test.describe('gaveta do celular (NAV-05)', () => {
  test.use({ storageState: sessao('master'), viewport: { width: 390, height: 844 }, hasTouch: true })
  test('abre com o fundo travado, fecha no Esc devolvendo o foco, e navegar fecha sozinha', async ({ page }) => {
    await abrir(page, '/admin/relatorios')
    const botao = page.getByRole('button', { name: 'Abrir menu' })
    await botao.click()
    await expect(page.locator('#menu-lateral')).toHaveAttribute('role', 'dialog')
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('hidden')
    await page.keyboard.press('Escape')
    await expect(page.locator('#menu-lateral')).not.toHaveAttribute('role', 'dialog')
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('')
    await expect(botao).toBeFocused()
    // navegar fecha
    await botao.click()
    await menu(page).getByRole('link', { name: 'Clientes', exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/clientes/)
    await expect(page.locator('#menu-lateral')).not.toHaveAttribute('role', 'dialog')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })
})

/* ============================================================================ Eventos */

test.describe('Eventos (/admin)', () => {
  test.use({ storageState: sessao('master') })

  test('a lista de eventos não tem mais a faixa de números: os números moram em Relatórios (28/09)', async ({ page }) => {
    await abrir(page, '/admin')
    await expect(page.locator('li[data-evento]').first()).toBeVisible()
    await expect(page.locator('[data-parte="faixa-do-dia"]')).toHaveCount(0)
    for (const k of ['liquido-30', 'disponivel', 'hoje', 'a-venda']) await expect(kpi(page, k), k).toHaveCount(0)
  })

  test('EVT-04: busca e situação na URL — o F5 mantém e o clique no menu limpa', async ({ page }) => {
    await abrir(page, '/admin')
    await page.locator('[data-situacao="encerrado"]').click()
    await expect(page).toHaveURL(/situacao=encerrado/)
    await page.locator('[data-parte="busca"]').fill('Sábado')
    await expect(page).toHaveURL(/busca=S%C3%A1bado|busca=Sábado/)
    await expect(page.locator('li[data-evento] h2')).toHaveText(['DEMO E2E · Sábado'])
    await page.reload()
    await hidratada(page)
    await expect(page.locator('li[data-evento] h2')).toHaveText(['DEMO E2E · Sábado'])
    await expect(page.locator('[data-situacao="encerrado"]')).toHaveAttribute('aria-pressed', 'true')
    await menu(page).getByRole('link', { name: 'Eventos', exact: true }).click()
    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.locator('[data-parte="busca"]')).toHaveValue('')
    expect(await page.locator('li[data-evento]').count()).toBeGreaterThan(1)
  })

  test('EVT-05/EVT-13: selo pra cada status e a barra dos pagos com a cortesia à parte', async ({ page }) => {
    await abrir(page, '/admin')
    const eventos = await api(page, '/api/admin/eventos')
    const encerrado = eventos.find((e: any) => e.status === 'encerrado')
    await expect(page.locator(`li[data-evento="${encerrado.id}"] [data-parte="selo"]`)).toHaveText('ENCERRADO')
    await expect(page.locator('body')).not.toContainText('PAUSADO')
    const comVenda = eventos.find((e: any) => e.estoque?.total > 0)
    const barra = page.locator(`li[data-evento="${comVenda.id}"] [data-parte="pagos"]`)
    await expect(barra).toContainText(`${comVenda.estoque.pagos.toLocaleString('pt-BR')}`)
  })
})

test.describe('Eventos — busca estranha, vazio e três pontos', () => {
  test.use({ storageState: sessao('master') })

  test('busca com emoji, <script> e texto enorme: nada executa, nada acha; "Mostrar todos" limpa busca e situação', async ({ page }) => {
    await abrir(page, '/admin?situacao=encerrado')
    await page.evaluate(() => { (window as any).__injetado = false })
    const lixo = `🎢🌊 <img src=x onerror="window.__injetado=true"> <script>window.__injetado=true</script> ${'z'.repeat(520)}`
    await page.locator('[data-parte="busca"]').fill(lixo)
    await expect(page.getByText('Nenhum evento com este filtro')).toBeVisible()
    await expect(page).toHaveURL(/busca=/)
    expect(await page.evaluate(() => (window as any).__injetado)).toBe(false)
    await expect(page.locator('main img[src="x"]')).toHaveCount(0)
    await page.locator('[data-acao="mostrar-todos"]').click()
    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.locator('[data-parte="busca"]')).toHaveValue('')
    await expect(page.locator('[data-situacao="todos"]')).toHaveAttribute('aria-pressed', 'true')
    expect(await page.locator('li[data-evento]').count()).toBeGreaterThan(1)
  })

  test('três pontos: os quatro atalhos do master, um menu aberto por vez, fecha no Esc e no clique fora', async ({ page }) => {
    await abrir(page, '/admin')
    const pontos = page.getByRole('button', { name: 'Mais ações deste evento' })
    expect(await pontos.count()).toBeGreaterThan(1)
    const aberto = page.locator('li[data-evento] [role="menu"]')
    await pontos.nth(0).click()
    await expect(aberto).toHaveCount(1)
    const itens = (await aberto.getByRole('menuitem').allInnerTexts()).map((t) => t.trim())
    expect(itens.sort()).toEqual(['Configurações', 'Dashboard', 'Relatórios', 'Validação e acessos'])
    // um aberto por vez: com um menu aberto, um véu cobre a TELA INTEIRA — o próximo clique, em
    // qualquer lugar fora do menu, fecha este em vez de abrir outro
    const veu = (await page.locator('li[data-evento] div.fixed.inset-0[aria-hidden="true"]').boundingBox())!
    expect([veu.x, veu.y, veu.width, veu.height]).toEqual([0, 0, 1366, 860])
    await page.mouse.click(700, 40) // fora do menu, no alto da tela
    await expect(aberto).toHaveCount(0)
    await pontos.nth(1).click()
    await expect(aberto).toHaveCount(1)
    await expect(pontos.nth(1)).toHaveAttribute('aria-expanded', 'true')
    await expect(pontos.nth(0)).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Escape')
    await expect(aberto).toHaveCount(0)
    await expect(page).toHaveURL(/\/admin$/)
  })
})

/* ================================================== criar evento (operação, EVT-01/03/…) */

test.describe('Criar evento pela operação', () => {
  test.use({ storageState: sessao('operacao') })
  test('EVT-01/03/06/09/14: a operação cria em Manaus às 20:00 — o horário vale no fuso, UF maiúscula, faixa Livre', async ({ page }) => {
    test.setTimeout(300_000)
    const nome = unico('ZZE2E Manaus')
    await abrir(page, '/admin/evento/novo')
    await expect(page.locator('#org')).toHaveCount(0)
    await expect(page.locator('#idade')).toHaveValue('0')
    await page.locator('#nome').fill(nome)
    await page.locator('#cid').fill('Manaus')
    await page.locator('#uf').fill('am')
    await expect(page.locator('#uf')).toHaveValue('AM')
    await page.locator('#sval').fill('(92) 99999-0000')
    const prosseguir = page.getByRole('button', { name: 'Prosseguir' })
    await prosseguir.click() // → 2
    await prosseguir.click() // → 3
    await prosseguir.click() // → 4
    await page.locator('input[inputmode="numeric"]').first().fill('5000')
    await prosseguir.click() // → 5
    await page.locator('#inicio').fill('2031-05-10T20:00')
    await page.locator('#fim').fill('2031-05-10T23:00')
    await page.locator('#fuso').selectOption('America/Manaus')
    await expect(page.locator('[data-parte="aviso-fuso"]')).toContainText('valem no fuso escolhido')
    await page.getByRole('button', { name: 'Publicar evento' }).click()
    await expect(page.getByText('Evento publicado!')).toBeVisible({ timeout: 60_000 })
    await expect(page).toHaveURL(/\/admin\/evento\/[0-9a-f-]{36}\/ingressos/, { timeout: 60_000 })
    const id = page.url().match(/evento\/([0-9a-f-]{36})\//)![1]!
    const resumo = await api(page, `/api/admin/evento/${id}/resumo`)
    expect(new Date(resumo.inicio).toISOString(), '20:00 em Manaus é 00:00 UTC do dia seguinte').toBe('2031-05-11T00:00:00.000Z')
    const lista = await api(page, '/api/admin/eventos')
    expect(lista.find((e: any) => e.id === id)?.estado).toBe('AM')
    const publico = await (await page.request.get(`/api/e/${resumo.slug}`)).json()
    expect(publico.evento.classificacao, 'EVT-14: sem mexer, nasce Livre').toBe(0)
  })
})

test.describe('Criar evento no celular (375 px)', () => {
  test.use({ storageState: sessao('master'), viewport: { width: 375, height: 812 }, hasTouch: true })
  test('"Passo X de 5", nada vaza da tela e a barra roxa não cobre o último campo — no passo 1 e no 4', async ({ page }) => {
    await abrir(page, '/admin/evento/novo')
    // mede com o passo PARADO: ao avançar, o bloco entra deslizando pela direita (~0,3 s) e,
    // durante o deslize, passa uns pixels da tela — o que se mede aqui é o desenho do passo
    const medir = () => page.evaluate(async () => {
      const finitas = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      await Promise.all(finitas.map((a) => a.finished.catch(() => {})))
      window.scrollTo(0, document.documentElement.scrollHeight)
      const barra = [...document.querySelectorAll<HTMLElement>('div.fixed')].find((d) => d.textContent?.includes('Prosseguir'))!
      const campos = [...document.querySelectorAll<HTMLElement>('input:not([type="hidden"]):not([type="file"]), textarea, select')]
        .filter((e) => e.getBoundingClientRect().height > 0)
      return {
        largura: document.documentElement.scrollWidth,
        topoDaBarra: barra.getBoundingClientRect().top,
        fimDoUltimoCampo: Math.max(...campos.map((c) => c.getBoundingClientRect().bottom)),
      }
    })
    await expect(page.getByText('Passo 1 de 5')).toBeVisible()
    let m = await medir()
    expect(m.largura).toBeLessThanOrEqual(375)
    expect(m.fimDoUltimoCampo, 'a barra fixa cobre o último campo do passo 1').toBeLessThanOrEqual(m.topoDaBarra)
    await page.locator('#nome').fill(unico('ZZE2E celular'))
    await page.locator('#cid').fill('Ubatã')
    await page.locator('#sval').fill('(73) 99999-0000')
    const prosseguir = page.getByRole('button', { name: 'Prosseguir' })
    await prosseguir.click(); await prosseguir.click(); await prosseguir.click() // → 4
    await expect(page.getByText('Passo 4 de 5')).toBeVisible()
    m = await medir()
    expect(m.largura, 'a tabela de preços do passo 4 vaza no celular').toBeLessThanOrEqual(375)
    expect(m.fimDoUltimoCampo, 'a barra fixa cobre o último campo do passo 4').toBeLessThanOrEqual(m.topoDaBarra)
    // não publica nada: o caso sai com o rascunho no navegador desta sessão de teste, só
  })
})

/* ======================================================================== Visão geral */

test.describe('Visão geral (/admin/relatorios)', () => {
  test.use({ storageState: sessao('master') })

  test('os quatro números são os da rota, no recorte padrão (30 dias) e em "Tudo"', async ({ page }) => {
    await abrir(page, '/admin/relatorios')
    let r = await api(page, '/api/admin/relatorios?periodo=30d')
    expect(centavos(await kpi(page, 'liquido').innerText())).toBe(r.resumo.liquidoCents)
    expect(centavos(await kpi(page, 'cobrado').innerText())).toBe(r.resumo.cobradoCents)
    expect(await kpi(page, 'ingressos').innerText()).toBe(r.resumo.ingressosVenda.toLocaleString('pt-BR'))
    await page.getByRole('group', { name: 'Período' }).getByRole('button', { name: 'Tudo' }).click()
    await expect(page).toHaveURL(/periodo=tudo/)
    r = await api(page, '/api/admin/relatorios?periodo=tudo')
    await expect.poll(async () => centavos(await kpi(page, 'liquido').innerText())).toBe(r.resumo.liquidoCents)
    expect(centavos(await kpi(page, 'cobrado').innerText())).toBe(r.resumo.cobradoCents)
  })

  test('REL-07: filtrado por evento, o clique em "Visão geral" no menu desfiltra tela e URL (e o F5 concorda)', async ({ page }) => {
    await abrir(page, '/admin/relatorios?periodo=tudo')
    const eventos = await api(page, '/api/admin/eventos')
    const demo = eventos.find((e: any) => e.nome.startsWith('DEMO E2E · Domingo'))
    await page.locator('[data-parte="filtro-evento"]').selectOption(demo.id)
    await expect(page).toHaveURL(new RegExp(`evento=${demo.id}`))
    const soDele = await api(page, `/api/admin/relatorios?periodo=tudo&evento=${demo.id}`)
    await expect(kpi(page, 'cobrado')).toHaveText(/R\$/)
    expect(centavos(await kpi(page, 'cobrado').innerText())).toBe(soDele.resumo.cobradoCents)
    await abrirGrupos(page)
    await menu(page).getByRole('link', { name: 'Visão geral', exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/relatorios$/)
    const padrao = await api(page, '/api/admin/relatorios?periodo=30d')
    await expect.poll(async () => centavos(await kpi(page, 'cobrado').innerText())).toBe(padrao.resumo.cobradoCents)
    await page.reload()
    await hidratada(page)
    expect(centavos(await kpi(page, 'cobrado').innerText())).toBe(padrao.resumo.cobradoCents)
  })

  test('REL-10: De depois de Até é barrado dentro do filtro, e a tela continua de pé', async ({ page }) => {
    await abrir(page, '/admin/relatorios')
    await page.getByRole('group', { name: 'Período' }).getByRole('button', { name: /Datas/ }).click()
    const [de, ate] = await page.locator('input[type="date"]').all()
    await de!.fill('2026-09-20')
    await ate!.fill('2026-09-01')
    await expect(page.locator('[data-parte="erro-periodo"]')).toContainText('A data inicial vem depois da final')
    await expect(page.getByRole('button', { name: 'Aplicar' })).toBeDisabled()
    await expect(kpi(page, 'liquido')).toBeVisible()
  })

  test('exportar: a planilha "resumo" sai com número que o Excel pt-BR soma (1234,56)', async ({ page }) => {
    await abrir(page, '/admin/relatorios?periodo=tudo')
    await page.locator('[data-acao="exportar"]').click()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-planilha="resumo"]').click(),
    ])
    const caminho = await download.path()
    const texto = (await import('node:fs')).readFileSync(caminho!, 'utf8')
    const r = await api(page, '/api/admin/relatorios?periodo=tudo')
    const esperado = `${Math.trunc(r.resumo.liquidoCents / 100)},${String(r.resumo.liquidoCents % 100).padStart(2, '0')}`
    expect(texto).toContain(esperado)
    // "(R$)" no rótulo é o nome da coluna; o VALOR vai sem símbolo, pra somar
    expect(texto).not.toMatch(/R\$\s*\d/)
  })
})

test.describe('Visão geral — histórico e o link do evento', () => {
  test.use({ storageState: sessao('master') })

  test('mexer no período não empilha histórico: o Voltar do navegador sai da tela (replace, de propósito)', async ({ page }) => {
    await abrir(page, '/admin/financeiro')
    await abrirGrupos(page)
    await menu(page).getByRole('link', { name: 'Visão geral', exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/relatorios$/)
    await hidratada(page)
    await page.mouse.move(900, 500) // tira o mouse da lateral: o trilho aberto cobre os chips
    await page.waitForTimeout(500) // o trilho recolhe 200 ms depois que o mouse sai
    await page.getByRole('group', { name: 'Período' }).getByRole('button', { name: '7 dias' }).click()
    await expect(page).toHaveURL(/periodo=7d/)
    await page.getByRole('group', { name: 'Período' }).getByRole('button', { name: 'Tudo' }).click()
    await expect(page).toHaveURL(/periodo=tudo/)
    await page.goBack()
    await expect(page).toHaveURL(/\/admin\/financeiro$/)
  })

  test('REL-09: trocar o período com a rota lenta mostra "atualizando…" até o número novo chegar', async ({ page }) => {
    await abrir(page, '/admin/relatorios')
    await page.route('**/api/admin/relatorios?**', async (rota) => {
      await new Promise((r) => setTimeout(r, 2_500))
      await rota.continue()
    })
    await page.getByRole('group', { name: 'Período' }).getByRole('button', { name: '7 dias' }).click()
    const periodo = page.locator('[data-parte="periodo-resolvido"]')
    await expect(periodo).toContainText('atualizando…')
    await expect(periodo).not.toContainText('atualizando…', { timeout: 20_000 })
    await page.unroute('**/api/admin/relatorios?**')
    const r = await api(page, '/api/admin/relatorios?periodo=7d')
    expect(centavos(await kpi(page, 'cobrado').innerText())).toBe(r.resumo.cobradoCents)
  })

  test('"Por evento" abre os Relatórios daquele evento', async ({ page }) => {
    await abrir(page, '/admin/relatorios?periodo=tudo')
    const link = page.locator('main a[href^="/admin/evento/"][href$="/relatorios"]').first()
    const destino = await link.getAttribute('href')
    await link.click()
    await expect(page).toHaveURL(new RegExp(`${destino}$`))
    await hidratada(page)
    await expect(page.locator('h1')).toBeVisible()
  })
})

test.describe('Visão geral pro financeiro (REL-04, REL-05)', () => {
  test.use({ storageState: sessao('financeiro') })
  test('sem "Ver os clientes" (porta que ele não abre) e com os e-mails do topo mascarados', async ({ page }) => {
    await abrir(page, '/admin/relatorios?periodo=tudo')
    await expect(page.locator('[data-acao="ver-clientes"]')).toHaveCount(0)
    const emails = await page.locator('[data-parte="email-top"]').allInnerTexts()
    expect(emails.length).toBeGreaterThan(0)
    for (const e of emails) expect(e, 'e-mail inteiro pra quem não é master').toMatch(/\*\*\*@/)
  })
})

/* ========================================================================= Financeiro */

test.describe('Financeiro (/admin/financeiro)', () => {
  test.use({ storageState: sessao('master') })

  test('os números são os da rota, e a conta fecha: líquido = partes − saldo devedor', async ({ page }) => {
    await abrir(page, '/admin/financeiro')
    const f = await api(page, '/api/admin/financeiro')
    const t = f.totais
    expect(centavos(await kpi(page, 'liquido').innerText())).toBe(t.liquidoCents)
    expect(centavos(await kpi(page, 'disponivel').innerText())).toBe(t.disponivelCents)
    expect(centavos(await kpi(page, 'retido').innerText())).toBe(t.retidoCents)
    expect(centavos(await kpi(page, 'transferido').innerText())).toBe(t.transferidoCents)
    expect(t.transferidoCents + t.emCursoCents + t.retidoCents + t.disponivelCents + t.recebidoDiretoCents - t.saldoDevedorCents)
      .toBe(t.liquidoCents)
    if (t.saldoDevedorCents) {
      // FIN-03: o saldo negativo tem nome, em vez de virar R$ 0,00
      await expect(page.locator('[data-parte="saldo-devedor"]')).toContainText(`R$ ${(t.saldoDevedorCents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`)
    }
  })

  test('FIN-02: o botão de saque conta só o que a execução manda (PIX solicitado)', async ({ page }) => {
    await abrir(page, '/admin/financeiro')
    const f = await api(page, '/api/admin/financeiro')
    const botao = page.locator('[data-acao="enviar-saques"]')
    await expect(botao).toHaveText(`Enviar saques pendentes (${f.saques.enviaveis.pedidos})`)
    if (!f.saques.enviaveis.pedidos) await expect(botao).toBeDisabled()
    // não clica: o caso não manda dinheiro nenhum
  })

  test('FIN-05/FIN-07: período na URL (F5 mantém) e situação da transferência em português', async ({ page }) => {
    await abrir(page, '/admin/financeiro')
    await page.getByRole('group', { name: 'Período' }).getByRole('button', { name: 'Este ano' }).click()
    await expect(page).toHaveURL(/periodo=ano/)
    await page.reload()
    await hidratada(page)
    await expect(page.getByRole('group', { name: 'Período' }).getByRole('button', { name: 'Este ano' })).toHaveAttribute('aria-pressed', 'true')
    const f = await api(page, '/api/admin/financeiro?periodo=ano')
    expect(centavos(await page.locator('[data-parte="no-periodo"]').innerText())).toBe(f.noPeriodo.liquidoCents)
    const selos = await page.locator('[data-parte="situacao-transferencia"]').allInnerTexts()
    for (const s of selos) expect(['Concluída', 'Solicitada', 'Processando', 'Falhou', 'Cancelada']).toContain(s.trim())
  })
})

test.describe('Financeiro — por evento', () => {
  test.use({ storageState: sessao('master') })
  test('"libera em dd/mm/aaaa" ou "liberado" como a rota diz; "Abrir" leva ao financeiro do evento com o MESMO líquido', async ({ page }) => {
    await abrir(page, '/admin/financeiro')
    const f = await api(page, '/api/admin/financeiro')
    const linhas = page.locator('tr[data-parte="linha-evento"]')
    const n = await linhas.count()
    expect(n, 'nenhum evento com movimento na base de E2E').toBeGreaterThan(0)
    for (let i = 0; i < n; i++) {
      const linha = linhas.nth(i)
      const nome = (await linha.locator('td').first().locator('p').first().innerText()).trim()
      const e = f.eventos.find((x: any) => x.nome === nome)
      expect(e, `a linha "${nome}" não é um evento da rota`).toBeTruthy()
      if (e.liberado) await expect(linha.locator('td').first()).toContainText('liberado')
      else await expect(linha.locator('td').first()).toContainText(/libera em \d{2}\/\d{2}\/\d{4}/)
      expect(centavos(await linha.locator('td').nth(1).innerText())).toBe(e.liquidoCents)
    }
    await linhas.first().locator('[data-acao="abrir-evento"]').click()
    await expect(page).toHaveURL(/\/admin\/evento\/[0-9a-f-]{36}\/financeiro/)
    const id = page.url().match(/evento\/([0-9a-f-]{36})\//)![1]!
    const doEvento = await api(page, `/api/admin/evento/${id}/financeiro`)
    expect(doEvento.resumo.liquidoCents).toBe(f.eventos.find((x: any) => x.id === id).liquidoCents)
  })
})

/* ========================================================== Dados e cobrança + o site */

test.describe('Dados e cobrança e o site (PROD-08, CFG-01, CFG-02, ORG-01)', () => {
  test.use({ storageState: sessao('master') })

  test('CNPJ com máscara e dígito conferido; chave pela metade avisa; o selo diz pra onde a cobrança vai', async ({ page }) => {
    await abrir(page, '/admin/configuracoes')
    const org = await api(page, '/api/admin/organizacao')
    // ORG-01: o selo é o ambiente EFETIVO (o que a chave escolhe), não o do select
    await expect(page.locator('[data-parte="selo-ambiente"]')).toHaveText(org.ambienteEfetivo === 'production' ? 'PRODUÇÃO' : 'TESTES')
    const doc = page.locator('[data-parte="campo-documento"]')
    await doc.fill('12ABC34501DE36')
    await expect(doc).toHaveValue('12.ABC.345/01DE-36')
    await expect(page.locator('[data-parte="erro-documento"]')).toContainText('dígito verificador')
    await expect(page.locator('[data-acao="salvar"]')).toBeDisabled()
    await page.locator('[data-parte="campo-chave"]').fill('$aact_hmlg_123')
    await expect(page.locator('[data-parte="chave-curta"]')).toContainText('não parece a chave inteira')
    // nada foi salvo
    expect((await api(page, '/api/admin/organizacao')).documento).toBe(org.documento)
  })

  test('o master preenche quem vende e o site mostra; apaga e o site omite (sem "a preencher" pro público)', async ({ page }) => {
    test.setTimeout(300_000)
    const antes = await api(page, '/api/admin/organizacao')
    const RAZAO = 'ZZ E2E Parque Aquático LTDA'
    try {
      await abrir(page, '/admin/configuracoes')
      await expect(page.locator('[data-parte="a-preencher"]').first()).toBeVisible()
      await expect(page.locator('[data-acao="salvar"]'), 'Salvar aceso sem nada mudado').toBeDisabled()
      await page.locator('#cfg-razao').fill(RAZAO)
      await expect(page.locator('[data-acao="salvar"]')).toBeEnabled()
      await page.locator('[data-parte="campo-documento"]').fill('12ABC34501DE35')
      await page.locator('#cfg-linha').fill('Rodovia de Teste E2E, km 1')
      await page.locator('#cfg-cidade').fill('Ubatã')
      await page.locator('#cfg-uf').fill('BA')
      await page.locator('#cfg-email').fill('atendimento@e2e.teste.invalido')
      await page.locator('[data-acao="salvar"]').click()
      const salvo = page.getByRole('status').filter({ hasText: 'Salvo.' })
      await expect(salvo).toBeVisible()
      await expect(salvo, '"Salvo." não sumiu sozinho').toBeHidden({ timeout: 6_000 })
      await expect(page.locator('[data-acao="salvar"]')).toBeDisabled()
      await expect.poll(async () => (await api(page, '/api/admin/organizacao')).razaoSocial).toBe(RAZAO)

      await abrir(page, '/termos')
      await expect(page.locator('[data-parte="quem-vende"]').first()).toContainText(RAZAO)
      await expect(page.locator('[data-parte="rodape-publico"]')).toContainText('12.ABC.345/01DE-35')
      await expect(page.locator('[data-parte="rodape-publico"]')).toContainText('Rodovia de Teste E2E, km 1')
      await abrir(page, '/cancelamento')
      await expect(page.locator('[data-parte="como-pedir"]')).toContainText('atendimento@e2e.teste.invalido')
    } finally {
      // devolve como estava: campo vazio = site omite a linha
      const r = await page.request.patch('/api/admin/organizacao', {
        headers: { origin: BASE },
        data: {
          razaoSocial: antes.razaoSocial ?? '', documento: antes.documento ?? '', enderecoLinha: antes.endereco?.linha ?? '',
          enderecoCidade: antes.endereco?.cidade ?? '', enderecoUf: antes.endereco?.uf ?? '', emailAtendimento: antes.emailAtendimento ?? '',
        },
      })
      expect(r.status(), await r.text()).toBe(200)
    }
    await abrir(page, '/termos')
    await expect(page.locator('[data-parte="rodape-publico"]')).not.toContainText(RAZAO)
    await expect(page.locator('[data-parte="rodape-publico"]')).not.toContainText(/a preencher/i)
  })
})

test.describe('Dados e cobrança — edição pendente', () => {
  test.use({ storageState: sessao('master') })
  test('com alteração não salva, o menu do painel pergunta antes de sair (Cancelar fica) e fechar a aba também', async ({ page }) => {
    await abrir(page, '/admin/configuracoes')
    const antes = await api(page, '/api/admin/organizacao')
    await expect(page.locator('[data-parte="barra-salvar"]')).toHaveCount(0)
    await page.locator('#cfg-razao').click()
    await page.locator('#cfg-razao').fill('ZZ E2E edição pendente')
    await expect(page.locator('[data-parte="barra-salvar"]')).toBeVisible()
    await abrirGrupos(page)
    let pergunta = ''
    page.once('dialog', (d) => { pergunta = `${d.type()}: ${d.message()}`; void d.dismiss() })
    await menu(page).getByRole('link', { name: 'Equipe', exact: true }).click()
    await expect.poll(() => pergunta).toContain('confirm: Tem alteração não salva')
    await expect(page).toHaveURL(/\/admin\/configuracoes$/)
    await expect(page.locator('#cfg-razao')).toHaveValue('ZZ E2E edição pendente')
    expect((await api(page, '/api/admin/organizacao')).razaoSocial, 'gravou sem o Salvar').toBe(antes.razaoSocial)
    // fechar a aba (e o F5) passa pelo beforeunload: o navegador pergunta
    const dialogo = page.waitForEvent('dialog')
    await page.close({ runBeforeUnload: true })
    const d = await dialogo
    expect(d.type()).toBe('beforeunload')
    await d.accept()
  })
})

test.describe('Dados e cobrança no celular (390 px)', () => {
  test.use({ storageState: sessao('master'), viewport: { width: 390, height: 844 }, hasTouch: true })
  test('com alteração pendente, o Salvar acompanha no pé da tela — sem voltar ao topo', async ({ page }) => {
    await abrir(page, '/admin/configuracoes')
    await page.locator('#cfg-razao').fill('ZZ E2E celular')
    await page.locator('#cfg-carteira').scrollIntoViewIfNeeded()
    const topo = (await page.locator('[data-acao="salvar"]').boundingBox())!
    expect(topo.y + topo.height, 'o caso não rolou: o Salvar do topo ainda está à vista').toBeLessThan(0)
    const pe = (await page.locator('[data-acao="salvar-rodape"]').boundingBox())!
    expect(pe.y).toBeGreaterThanOrEqual(0)
    expect(pe.y + pe.height).toBeLessThanOrEqual(844)
    await expect(page.locator('[data-acao="salvar-rodape"]')).toBeEnabled()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })
})

/* ============================================================================= Equipe */

test.describe('Equipe', () => {
  test.use({ storageState: sessao('master') })

  test('EQP-01: trocar o papel pede confirmação; Cancelar não grava nada', async ({ page }) => {
    await abrir(page, '/admin/equipe')
    const select = page.locator('select[aria-label^="Papel de"]:not([disabled])').last()
    const antes = await select.inputValue()
    const outro = antes === 'operacao' ? 'portaria' : 'operacao'
    let patches = 0
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().endsWith('/api/admin/equipe')) patches++ })
    await select.selectOption(outro)
    await expect(page.locator('[data-parte="confirmar-papel"]')).toContainText('Isso desconecta')
    await page.locator('[data-acao="cancelar-papel"]').click()
    await expect(page.locator('[data-parte="confirmar-papel"]')).toHaveCount(0)
    await expect(select).toHaveValue(antes)
    expect(patches, 'gravou sem confirmar').toBe(0)
  })

  test('CFG-04: dar acesso com e-mail torto diz o campo — não "Dados inválidos"', async ({ page }) => {
    await abrir(page, '/admin/equipe')
    await page.getByRole('button', { name: 'Dar acesso a alguém' }).click()
    const painel = page.locator('[data-parte="modal-lateral"]')
    await painel.getByPlaceholder('Nome completo').fill('Pessoa E2E')
    await painel.getByPlaceholder('pessoa@empresa.com.br').fill('isto@nao-e-email')
    await painel.getByRole('button', { name: 'Criar acesso' }).click()
    await expect(painel.getByRole('alert')).toContainText('E-mail: formato errado')
    await expect(painel.getByRole('alert')).not.toContainText('Dados inválidos')
  })

  test('a linha "você" tem o select travado com a dica', async ({ page }) => {
    await abrir(page, '/admin/equipe')
    const eu = await api(page, '/api/admin/equipe')
    const meu = eu.pessoas.find((p: any) => p.id === eu.eu)
    const select = page.locator(`select[aria-label="Papel de ${meu.nome}"]`)
    await expect(select).toBeDisabled()
    await expect(select).toHaveAttribute('title', /peça a outro master/)
  })
})

/* =========================================================================== Clientes */

test.describe('Clientes', () => {
  test.use({ storageState: sessao('master') })

  test('REL-07 + proposta 16: busca na URL, topo do recorte com a base embaixo, e o menu desfiltra', async ({ page }) => {
    await abrir(page, '/admin/clientes')
    const base = await api(page, '/api/admin/clientes')
    expect(await kpi(page, 'clientes').innerText()).toBe(base.resumo.total.toLocaleString('pt-BR'))
    await page.locator('[data-parte="chip-cadastro"]').click()
    await expect(page).toHaveURL(/cadastro=1/)
    const recorte = await api(page, '/api/admin/clientes?cadastro=1')
    await expect(kpi(page, 'clientes')).toHaveText(recorte.recorte.total.toLocaleString('pt-BR'))
    await expect(page.locator('[data-kpi="clientes"] [data-parte="kpi-base"]')).toHaveText(`de ${base.resumo.total.toLocaleString('pt-BR')} na base`)
    await menu(page).getByRole('link', { name: 'Clientes', exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/clientes$/)
    await expect(kpi(page, 'clientes')).toHaveText(base.resumo.total.toLocaleString('pt-BR'))
    await expect(page.locator('[data-parte="chip-cadastro"]')).toHaveAttribute('aria-pressed', 'false')
  })

  test('CLI-01: e-mail com números não traz estranho pelo CPF ou celular', async ({ page }) => {
    await abrir(page, '/admin/clientes')
    const todos = await api(page, '/api/admin/clientes?porPagina=100')
    const alguem = todos.itens.find((c: any) => (c.telefone ?? '').replace(/\D/g, '').length >= 6)
    test.skip(!alguem, 'a base de E2E não tem cliente com celular')
    const digitos = alguem.telefone.replace(/\D/g, '').slice(2, 6)
    const busca = `ninguem${digitos}@e2e.teste.invalido`
    await page.locator('[data-parte="busca"]').fill(busca)
    await page.locator('[data-parte="busca"]').press('Enter')
    await expect(page).toHaveURL(/q=/)
    await expect(page.locator('[data-parte="vazio"]')).toContainText('Nenhum cliente com esses filtros')
    await expect(page.getByRole('button', { name: /^Exportar 0/ }), 'exportar zero clientes').toBeDisabled()
  })

  test('paginação: "1–N de N" e os dois botões apagados nas pontas', async ({ page }) => {
    await abrir(page, '/admin/clientes')
    const r = await api(page, '/api/admin/clientes')
    const { total, porPagina } = r.paginacao
    const ate = Math.min(total, porPagina)
    await expect(page.getByText(new RegExp(`1–${ate.toLocaleString('pt-BR')}\\s+de ${total.toLocaleString('pt-BR')}`))).toBeVisible()
    await expect(page.locator('[data-acao="anterior"]')).toBeDisabled()
    if (total <= porPagina) await expect(page.locator('[data-acao="proxima"]')).toBeDisabled()
    else {
      await page.locator('[data-acao="proxima"]').click()
      await expect(page).toHaveURL(/pagina=2/)
      await page.reload(); await hidratada(page)
      await expect(page.locator('[data-acao="anterior"]')).toBeEnabled()
    }
  })

  test('a ficha: CPF inteiro, WhatsApp só com número de 10/11 dígitos (nova aba), fecha no Esc, no X e no véu', async ({ page }) => {
    await abrir(page, '/admin/clientes')
    const lista = await api(page, '/api/admin/clientes?porPagina=100')
    const alvo = lista.itens.find((c: any) => c.cpf) ?? lista.itens[0]
    const linha = page.locator('tbody tr', { hasText: alvo.email }).first()
    const painel = page.locator('[data-parte="modal-lateral"]')
    await linha.click()
    await expect(painel).toBeVisible()
    const ficha = await api(page, `/api/admin/clientes/${alvo.id}`)
    const cpf = String(ficha.cpf ?? '').replace(/\D/g, '')
    if (cpf.length === 11) await expect(painel).toContainText(`${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`)
    const zap = painel.getByRole('link', { name: 'WhatsApp' })
    const digitos = String(ficha.telefone ?? '').replace(/\D/g, '')
    if (digitos.length === 10 || digitos.length === 11) {
      await expect(zap).toHaveAttribute('href', `https://wa.me/55${digitos}`)
      await expect(zap).toHaveAttribute('target', '_blank')
    } else {
      await expect(zap).toHaveCount(0)
    }
    await page.keyboard.press('Escape')
    await expect(painel).toHaveCount(0)
    await linha.click()
    await expect(painel).toBeVisible()
    await painel.getByLabel('Fechar', { exact: true }).click()
    await expect(painel).toHaveCount(0)
    await linha.click()
    await expect(painel).toBeVisible()
    await page.mouse.click(20, 400) // o véu, à esquerda do painel
    await expect(painel).toHaveCount(0)
  })

  test('CLI-04: exportar pelo botão baixa a planilha e deixa a linha na Auditoria', async ({ page }) => {
    await abrir(page, '/admin/clientes')
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /^Exportar \d/ }).click(),
    ])
    expect(download.suggestedFilename()).toMatch(/^clientes-.*\.csv$/)
    await expect(page.locator('.faixa-aviso')).toContainText('A exportação fica registrada na Auditoria')
    const aud = await api(page, '/api/admin/auditoria?entidade=clientes&periodo=hoje')
    expect(aud.linhas.some((l: any) => l.acao === 'exportado' && l.autor?.email === LOGINS.master)).toBe(true)
    // e a navegação de topo (sem o cabeçalho da tela) não exporta
    const cru = await page.request.get('/api/admin/clientes/exportar')
    expect(cru.status()).toBe(400)
  })
})

/* ========================================================================== Auditoria */

test.describe('Auditoria', () => {
  test.use({ storageState: sessao('master') })

  test('filtros na URL, o período do painel e o "Hoje" do parque; AUD-02: a criação de evento aparece com autor', async ({ page }) => {
    await abrir(page, '/admin/auditoria')
    await page.getByRole('group', { name: 'Período' }).getByRole('button', { name: 'Hoje' }).click()
    await expect(page).toHaveURL(/periodo=hoje/)
    await page.locator('[data-parte="filtro-entidade"]').selectOption('evento')
    await expect(page).toHaveURL(/entidade=evento/)
    await page.reload()
    await hidratada(page)
    await expect(page.locator('[data-parte="filtro-entidade"]')).toHaveValue('evento')
    const r = await api(page, '/api/admin/auditoria?periodo=hoje&entidade=evento')
    expect(r.filtros.de).toBe(r.filtros.ate)
    const criado = r.linhas.find((l: any) => l.acao === 'criado')
    test.skip(!criado, 'nenhum evento criado hoje nesta base (o caso da operação cria um)')
    expect(criado.autor?.nome, 'AUD-02: criação de evento sem autor').toBeTruthy()
    await expect(page.locator('tbody tr', { hasText: 'criado' }).first()).toContainText(criado.autor.nome)
  })
})

/* ======================================================================= Organização */

test.describe('Organização (ORG-02)', () => {
  test.use({ storageState: sessao('master') })
  test('um cartão, sem busca; os números são os da Visão geral com "Tudo"', async ({ page }) => {
    await abrir(page, '/admin/organizacoes')
    await expect(page.locator('input')).toHaveCount(0)
    const [org] = await api(page, '/api/admin/organizacoes')
    const vg = await api(page, '/api/admin/relatorios?periodo=tudo')
    expect(centavos(await kpi(page, 'liquido').innerText())).toBe(org.liquidoCents)
    expect(org.liquidoCents).toBe(vg.resumo.liquidoCents)
    expect(centavos(await kpi(page, 'cobrado').innerText())).toBe(vg.resumo.cobradoCents)
    await page.locator('[data-acao="editar"]').click()
    await expect(page).toHaveURL(/\/admin\/configuracoes$/)
  })
})

/* ===================================================================== Reconciliação */

test.describe('Reconciliação', () => {
  test.use({ storageState: sessao('master') })
  test('período do painel sem "Tudo", na URL; registrar conferência grava com o período resolvido', async ({ page }) => {
    await abrir(page, '/admin/reconciliacao')
    const grupo = page.getByRole('group', { name: 'Período' })
    await expect(grupo.getByRole('button', { name: 'Tudo' })).toHaveCount(0)
    await expect(grupo.getByRole('button', { name: 'Este mês' })).toHaveAttribute('aria-pressed', 'true')
    await grupo.getByRole('button', { name: '7 dias' }).click()
    await expect(page).toHaveURL(/periodo=7d/)
    const r = await api(page, '/api/admin/reconciliacao?periodo=7d')
    await page.getByRole('button', { name: 'Registrar conferência' }).click()
    await expect(page.getByText(/Conferência registrada em/)).toBeVisible()
    const depois = await api(page, '/api/admin/reconciliacao?periodo=7d')
    expect(depois.ultimaConferencia).toMatchObject({ de: r.periodo.de, ate: r.periodo.ate, por: LOGINS.master })
  })
})

/* ============================================================================== Filas */

test.describe('Filas', () => {
  test.use({ storageState: sessao('master') })
  test('"Empurrar a fila agora" devolve o recado do servidor', async ({ page }) => {
    await abrir(page, '/admin/filas')
    const botao = page.getByRole('button', { name: 'Empurrar a fila agora' })
    test.skip(!(await botao.count()), 'a tela não oferece o empurrão nesta base')
    await botao.first().click()
    await expect(page.getByText(/devolução|Fila varrida|Não havia/i).first()).toBeVisible()
  })

  test('atualiza sozinha a cada 15 s com a aba à vista — e para com a aba escondida', async ({ page }) => {
    test.setTimeout(150_000)
    let pedidos = 0
    let recargas = 0
    const ehFilas = (u: string) => new URL(u).pathname === '/api/admin/filas'
    page.on('request', (r) => { if (ehFilas(r.url())) pedidos++ })
    page.on('load', () => { recargas++ })
    await abrir(page, '/admin/filas')
    // à vista: o próximo pedido chega sozinho (o relógio é de 15 s; 20 s de folga pro nuxt dev)
    await page.waitForRequest((r) => ehFilas(r.url()), { timeout: 20_000 })
    const esconder = () => page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await esconder()
    let antes = { pedidos, recargas }
    await page.waitForTimeout(16_500)
    if (recargas !== antes.recargas) {
      // o `nuxt dev` recarregou a página no meio (reotimização de dependência): documento novo,
      // aba "à vista" de novo — esconde outra vez e mede de novo
      await hidratada(page)
      await esconder()
      antes = { pedidos, recargas }
      await page.waitForTimeout(16_500)
    }
    expect(pedidos - antes.pedidos, 'atualizou com a aba escondida').toBe(0)
  })
})

/* ================================================================= celular (375 px) */

test.describe('celular 375 px — nada vaza da tela', () => {
  test.use({ storageState: sessao('master'), viewport: { width: 375, height: 812 }, hasTouch: true })
  for (const rota of ['/admin', '/admin/relatorios?periodo=tudo', '/admin/financeiro', '/admin/clientes', '/admin/configuracoes',
    '/admin/organizacoes', '/admin/equipe', '/admin/auditoria', '/admin/reconciliacao', '/admin/filas', '/admin/suporte']) {
    test(`${rota}: a página não rola de lado; tabela larga rola dentro do cartão; botão da tabela com alvo ≥ 40 px`, async ({ page }) => {
      await abrir(page, rota)
      const r = await page.evaluate(() => {
        const tabelas = [...document.querySelectorAll('main table')].filter((t) => t.getBoundingClientRect().width > 0)
        const soltas = tabelas.filter((t) => {
          if (t.getBoundingClientRect().right <= innerWidth + 1) return false
          for (let p = t.parentElement; p; p = p.parentElement) {
            const o = getComputedStyle(p).overflowX
            if (o === 'auto' || o === 'scroll') return false
          }
          return true
        }).length
        const baixos = [...document.querySelectorAll<HTMLElement>('main table button, main table a.btn-secundario, main table select')]
          .filter((b) => { const x = b.getBoundingClientRect(); return x.height > 0 && x.height < 40 }).length
        return { largura: document.documentElement.scrollWidth, soltas, baixos }
      })
      expect(r.largura, 'a página rola de lado').toBeLessThanOrEqual(375)
      expect(r.soltas, 'tabela larga fora de um cartão que rola').toBe(0)
      expect(r.baixos, 'botão de tabela com alvo menor que 40 px').toBe(0)
      if (rota === '/admin') {
        // busca na largura toda, chips rolam de lado, três pontos com alvo ≥ 40 px
        const busca = (await page.locator('[data-parte="busca"]').boundingBox())!
        expect(busca.width).toBeGreaterThanOrEqual(375 - 2 * 16 - 2)
        const chips = page.getByRole('group', { name: 'Situação' })
        expect(await chips.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto')
        const pontos = (await page.getByRole('button', { name: 'Mais ações deste evento' }).first().boundingBox())!
        expect(Math.min(pontos.width, pontos.height)).toBeGreaterThanOrEqual(40)
      }
    })
  }
})
