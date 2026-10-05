/**
 * equipe-da-plataforma.test.ts — quem configura o recebimento (05/10): a lista do ambiente.
 * Vazia fecha; e-mail inteiro ou `@dominio`; sem diferença de maiúscula; domínio parecido não passa.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ehDaEquipeDaPlataforma } from './equipe-da-plataforma'

const antes = process.env.EQUIPE_DA_PLATAFORMA
afterEach(() => {
  if (antes === undefined) delete process.env.EQUIPE_DA_PLATAFORMA
  else process.env.EQUIPE_DA_PLATAFORMA = antes
})

describe('equipe da plataforma', () => {
  it('lista vazia ou ausente: ninguém', () => {
    delete process.env.EQUIPE_DA_PLATAFORMA
    expect(ehDaEquipeDaPlataforma('dono@fazendapark.com.br')).toBe(false)
    process.env.EQUIPE_DA_PLATAFORMA = ' , '
    expect(ehDaEquipeDaPlataforma('dono@fazendapark.com.br')).toBe(false)
  })

  it('e-mail inteiro, sem diferença de maiúscula nem espaço', () => {
    process.env.EQUIPE_DA_PLATAFORMA = 'Guilherme@Diamond.Example , outra@x.example'
    expect(ehDaEquipeDaPlataforma(' guilherme@diamond.example ')).toBe(true)
    expect(ehDaEquipeDaPlataforma('outra@x.example')).toBe(true)
    expect(ehDaEquipeDaPlataforma('guilherme2@diamond.example')).toBe(false)
  })

  it('@dominio vale pro domínio exato — subdomínio e domínio com sufixo não passam', () => {
    process.env.EQUIPE_DA_PLATAFORMA = '@diamond.example'
    expect(ehDaEquipeDaPlataforma('qualquer@diamond.example')).toBe(true)
    expect(ehDaEquipeDaPlataforma('x@cliente.diamond.example')).toBe(false)
    expect(ehDaEquipeDaPlataforma('x@diamond.example.br')).toBe(false)
    expect(ehDaEquipeDaPlataforma('diamond.example')).toBe(false)
    expect(ehDaEquipeDaPlataforma(null)).toBe(false)
  })
})
