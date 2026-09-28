/**
 * O prazo de venda do site quando o painel deixa o encerramento EM BRANCO (regra do dono, 28/09):
 * vende até 1 dia antes do término. Evento de 15 a 20 vende até o dia 19 — inclusive depois de
 * ter começado. Antes o "em branco" fechava no início, e evento com início já passado sumia do site.
 */
import { createError } from 'h3'
import { describe, expect, it } from 'vitest'

// a rota usa os globais do Nitro ao carregar: entram antes do import dela
;(globalThis as any).defineEventHandler ??= (h: any) => h
;(globalThis as any).createError ??= createError
const { fimDasVendas, portaDeVenda, VENDA_PARA_ANTES_DO_FIM_MS } = await import('./[slug].get')

const ev = (extra: Record<string, any> = {}) => ({
  status: 'ativo', timezone: 'America/Bahia',
  starts_at: '2031-03-15T13:00:00Z', ends_at: '2031-03-20T21:00:00Z',
  sales_end_at: null, sales_end_minutes_after: null, ...extra,
})

describe('fimDasVendas · encerramento em branco', () => {
  it('é 1 dia antes do término', () => {
    expect(fimDasVendas(ev())?.toISOString()).toBe('2031-03-19T21:00:00.000Z')
    expect(VENDA_PARA_ANTES_DO_FIM_MS).toBe(24 * 3600_000)
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
