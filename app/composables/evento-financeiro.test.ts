// @vitest-environment happy-dom
/**
 * Financeiro do evento na TELA — o borderô que vai pro produtor e pro contador.
 *
 * ADM-13: a linha "Resultado" dizia Face − Descontos − Estornado ao lado do Líquido e a conta não
 * fechava: o "Estornado" era TODA devolução (inclusive a do pedido estornado por inteiro, cuja face
 * já nem está na face vendida) e a fatia da plataforma não aparecia.
 * ADM-35: o CSV era montado à mão, sem neutralizar fórmula.
 *
 * A fixture é a de `relatorios.test.ts` em escala: face 1.000, taxa do comprador 100, cupom 50,
 * plataforma 100, estorno parcial 20 → líquido 930; e um pedido de R$ 220 estornado por inteiro.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { limparTela, montarTela } from './.vitest-setup-dom'

const tela = () => import('../pages/admin/evento/[id]/financeiro/bordero.vue')
const EV = 'ev-bordero'

const TOTAIS = {
  faceCents: 1000_00, taxaCents: 100_00, plataformaCents: 100_00, descontoCents: 50_00,
  estornadoCents: 240_00, estornadoNoLiquidoCents: 20_00, liquidoCents: 930_00,
  transferidoCents: 0, emCursoCents: 0, naPlataformaCents: 930_00, recebidoDiretoCents: 0,
  aReceberCents: 930_00, pedidosPagos: 3, pedidosPendentes: 0, pedidosPerdidos: 0,
  ingressosEmitidos: 5, cortesias: 0, ingressosUsados: 0, pessoasQueEntraram: 0,
  ingressosCancelados: 0, comparecimentoPct: 0, aptos: 5,
}
const BORDERO = {
  evento: { id: EV, nome: 'Evento', slug: 'evento', status: 'ativo', inicio: '2026-10-18T12:00:00Z',
            fim: '2026-10-18T22:00:00Z', taxaBps: 1000, liberaEm: '2026-10-20T22:00:00Z', liberado: false },
  totais: TOTAIS,
  lotes: [{ setor: '=HYPERLINK("http://x";"clique")', setorTipo: 'ingresso', lote: '1º lote', loteId: 'l1',
            faceUnitCents: 100_00, estoque: 100, vendidos: 10, cortesias: 0, faceCents: 1000_00, taxaCents: 100_00 }],
  canais: [], formas: [],
}

const montar = async (dados: any = BORDERO) => montarTela(await tela(), {
  rota: { params: { id: EV } },
  respostas: { [`/api/admin/evento/${EV}/bordero`]: dados },
  stubs: { AbasSecao: true },
})

afterEach(() => { limparTela(); vi.restoreAllMocks() })

describe('borderô — a linha Resultado fecha na tela (ADM-13)', () => {
  it('a conta: face + taxa − cupom − plataforma − estorno parcial = líquido', async () => {
    const { linhasDoResultado } = await tela()
    const r = linhasDoResultado(TOTAIS)
    expect(r.linhas.map((l) => [l.chave, l.sinal, l.cents])).toEqual([
      ['face', '', 1000_00], ['taxa', '+', 100_00], ['desconto', '−', 50_00],
      ['plataforma', '−', 100_00], ['parcial', '−', 20_00], ['liquido', '=', 930_00],
    ])
    expect(r.diferencaCents, 'a conta da tela não fecha com o líquido da rota').toBe(0)
    expect(r.estornoTotalCents, 'o estorno total é à parte: 240 − 20 da parte que está no líquido').toBe(220_00)
  })

  it('montada: as seis linhas na ordem, o estorno total à parte, sem "−R$ 240,00" na conta', async () => {
    const w = await montar()
    const linhas = w.findAll('[data-parte="resultado"] [data-linha]')
      .map((l) => [l.find('dt').text().replace(/\s+/g, ' '), l.find('dd').text()])
    expect(linhas).toEqual([
      ['Face vendida', 'R$ 1.000,00'],
      ['+Taxa de serviço paga pelo comprador', 'R$ 100,00'],
      ['−Descontos dados (cupons)', 'R$ 50,00'],
      ['−Parte da plataforma', 'R$ 100,00'],
      ['−Estornos parciais (devolvidos de pedidos que seguem valendo)', 'R$ 20,00'],
      ['=Líquido da produção', 'R$ 930,00'],
    ])
    const aParte = w.find('[data-parte="estorno-total"]')
    expect(aParte.text()).toContain('R$ 220,00')
    expect(aParte.text()).toContain('R$ 240,00')
    expect(w.find('[data-parte="resultado"]').text(), 'a devolução total voltou pra dentro da conta')
      .not.toContain('240,00')
    expect(w.find('[data-parte="conta-nao-fecha"]').exists()).toBe(false)
  })

  it('se a rota e a conta divergirem, a tela avisa em vez de esconder', async () => {
    const w = await montar({ ...BORDERO, totais: { ...TOTAIS, liquidoCents: 929_99 } })
    expect(w.find('[data-parte="conta-nao-fecha"]').text()).toContain('R$ -0,01')
  })
})

describe('borderô — exportação pelo baixarCsv (ADM-35)', () => {
  it('nome de setor que começa com "=" sai neutralizado, e a conta do Resultado vai junto', async () => {
    let blob: Blob | null = null
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b: any) => { blob = b; return 'blob:teste' })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const w = await montar()
    await w.findAll('button').find((b) => b.text().includes('Exportar'))!.trigger('click')
    expect(blob, 'a tela não gerou arquivo nenhum').toBeTruthy()
    const csv = await (blob as unknown as Blob).text()
    expect(csv, 'fórmula crua no CSV').toContain(`"'=HYPERLINK(""http://x"";""clique"")"`)
    expect(csv).toContain('"Líquido da produção";"";"R$ 930,00"')
    expect(csv, 'o sinal da conta sumiu do valor').toContain('"Descontos dados (cupons)";"";"-R$ 50,00"')
    expect(csv).toContain('"Devolvido em pedidos estornados por inteiro (fora da conta)";"";"R$ 220,00"')
  })
})

// ===========================================================================
// Financeiro › Transferências — situação com acento (ADM-44), CSV da casa (ADM-35) e filtro na
// URL (ADM-31)
// ===========================================================================
describe('transferências do evento', () => {
  const transferencias = () => import('../pages/admin/evento/[id]/financeiro/index.vue')
  const saida = (id: string, status: string, beneficiario = 'Produtora') => ({
    id, codigo: `TR-${id}`, beneficiario, documento: null, pedidoPor: 'Dono', pedidoPorEmail: null,
    pedidoEm: '2026-09-20T15:00:00Z', processadoEm: null, valorCents: 1000_00, taxaCents: 0,
    destino: 'chave@pix', destinoTipo: 'pix', status, erro: null, observacao: null, idNoGateway: null })
  const FIN = {
    evento: { id: EV, diasDeRetencao: 2, liberaEm: '2026-10-20T22:00:00Z', liberado: true },
    resumo: { liquidoCents: 5000_00, retidoCents: 0, disponivelCents: 3000_00, emCursoCents: 0,
              naPlataformaCents: 5000_00, recebidoDiretoCents: 0, transferidoCents: 1000_00, transferencias: 2 },
    transferencias: [saida('a', 'concluida', '=HYPERLINK("http://x";"clique")'), saida('b', 'falhou')],
  }
  const abrir = async (query: Record<string, string> = {}) => montarTela(await transferencias(), {
    rota: { params: { id: EV }, query },
    respostas: { [`/api/admin/evento/${EV}/financeiro`]: FIN },
    stubs: { AbasSecao: true, CampoMoeda: true, ModalLateral: true },
  })

  it('a situação sai com acento, nas palavras do filtro', async () => {
    const w = await abrir()
    const selos = w.findAll('[data-parte="situacao"]').map((s) => s.text())
    expect(selos, '"CONCLUIDA" sem acento voltou').toEqual(['CONCLUÍDA', 'FALHOU'])
  })

  it('o CSV sai pelo baixarCsv: fórmula neutralizada, valor em reais, situação com acento', async () => {
    const w = await abrir()
    let blob: Blob | null = null
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b: any) => { blob = b; return 'blob:x' })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await w.findAll('button').find((b) => b.text().includes('Exportar'))!.trigger('click')
    const csv = await blob!.text()
    expect(csv, 'fórmula crua na planilha').toContain(`"'=HYPERLINK(""http://x"";""clique"")"`)
    expect(csv).toContain('"R$ 1.000,00"')
    expect(csv).toContain('"Concluída"')
  })

  it('o filtro vem da URL (F5 e link mantêm o recorte) e volta pra ela', async () => {
    const { navegacoes } = await import('./.vitest-setup-dom')
    const w = await abrir({ status: 'falhou' })
    expect(w.findAll('[data-parte="situacao"]').map((s) => s.text()), 'o F5 perdeu o filtro').toEqual(['FALHOU'])
    await w.find('select#st').setValue('concluida')
    await new Promise((r) => setTimeout(r, 300))
    expect(navegacoes.at(-1), 'o filtro não foi pra URL').toEqual({ query: { status: 'concluida' } })
  })
})
