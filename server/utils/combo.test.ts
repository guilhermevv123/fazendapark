/**
 * combo.test.ts — o combo vira um ingresso por pessoa (050): quantas partes, o rótulo e a fração da
 * troca de dia de uma parte, com os preços REAIS da 6ª edição.
 */
import { describe, expect, it } from 'vitest'
import { partesPorUnidade, rotuloDaParte } from './combo'
import { opcoesDeTroca, type TipoParaTroca } from './troca-de-dia'
import { pagoDoIngressoNaTroca } from './troca-de-dia-banco'
import { pessoasPorDiaDeUso } from './pessoas-por-dia'

describe('as partes do combo', () => {
  it('combo de 10 emite 10; entrada solta, tipo sem pessoas e lixo emitem 1', () => {
    expect(partesPorUnidade(10)).toBe(10)
    expect(partesPorUnidade('15')).toBe(15)
    for (const x of [null, undefined, 1, 0, -3, 'abc', 101, 1.5]) expect(partesPorUnidade(x)).toBe(1)
  })
  it('"pessoa 3 de 10"; fora de combo, nada', () => {
    expect(rotuloDaParte(3, 10)).toBe('pessoa 3 de 10')
    expect(rotuloDaParte(null, null)).toBeNull()
    expect(rotuloDaParte(11, 10)).toBeNull()
  })
})

describe('a troca de dia de UMA parte paga a fração', () => {
  const DOM = '2026-10-11', SAB = '2026-10-10'
  const TIPOS: TipoParaTroca[] = [
    { id: 'ind-dom', nome: 'ENTRADA INDIVIDUAL DOMINGO', dias: [DOM], faceCents: 3000, pessoas: 1, disponivel: true, ordem: 0 },
    { id: 'combo-sab', nome: 'COMBO SÁBADO - COMBO 10 PESSOAS', dias: [SAB], faceCents: 16000, pessoas: 10, disponivel: true, ordem: 1 },
    { id: 'combo-dom', nome: 'COMBO DOMINGO - COMBO 10 PESSOAS', dias: [DOM], faceCents: 25000, pessoas: 10, disponivel: true, ordem: 2 },
  ]
  it('o pago da parte é 1/10 do combo', () => {
    expect(pagoDoIngressoNaTroca(16000, 'combo-sab', TIPOS, 1, 10)).toBe(1600)
    expect(pagoDoIngressoNaTroca(null, 'combo-sab', TIPOS, 1, 10), 'sem item: o preço de hoje do tipo').toBe(1600)
    expect(pagoDoIngressoNaTroca(16000, 'combo-sab', TIPOS), 'ingresso inteiro: o valor cheio').toBe(16000)
  })
  it('parte de combo de sábado no domingo: troca pelo COMBO de domingo, R$ 25 − R$ 16 = R$ 9', () => {
    const o = opcoesDeTroca({ tipo: 'COMBO SÁBADO - COMBO 10 PESSOAS', pessoas: 1, pessoasDoTipo: 10, pagoCents: 1600 }, TIPOS, DOM)
    expect(o).toEqual([{ tipoId: 'combo-dom', nome: 'COMBO DOMINGO - COMBO 10 PESSOAS', pessoas: 1, precoCents: 2500,
      diferencaCents: 900, sugerida: true }])
  })
  it('a parte NÃO vira entrada individual (o preço da pessoa no combo é outro)', () => {
    const o = opcoesDeTroca({ tipo: 'COMBO SÁBADO - COMBO 10 PESSOAS', pessoas: 1, pessoasDoTipo: 10, pagoCents: 1600 }, TIPOS, DOM)
    expect(o.map((x) => x.tipoId)).not.toContain('ind-dom')
  })
  it('o combo antigo, de um ingresso só, segue trocando inteiro (R$ 90)', () => {
    const o = opcoesDeTroca({ tipo: 'COMBO SÁBADO - COMBO 10 PESSOAS', pessoas: 10, pagoCents: 16000 }, TIPOS, DOM)
    expect(o[0]).toMatchObject({ tipoId: 'combo-dom', pessoas: 10, precoCents: 25000, diferencaCents: 9000 })
  })
})

describe('pessoas por dia com as partes', () => {
  it('10 partes de 1 pessoa contam 10 pessoas "em combo" no dia', () => {
    const r = pessoasPorDiaDeUso(
      [{ tipo: 'COMBO DOMINGO', dias: ['2026-10-11'], pessoas: 1, ingressos: 10, emCombo: true },
       { tipo: 'ENTRADA INDIVIDUAL DOMINGO', dias: ['2026-10-11'], pessoas: 1, ingressos: 3 }],
      [{ dia: '2026-10-11', rotulo: 'domingo 11/10' }])
    expect(r.dias[0]).toMatchObject({ pessoas: 13, emCombo: 10 })
  })
})

import { diaDoCorteOnline, vendeOnlineAgora } from './dias-de-uso'
describe('prazo da venda online por dia (dono, 09/10)', () => {
  // quinta 08/10 23:59 e sexta 09/10 00:00 no fuso do parque (UTC−3)
  const quinta2359 = new Date('2026-10-09T02:59:00Z')
  const sexta0000 = new Date('2026-10-09T03:00:00Z')
  it('o ingresso de sexta vende até quinta 23:59 e sai à meia-noite', () => {
    expect(vendeOnlineAgora(['2026-10-09'], '2026-10-09T12:00:00Z', 'America/Bahia', quinta2359)).toBe(true)
    expect(vendeOnlineAgora(['2026-10-09'], '2026-10-09T12:00:00Z', 'America/Bahia', sexta0000)).toBe(false)
  })
  it('o de sábado segue vendendo na sexta', () => {
    expect(vendeOnlineAgora(['2026-10-10'], '2026-10-09T12:00:00Z', 'America/Bahia', sexta0000)).toBe(true)
  })
  it('tipo sem dia: o corte é o 1º dia do evento (evento de quarta vende até terça 23:59)', () => {
    expect(diaDoCorteOnline(null, '2026-10-14T12:00:00Z', 'America/Bahia')).toBe('2026-10-14')
    expect(vendeOnlineAgora(null, '2026-10-14T12:00:00Z', 'America/Bahia', new Date('2026-10-14T02:59:00Z'))).toBe(true)
    expect(vendeOnlineAgora(null, '2026-10-14T12:00:00Z', 'America/Bahia', new Date('2026-10-14T03:00:00Z'))).toBe(false)
  })
  it('vários dias: o corte é o PRIMEIRO', () => {
    expect(diaDoCorteOnline(['2026-10-11', '2026-10-10'], null, 'America/Bahia')).toBe('2026-10-10')
  })
})

// portaria, 10/10: "um QR Code só pra ler os 10 ... quando lê, lê automaticamente tudo"
describe('QR do combo inteiro', () => {
  it('o código do grupo é o da parte + -COMBO, e volta pra parte (digitado em minúscula também)', async () => {
    const { codigoDoComboInteiro, parteDoComboInteiro } = await import('./combo')
    expect(codigoDoComboInteiro('ING-ABCD-EFGH')).toBe('ING-ABCD-EFGH-COMBO')
    expect(parteDoComboInteiro('ING-ABCD-EFGH-COMBO')).toBe('ING-ABCD-EFGH')
    expect(parteDoComboInteiro(' ing-abcd-efgh-combo ')).toBe('ING-ABCD-EFGH')
    expect(parteDoComboInteiro('ING-ABCD-EFGH')).toBeNull()
    expect(parteDoComboInteiro('-COMBO')).toBeNull()
    expect(parteDoComboInteiro(null)).toBeNull()
  })

  it('o pedido ganha UM QR por combo com 2+ pessoas ainda pra entrar, na frente da pessoa 1', async () => {
    const { combosDoPedido } = await import('./combo')
    const parte = (g: string, k: number, extra: any = {}) =>
      ({ id: `${g}${k}`, code: `CON-${g}${k}-AAAA`, status: 'valido', combo_group: g, combo_seq: k, combo_size: 3, ...extra })
    const r = combosDoPedido([
      { id: 'solta', code: 'ING-SOLT-AAAA', status: 'valido' },
      parte('a', 1, { status: 'usado' }), parte('a', 2), parte('a', 3),
      parte('b', 1), parte('b', 2, { transferido: true }), parte('b', 3, { status: 'usado' }),
      parte('c', 1), parte('c', 2), parte('c', 3, { status: 'cancelado' }),
    ])
    // a: 2 restam, começa pela 2; b: só 1 resta (a outra é do amigo) = sem QR do grupo; c: 2 restam
    expect(r).toEqual([
      { grupo: 'a', tamanho: 3, restam: 2, ticketId: 'a2', codigoDaParte: 'CON-a2-AAAA', codigo: 'CON-a2-AAAA-COMBO', antesDe: 'a1' },
      { grupo: 'c', tamanho: 3, restam: 2, ticketId: 'c1', codigoDaParte: 'CON-c1-AAAA', codigo: 'CON-c1-AAAA-COMBO', antesDe: 'c1' },
    ])
  })
})
