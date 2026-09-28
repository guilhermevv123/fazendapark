/**
 * painelPeriodo.test.ts — o vocabulário de período dos painéis e a conta de calendário dele.
 *
 * Mutação conferida: `faixaDoPeriodo('mes_passado')` terminando no dia 1º do mês atual (em vez do
 * último dia do anterior) deixa o caso do mês passado vermelho; `problemaNoPeriodo` sem o ramo
 * `de > ate` deixa o caso REL-10 vermelho.
 */
import { describe, expect, it } from 'vitest'
import {
  diaDeCalendario, diasNoPeriodo, ehChavePeriodo, faixaDoPeriodo, periodoAnterior, PERIODOS,
  problemaNoPeriodo, rotuloDoPeriodo, somarDiasNoCalendario,
} from './painelPeriodo'

describe('os atalhos', () => {
  it('é o mesmo vocabulário em toda tela de dinheiro, na ordem', () => {
    expect(PERIODOS.map((p) => p.rotulo)).toEqual(
      ['Hoje', '7 dias', '30 dias', 'Este mês', 'Mês passado', 'Este ano', 'Tudo'])
    expect(ehChavePeriodo('30d')).toBe(true)
    expect(ehChavePeriodo('90d')).toBe(false)
  })

  it('cada chave vira as datas do calendário do parque, com as duas pontas', () => {
    const hoje = '2026-09-27'
    expect(faixaDoPeriodo('hoje', hoje)).toEqual({ de: '2026-09-27', ate: '2026-09-27' })
    expect(faixaDoPeriodo('7d', hoje)).toEqual({ de: '2026-09-21', ate: '2026-09-27' })
    expect(faixaDoPeriodo('30d', hoje)).toEqual({ de: '2026-08-29', ate: '2026-09-27' })
    expect(faixaDoPeriodo('mes', hoje)).toEqual({ de: '2026-09-01', ate: '2026-09-27' })
    expect(faixaDoPeriodo('mes_passado', hoje)).toEqual({ de: '2026-08-01', ate: '2026-08-31' })
    expect(faixaDoPeriodo('ano', hoje)).toEqual({ de: '2026-01-01', ate: '2026-09-27' })
    expect(faixaDoPeriodo('tudo', hoje)).toEqual({ de: null, ate: null })
  })

  it('mês passado em janeiro é dezembro do ano anterior; março pega o fim de fevereiro', () => {
    expect(faixaDoPeriodo('mes_passado', '2027-01-10')).toEqual({ de: '2026-12-01', ate: '2026-12-31' })
    expect(faixaDoPeriodo('mes_passado', '2028-03-05')).toEqual({ de: '2028-02-01', ate: '2028-02-29' })
  })
})

describe('o período anterior (a régua da comparação)', () => {
  it('tem o mesmo tamanho e termina na véspera', () => {
    expect(periodoAnterior('2026-08-29', '2026-09-27')).toEqual({ de: '2026-07-30', ate: '2026-08-28' })
    expect(diasNoPeriodo('2026-07-30', '2026-08-28')).toBe(30)
    expect(periodoAnterior('2026-09-27', '2026-09-27')).toEqual({ de: '2026-09-26', ate: '2026-09-26' })
    expect(periodoAnterior(null, '2026-09-27')).toBeNull()
  })
})

describe('datas digitadas (REL-10: De depois de Até não derruba a tela)', () => {
  it('a frase diz o que está errado', () => {
    expect(problemaNoPeriodo('2026-09-30', '2026-09-01')).toMatch(/inicial vem depois da final/)
    expect(problemaNoPeriodo('2026-02-31', null)).toMatch(/não é uma data válida/)
    expect(problemaNoPeriodo('2026-09-01', '2026-09-30')).toBeNull()
    expect(problemaNoPeriodo(null, null)).toBeNull()
  })

  it('calendário sem fuso: 31/02 não existe, e somar atravessa mês e ano', () => {
    expect(diaDeCalendario('2026-02-31')).toBe(false)
    expect(diaDeCalendario('2028-02-29')).toBe(true)
    expect(somarDiasNoCalendario('2026-12-31', 1)).toBe('2027-01-01')
    expect(somarDiasNoCalendario('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('o período como a pessoa lê', () => {
    expect(rotuloDoPeriodo('2026-09-01', '2026-09-27')).toBe('01/09 a 27/09/2026')
    expect(rotuloDoPeriodo('2025-12-15', '2026-01-10')).toBe('15/12/2025 a 10/01/2026')
    expect(rotuloDoPeriodo('2026-09-27', '2026-09-27')).toBe('27/09/2026')
    expect(rotuloDoPeriodo(null, null)).toBe('todo o período')
  })
})
