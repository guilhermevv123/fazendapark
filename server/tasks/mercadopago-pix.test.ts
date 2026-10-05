/**
 * A tarefa do Pix do Mercado Pago é PRÓPRIA — fora da `liberar-expirados` de propósito: MP lento
 * não pode segurar a devolução de estoque nem o cancelamento das cobranças do Asaas atrás dele.
 * Sem banco: só a forma da rodada.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

;(globalThis as any).defineTask ??= (t: any) => t
const { PRAZO_DA_RODADA_MS, etapasDoMp } = await import('./mercadopago-pix')
const { ETAPAS } = await import('./liberar-expirados')

describe('tarefa mercadopago-pix', () => {
  it('as quatro portas do MP, na ordem: esperando, vencido, pendurado, já pago (conferência, por último)', () => {
    expect(etapasDoMp().map((e) => e.nome)).toEqual([
      'pix do mercado pago esperando', 'pix do mercado pago vencido', 'pix do mercado pago pendurado',
      'pix do mercado pago já pago (conferência)',
    ])
  })

  it('nenhuma etapa do MP dentro da tarefa de minuto', () => {
    expect(ETAPAS.map((e) => e.nome).filter((n) => /mercado pago/.test(n))).toEqual([])
  })

  it('a rodada cabe no minuto', () => {
    expect(PRAZO_DA_RODADA_MS).toBeLessThan(60_000)
  })

  it('o cron dispara as duas tarefas no mesmo minuto', () => {
    // o nuxt.config só carrega dentro do Nuxt: a linha é conferida como texto
    const config = readFileSync(new URL('../../nuxt.config.ts', import.meta.url), 'utf8')
    expect(config).toContain(`scheduledTasks: { '* * * * *': ['liberar-expirados', 'mercadopago-pix'] }`)
  })
})
