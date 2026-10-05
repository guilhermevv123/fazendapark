/**
 * filtros-rapidos.e2e.ts — filtro na URL com troca RÁPIDA, em toda tela de filtro do painel.
 *
 * O defeito (auditoria 28/09): cada troca de filtro navega, e uma troca feita enquanto a anterior
 * ainda navegava era engolida (`navigateTo` durante o middleware de outra navegação só devolve o
 * destino) ou apagava a anterior (consulta montada da rota velha). A tela mostrava o filtro novo,
 * a URL não — e o F5 mostrava outra coisa. O conserto é `app/composables/consultaNaUrl.ts`.
 *
 * A janela, medida no código antigo com a segunda troca disparada N ms depois da primeira:
 * Clientes perdia a troca em até 1 ms; o Atendimento IA, em até 10 ms — e ele navega a CADA TECLA
 * da busca: num celular fraco (4 a 10× mais lento), digitar rápido deixava as últimas letras fora
 * da URL. Ações do Playwright não servem pra isto (ele espera a tela estabilizar entre uma e outra,
 * e a navegação termina nesse meio-tempo): as trocas saem daqui, no próprio navegador, com o
 * intervalo exato. Código antigo: vermelho. Código novo: verde.
 */
import { expect, test, type Page } from '@playwright/test'
import { BASE, hidratada, sessao, travaDeBase } from './apoio'

test.beforeAll(() => travaDeBase(BASE))
test.use({ storageState: sessao('master') })

type Troca = { seletor: string; valor?: string; texto?: string; clique?: boolean }

async function abrir(page: Page, caminho: string) {
  await page.goto(caminho)
  await hidratada(page)
}

/** Dispara as trocas no navegador, uma a cada `intervaloMs`, como a mão rápida (ou o celular lento). */
async function emSequencia(page: Page, trocas: Troca[], intervaloMs: number) {
  await page.evaluate(async ({ trocas, intervaloMs }) => {
    for (const [i, t] of trocas.entries()) {
      if (i) await new Promise((r) => setTimeout(r, intervaloMs))
      const candidatos = [...document.querySelectorAll<HTMLElement>(t.seletor)]
      const el = (t.texto ? candidatos.find((c) => c.textContent?.trim() === t.texto) : candidatos[0]) as any
      if (!el) throw new Error(`não achei ${t.seletor} ${t.texto ?? ''}`)
      if (t.clique) { el.click(); continue }
      el.value = t.valor
      el.dispatchEvent(new Event(el.tagName === 'INPUT' ? 'input' : 'change', { bubbles: true }))
    }
  }, { trocas, intervaloMs })
}

const PERIODO = '[role="group"][aria-label="Período"] button'
const periodo = (page: Page, nome: string) =>
  page.getByRole('group', { name: 'Período' }).getByRole('button', { name: nome, exact: true })
const segundaOpcao = (page: Page, seletor: string) => page.locator(seletor).locator('option').nth(1).getAttribute('value')

test('Eventos: dois chips de situação em sequência — vale o ÚLTIMO, na URL e no F5', async ({ page }) => {
  await abrir(page, '/admin')
  await emSequencia(page, [
    { seletor: '[data-situacao="encerrado"]', clique: true },
    { seletor: '[data-situacao="rascunho"]', clique: true },
  ], 0)
  await expect(page).toHaveURL(/situacao=rascunho/)
  await page.reload()
  await hidratada(page)
  await expect(page.locator('[data-situacao="rascunho"]')).toHaveAttribute('aria-pressed', 'true')
})

test('Clientes: idade e ordem em sequência — as duas na URL e no F5', async ({ page }) => {
  await abrir(page, '/admin/clientes')
  test.skip(!(await page.locator('[data-parte="filtro-faixa"]').count()), 'sem cliente nesta base: a tela não mostra os filtros')
  const faixa = (await segundaOpcao(page, '[data-parte="filtro-faixa"]'))!
  await emSequencia(page, [
    { seletor: '[data-parte="filtro-faixa"]', valor: faixa },
    { seletor: '[data-parte="ordem"]', valor: 'nome' },
  ], 0)
  await expect(page).toHaveURL(new RegExp(`faixa=${faixa}`))
  await expect(page).toHaveURL(/ordem=nome/)
  await page.reload()
  await hidratada(page)
  await expect(page.locator('[data-parte="filtro-faixa"]')).toHaveValue(faixa)
  await expect(page.locator('[data-parte="ordem"]')).toHaveValue('nome')
})

test('Visão geral: período e evento em sequência — os dois na URL e no F5', async ({ page }) => {
  await abrir(page, '/admin/relatorios')
  const id = (await segundaOpcao(page, '[data-parte="filtro-evento"]'))!
  await emSequencia(page, [
    { seletor: PERIODO, texto: 'Tudo', clique: true },
    { seletor: '[data-parte="filtro-evento"]', valor: id },
  ], 0)
  await expect(page).toHaveURL(/periodo=tudo/)
  await expect(page).toHaveURL(new RegExp(`evento=${id}`))
  await page.reload()
  await hidratada(page)
  await expect(periodo(page, 'Tudo')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-parte="filtro-evento"]')).toHaveValue(id)
})

test('Financeiro: dois períodos em sequência — vale o ÚLTIMO, na URL e no F5', async ({ page }) => {
  await abrir(page, '/admin/financeiro')
  await emSequencia(page, [
    { seletor: PERIODO, texto: 'Este ano', clique: true },
    { seletor: PERIODO, texto: 'Hoje', clique: true },
  ], 0)
  await expect(page).toHaveURL(/periodo=hoje/)
  await page.reload()
  await hidratada(page)
  await expect(periodo(page, 'Hoje')).toHaveAttribute('aria-pressed', 'true')
})

test('Auditoria: período e entidade em sequência — os dois na URL e no F5', async ({ page }) => {
  await abrir(page, '/admin/auditoria')
  const entidade = await segundaOpcao(page, '[data-parte="filtro-entidade"]')
  test.skip(!entidade, 'auditoria vazia nesta base')
  await emSequencia(page, [
    { seletor: PERIODO, texto: '7 dias', clique: true },
    { seletor: '[data-parte="filtro-entidade"]', valor: entidade! },
  ], 0)
  await expect(page).toHaveURL(/periodo=7d/)
  await expect(page).toHaveURL(new RegExp(`entidade=${entidade}`))
  await page.reload()
  await hidratada(page)
  await expect(periodo(page, '7 dias')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-parte="filtro-entidade"]')).toHaveValue(entidade!)
})

test('Reconciliação: período e evento em sequência — os dois na URL e no F5', async ({ page }) => {
  await abrir(page, '/admin/reconciliacao')
  const id = (await segundaOpcao(page, '[data-parte="filtro-evento"]'))!
  await emSequencia(page, [
    { seletor: PERIODO, texto: '7 dias', clique: true },
    { seletor: '[data-parte="filtro-evento"]', valor: id },
  ], 0)
  await expect(page).toHaveURL(/periodo=7d/)
  await expect(page).toHaveURL(new RegExp(`eventoId=${id}`))
  await page.reload()
  await hidratada(page)
  await expect(periodo(page, '7 dias')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-parte="filtro-evento"]')).toHaveValue(id)
})

test.describe('Atendimento IA', () => {
  test.beforeEach(async ({ page }) => {
    await abrir(page, '/admin/agentes')
    test.skip(!!(await page.getByText(/painel ainda não ligado|não consegui ler/i).count()), 'automação fora do ar')
  })

  test('canal e busca a 5 ms um do outro — os dois na URL e no F5', async ({ page }) => {
    await emSequencia(page, [
      // desde o painel em formato chat (a42dbe1) o canal é um grupo de botões, não um select
      { seletor: '[role="group"][aria-label="Canal"] button', texto: 'Instagram', clique: true },
      { seletor: 'input[aria-label="Buscar conversa"]', valor: 'ingresso' },
    ], 5)
    await expect(page).toHaveURL(/canal=instagram/)
    await expect(page).toHaveURL(/q=ingresso/)
    await page.reload()
    await hidratada(page)
    await expect(page.getByRole('group', { name: 'Canal' }).getByRole('button', { name: 'Instagram' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('searchbox', { name: /buscar conversa/i })).toHaveValue('ingresso')
  })

  test('digitar a busca rápido (uma tecla a cada 8 ms) — a ÚLTIMA letra chega na URL', async ({ page }) => {
    const palavra = 'ingresso'
    await emSequencia(page, [...palavra].map((_, i) => (
      { seletor: 'input[aria-label="Buscar conversa"]', valor: palavra.slice(0, i + 1) })), 8)
    await expect(page).toHaveURL(/q=ingresso(&|$)/)
    await page.reload()
    await hidratada(page)
    await expect(page.getByRole('searchbox', { name: /buscar conversa/i })).toHaveValue(palavra)
  })

  test('o clique em "Atendimento IA" no menu limpa a tela junto com a URL', async ({ page }) => {
    await abrir(page, '/admin/agentes?canal=instagram&q=ingresso')
    await expect(page.getByRole('searchbox', { name: /buscar conversa/i })).toHaveValue('ingresso')
    // o trilho do computador abre no hover: recolhido, os filhos dos grupos nem se desenham
    await page.locator('#menu-lateral').hover()
    await page.locator('nav[aria-label="Menu do painel"]').getByRole('link', { name: 'Atendimento IA', exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/agentes$/)
    await expect(page.getByRole('searchbox', { name: /buscar conversa/i })).toHaveValue('')
    await expect(page.getByRole('group', { name: 'Canal' }).getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'true')
  })
})
