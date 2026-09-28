/**
 * fusoHorario.test.ts — a hora digitada vale no fuso ESCOLHIDO, não no do navegador (EVT-03).
 */
import { describe, expect, it } from 'vitest'
import { deslocamentoDoFuso, fusoValido, instanteNoFuso } from './fusoHorario'

describe('instanteNoFuso', () => {
  it('20:00 em cada fuso do assistente vira o instante certo', () => {
    expect(instanteNoFuso('2031-03-10T20:00', 'America/Bahia')).toBe('2031-03-10T23:00:00.000Z')
    expect(instanteNoFuso('2031-03-10T20:00', 'America/Manaus')).toBe('2031-03-11T00:00:00.000Z')
    expect(instanteNoFuso('2031-03-10T20:00', 'America/Rio_Branco')).toBe('2031-03-11T01:00:00.000Z')
    expect(instanteNoFuso('2031-03-10T20:00', 'America/Noronha')).toBe('2031-03-10T22:00:00.000Z')
  })

  it('não depende do fuso de quem está criando (o processo pode estar em qualquer lugar)', () => {
    // a conta é só com o fuso pedido: o mesmo texto dá o mesmo instante sempre
    const a = instanteNoFuso('2031-12-31T23:30', 'America/Manaus')
    expect(a).toBe('2032-01-01T03:30:00.000Z')
    expect(deslocamentoDoFuso(Date.parse(a!), 'America/Manaus')).toBe(-4 * 3600_000)
  })

  it('troca de horário de verão (fuso com DST) acerta na segunda volta', () => {
    // Nova York: 2031-03-09 02:30 não existe (pula pra 03:30); 01:30 é EST (−5) e 12:00 é EDT (−4)
    expect(instanteNoFuso('2031-03-09T01:30', 'America/New_York')).toBe('2031-03-09T06:30:00.000Z')
    expect(instanteNoFuso('2031-03-09T12:00', 'America/New_York')).toBe('2031-03-09T16:00:00.000Z')
  })

  it('vazio, incompleto, dia que não existe e fuso desconhecido: null', () => {
    expect(instanteNoFuso('', 'America/Bahia')).toBeNull()
    expect(instanteNoFuso('2031-03-10', 'America/Bahia')).toBeNull()
    expect(instanteNoFuso('2031-02-31T10:00', 'America/Bahia')).toBeNull()
    expect(instanteNoFuso('2031-03-10T20:00', 'Marte/Olympus')).toBeNull()
    expect(fusoValido('America/Manaus')).toBe(true)
  })
})
