/** pessoas-do-tipo.test.ts — o número de pessoas que o NOME do combo diz (048). O caminho com banco está em `server/api/pessoas-do-tipo.test.ts`. */
import { describe, expect, it } from 'vitest'
import { pessoasPeloNome, seloDePessoas } from './pessoas-do-tipo'

describe('pessoas pelo nome do tipo', () => {
  it.each([
    ['COMBO SEXTA - COMBO 10 PESSOAS', 10],
    ['COMBO SEGUNDA-FEIRA - COMBO 10 PESSOAS', 10],
    ['Combo 15', 15],
    ['combo de 12', 12],
    ['Mesa p/ 4 pessoas', 4],
    ['Família 5 pax', 5],
  ] as const)('%s → %d', (nome, n) => expect(pessoasPeloNome(nome)).toBe(n))
  it.each(['ENTRADA INDIVIDUAL SEXTA', 'Inteira', 'Meia-entrada', '1 pessoa', 'COMBO 500 PESSOAS', ''])(
    '%s → nada a sugerir', (nome) => expect(pessoasPeloNome(nome)).toBeNull())
  it('o selo só aparece pra quem conta mais de uma', () => {
    expect(seloDePessoas(10)).toBe('conta 10 pessoas')
    expect(seloDePessoas(1)).toBeNull()
    expect(seloDePessoas(null)).toBeNull()
  })
})
