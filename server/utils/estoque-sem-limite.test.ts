import { describe, expect, it } from 'vitest'
import { ESTOQUE_SEM_LIMITE, estoqueSemLimite, quantidadeNaTela } from './estoque-sem-limite'

describe('estoque sem limite', () => {
  it('o teto do sistema é "sem limite"; número de verdade continua número', () => {
    expect(estoqueSemLimite(ESTOQUE_SEM_LIMITE)).toBe(true)
    expect(estoqueSemLimite(100)).toBe(false)
    // o disponível depois de vendas continua "sem limite"
    expect(estoqueSemLimite(ESTOQUE_SEM_LIMITE - 1234)).toBe(true)
    expect(quantidadeNaTela(ESTOQUE_SEM_LIMITE - 1)).toBe('Sem limite')
    expect(estoqueSemLimite(null)).toBe(false)
    expect(quantidadeNaTela(ESTOQUE_SEM_LIMITE)).toBe('Sem limite')
    expect(quantidadeNaTela(5000)).toBe('5.000')
  })
})
