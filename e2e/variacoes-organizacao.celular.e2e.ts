/**
 * variacoes-organizacao.celular.e2e.ts — as variações do painel da organização que são de CELULAR
 * (rodada final da matriz, agente V-ORG, 28/09). Roda no projeto `celular` (Pixel 7, toque).
 *
 *   E2E_BASE=http://127.0.0.1:3120 npx playwright test e2e/variacoes-organizacao.celular.e2e.ts --reporter=line
 *
 * Terreno: uma organização própria "ZZVARORG …" (ver `variacoes-organizacao-apoio.ts`), que sai no
 * `afterAll`. Nada é publicado.
 */
import { expect, test } from '@playwright/test'
import { BASE, travaDeBase } from './apoio'
import { abrir } from './evento-apoio'
import { PREFIXO, apagarOrganizacao, criarOrganizacao, entrarComo, fecharBanco, prosseguir, type OrgZZ } from './variacoes-organizacao-apoio'

test.beforeAll(() => travaDeBase(BASE))
test.afterAll(async () => { await fecharBanco() })

test.describe('Criar evento no celular', () => {
  let org: OrgZZ
  test.beforeAll(async () => { org = await criarOrganizacao('celular', ['master']) })
  test.afterAll(async () => { if (org) await apagarOrganizacao(org.id) })

  test('#69 Criar evento › InfoDica no celular: o toque abre (inteira na tela) e tocar fora fecha', async ({ page, context }) => {
    const { api, cookies } = await entrarComo(org.usuarios.master!.email)
    await context.addCookies(cookies)
    await abrir(page, '/admin/evento/novo')
    await page.locator('#nome').fill(`${PREFIXO} infodica celular`)
    await page.locator('#cid').fill('Ubatã')
    await page.locator('#sval').fill('(73) 99999-0000')
    await prosseguir(page).click() // → 2
    await prosseguir(page).click() // → 3
    const titulo = page.getByRole('heading', { name: 'Setores, lotes e tipos de ingresso' })
    await expect(titulo).toBeVisible()
    const medidas: { rotulo: string; de: number; ate: number; largura: number }[] = []
    for (const [rotulo, trecho] of [['O que é setor?', 'Onde a pessoa fica'], ['O que é lote?', 'As levas de venda']] as const) {
      const botao = page.getByRole('button', { name: rotulo })
      const dica = botao.locator('xpath=..').getByRole('tooltip')
      await expect(dica, rotulo).toBeHidden()
      await botao.tap()
      await expect(dica, `${rotulo}: o toque abre`).toBeVisible()
      await expect(dica).toContainText(trecho)
      // quanto do balão cabe na tela (anotado: o balão é centrado no "i" e tem 288 px)
      const caixa = (await dica.boundingBox())!
      const largura = page.viewportSize()!.width
      test.info().annotations.push({
        type: 'medida', description: `${rotulo}: balão de ${Math.round(caixa.x)} a ${Math.round(caixa.x + caixa.width)} px numa tela de ${largura} px`,
      })
      medidas.push({ rotulo, de: caixa.x, ate: caixa.x + caixa.width, largura })
      await titulo.tap()
      await expect(dica, `${rotulo}: tocar fora fecha`).toBeHidden()
    }
    await api.dispose()
    // aberta, a dica tem que dar pra LER: o balão inteiro dentro da tela (medido no fim, depois de
    // exercitar abrir e fechar das duas — a frase cortada na borda é o que a pessoa vê)
    for (const m of medidas) {
      expect(m.de, `${m.rotulo}: o balão começa fora da tela (x = ${Math.round(m.de)} px) e corta o começo das linhas`).toBeGreaterThanOrEqual(0)
      expect(m.ate, `${m.rotulo}: o balão passa da borda direita`).toBeLessThanOrEqual(m.largura)
    }
  })
})
