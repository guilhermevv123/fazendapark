/**
 * O PDF dos ingressos: uma página por ingresso, o código legível escrito, e nada de estourar por
 * caractere que a fonte padrão do PDF não escreve (emoji, aspas tortas, travessão no nome do evento).
 */
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { latin1, montarPdfDosIngressos } from './ingresso-pdf'

const base = {
  evento: 'Domingo de Sol 🌞 — “edição” especial', quando: '11 de outubro de 2026 às 09:00', local: 'Conquista Park · Vitória da Conquista/BA',
  pedido: 'PED-TEST-0001',
  ingressos: [
    { codigo: 'CON-AAAA-1111', qr: 'v1.qr.assinado.1', tipo: 'Inteira', setor: 'Geral', lote: '1º lote', titular: 'Ana Conceição' },
    { codigo: 'CON-BBBB-2222', qr: 'v1.qr.assinado.2', tipo: 'Meia', setor: 'Geral', lote: '1º lote', titular: 'João Ávila' },
  ],
}

describe('PDF dos ingressos', () => {
  it('uma página por ingresso, e é PDF de verdade', async () => {
    const bytes = await montarPdfDosIngressos(base)
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-')
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(2)
    expect(doc.getTitle()).toContain('Domingo de Sol')
  })

  // portaria, 10/10: o QR do combo inteiro vai na frente e NÃO tira página de ninguém
  it('com o QR do combo: uma página a mais, e nenhuma pessoa do combo fica de fora', async () => {
    const partes = [1, 2, 3].map((k) => ({ codigo: `CON-CMB${k}-AAAA`, qr: `v1.qr.${k}`, tipo: 'Combo', pessoaDoCombo: `pessoa ${k} de 3` }))
    const bytes = await montarPdfDosIngressos({ ...base, ingressos: [
      { codigo: 'CON-CMB1-AAAA-COMBO', qr: 'v1.qr.combo', tipo: 'QR do combo · 3 pessoas', combo: true,
        pessoaDoCombo: 'entram as 3 pessoas de uma vez' }, ...partes] })
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(4)
  })

  it('emoji, aspas tortas e travessão não derrubam o PDF', () => {
    expect(latin1('Sol 🌞 — “x” ‘y’…')).toBe('Sol - "x" \'y\'...')
    expect(latin1('Conceição Ávila')).toBe('Conceição Ávila')
  })
})
