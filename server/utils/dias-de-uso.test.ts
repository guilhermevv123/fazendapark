/**
 * dias-de-uso.test.ts — a régua pura dos dias de uso do tipo (047). A mesma régua roda na catraca
 * online, no tablet sem rede e na tela do painel; o caminho com banco e HTTP está em
 * `server/api/dia-de-uso.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  conferirDiasDeUso, diaDeUsoDe, diasDoEvento, fraseDosDiasDeUso, limparDiasDeUso, mensagemForaDoDiaDeUso,
  rotuloDoDiaDeUso, sugerirDiasDeUsoPeloNome, valeNoDiaDeUso,
} from './dias-de-uso'

// o evento real do parque: sex 09/10 09:00 a seg 12/10 17:00 (Bahia)
const EVENTO = diasDoEvento('2026-10-09T12:00:00Z', '2026-10-12T20:00:00Z', 'America/Bahia')

describe('o dia, no fuso do evento', () => {
  it('meia-noite e pouco da Bahia ainda é o dia da Bahia, não o de Greenwich', () => {
    // 02:30Z do dia 10 = 23:30 do dia 09 na Bahia
    expect(diaDeUsoDe('2026-10-10T02:30:00Z', 'America/Bahia')).toBe('2026-10-09')
    expect(diaDeUsoDe('2026-10-10T03:30:00Z', 'America/Bahia')).toBe('2026-10-10')
  })
  it('os dias do evento, um por dia do calendário, com o rótulo da tela', () => {
    expect(EVENTO).toEqual([
      { dia: '2026-10-09', rotulo: 'sexta 09/10' },
      { dia: '2026-10-10', rotulo: 'sábado 10/10' },
      { dia: '2026-10-11', rotulo: 'domingo 11/10' },
      { dia: '2026-10-12', rotulo: 'segunda 12/10' },
    ])
    expect(diasDoEvento(null, null)).toEqual([])
  })
})

describe('passa ou não passa', () => {
  it('sem dia marcado passa sempre — é o que mantém o vendido igual', () => {
    expect(valeNoDiaDeUso(null, '2026-10-11')).toBe(true)
    expect(valeNoDiaDeUso([], '2026-10-11')).toBe(true)
  })
  it('o de sexta não passa no domingo; passa na sexta', () => {
    expect(valeNoDiaDeUso(['2026-10-09'], '2026-10-11')).toBe(false)
    expect(valeNoDiaDeUso(['2026-10-09'], '2026-10-09')).toBe(true)
  })
  it('a frase da porta diz o dia certo', () => {
    expect(mensagemForaDoDiaDeUso(['2026-10-09'])).toBe('Este ingresso não vale hoje — vale só sexta 09/10')
    expect(fraseDosDiasDeUso(['2026-10-11', '2026-10-09', '2026-10-10']))
      .toBe('sexta 09/10, sábado 10/10 e domingo 11/10')
    expect(rotuloDoDiaDeUso('2026-10-12')).toBe('segunda 12/10')
  })
  it('lixo na lista não vira dia (data torta, repetida, Date do pg)', () => {
    expect(limparDiasDeUso(['2026-10-09', 'ontem', '2026-10-09', '2026-13-45x'])).toEqual(['2026-10-09'])
    expect(limparDiasDeUso([new Date('2026-10-10T12:00:00Z')])).toEqual(['2026-10-10'])
    expect(limparDiasDeUso('2026-10-09')).toBeNull()
  })
})

describe('o painel', () => {
  it('o nome do tipo sugere o dia (com e sem acento, com "-FEIRA")', () => {
    expect(sugerirDiasDeUsoPeloNome('ENTRADA INDIVIDUAL SEXTA', EVENTO)).toEqual(['2026-10-09'])
    expect(sugerirDiasDeUsoPeloNome('COMBO SÁBADO - COMBO 10 PESSOAS', EVENTO)).toEqual(['2026-10-10'])
    expect(sugerirDiasDeUsoPeloNome('ENTRADA INDIVIDUAL SEGUNDA-FEIRA', EVENTO)).toEqual(['2026-10-12'])
    expect(sugerirDiasDeUsoPeloNome('Inteira', EVENTO)).toEqual([])
    // dia que o evento não tem: nada a sugerir
    expect(sugerirDiasDeUsoPeloNome('ENTRADA QUARTA', EVENTO)).toEqual([])
  })
  it('dia fora do evento é recusado com a frase; vazio é "qualquer dia"', () => {
    expect(conferirDiasDeUso(['2026-10-09'], EVENTO)).toEqual({ ok: true, dias: ['2026-10-09'] })
    expect(conferirDiasDeUso([], EVENTO)).toEqual({ ok: true, dias: null })
    const r = conferirDiasDeUso(['2026-10-15'], EVENTO)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.erro).toContain('quinta 15/10 não é dia deste evento')
  })
})
