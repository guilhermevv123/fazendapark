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
    })
  })

  test.describe('operação', () => {
    test.use({ storageState: sessao('operacao') })
    test('menu da operação: só Eventos; a faixa do dia sem dinheiro nenhum (EVT-02)', async ({ page }) => {
      await abrir(page, '/admin')
      const nomes = await nomesDoMenu(page)
      expect(nomes).toContain('Eventos')
      for (const fora of ['Clientes', 'Relatórios', 'Financeiro', 'Configurações']) expect(nomes, fora).not.toContain(fora)
      await expect(page.locator('[data-parte="faixa-do-dia"]')).toBeVisible()
      await expect(page.locator('[data-parte="faixa-do-dia"]')).not.toContainText('R$')
      await expect(kpi(page, 'liquido-30')).toHaveCount(0)
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
      await expect(menu(page)).toContainText('Seu acesso é só o leitor de entrada')
      await abrir(page, `/admin/evento/${EVENTO_SEED.id}/validacao`)
      expect(await nomesDoMenu(page)).toEqual(['Validação e acessos', 'Leitor de entrada'])
      await expect(page.getByText('Voltar aos eventos')).toHaveCount(0)
      await expect(trilha(page).getByRole('link')).toHaveCount(0)
      await expect(page.getByRole('link', { name: 'Suporte' })).toHaveCount(0)
    })
  })

  test('Sair (caminho feliz): vai pro /entrar e o /admin volta pro login com o ?de=', async ({ browser }) => {
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

  test('faixa do dia: os números são os das rotas da Visão geral e do Financeiro', async ({ page }) => {
    await abrir(page, '/admin')
    const vg = await api(page, '/api/admin/relatorios?periodo=30d')
    const caixa = await api(page, '/api/admin/financeiro')
    expect(centavos(await kpi(page, 'liquido-30').innerText())).toBe(vg.resumo.liquidoCents)
    expect(centavos(await kpi(page, 'disponivel').innerText())).toBe(caixa.totais.disponivelCents)
    const hoje = vg.porDia.find((d: any) => d.dia === vg.filtro.hoje)
    expect(centavos(await kpi(page, 'hoje').innerText())).toBe(hoje?.cobradoCents ?? 0)
    const eventos = await api(page, '/api/admin/eventos')
    expect(await kpi(page, 'a-venda').innerText()).toBe(String(eventos.filter((e: any) => e.status === 'ativo').length))
  })

  test('EVT-04: busca e situação na URL — o F5 mantém e o clique no menu limpa', async ({ page }) => {
    await abrir(page, '/admin')
    await page.locator('[data-situacao="encerrado"]').click()
    await expect(page).toHaveURL(/situacao=encerrado/)
    await page.locator('[data-parte="busca"]').fill('Sábado')
    await expect(page).toHaveURL(/busca=S%C3%A1bado|busca=Sábado/)
    await expect(page.locator('li[data-evento] h2')).toHaveText(['DEMO F2 · Sábado 29/08'])
    await page.reload()
    await hidratada(page)
    await expect(page.locator('li[data-evento] h2')).toHaveText(['DEMO F2 · Sábado 29/08'])
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
    const demo = eventos.find((e: any) => e.nome.startsWith('DEMO F2 · Domingo'))
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
      await page.locator('#cfg-razao').fill(RAZAO)
      await page.locator('[data-parte="campo-documento"]').fill('12ABC34501DE35')
      await page.locator('#cfg-linha').fill('Rodovia de Teste E2E, km 1')
      await page.locator('#cfg-cidade').fill('Ubatã')
      await page.locator('#cfg-uf').fill('BA')
      await page.locator('#cfg-email').fill('atendimento@e2e.teste.invalido')
      await page.locator('[data-acao="salvar"]').click()
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
})
