/**
 * ADM-52 · a tarefa de minuto em minuto: a etapa que cai não leva as outras.
 *
 * As etapas eram chamadas em fila, sem rede: uma exceção na primeira derrubava
 * a rodada inteira — e junto a expiração das transferências paradas, que
 * trancam o ingresso (uma pendente por ingresso) e não têm nada com o defeito
 * da primeira. Função pura sobre as etapas; sem banco.
 */
import { describe, expect, it, vi } from 'vitest'

;(globalThis as any).defineTask ??= (t: any) => t
const { ETAPAS, varrer } = await import('./liberar-expirados')

describe('ADM-52 · cada etapa por si', () => {
  it('a primeira cai e as outras rodam — inclusive a das transferências', async () => {
    const rodou: string[] = []
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await varrer([
      { nome: 'pedidos vencidos', rodar: async () => { throw new Error('banco piscou') }, falar: () => '' },
      { nome: 'cobranças', rodar: async () => { rodou.push('cobranças'); return 0 }, falar: () => '' },
      { nome: 'transferências paradas', rodar: async () => { rodou.push('transferências'); return 2 },
        falar: (n) => `${n} venceram` },
    ])
    expect(rodou, 'a falha da primeira etapa matou a expiração das transferências').toEqual(
      ['cobranças', 'transferências'])
    expect(r.falhas).toEqual({ 'pedidos vencidos': 'banco piscou' })
    expect(r.feitos).toEqual({ cobranças: 0, 'transferências paradas': 2 })
    // a falha não some: sai no log, com o nome da etapa
    expect(erro.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/pedidos vencidos.*banco piscou/)
    erro.mockRestore()
  })

  it('as etapas de verdade estão todas na rodada', () => {
    expect(ETAPAS.map((e) => e.nome)).toEqual([
      'pedidos vencidos', 'cobranças de reserva vencida', 'transferências paradas',
      'análise de risco sem saída', 'cadastro de pedido morto',
      // por último: a única etapa sem pressa (rede de baixo do webhook do Asaas, 05/10)
      'cobranças do asaas pagas sem aviso',
    ])
  })
})
