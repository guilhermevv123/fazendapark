/**
 * painelPlanilha.test.ts — o dinheiro da planilha é número que o Excel brasileiro soma.
 * Mutação conferida: devolver `reais(c)` deixa os três casos vermelhos.
 */
import { describe, expect, it } from 'vitest'
import { celulaCsv } from './baixarCsv'
import { centavosParaPlanilha } from './painelPlanilha'

describe('centavosParaPlanilha', () => {
  it('vírgula decimal, sem milhar e sem R$', () => {
    expect(centavosParaPlanilha(123_456)).toBe('1234,56')
    expect(centavosParaPlanilha(5)).toBe('0,05')
    expect(centavosParaPlanilha(0)).toBe('0,00')
    expect(centavosParaPlanilha(null)).toBe('0,00')
  })

  it('negativo continua número (e o CSV não o trata como fórmula)', () => {
    expect(centavosParaPlanilha(-20_000)).toBe('-200,00')
    expect(celulaCsv(centavosParaPlanilha(-20_000))).toBe('"-200,00"')
  })

  it('não passa por float: 0,29 não vira 0,28', () => {
    expect(centavosParaPlanilha(29)).toBe('0,29')
    expect(centavosParaPlanilha(1_000_000_007)).toBe('10000000,07')
  })
})
