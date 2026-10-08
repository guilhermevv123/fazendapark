/**
 * troca-de-dia.test.ts — a régua da troca de dia na portaria (049), com os tipos e preços REAIS da
 * 6ª edição (lidos de produção em 08/10). A MESMA função roda no servidor e no tablet sem rede.
 */
import { describe, expect, it } from 'vitest'
import { conferirTroca, nomeSemDia, opcoesDeTroca, type TipoParaTroca } from './troca-de-dia'

const SEX = '2026-10-09', SAB = '2026-10-10', DOM = '2026-10-11', SEG = '2026-10-12'
let n = 0
const tipo = (nome: string, dia: string, faceCents: number, pessoas = 1, disponivel = true): TipoParaTroca =>
  ({ id: `t${++n}`, nome, dias: [dia], faceCents, pessoas, disponivel, ordem: n })

const TIPOS: TipoParaTroca[] = [
  tipo('ENTRADA INDIVIDUAL SEXTA', SEX, 2000),
  tipo('ENTRADA INDIVIDUAL SÁBADO', SAB, 2000),
  tipo('ENTRADA INDIVIDUAL DOMINGO', DOM, 3000),
  tipo('ENTRADA INDIVIDUAL SEGUNDA-FEIRA', SEG, 3000),
  tipo('COMBO SEXTA - COMBO 10 PESSOAS', SEX, 16000, 10),
  tipo('COMBO SÁBADO - COMBO 10 PESSOAS', SAB, 16000, 10),
  tipo('COMBO DOMINGO - COMBO 10 PESSOAS', DOM, 25000, 10),
  tipo('COMBO SEGUNDA-FEIRA - COMBO 10 PESSOAS', SEG, 25000, 10),
]

describe('o tipo irmão', () => {
  it('o nome sem o dia casa os tipos de dias diferentes', () => {
    expect(nomeSemDia('ENTRADA INDIVIDUAL SÁBADO')).toBe(nomeSemDia('ENTRADA INDIVIDUAL DOMINGO'))
    expect(nomeSemDia('ENTRADA INDIVIDUAL SEGUNDA-FEIRA')).toBe('ENTRADA INDIVIDUAL')
    expect(nomeSemDia('COMBO SÁBADO - COMBO 10 PESSOAS')).toBe('COMBO COMBO 10 PESSOAS')
    expect(nomeSemDia('COMBO SÁBADO - COMBO 10 PESSOAS')).toBe(nomeSemDia('COMBO SEGUNDA-FEIRA - COMBO 10 PESSOAS'))
  })
})

describe('as opções de hoje', () => {
  it('sábado no domingo: entrada de domingo, diferença R$ 10,00, sugerida', () => {
    const o = opcoesDeTroca({ tipo: 'ENTRADA INDIVIDUAL SÁBADO', pessoas: 1, pagoCents: 2000 }, TIPOS, DOM)
    expect(o).toEqual([{ tipoId: TIPOS[2]!.id, nome: 'ENTRADA INDIVIDUAL DOMINGO', pessoas: 1, precoCents: 3000,
      diferencaCents: 1000, sugerida: true }])
  })
  it('combo de sábado no domingo: só combo de 10 (as pessoas não mudam), diferença R$ 90,00', () => {
    const o = opcoesDeTroca({ tipo: 'COMBO SÁBADO - COMBO 10 PESSOAS', pessoas: 10, pagoCents: 16000 }, TIPOS, DOM)
    expect(o).toHaveLength(1)
    expect(o[0]).toMatchObject({ nome: 'COMBO DOMINGO - COMBO 10 PESSOAS', diferencaCents: 9000, pessoas: 10, sugerida: true })
  })
  it('o mais caro num dia mais barato entra sem diferença — e sem troco', () => {
    const o = opcoesDeTroca({ tipo: 'ENTRADA INDIVIDUAL DOMINGO', pessoas: 1, pagoCents: 3000 }, TIPOS, SAB)
    expect(o[0]).toMatchObject({ nome: 'ENTRADA INDIVIDUAL SÁBADO', diferencaCents: 0 })
  })
  it('entre dois tipos iguais de hoje vale o do lote aberto', () => {
    const fechado = { ...tipo('ENTRADA INDIVIDUAL DOMINGO', DOM, 2500, 1, false), ordem: -1 }
    const o = opcoesDeTroca({ tipo: 'ENTRADA INDIVIDUAL SÁBADO', pessoas: 1, pagoCents: 2000 }, [fechado, ...TIPOS], DOM)
    expect(o[0]!.precoCents).toBe(3000)
  })
  it('sem tipo de hoje do mesmo tamanho: nada a oferecer', () => {
    const o = opcoesDeTroca({ tipo: 'COMBO 15', pessoas: 15, pagoCents: 20000 }, TIPOS, DOM)
    expect(o).toEqual([])
  })
  it('tipo "qualquer dia" não entra como troca', () => {
    const livre: TipoParaTroca = { id: 'livre', nome: 'INTEIRA', dias: null, faceCents: 1000, pessoas: 1, disponivel: true, ordem: 0 }
    const o = opcoesDeTroca({ tipo: 'ENTRADA INDIVIDUAL SÁBADO', pessoas: 1, pagoCents: 2000 }, [livre, ...TIPOS], DOM)
    expect(o.map((x) => x.tipoId)).not.toContain('livre')
  })
})

describe('a confirmação do porteiro', () => {
  const o = opcoesDeTroca({ tipo: 'ENTRADA INDIVIDUAL SÁBADO', pessoas: 1, pagoCents: 2000 }, TIPOS, DOM)
  const domingo = TIPOS[2]!.id
  it('valor certo e forma escolhida: vale', () => {
    expect(conferirTroca(o, domingo, 1000, 'dinheiro').ok).toBe(true)
  })
  it('valor diferente do de agora: recusa com a conta nova', () => {
    const r = conferirTroca(o, domingo, 500, 'dinheiro')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.erro).toContain('R$')
  })
  it('com diferença, "sem diferença" não vale; sem forma também não', () => {
    expect(conferirTroca(o, domingo, 1000, 'sem_diferenca').ok).toBe(false)
  })
  it('tipo que não vale hoje: recusa', () => {
    expect(conferirTroca(o, TIPOS[0]!.id, 0, 'sem_diferenca').ok).toBe(false)
  })
  it('sem diferença só com "sem diferença"', () => {
    const zero = opcoesDeTroca({ tipo: 'ENTRADA INDIVIDUAL DOMINGO', pessoas: 1, pagoCents: 3000 }, TIPOS, SAB)
    expect(conferirTroca(zero, TIPOS[1]!.id, 0, 'sem_diferenca').ok).toBe(true)
    expect(conferirTroca(zero, TIPOS[1]!.id, 0, 'pix').ok).toBe(false)
  })
})
