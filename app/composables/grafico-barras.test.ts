// @vitest-environment happy-dom
/**
 * grafico-barras.test.ts — `<PainelGraficoBarras>` com UM dia no período (matriz da auditoria,
 * "Vendas por dia — um dia só"): a barra única ocupava o cartão inteiro e virava um bloco sem forma
 * de barra. O teto é 9% da largura; com muitos dias vale a fatia (72% dela, o resto é o respiro).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { limparTela, montarTela } from './.vitest-setup-dom'

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => limparTela())

const LARGURA = 1000 // o viewBox do componente
async function grafico(n: number) {
  const pontos = Array.from({ length: n }, (_, i) => ({ chave: `2026-07-${String(i + 1).padStart(2, '0')}`, valor: 9000 }))
  return montarTela((await import('../components/painel/GraficoBarras.vue')).default, {
    props: { pontos, passo: 'dia', formatar: (v: number) => String(v), rotuloAcessivel: 'vendas' },
  })
}
const larguras = (tela: any) => tela.findAll('rect[data-parte="barra"]').map((r: any) => Number(r.attributes('width')))

describe('Vendas por dia — a largura da barra', () => {
  it('um dia só: UMA barra, com no máximo 9% da largura, no meio do cartão', async () => {
    const tela = await grafico(1)
    expect(larguras(tela)).toEqual([LARGURA * 0.09])
    const x = Number(tela.find('rect[data-parte="barra"]').attributes('x'))
    expect(x + LARGURA * 0.09 / 2).toBe(LARGURA / 2)
  })

  it('30 dias: cada barra é 72% da sua fatia (abaixo do teto)', async () => {
    const tela = await grafico(30)
    const l = larguras(tela)
    expect(l).toHaveLength(30)
    expect(l[0]).toBeCloseTo((LARGURA / 30) * 0.72, 6)
  })
})
