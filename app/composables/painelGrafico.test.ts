/**
 * painelGrafico.test.ts — a série contínua, o agrupamento e o rótulo que não troca de mês.
 *
 * FIN-01 / REL-01 (a metade do NAVEGADOR): o servidor mandava o mês como instante
 * (`2026-09-01T03:00:00.000Z`) e a tela lia no fuso do navegador. Aqui o caso roda com o relógio
 * do processo em America/Manaus (-04) e em UTC: a chave de calendário (`2026-09-01`, o que a rota
 * manda agora) sai "set." nos dois; o instante antigo sai "ago." em Manaus — é o defeito,
 * reproduzido pra provar que a fixtura ainda o exerce. Mutação conferida: `rotuloDoPonto` usando
 * `new Date(chave)` no lugar de `paraData` deixa o caso de Manaus vermelho.
 *
 * REL-03: dia sem venda sumia do eixo e 90 dias vazavam do cartão. Mutação: `serieContinua`
 * devolvendo só os pontos recebidos deixa o caso do buraco vermelho.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  detalheDoPonto, escalaDoEixo, escolherPasso, indicesComRotulo, inicioDoBalde, reaisCompacto,
  rotuloDoPonto, serieContinua, variacao,
} from './painelGrafico'
import { mesCurto } from './formato'

const fusoOriginal = process.env.TZ
afterEach(() => { process.env.TZ = fusoOriginal })

describe('o rótulo do mês é o do calendário do parque, em qualquer navegador', () => {
  it('chave 2026-09-01 é "set." em Manaus (-04), na Bahia (-03) e em UTC', () => {
    for (const fuso of ['America/Manaus', 'America/Bahia', 'UTC', 'America/Noronha']) {
      process.env.TZ = fuso
      expect(rotuloDoPonto('2026-09-01', 'mes'), fuso).toBe('set.')
      expect(rotuloDoPonto('2026-09-01', 'mes', true), fuso).toBe('set. 2026')
      expect(detalheDoPonto('2026-09-01', 'mes'), fuso).toBe('setembro de 2026')
      expect(rotuloDoPonto('2026-09-21', 'dia'), fuso).toBe('21/09')
    }
  })

  it('a fixtura exerce o defeito: o INSTANTE que a rota mandava vira agosto num navegador em -04', () => {
    process.env.TZ = 'America/Manaus'
    // o que `date_trunc('month', paid_at)` devolvia, com a sessão do banco em America/Bahia
    expect(mesCurto('2026-09-01T03:00:00.000Z')).toBe('ago.')
    // e o que ela devolvia com a sessão em UTC (produção antes de 6ef139b), lido na Bahia
    process.env.TZ = 'America/Bahia'
    expect(mesCurto('2026-09-01T00:00:00.000Z')).toBe('ago.')
  })

  it('janeiro ganha o ano no eixo mensal', () => {
    expect(rotuloDoPonto('2027-01-01', 'mes')).toBe('jan. 2027')
    expect(rotuloDoPonto('2026-12-01', 'mes')).toBe('dez.')
  })
})

describe('a série é contínua', () => {
  const vendas = [
    { dia: '2026-09-02', cobradoCents: 1000, pedidos: 1 },
    { dia: '2026-09-05', cobradoCents: 3000, pedidos: 2 },
    { dia: '2026-09-05', cobradoCents: 500, pedidos: 1 },
  ]

  it('dia sem venda entra com zero, na ordem do calendário', () => {
    const s = serieContinua(vendas, '2026-09-01', '2026-09-06', 'dia', ['cobradoCents', 'pedidos'])
    expect(s.map((p) => [p.chave, p.cobradoCents, p.pedidos])).toEqual([
      ['2026-09-01', 0, 0], ['2026-09-02', 1000, 1], ['2026-09-03', 0, 0],
      ['2026-09-04', 0, 0], ['2026-09-05', 3500, 3], ['2026-09-06', 0, 0],
    ])
  })

  it('agrupa por semana (começando na segunda) e por mês, e a soma não muda', () => {
    const semanas = serieContinua(vendas, '2026-09-01', '2026-09-06', 'semana', ['cobradoCents'])
    expect(semanas.map((p) => p.chave)).toEqual(['2026-08-31'])
    expect(semanas[0]!.cobradoCents).toBe(4500)
    const meses = serieContinua(vendas, '2026-07-15', '2026-09-30', 'mes', ['cobradoCents'])
    expect(meses.map((p) => [p.chave, p.cobradoCents])).toEqual([
      ['2026-07-01', 0], ['2026-08-01', 0], ['2026-09-01', 4500],
    ])
  })

  it('ponto fora do período não entra', () => {
    const s = serieContinua(vendas, '2026-09-03', '2026-09-04', 'dia', ['cobradoCents'])
    expect(s.reduce((n, p) => n + Number(p.cobradoCents), 0)).toBe(0)
  })

  it('o passo cresce com o período: dia até 2 meses, semana até ~6, mês depois', () => {
    expect(escolherPasso('2026-09-01', '2026-09-30')).toBe('dia')
    expect(escolherPasso('2026-07-01', '2026-09-30')).toBe('semana')
    expect(escolherPasso('2026-01-01', '2026-09-30')).toBe('mes')
    expect(inicioDoBalde('2026-09-27', 'semana')).toBe('2026-09-21') // domingo → a segunda antes
    expect(inicioDoBalde('2026-09-21', 'semana')).toBe('2026-09-21')
  })
})

describe('eixo e rótulos', () => {
  it('o topo do eixo é redondo e nunca menor que a maior barra', () => {
    expect(escalaDoEixo(82_500)).toEqual({ topo: 150_000, linhas: [50_000, 100_000, 150_000] })
    expect(escalaDoEixo(0).topo).toBeGreaterThan(0)
    for (const v of [1, 99, 1234, 99_999, 3_141_592]) expect(escalaDoEixo(v).topo).toBeGreaterThanOrEqual(v)
  })

  it('real compacto sem float no caminho', () => {
    expect(reaisCompacto(95_000)).toBe('R$ 950')
    expect(reaisCompacto(1_250_000)).toBe('R$ 12,5 mil')
    expect(reaisCompacto(1_000_000)).toBe('R$ 10 mil')
    expect(reaisCompacto(123_456_789)).toBe('R$ 1,2 mi')
    expect(reaisCompacto(-50_000)).toBe('-R$ 500')
  })

  it('no máximo N rótulos, espaçados, sem espremer o último', () => {
    expect([...indicesComRotulo(30, 6)]).toEqual([0, 5, 10, 15, 20, 25, 29])
    // o último colado no anterior (1 barra de distância) fica sem rótulo
    expect([...indicesComRotulo(27, 6)]).toEqual([0, 5, 10, 15, 20, 25])
    expect([...indicesComRotulo(5, 10)]).toEqual([0, 1, 2, 3, 4])
    expect(indicesComRotulo(0, 6).size).toBe(0)
  })

  it('variação contra o anterior: sem base não inventa porcentagem', () => {
    expect(variacao(150, 100)).toBe(50)
    expect(variacao(50, 100)).toBe(-50)
    expect(variacao(10, 0)).toBeNull()
    expect(variacao(10, null)).toBeNull()
  })
})
