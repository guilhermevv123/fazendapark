/**
 * telas-estreitas.e2e.ts — nenhuma tela do painel rola de lado num celular estreito (28/09).
 *
 * A bateria de celular media em 375 px (organização) e no Pixel 7 (412 px, balcão e portaria).
 * O Android mais vendido no Brasil tem 360 px de largura, e os pequenos 320. Medido na
 * rodada final: em 360 px, cinco telas rolavam de lado — o painel do evento (as duas datas do
 * período lado a lado), o financeiro, as sessões e as configurações do evento (linha de botões
 * sem quebra; selo de "setor · lote" que não quebra) e o Atendimento IA (selo com o nome do fluxo
 * da automação). Em 320 px, mais a reconciliação (tabela sem cartão que rola) e as cortesias.
 * Página que rola de lado no celular faz o navegador afastar o zoom — a tela inteira fica miúda.
 *
 * O `vue-tracer-overlay` e o botão do DevTools são do `nuxt dev` (não existem no build de
 * produção): saem antes da medida.
 */
import { expect, test, type Page } from '@playwright/test'
import { BASE, EVENTO_SEED, hidratada, sessao, travaDeBase } from './apoio'

test.beforeAll(() => travaDeBase(BASE))

const EV = `/admin/evento/${EVENTO_SEED.id}`
const TELAS = [
  '/admin', '/admin/relatorios?periodo=tudo', '/admin/financeiro', '/admin/reconciliacao', '/admin/auditoria',
  '/admin/clientes', '/admin/equipe', '/admin/configuracoes', '/admin/agentes', '/admin/filas', '/admin/suporte',
  `${EV}/dashboard`, `${EV}/dashboard?aba=publico`, `${EV}/relatorios`, `${EV}/relatorios/extrato`,
  `${EV}/relatorios/lotes`, `${EV}/financeiro`, `${EV}/financeiro/bordero`, `${EV}/vendas`,
  `${EV}/vendas/participantes`, `${EV}/vendas/transferencias`, `${EV}/ingressos`, `${EV}/ingressos/cortesias`,
  `${EV}/ingressos/cupons`, `${EV}/ingressos/sessoes`, `${EV}/ingressos/promoters`, `${EV}/configuracoes`,
  `${EV}/pdv`, `${EV}/pdv/caixa`, `${EV}/validacao`, `${EV}/validacao/historico`, '/admin/evento/novo',
]

async function sobraDeLado(page: Page) {
  return page.evaluate(() => {
    document.querySelectorAll('#vue-tracer-overlay, #nuxt-devtools-container, nuxt-devtools-frame')
      .forEach((e) => e.remove())
    const largura = document.documentElement.clientWidth
    const culpado = [...document.querySelectorAll<HTMLElement>('body *')].find((e) => {
      const b = e.getBoundingClientRect()
      if (!(b.width > 0 && b.right > largura + 1)) return false
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX)) return false
      }
      return ![...e.children].some((f) => (f as HTMLElement).getBoundingClientRect().right > largura + 1)
    })
    return {
      sobra: document.documentElement.scrollWidth - largura,
      culpado: culpado ? `${culpado.tagName.toLowerCase()}.${[...culpado.classList].slice(0, 4).join('.')} "${(culpado.textContent ?? '').trim().slice(0, 50)}"` : '',
    }
  })
}

for (const largura of [360, 320]) {
  test.describe(`celular ${largura} px — nenhuma tela rola de lado`, () => {
    test.use({ storageState: sessao('master'), viewport: { width: largura, height: 760 }, hasTouch: true })
    for (const tela of TELAS) {
      test(`${tela.replace(EV, '/evento')}`, async ({ page }) => {
        await page.goto(tela)
        await hidratada(page)
        // gráfico e lista chegam depois da hidratação: mede com a tela assentada
        await page.waitForLoadState('networkidle').catch(() => {})
        const r = await sobraDeLado(page)
        expect(r.sobra, `rola ${r.sobra}px de lado — quem empurra: ${r.culpado}`).toBeLessThanOrEqual(0)
      })
    }
  })
}
