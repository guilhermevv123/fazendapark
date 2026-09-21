import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  arredonda, faceComDesconto, faceParaTotal, paraCentavos,
  precificar, reais, somarPedido, taxaPlataforma,
} from './dinheiro'
import {
  paraCentavos as paraCentavosDaTela, reais as reaisDaTela,
} from '../../app/composables/formato'

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

/* ------------------------------------------------- uma implementação só --- */

/**
 * A trava que impede a SEGUNDA leitura de valor em reais de voltar.
 *
 * Este arquivo tinha a própria: `Number(limpo)` depois de tirar o `R$`. Dava
 * pra ver a discordância rodando as duas lado a lado, e é por isso que os
 * casos abaixo são exatamente as entradas onde elas se separavam — não
 * entradas bonitas.
 *
 * O `toBe(paraCentavosDaTela)` fica vermelho no minuto em que alguém escrever
 * `export function paraCentavos` aqui de novo: deixa de ser a MESMA função e
 * vira uma cópia que ninguém compara.
 */
describe('paraCentavos e reais vêm de um lugar só', () => {
  it('são literalmente a função de app/composables/formato.ts', () => {
    expect(paraCentavos).toBe(paraCentavosDaTela)
    expect(reais).toBe(reaisDaTela)
  })

  it('"1.200" é mil e duzentos — a cópia daqui respondia R$ 1,20', () => {
    expect(paraCentavos('1.200')).toBe(120_000)
    // a conta que a cópia fazia, com o JavaScript falando en-US:
    expect(Math.round(Number('1.200') * 100)).toBe(120)
    expect(paraCentavos('1.200')).not.toBe(Math.round(Number('1.200') * 100))
    expect(paraCentavos('1.000')).toBe(100_000)
  })

  it('"1.234.567" tem resposta; a cópia daqui explodia', () => {
    expect(paraCentavos('1.234.567')).toBe(123_456_700)
    expect(Number('1.234.567')).toBeNaN() // era daqui que saía o "valor inválido"
  })

  it('e continua concordando onde as duas já concordavam', () => {
    for (const t of ['500.00', '8.15', '1.200,00', 'R$ 1.234,56', '27,275', '', 'abc']) {
      expect(paraCentavos(t), `entrada ${JSON.stringify(t)}`).toBe(paraCentavosDaTela(t))
    }
  })
})

describe('reais', () => {
  it('formata pt-BR', () => {
    expect(reais(3000)).toBe('R$ 30,00')
    expect(reais(123_456)).toBe('R$ 1.234,56')
  })

  it('o R$ sai com espaço NORMAL — o fino era o daqui', () => {
    // `toLocaleString('pt-BR', { style: 'currency' })`, que era a conta desta
    // cópia, separa com U+00A0.
    //
    // ATENÇÃO: isto vale pra quem importa `reais` DAQUI — e no servidor isso
    // é ninguém. O e-mail de ingresso NÃO passa por aqui: `email.ts` tem a
    // própria cópia e continua com o espaço fino. Quem lê este caso e conclui
    // "o e-mail está unificado" conclui errado — a varredura no fim do
    // arquivo lista as quatro cópias que sobraram, com a prova.
    expect(reais(3000)).not.toContain(' ')
    expect((3000 / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }))
      .toContain(' ')
  })

  it('centavo quebrado grita em vez de derrubar quem chama', () => {
    // a cópia daqui chamava `inteiro()` e JOGAVA — num caminho de e-mail isso
    // seria cliente sem ingresso, não número errado na tela
    expect(reais(Number.NaN)).toBe('R$ ?')
    expect(() => reais(29.9)).not.toThrow()
  })
})

/* ============================== as cópias que sobraram ================== */

/**
 * A VARREDURA QUE IMPEDE A QUINTA CÓPIA — e que nomeia as quatro que existem.
 *
 * O caso `são literalmente a função de app/composables/formato.ts` prova que
 * ESTE módulo não tem cópia própria. Ele não prova nada sobre o resto do
 * servidor, e o resto do servidor é onde o texto de verdade é montado.
 *
 * Medido: nenhum arquivo do servidor importa `reais` daqui. Quatro escrevem o
 * `R$` sozinhos, com a MESMA linha e nomes diferentes — e o nome diferente é
 * por que `grep "function reais"` devolve zero e passa a sensação de que
 * existe uma escrita só:
 *
 *   email.ts:399        const reais
 *   cancelamento.ts:85  const brl
 *   saque.ts:78         const brl
 *   asaas.ts:1185       const real
 *
 * As quatro divergem do formatador único em dois pontos medidos: separam o
 * `R$` com espaço FINO (U+00A0) e imprimem `R$ NaN` onde o único imprime
 * `R$ ?`. O e-mail de ingresso do comprador sai por `email.ts`.
 *
 * A asserção é de SUPERCONJUNTO de propósito: ela acusa cópia NOVA e fica
 * calada quando uma das quatro é consertada. Igualdade aqui viraria vermelho
 * na cara de quem está justamente arrumando o problema — e três desses quatro
 * arquivos pertencem a outras trilhas, em obra agora.
 *
 * `reaisParaCentavos` do `asaas.ts` fica FORA da lista de propósito: ela lê
 * o float que o gateway manda em JSON (`"value": 19.9`), não texto digitado
 * por gente, e a régua de milhar do pt-BR não se aplica. É a única leitura de
 * reais que tem motivo pra existir fora do formatador único, e o motivo está
 * escrito lá.
 */
const COPIAS_CONHECIDAS = ['asaas.ts', 'cancelamento.ts', 'email.ts', 'saque.ts']

/** o código sem comentário — senão a própria explicação acima acusa o arquivo */
function semComentario(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((linha) => {
    const barras = linha.search(/(^|[^:])\/\//)
    return barras >= 0 ? linha.slice(0, linha.indexOf('//', barras)) : linha
  }).join('\n')
}

describe('quantos jeitos de escrever R$ existem em server/utils', () => {
  const dir = new URL('.', import.meta.url)
  const proprios = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter((f) => {
      const src = semComentario(readFileSync(new URL(f, dir), 'utf8'))
      return /style:\s*['"]currency['"]|Intl\.NumberFormat/.test(src)
    })
    .sort()

  it('não nasceu uma quinta cópia', () => {
    const novas = proprios.filter((f) => !COPIAS_CONHECIDAS.includes(f))
    expect(novas,
      'arquivo novo montando o R$ por conta própria: importe `reais` de ./dinheiro '
      + '— a cópia separa com espaço fino (U+00A0) e imprime "R$ NaN" no lugar de "R$ ?"')
      .toEqual([])
  })

  it('e as quatro conhecidas realmente divergem do formatador único', () => {
    // a linha que as quatro repetem, rodada aqui pra a divergência ser um
    // NÚMERO medido e não uma afirmação de comentário
    const daCopia = (c: number) =>
      (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

    expect(daCopia(3000)).not.toBe(reais(3000))          // U+00A0 contra U+0020
    expect(daCopia(3000).charCodeAt(2)).toBe(0x00a0)
    expect(reais(3000).charCodeAt(2)).toBe(0x0020)

    // O MENOS TROCA DE LADO — a divergência que aparece a olho nu, e some
    // numa tela de estorno. Hoje nenhuma linha de `audit_log` tem `*Cents`
    // negativo (medido: zero), então ninguém viu ainda; `cancelamento.ts` e
    // `saque.ts`, que são duas das quatro cópias, são justamente os dois
    // lugares onde valor devolvido tem sinal.
    expect(reais(-2000)).toBe('R$ -20,00')
    expect(daCopia(-2000)).toBe('-R$ 20,00')
    expect(daCopia(-2000)).not.toBe(reais(-2000))
    // o ` ` está escrito por extenso porque a armadilha é exatamente
    // esta: 'R$ NaN' digitado com espaço normal FALHA contra esta string, e
    // as duas aparecem idênticas no relatório do vitest
    expect(daCopia(Number.NaN)).toBe('R$ NaN')      // o que o comprador lê
    expect(reais(Number.NaN)).toBe('R$ ?')
  })
})
