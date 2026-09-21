import { describe, expect, it } from 'vitest'
import {
  arredonda, faceComDesconto, faceParaTotal, paraCentavos,
  precificar, reais, somarPedido, taxaPlataforma,
} from './dinheiro'

describe('arredonda', () => {
  it('vai meio pra cima', () => {
    expect(arredonda(5, 10)).toBe(1)      // 0,5 → 1
    expect(arredonda(4, 10)).toBe(0)      // 0,4 → 0
    expect(arredonda(15, 10)).toBe(2)     // 1,5 → 2
  })
  it('mantém exatidão onde float erraria', () => {
    // 10% de R$ 999.999,99 = R$ 99.999,999 → arredonda pra 100.000,00
    expect(arredonda(99_999_999 * 1000, 10_000)).toBe(10_000_000)
    // a mesma conta em float: 99999999 * 0.1 = 9999999.900000001
    expect(taxaPlataforma(99_999_999, 1000)).toBe(10_000_000)
    // e um caso onde o .5 exato precisa subir, não cair pro par
    expect(arredonda(5, 10)).toBe(1)
    expect(arredonda(25, 10)).toBe(3)   // 2,5 → 3 (não 2)
  })
})

describe('reproduz o que está no ar na Zig hoje', () => {
  // Lidos no painel da Fazenda Park em 20/09/2026, evento CONQUISTA PARK 3ª ED.
  // Taxa de conveniência de 10%.
  const TAXA = 1000

  it('lote de face R$ 30,00 com taxa repassada → comprador paga R$ 33,00', () => {
    const p = precificar(3000, TAXA, 'repassar')
    expect(p.platformCents).toBe(300)
    expect(p.totalCents).toBe(3300)
    expect(p.produtorCents).toBe(3000)
  })

  it('lote de face R$ 27,27 → comprador paga exatamente R$ 30,00', () => {
    // este é o número que estava no painel: o produtor calculou 30/1,10 na mão
    const p = precificar(2727, TAXA, 'repassar')
    expect(p.platformCents).toBe(273)
    expect(p.totalCents).toBe(3000)
  })

  it('e a gente faz essa conta pra ele, ao contrário', () => {
    const r = faceParaTotal(3000, TAXA, 'repassar')
    expect(r.faceCents).toBe(2727)
    expect(r.exato).toBe(true)
    expect(r.resultado.totalCents).toBe(3000)
  })

  it('combo de 10 pessoas do domingo: R$ 250,00 de face', () => {
    const p = precificar(25000, TAXA, 'repassar')
    expect(p.totalCents).toBe(27500)
  })
})

describe('faceParaTotal', () => {
  it('nunca passa do total pedido', () => {
    for (let alvo = 1; alvo <= 20000; alvo += 7) {
      for (const bps of [0, 500, 1000, 1250, 2000]) {
        const r = faceParaTotal(alvo, bps, 'repassar')
        expect(r.resultado.totalCents).toBeLessThanOrEqual(alvo)
        // e é o MAIOR face possível: um centavo a mais já passaria
        const acima = precificar(r.faceCents + 1, bps, 'repassar')
        expect(acima.totalCents).toBeGreaterThan(alvo)
      }
    }
  })
  it('no modo absorver a face é o próprio total', () => {
    const r = faceParaTotal(5000, 1000, 'absorver')
    expect(r.faceCents).toBe(5000)
    expect(r.resultado.totalCents).toBe(5000)
    expect(r.resultado.produtorCents).toBe(4500) // produtor come a taxa
  })
  it('taxa zero é identidade', () => {
    const r = faceParaTotal(1234, 0, 'repassar')
    expect(r.faceCents).toBe(1234)
    expect(r.exato).toBe(true)
  })
})

describe('modo absorver', () => {
  it('comprador paga a face e o produtor leva o desconto da taxa', () => {
    const p = precificar(3000, 1000, 'absorver')
    expect(p.totalCents).toBe(3000)
    expect(p.feeCents).toBe(0)
    expect(p.platformCents).toBe(300)
    expect(p.produtorCents).toBe(2700)
  })
})

describe('gratuito', () => {
  it('cortesia não gera taxa', () => {
    const p = precificar(0, 1000, 'repassar')
    expect(p.totalCents).toBe(0)
    expect(p.platformCents).toBe(0)
  })
})

describe('faceComDesconto (meia-entrada)', () => {
  it('meia de 50% sobre R$ 30,00', () => {
    expect(faceComDesconto(3000, 5000)).toBe(1500)
  })
  it('arredonda meio pra cima no desconto', () => {
    expect(faceComDesconto(333, 5000)).toBe(166) // 333 − 167
  })
  it('100% zera', () => {
    expect(faceComDesconto(3000, 10_000)).toBe(0)
  })
})

describe('somarPedido', () => {
  it('arredonda por unidade, não no agregado', () => {
    // 3 × face 3333 com 10%: taxa unitária 333 → 999 no total.
    // Se somasse primeiro (9999 × 10% = 1000) daria um centavo fantasma.
    const t = somarPedido([{ quantidade: 3, faceUnitCents: 3333 }], 1000, 'repassar')
    expect(t.platformCents).toBe(999)
    expect(t.totalCents).toBe(3333 * 3 + 999)
  })

  it('o total sempre fecha com a identidade do schema', () => {
    const t = somarPedido(
      [{ quantidade: 2, faceUnitCents: 3000 }, { quantidade: 1, faceUnitCents: 2727 }],
      1000, 'repassar',
    )
    expect(t.totalCents).toBe(t.faceCents + t.feeCents - t.discountCents)
  })

  it('cupom percentual desconta da face, não da taxa', () => {
    const t = somarPedido([{ quantidade: 1, faceUnitCents: 10_000 }], 1000, 'repassar',
      { kind: 'percentual', value: 1000 })
    expect(t.faceCents).toBe(10_000)
    expect(t.feeCents).toBe(1000)        // taxa intacta
    expect(t.discountCents).toBe(1000)   // 10% de 100,00
    expect(t.totalCents).toBe(10_000)
  })

  it('cupom fixo não deixa o total ficar negativo', () => {
    const t = somarPedido([{ quantidade: 1, faceUnitCents: 2000 }], 1000, 'repassar',
      { kind: 'fixo', value: 999_999 })
    expect(t.discountCents).toBe(2000)
    expect(t.totalCents).toBe(200)       // sobra a taxa
    expect(t.totalCents).toBeGreaterThanOrEqual(0)
  })

  it('recusa quantidade inválida', () => {
    expect(() => somarPedido([{ quantidade: 0, faceUnitCents: 100 }], 1000, 'repassar')).toThrow()
    expect(() => somarPedido([{ quantidade: 1.5, faceUnitCents: 100 }], 1000, 'repassar')).toThrow()
  })
})

describe('fronteira de tipos', () => {
  it('recusa float onde espera centavo', () => {
    expect(() => precificar(29.9, 1000, 'repassar')).toThrow(/inteiro/)
    expect(() => taxaPlataforma(100, 10.5)).toThrow(/inteiro/)
  })
  it('recusa face negativa', () => {
    expect(() => precificar(-1, 1000, 'repassar')).toThrow()
  })
})

describe('paraCentavos', () => {
  it('lê o jeito que o brasileiro digita', () => {
    expect(paraCentavos('R$ 1.234,56')).toBe(123_456)
    expect(paraCentavos('1234,56')).toBe(123_456)
    expect(paraCentavos('30')).toBe(3000)
    expect(paraCentavos('29.90')).toBe(2990)   // digitou com ponto decimal
    expect(paraCentavos('')).toBe(0)
  })
  it('o clássico: 29.90 em float não pode virar 2989', () => {
    expect(paraCentavos(29.9)).toBe(2990)
  })
})

describe('reais', () => {
  it('formata pt-BR', () => {
    expect(reais(3000).replace(/ /g, ' ')).toBe('R$ 30,00')
    expect(reais(123_456).replace(/ /g, ' ')).toBe('R$ 1.234,56')
  })
})
