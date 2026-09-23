/**
 * CSV sem fórmula de planilha (achado de QA, 22/09).
 *
 * O nome do cliente é livre no checkout público e vai direto pra exportação
 * de Clientes. `=HYPERLINK(...)` virava fórmula no Excel de quem abre o
 * arquivo. O escape só dobrava aspas.
 */
import { describe, expect, it } from 'vitest'
import { celulaCsv } from './baixarCsv'

describe('celulaCsv', () => {
  it.each([
    ['=HYPERLINK("http://mal.invalido";"clique")'],
    ['+1+cmd|\' /C calc\'!A0'],
    ['-2+3+cmd|\' /C calc\'!A0'],
    ['@SUM(1+1)'],
    ['\t=1+1'],
    ['\r=1+1'],
  ])('texto que começa como fórmula ganha apóstrofo: %s', (valor) => {
    // ← com o escape antigo, a célula começava por `=`/`+`/`-`/`@` e a planilha executava
    expect(celulaCsv(valor).startsWith(`"'`)).toBe(true)
  })

  it('aspas continuam dobradas, junto com o apóstrofo', () => {
    expect(celulaCsv('=A1&"x"')).toBe(`"'=A1&""x"""`)
  })

  it.each([
    ['-R$ 10,00'], ['-1.234,56'], ['-12'], ['+5%'],
  ])('número/dinheiro negativo já formatado NÃO é estragado: %s', (valor) => {
    expect(celulaCsv(valor)).toBe(`"${valor}"`)
  })

  it('o negativo que o Intl de verdade formata (com espaço não separável) também passa', () => {
    const v = (-1234.5).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    expect(celulaCsv(v)).toBe(`"${v}"`)
  })

  it('number de verdade passa direto, inclusive negativo', () => {
    expect(celulaCsv(-42)).toBe('"-42"')
    expect(celulaCsv(0)).toBe('"0"')
  })

  it('texto comum, vazio e nulo', () => {
    expect(celulaCsv('Ana Souza')).toBe('"Ana Souza"')
    expect(celulaCsv('')).toBe('""')
    expect(celulaCsv(null)).toBe('""')
    expect(celulaCsv(undefined)).toBe('""')
    // hífen no MEIO não é fórmula
    expect(celulaCsv('Ana-Maria')).toBe('"Ana-Maria"')
  })
})
