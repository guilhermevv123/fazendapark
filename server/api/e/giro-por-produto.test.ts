import { beforeAll, describe, expect, it, vi } from 'vitest'

// A rota chama `defineEventHandler` (auto-import do Nitro) no topo do arquivo.
vi.stubGlobal('defineEventHandler', (f: unknown) => f)
let chaveDoProduto: typeof import('./[slug].get').chaveDoProduto
let situacoesDoSetor: typeof import('./[slug].get').situacoesDoSetor
beforeAll(async () => {
  ;({ chaveDoProduto, situacoesDoSetor } = await import('./[slug].get'))
})

const agora = new Date('2026-10-15T12:00:00Z')
const ctx = { vendasAbertas: true, giroAutomatico: true, agora }
const lote = (name: string, sort_order: number, extra: Record<string, unknown> = {}) => ({
  name, sort_order, quantity: 100, sold: 0, reserved: 0, starts_at: null, expires_at: null, ...extra,
})

describe('giro de lote por produto', () => {
  it('produtos diferentes no mesmo setor vendem cada um por si (caso 7ª edição)', () => {
    const s = situacoesDoSetor([
      lote('ENTRADA INDIVIDUAL SÁBADO', 1),
      lote('ENTRADA INDIVIDUAL DOMINGO', 2),
      lote('COMBO SÁBADO - COMBO 10 PESSOAS', 3),
      lote('COMBO DOMINGO - COMBO 10 PESSOAS', 4),
    ], ctx)
    expect(s).toEqual(['disponivel', 'disponivel', 'disponivel', 'disponivel'])
  })

  it('1º/2º lote do mesmo produto continuam girando', () => {
    expect(situacoesDoSetor([lote('1º LOTE', 1), lote('2º LOTE', 2)], ctx)).toEqual(['disponivel', 'em_breve'])
    expect(situacoesDoSetor([lote('Pista - 1º lote', 1), lote('Pista - 2º lote', 2)], ctx))
      .toEqual(['disponivel', 'em_breve'])
  })

  it('o giro de um produto não segura o outro', () => {
    const s = situacoesDoSetor([
      lote('Pista 1º lote', 1), lote('Pista 2º lote', 2), lote('Camarote', 3),
    ], ctx)
    expect(s).toEqual(['disponivel', 'em_breve', 'disponivel'])
  })

  it('2º lote abre quando o 1º esgota, só dentro do produto', () => {
    const s = situacoesDoSetor([
      lote('Pista 1º lote', 1, { sold: 100 }), lote('Pista 2º lote', 2), lote('Camarote', 3),
    ], ctx)
    expect(s).toEqual(['esgotado', 'disponivel', 'disponivel'])
  })

  it('sem nome, cai no mesmo giro (comportamento antigo)', () => {
    const l = (o: number) => ({ sort_order: o, quantity: 100, sold: 0, reserved: 0, starts_at: null, expires_at: null })
    expect(situacoesDoSetor([l(1), l(2)], ctx)).toEqual(['disponivel', 'em_breve'])
  })

  it('chaveDoProduto tira só o "qual lote"', () => {
    expect(chaveDoProduto({ name: '2º LOTE' })).toBe('')
    expect(chaveDoProduto({ lote: 'Lote 3' })).toBe('')
    expect(chaveDoProduto({ name: 'Pista - Segundo Lote' })).toBe('pista')
    expect(chaveDoProduto({ name: 'ENTRADA INDIVIDUAL SÁBADO' })).toBe('entrada individual sabado')
  })
})
