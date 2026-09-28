// @vitest-environment happy-dom
/**
 * Relatórios do evento na TELA — o que o navegador escreve com o que a rota mandou.
 *
 * ADM-10: o dia da tabela "por dia" chega como `AAAA-MM-DD` (dia de calendário do evento). O
 * extrato fazia `new Date('2026-09-20')`, que é meia-noite UTC — 21h do dia 19 na Bahia — e a
 * linha saía com o dia ANTERIOR. O fuso deste processo é fixado na Bahia aqui em cima: numa
 * máquina em UTC o defeito some e o teste passaria à toa.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const TZ_ANTES = process.env.TZ
process.env.TZ = 'America/Bahia'

const { limparTela, montarTela } = await import('./.vitest-setup-dom')

const EV = 'ev-relatorios'
const extrato = () => import('../pages/admin/evento/[id]/relatorios/extrato.vue')

const EXTRATO = {
  evento: { id: EV, nome: 'Evento', feeBps: 1000, modoOnline: 'repassar', modoBalcao: 'absorver' },
  filtros: { de: null, ate: null, canal: '', ponto: '', forma: '', limite: 300 },
  pontos: [],
  totais: { pedidos: 2, ingressos: 2, cobradoCents: 10000, faceCents: 10000, taxaCompradorCents: 0,
            taxaPlataformaCents: 1000, descontoCents: 0, estornadoCents: 0,
            estornadoNoLiquidoCents: 0, liquidoCents: 9000 },
  foraDoTotal: { pedidos: 0, cobradoCents: 0, estornadoCents: 0, porStatus: [] },
  porCanal: [], porPonto: [], porForma: [],
  porDia: [
    { dia: '2026-09-20', pedidos: 1, ingressos: 1, cobradoCents: 5000, faceCents: 5000, taxaCents: 500 },
    { dia: '2026-09-19', pedidos: 1, ingressos: 1, cobradoCents: 5000, faceCents: 5000, taxaCents: 500 },
  ],
  linhas: [],
  truncado: false,
}

afterEach(() => limparTela())
afterAll(() => { process.env.TZ = TZ_ANTES })

describe('extrato — o dia da tabela "por dia"', () => {
  it('20/09 é 20/09 (não 19/09) com o navegador na Bahia', async () => {
    const w = await montarTela(await extrato(), {
      rota: { params: { id: EV } },
      respostas: { [`/api/admin/evento/${EV}/extrato`]: EXTRATO },
      stubs: { AbasSecao: true },
    })
    const dias = w.findAll('tbody tr td:first-child').map((c) => c.text())
    expect(dias, 'data pura lida como UTC: cada linha saiu com o dia anterior').toEqual(['20/09/2026', '19/09/2026'])
  })
})

// ===========================================================================
// Relatórios › Visão geral — ADM-28 (conversão do site), ADM-30 (série sem buraco, 24 horas),
// ADM-35 (CSV pelo baixarCsv) e ADM-48 (número com vírgula)
// ===========================================================================
const visaoGeral = () => import('../pages/admin/evento/[id]/relatorios/index.vue')

const dia = (d: string, cobradoCents: number, pedidos = 1) => ({ dia: d, pedidos, pedidosComEstorno: 0,
  cobradoCents, faceCents: cobradoCents, estornadoNoLiquidoCents: 0, liquidoCents: cobradoCents })

const RELATORIOS = {
  evento: { id: EV, nome: '=HYPERLINK("http://golpe";"clique")', comeca: '2026-10-18T12:00:00Z',
            termina: '2026-10-19T02:00:00Z', criadoEm: '2026-08-01T12:00:00Z', taxaBps: 1000, fuso: 'America/Bahia' },
  resumo: { pedidos: 4, ingressos: 6, ticketMedioCents: 15000, porIngressoCents: 10000, ingressosPorPedido: 1.5,
            faceCents: 54000, taxaCents: 6000, descontoCents: 0, cobradoCents: 60000 },
  funil: { criados: 10, finalizados: 5, pagos: 5, conversaoPct: 50, abandonoPct: 50, canal: 'online',
           porStatus: [{ status: 'pago', n: 5 }, { status: 'expirado', n: 5 }] },
  // três dias com venda num intervalo de DEZ: o gráfico tem que ter as dez barras
  porDia: [dia('2026-09-10', 30000, 2), dia('2026-09-01', 10000), dia('2026-09-05', 20000)],
  porDiaSemana: [{ dow: 2, pedidos: 1, cobradoCents: 10000, liquidoCents: 9000 }],
  porHoraDoDia: [{ hora: 14, pedidos: 3 }, { hora: 20, pedidos: 1 }],
  antecedencia: [], topCompradores: [], porPromoter: [], porCupom: [], porParcela: [],
}

async function abrirVisaoGeral() {
  return montarTela(await visaoGeral(), {
    rota: { params: { id: EV } },
    respostas: { [`/api/admin/evento/${EV}/relatorios`]: RELATORIOS },
    stubs: { AbasSecao: true },
  })
}

describe('série por dia sem buraco, 24 horas e 7 dias (ADM-30)', () => {
  it('serieDiaria preenche o dia sem venda com zero, em ordem, e ignora data torta', async () => {
    const { serieDiaria } = await visaoGeral()
    const vazio = (d: string) => ({ dia: d, n: 0 })
    const s = serieDiaria([{ dia: '2026-09-03', n: 2 }, { dia: '2026-09-01', n: 1 }, { dia: 'lixo', n: 9 }], vazio)
    expect(s).toEqual([{ dia: '2026-09-01', n: 1 }, { dia: '2026-09-02', n: 0 }, { dia: '2026-09-03', n: 2 }])
    // virada de mês e de ano, e o horário de verão não pula nem repete dia
    expect(serieDiaria([{ dia: '2026-12-31', n: 1 }, { dia: '2027-01-02', n: 1 }], vazio).map((d) => d.dia))
      .toEqual(['2026-12-31', '2027-01-01', '2027-01-02'])
    expect(serieDiaria([], vazio)).toEqual([])
    // fim de mês e ano bissexto: o dia seguinte é de calendário
    expect(serieDiaria([{ dia: '2028-02-27', n: 1 }, { dia: '2028-03-01', n: 1 }], vazio).map((d) => d.dia))
      .toEqual(['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01'])
    expect(serieDiaria([{ dia: '2026-04-30', n: 1 }, { dia: '2026-05-01', n: 1 }], vazio).map((d) => d.dia))
      .toEqual(['2026-04-30', '2026-05-01'])
  })

  it('vinteQuatroHoras e seteDias têm todas as posições', async () => {
    const { vinteQuatroHoras, seteDias } = await visaoGeral()
    const h = vinteQuatroHoras([{ hora: 14, pedidos: 3 }])
    expect(h).toHaveLength(24)
    expect(h[0]).toEqual({ hora: 0, pedidos: 0 })
    expect(h[14].pedidos).toBe(3)
    expect(seteDias([{ dow: 6, pedidos: 2 }]).map((d) => d.pedidos)).toEqual([0, 0, 0, 0, 0, 0, 2])
  })

  it('na tela: dez barras de dia (sete sem venda), 24 de hora, e o gráfico rola dentro do card', async () => {
    const w = await abrirVisaoGeral()
    expect(w.findAll('[data-parte="barra-dia"]'), 'o dia sem venda sumiu do gráfico').toHaveLength(10)
    expect(w.find('[data-parte="dias-resumo"]').text().replace(/\s+/g, ' ')).toBe('10 dias · 3 com venda')
    expect(w.findAll('[data-parte="barra-hora"]'), 'o gráfico de horas começou na 1ª hora com venda').toHaveLength(24)
    expect(w.find('[data-parte="por-semana"]').findAll('.rounded-t')).toHaveLength(7)
    expect(w.find('[data-parte="rolagem-dias"]').classes()).toContain('overflow-x-auto')
  })
})

describe('conversão do site e número com vírgula (ADM-28, ADM-48)', () => {
  it('o card diz que a conversão é do site, com os pedidos online', async () => {
    const w = await abrirVisaoGeral()
    const card = w.find('[data-parte="conversao"]').text().replace(/\s+/g, ' ')
    expect(card).toContain('Conversão do site')
    expect(card).toContain('50%')
    expect(card).toContain('5 pagos de 10 pedidos online')
    expect(w.text(), '1,5 ingresso por pedido escrito com ponto').toContain('1,5 ingressos cada')
  })
})

describe('o CSV da visão geral sai pelo baixarCsv (ADM-35)', () => {
  it('nome do evento com cara de fórmula vira texto, e o dia sem venda entra na planilha', async () => {
    const w = await abrirVisaoGeral()
    let blob: Blob | null = null
    const criar = vi.spyOn(URL, 'createObjectURL').mockImplementation((b: any) => { blob = b; return 'blob:x' })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clique = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      await w.findAll('button').find((b) => b.text().includes('Exportar'))!.trigger('click')
      expect(criar).toHaveBeenCalledTimes(1)
      const texto = await blob!.text()
      expect(texto, 'o nome do evento entrou como fórmula no Excel').toContain(`"'=HYPERLINK(""http://golpe"";""clique"")"`)
      expect(texto).toContain('"Ingressos por pedido";"1,5"')
      expect(texto).toContain('"Conversão do site";"50%"')
      expect(texto.split('\r\n').filter((l) => /^"\d{2}\/09\/2026"/.test(l)), 'dia sem venda fora da planilha').toHaveLength(10)
    } finally {
      criar.mockRestore(); clique.mockRestore()
    }
  })
})

// ===========================================================================
// Relatórios › Lotes — o campeão de R$ 0 e a cor do giro invertida (ADM-46)
// ===========================================================================
describe('vendas por lote (ADM-46)', () => {
  const lotes = () => import('../pages/admin/evento/[id]/relatorios/lotes.vue')
  const lote = (loteId: string, vendidos: number, estoque: number, faceUnit: number) => ({
    loteId, setor: `Setor ${loteId}`, lote: `Lote ${loteId}`, faceUnitCents: faceUnit, estoque, vendidos,
    cortesias: 0, faceCents: vendidos * faceUnit, taxaCents: 0 })
  const abrir = async (l: any[]) => montarTela(await lotes(), {
    rota: { params: { id: EV } },
    respostas: { [`/api/admin/evento/${EV}/bordero`]: { lotes: l } },
    stubs: { AbasSecao: true },
  })

  it('esgotando é verde; parado é neutro — não o contrário', async () => {
    const { corDoGiro } = await lotes()
    expect(corDoGiro(95), '90% vendido pintado como problema').toBe('bg-ok')
    expect(corDoGiro(70)).toBe('bg-acao')
    expect(corDoGiro(5)).toBe('bg-linha-forte')
  })

  it('sem venda nenhuma, não há "lote que mais rendeu" e a barra de zero fica vazia', async () => {
    const w = await abrir([lote('A', 0, 100, 5000), lote('B', 0, 50, 3000)])
    const card = w.find('[data-parte="campeao"]').text().replace(/\s+/g, ' ')
    expect(card, 'o campeão de R$ 0,00 voltou').toContain('—')
    expect(card).toContain('nenhum lote vendeu ainda')
    for (const b of w.findAll('[data-parte="giro"]')) expect(b.attributes('style')).toContain('width: 0%')
  })

  it('com venda, o campeão é o de maior receita e o lote esgotando pinta verde', async () => {
    const w = await abrir([lote('A', 10, 100, 5000), lote('B', 48, 50, 3000)])
    expect(w.find('[data-parte="campeao"]').text()).toContain('Setor B')
    const barras = w.findAll('[data-parte="giro"]')
    expect(barras[1].classes()).toContain('bg-ok')
  })
})
