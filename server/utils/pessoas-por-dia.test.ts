/**
 * pessoas-por-dia.test.ts — quantas pessoas vêm em cada dia (dashboard do evento, 08/10). O dono
 * usa pra dimensionar equipe; o número não pode inventar gente nem esconder gente.
 */
import { describe, expect, it } from 'vitest'
import { funcionariosPara, pessoasPorDiaDeUso } from './pessoas-por-dia'
import { diasDoEvento } from './dias-de-uso'

// o evento real do parque: sex 09/10 a seg 12/10 (Bahia)
const DIAS = diasDoEvento('2026-10-09T12:00:00Z', '2026-10-12T20:00:00Z', 'America/Bahia')
const dia = (r: ReturnType<typeof pessoasPorDiaDeUso>, d: string) => r.dias.find((x) => x.dia === d)!

describe('pessoas por dia de uso', () => {
  it('combo de 10 conta 10 no dia dele; a individual conta 1', () => {
    const r = pessoasPorDiaDeUso([
      { tipo: 'COMBO DOMINGO - COMBO 10 PESSOAS', dias: ['2026-10-11'], pessoas: 10, ingressos: 6 },
      { tipo: 'ENTRADA INDIVIDUAL DOMINGO', dias: ['2026-10-11'], pessoas: 1, ingressos: 38 },
      { tipo: 'ENTRADA INDIVIDUAL SEXTA', dias: ['2026-10-09'], pessoas: 1, ingressos: 5 },
    ], DIAS)
    expect(dia(r, '2026-10-11')).toMatchObject({ pessoas: 98, ingressos: 44, emCombo: 60, temIngressoDeVariosDias: false })
    expect(dia(r, '2026-10-09')).toMatchObject({ pessoas: 5, ingressos: 5, emCombo: 0 })
    expect(dia(r, '2026-10-10')).toMatchObject({ pessoas: 0, ingressos: 0 })
    expect(dia(r, '2026-10-11').tipos[0]).toEqual({ nome: 'COMBO DOMINGO - COMBO 10 PESSOAS', ingressos: 6, pessoas: 60, porIngresso: 10 })
    expect(r.qualquerDia.pessoas).toBe(0)
  })

  it('sem dia marcado vai pra "qualquer dia", e não soma em dia nenhum', () => {
    const r = pessoasPorDiaDeUso([{ tipo: 'Inteira', dias: null, pessoas: 1, ingressos: 7 }], DIAS)
    expect(r.dias.every((d) => d.pessoas === 0)).toBe(true)
    expect(r.qualquerDia).toMatchObject({ pessoas: 7, ingressos: 7, emCombo: 0 })
  })

  it('ingresso de dois dias conta nos dois, com o aviso', () => {
    const r = pessoasPorDiaDeUso([{ tipo: 'FIM DE SEMANA', dias: ['2026-10-10', '2026-10-11'], pessoas: 1, ingressos: 4 }], DIAS)
    expect(dia(r, '2026-10-10')).toMatchObject({ pessoas: 4, temIngressoDeVariosDias: true })
    expect(dia(r, '2026-10-11')).toMatchObject({ pessoas: 4, temIngressoDeVariosDias: true })
  })

  it('dia que não é do evento não some: fica contado à parte', () => {
    const r = pessoasPorDiaDeUso([{ tipo: 'X', dias: ['2026-10-20'], pessoas: 1, ingressos: 3 }], DIAS)
    expect(r.foraDoEvento).toEqual({ pessoas: 3, ingressos: 3 })
  })

  it('quem já entrou aparece no dia certo', () => {
    const r = pessoasPorDiaDeUso([], DIAS, { '2026-10-09': 42 })
    expect(dia(r, '2026-10-09').entraram).toBe(42)
    expect(dia(r, '2026-10-10').entraram).toBe(0)
  })

  it('funcionários: arredonda pra cima; sem régua, zero', () => {
    expect(funcionariosPara(98, 50)).toBe(2)
    expect(funcionariosPara(100, 50)).toBe(2)
    expect(funcionariosPara(101, 50)).toBe(3)
    expect(funcionariosPara(98, null)).toBe(0)
    expect(funcionariosPara(0, 50)).toBe(0)
  })
})
