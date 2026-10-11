/**
 * O prazo de venda do site quando o painel deixa o encerramento EM BRANCO (regra do dono, 28/09):
 * vende a véspera do último dia INTEIRA — evento de 15 a 20 vende até a meia-noite que começa o
 * dia 20 (a mesma régua do corte por dia, 09/10). Inclusive depois de ter começado. Até 11/10 era
 * "término − 24h", e o evento que acabava segunda 17h fechou o site domingo 17h.
 */
import { createError } from 'h3'
import { describe, expect, it } from 'vitest'

// a rota usa os globais do Nitro ao carregar: entram antes do import dela
;(globalThis as any).defineEventHandler ??= (h: any) => h
;(globalThis as any).createError ??= createError
const { fimDasVendas, meiaNoiteNoFuso, portaDeVenda } = await import('./[slug].get')

const ev = (extra: Record<string, any> = {}) => ({
  status: 'ativo', timezone: 'America/Bahia',
  starts_at: '2031-03-15T13:00:00Z', ends_at: '2031-03-20T21:00:00Z',
  sales_end_at: null, sales_end_minutes_after: null, ...extra,
})

describe('fimDasVendas · encerramento em branco', () => {
  it('é a meia-noite (no fuso do evento) que começa o último dia', () => {
    // termina 20/03 18h na Bahia: o site fecha 20/03 00h00 da Bahia = 03h00 UTC
    expect(fimDasVendas(ev())?.toISOString()).toBe('2031-03-20T03:00:00.000Z')
  })
  it('a véspera vende INTEIRA: às 22h do dia 19 ainda abre (o caso de 11/10)', () => {
    expect(portaDeVenda(ev(), new Date('2031-03-20T01:00:00Z')).aberta).toBe(true)
    expect(portaDeVenda(ev(), new Date('2031-03-20T02:59:00Z')).aberta).toBe(true)
    expect(portaDeVenda(ev(), new Date('2031-03-20T03:00:00Z')).aberta).toBe(false)
    // a 6ª edição: termina segunda 12/10 17h; domingo 19h16 o site TEM que vender a segunda
    const sexta = ev({ starts_at: '2026-10-09T12:00:00Z', ends_at: '2026-10-12T20:00:00Z' })
    expect(fimDasVendas(sexta)?.toISOString()).toBe('2026-10-12T03:00:00.000Z')
    expect(portaDeVenda(sexta, new Date('2026-10-11T22:16:00Z')).aberta).toBe(true)
  })
  it('meia-noite no fuso: Bahia (−3), São Paulo, e UTC', () => {
    expect(meiaNoiteNoFuso('2026-10-12', 'America/Bahia').toISOString()).toBe('2026-10-12T03:00:00.000Z')
    expect(meiaNoiteNoFuso('2026-10-12', 'America/Sao_Paulo').toISOString()).toBe('2026-10-12T03:00:00.000Z')
    expect(meiaNoiteNoFuso('2026-10-12', 'UTC').toISOString()).toBe('2026-10-12T00:00:00.000Z')
  })
  it('evento que já começou continua vendendo até a véspera do fim', () => {
    expect(portaDeVenda(ev(), new Date('2031-03-17T12:00:00Z')).aberta).toBe(true)
    expect(portaDeVenda(ev(), new Date('2031-03-10T12:00:00Z')).aberta).toBe(true)
  })
  it('no último dia o site já não vende', () => {
    const p = portaDeVenda(ev(), new Date('2031-03-20T12:00:00Z'))
    expect(p.aberta).toBe(false)
    expect(p.motivo).toBe('prazo_encerrado')
  })
  it('data escolhida no painel manda, e "minutos após o início" também', () => {
    expect(fimDasVendas(ev({ sales_end_at: '2031-03-16T00:00:00Z' }))?.toISOString()).toBe('2031-03-16T00:00:00.000Z')
    expect(fimDasVendas(ev({ sales_end_minutes_after: 60 }))?.toISOString()).toBe('2031-03-15T14:00:00.000Z')
  })
})
