/**
 * Cobrança parcelada no formato que o Asaas documenta (auditoria 27/09, B06).
 *
 * O checkout mandava `value` = TOTAL junto de `installmentCount`. A doc do `POST /v3/payments`
 * pede, pra parcelado, `installmentCount` + `installmentValue` OU `totalValue` — `value` com
 * parcelas fica fora do contrato e arrisca virar o valor de CADA parcela (R$ 60 em 3x = R$ 180).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { valorDaCobranca } from './asaas'

describe('valorDaCobranca', () => {
  it('à vista manda só `value`', () => {
    expect(valorDaCobranca(6000, 1)).toEqual({ value: 60 })
    expect(valorDaCobranca(6000, null)).toEqual({ value: 60 })
    expect(valorDaCobranca(1999, 0)).toEqual({ value: 19.99 })
  })

  it('parcelado manda `installmentCount` + `totalValue` e NUNCA `value`', () => {
    const c = valorDaCobranca(6000, 3)
    expect(c).toEqual({ installmentCount: 3, totalValue: 60 })
    expect('value' in c).toBe(false)
  })

  it('o total vai inteiro — quem divide (e põe o centavo que sobra na última) é o Asaas', () => {
    expect(valorDaCobranca(10000, 3)).toEqual({ installmentCount: 3, totalValue: 100 })
  })

  it('o checkout usa a função — sem `value` cru ao lado de `installmentCount`', () => {
    const fonte = readFileSync(new URL('../api/checkout.post.ts', import.meta.url), 'utf8')
      .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(fonte).toContain('valorDaCobranca(')
    expect(fonte).not.toMatch(/installmentCount\s*:/)
  })
})
