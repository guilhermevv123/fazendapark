/**
 * Volte Mais (037) — a conta pura: feriado, regra do dia, quais ingressos recebem o desconto e o
 * regulamento. O que lê o banco (situação do CPF, a trava, o checkout) está em
 * `server/api/fidelidade.test.ts`, pela HTTP.
 */
import { describe, expect, it } from 'vitest'
import { descontoDaFidelidade, diaNoFusoDaFidelidade, feriadoNacionalDoDia, regraDoDiaDaFidelidade } from './fidelidade'
import { PROGRAMA_DE_FIDELIDADE_PADRAO, regulamentoDaFidelidade, type ProgramaDeFidelidade } from './fidelidade-texto'

const prog = (o: Partial<ProgramaDeFidelidade> = {}): ProgramaDeFidelidade => ({
  id: 'p1', org_id: 'o1', ...PROGRAMA_DE_FIDELIDADE_PADRAO,
  ativo: true, vigencia_inicio: '2026-10-01', vigencia_fim: '2026-12-31', ...o,
})

describe('feriado nacional (a mesma tabela dos robôs)', () => {
  it('fixos e móveis de 2026 e 2027', () => {
    expect(feriadoNacionalDoDia('2026-10-12')).toBe('Nossa Senhora Aparecida')
    expect(feriadoNacionalDoDia('2026-11-20')).toBe('Consciência Negra')
    expect(feriadoNacionalDoDia('2027-02-08')).toBe('Carnaval')          // Páscoa 2027 = 28/03
    expect(feriadoNacionalDoDia('2027-03-26')).toBe('Sexta-feira Santa')
    expect(feriadoNacionalDoDia('2027-05-27')).toBe('Corpus Christi')
    expect(feriadoNacionalDoDia('2026-10-13')).toBeNull()
  })
  it('o dia do evento é o do PARQUE: 23h30 da Bahia ainda é o mesmo dia', () => {
    expect(diaNoFusoDaFidelidade('2026-10-10T02:30:00Z', 'America/Bahia')).toBe('2026-10-09')
  })
})

describe('regra do dia', () => {
  const ev = (dia: string) => ({ id: 'e1', dia })
  it('desligado, sem vigência, antes e depois da vigência: não vale', () => {
    expect(regraDoDiaDaFidelidade(prog({ ativo: false }), ev('2026-10-10'), '2026-10-05').vale).toBe(false)
    expect(regraDoDiaDaFidelidade(prog({ vigencia_fim: null }), ev('2026-10-10'), '2026-10-05').vale).toBe(false)
    expect(regraDoDiaDaFidelidade(prog(), ev('2026-10-10'), '2026-09-30')).toEqual({ vale: false, motivo: 'a promoção ainda não começou' })
    expect(regraDoDiaDaFidelidade(prog(), ev('2027-01-02'), '2027-01-01')).toEqual({ vale: false, motivo: 'a promoção terminou' })
  })
  it('só sexta: sábado não vale, sexta vale; feriado segue o próprio interruptor', () => {
    const soSexta = prog({ dias_semana: [5] })
    expect(regraDoDiaDaFidelidade(soSexta, ev('2026-10-09'), '2026-10-05').vale).toBe(true)      // sexta
    expect(regraDoDiaDaFidelidade(soSexta, ev('2026-10-10'), '2026-10-05').vale).toBe(false)     // sábado
    expect(regraDoDiaDaFidelidade(soSexta, ev('2026-10-12'), '2026-10-05').vale).toBe(true)      // feriado (segunda)
    expect(regraDoDiaDaFidelidade(prog({ vale_feriado: false }), ev('2026-10-12'), '2026-10-05'))
      .toEqual({ vale: false, motivo: 'não vale em feriado (Nossa Senhora Aparecida)' })
  })
  it('evento marcado fora não vale', () => {
    expect(regraDoDiaDaFidelidade(prog({ eventos_fora: ['e1'] }), ev('2026-10-10'), '2026-10-05'))
      .toEqual({ vale: false, motivo: 'não vale neste evento' })
  })
})

describe('desconto no pedido', () => {
  const p50 = { desconto_bps: 5000, ingressos_por_compra: 1 }
  it('1 ingresso por compra: 50% no MAIS CARO elegível, nunca na meia nem no grátis', () => {
    const r = descontoDaFidelidade([
      { faceUnitCents: 1000, quantidade: 2, tipoComDesconto: true },    // meia: fora
      { faceUnitCents: 0, quantidade: 1, tipoComDesconto: false },      // grátis: fora
      { faceUnitCents: 2000, quantidade: 1, tipoComDesconto: false },
      { faceUnitCents: 2500, quantidade: 1, tipoComDesconto: false },
    ], p50)
    expect(r).toEqual({ cents: 1250, ingressos: 1 })
  })
  it('a família (4 por compra) leva 4, mesmo vindo em linhas diferentes', () => {
    expect(descontoDaFidelidade([
      { faceUnitCents: 2000, quantidade: 3, tipoComDesconto: false },
      { faceUnitCents: 2500, quantidade: 2, tipoComDesconto: false },
    ], { desconto_bps: 5000, ingressos_por_compra: 4 })).toEqual({ cents: 1250 + 1250 + 1000 + 1000, ingressos: 4 })
  })
  it('centavo ímpar arredonda pra BAIXO (nunca dá mais desconto que o anunciado)', () => {
    expect(descontoDaFidelidade([{ faceUnitCents: 2251, quantidade: 1, tipoComDesconto: false }], p50).cents).toBe(1125)
  })
  it('só meia no carrinho: nada a descontar', () => {
    expect(descontoDaFidelidade([{ faceUnitCents: 1000, quantidade: 2, tipoComDesconto: true }], p50)).toEqual({ cents: 0, ingressos: 0 })
  })
})

describe('regulamento', () => {
  it('diz vigência, quantos retornos, prazo, o que não acumula e a consumação', () => {
    const t = regulamentoDaFidelidade(prog({ dias_semana: [5], vale_feriado: false, prazo_dias: 60, retornos: 2, consumacao_bps: 1000 }))
    expect(t).toContain('de 01/10/2026 a 31/12/2026')
    expect(t).toContain('2 retornos com 50% de desconto')
    expect(t).toContain('em até 60 dias')
    expect(t).toContain('vale em sexta; não vale em feriados nacionais')
    expect(t).toContain('Não acumula com meia-entrada nem com cupom')
    expect(t).toContain('10% de desconto na consumação')
  })
  it('sem consumação e sem prazo: a linha some / vira "dentro da vigência"', () => {
    const t = regulamentoDaFidelidade(prog({ consumacao_bps: 0, prazo_dias: null }))
    expect(t).not.toContain('consumação')
    expect(t).toContain('dentro da vigência')
  })
})
