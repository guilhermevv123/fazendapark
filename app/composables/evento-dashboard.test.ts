// @vitest-environment happy-dom
/**
 * Painel do evento na TELA — o que o dono lê (ADM-11, ADM-12, ADM-33).
 *
 * ADM-11: "− R$ 100 devolvidos" aparecia debaixo de um total que nunca teve esse dinheiro (o
 * pedido estornado por inteiro não é pedido vivo) e quem lia descontava de novo; o líquido vinha
 * na resposta e não aparecia em lugar nenhum. ADM-12: "Pedidos concluídos" contava a cortesia.
 * ADM-33: "1.5 ingressos por pedido", com ponto.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { limparTela, montarTela } from './.vitest-setup-dom'

const tela = () => import('../pages/admin/evento/[id]/dashboard.vue')
const EV = 'ev-painel'

/** um pedido de R$ 200 pago, um de R$ 100 estornado por inteiro, e duas cortesias */
const PAINEL = {
  periodo: { de: '2026-09-01T03:00:00.000Z', ate: '2026-09-21T02:59:59.999Z', fuso: 'America/Bahia', hoje: '2026-09-20' },
  regua: 'pedido que virou dinheiro, pela data do pagamento',
  totais: {
    cobradoCents: 200_00, faceCents: 200_00, taxaCents: 20_00, descontoCents: 0,
    estornadoCents: 100_00, pedidosComDevolucao: 1, estornadoNoLiquidoCents: 0, liquidoCents: 180_00,
    hojeCents: 0, hojeLiquidoCents: 0,
    pedidos: 3, pedidosFechados: 3, pedidosComEstorno: 0,
    ingressos: 5, pagos: 3, cortesiasEmitidas: 2,
    ticketMedioPorIngressoCents: 66_67, ticketMedioPorPedidoCents: 200_00,
    ingressosPorPedido: 1.5, pedidosPagantes: 1, ingressosPagantes: 3, pedidosSemCobranca: 2,
  },
  publico: { pessoas: 0, passagens: 0, ingressosComEntrada: 0, passagensOffline: 0, ultimaEm: null },
  ritmo: [{ dia: '2026-09-20', cobradoCents: 200_00, liquidoCents: 180_00, ingressos: 3 }],
  funil: { criados: 4, finalizados: 3, devolvidos: 1, abandonados: 0, abertos: 0, contestados: 0, comEstorno: 0, outros: 0 },
  porForma: [{ forma: 'pix', cobradoCents: 200_00, liquidoCents: 180_00, n: 1 }],
  porCanal: [{ canal: 'online', cobradoCents: 200_00, liquidoCents: 180_00, n: 1 }],
  porSetor: [{ setor: 'Pista', lote: '1º lote', quantidade: 100, vendidos: 5, reservados: 0,
               vendidosPeriodo: 5, cobradoCents: 200_00 }],
}

const montar = async (dados: any = PAINEL) => montarTela(await tela(), {
  rota: { params: { id: EV }, path: `/admin/evento/${EV}/dashboard` },
  respostas: { [`/api/admin/evento/${EV}/dashboard`]: dados },
})

afterEach(() => limparTela())

describe('painel — devolução, líquido e pedidos pagos', () => {
  it('devolvido aparece nomeado, sem sinal de menos, com o porquê de não subtrair (ADM-11)', async () => {
    const w = await montar()
    const linha = w.find('[data-parte="devolvido"]')
    expect(linha.exists(), 'a devolução sumiu da tela').toBe(true)
    expect(linha.text()).toContain('Devolvido ao comprador')
    expect(linha.text()).toContain('R$ 100,00')
    expect(linha.text()).toContain('em 1 pedido')
    expect(linha.text()).toContain('estornado por inteiro')
    expect(w.text(), 'o "− R$ X" voltou: quem lê desconta de novo').not.toMatch(/[−-]\s*R\$\s*100,00/)
  })

  it('o líquido do produtor está na tela (ADM-11)', async () => {
    const w = await montar()
    expect(w.find('[data-parte="liquido"]').text()).toContain('R$ 180,00')
  })

  it('"Pedidos pagos" não conta cortesia e "ingressos por pedido" sai com vírgula (ADM-12, ADM-33)', async () => {
    const w = await montar()
    expect(w.find('[data-parte="pedidos-pagos"]').text()).toBe('1')
    expect(w.text()).toContain('1,5 ingressos por pedido')
    expect(w.text()).toContain('+ 2 sem cobrança')
  })

  it('sem devolução, a linha nem aparece', async () => {
    const w = await montar({ ...PAINEL, totais: { ...PAINEL.totais, estornadoCents: 0, pedidosComDevolucao: 0 } })
    expect(w.find('[data-parte="devolvido"]').exists()).toBe(false)
  })
})

describe('a rosca é do checkout do site (ADM-28)', () => {
  it('o título e a legenda dizem que balcão e cortesia não entram', async () => {
    const w = await montar()
    const card = w.find('[data-parte="funil-site"]').text().replace(/\s+/g, ' ')
    expect(card).toContain('Checkout do site')
    expect(card, 'a rosca não diz que é só do site').toContain('balcão e cortesia não entram')
  })
})

// ===========================================================================
// O painel redesenhado (27/09): cada defeito do desenho, na tela e nas contas puras da tela
// ===========================================================================
import { vi } from 'vitest'
import { unref } from 'vue'

const conta = () => import('../pages/admin/evento/[id]/dashboard.vue')

/** a resposta com os blocos novos — e um evento que vendeu online e no balcão */
const NOVO = {
  ...PAINEL,
  evento: { id: EV, nome: 'Evento', status: 'ativo' },
  periodo: { ...PAINEL.periodo, nome: 'tudo', diaDe: null, diaAte: null, atualizadoEm: '2026-09-20T17:32:00.000Z', horaAgora: 14 },
  totais: { ...PAINEL.totais, cobradoCents: 1200_00, liquidoCents: 1080_00, liquidoNaPlataformaCents: 900_00, liquidoDiretoCents: 180_00 },
  // online R$ 1.000 (PIX 600 + crédito 400) e balcão R$ 200: a régua do ADM-18
  porForma: [
    { forma: 'pix', cobradoCents: 600_00, liquidoCents: 0, n: 6 },
    { forma: 'credito', cobradoCents: 400_00, liquidoCents: 0, n: 4 },
    { forma: 'dinheiro', cobradoCents: 200_00, liquidoCents: 0, n: 2 },
    { forma: 'cortesia', cobradoCents: 0, liquidoCents: 0, n: 3 },
  ],
  porCanal: [
    { canal: 'online', cobradoCents: 1000_00, liquidoCents: 0, n: 10 },
    { canal: 'bilheteria', cobradoCents: 200_00, liquidoCents: 0, n: 2 },
    { canal: 'cortesia', cobradoCents: 0, liquidoCents: 0, n: 3 },
  ],
  serie: [
    { dia: '2026-09-18', cobradoCents: 500_00, liquidoCents: 0, ingressos: 5 },
    { dia: '2026-09-19', cobradoCents: 0, liquidoCents: 0, ingressos: 0 },
    { dia: '2026-09-20', cobradoCents: 700_00, liquidoCents: 0, ingressos: 7 },
  ],
  serieCortada: false,
  porHoraHoje: Array.from({ length: 24 }, (_, hora) => ({
    hora, hojeCents: hora === 10 ? 300_00 : 0, hojePedidos: hora === 10 ? 3 : 0, ontemCents: hora === 9 ? 100_00 : 0, ontemPedidos: 0 })),
  porTipo: [{ especie: 'inteira', ingressos: 8, cobradoCents: 0 }, { especie: 'meia', ingressos: 4, cobradoCents: 0 },
            { especie: 'gratuito', ingressos: 0, cobradoCents: 0 }],
  cotaDeMeia: [
    { loteId: 'a', setor: 'Piscinas', lote: '1º lote', quantidade: 100, cotaBps: 4000, cota: 40, meias: 36 },
    { loteId: 'b', setor: 'Piscinas', lote: '2º lote', quantidade: 100, cotaBps: 4000, cota: 40, meias: 41 },
    { loteId: 'c', setor: 'Camarote', lote: 'Único', quantidade: 100, cotaBps: 4000, cota: 40, meias: 3 },
  ],
  proximosDias: [
    { id: 's1', titulo: 'Sábado', dia: '2026-10-03', hora: '09:00', capacidade: 100, ocupadas: 100, vagas: 0, lotado: true },
    { id: 's2', titulo: 'Domingo', dia: '2026-10-04', hora: '09:00', capacidade: 100, ocupadas: 60, vagas: 40, lotado: false },
    { id: 's3', titulo: null, dia: '2026-10-12', hora: '09:00', capacidade: null, ocupadas: 5, vagas: null, lotado: false },
  ],
  sessoes: { futuras: 3, todas: 3 },
  portaria: {
    pessoas: 812, entradas: 700, ingressos: 690, aptos: 1100, faltam: 410, comparecimentoPct: 63, offline: 4, ultima: null,
    hoje: { pessoas: 312, passagens: 290 }, portoes: ['Norte', 'Sul'],
    quartos: [
      { quarto: 36, rotulo: '09:00', pessoas: 30, porPortao: { Norte: 20, Sul: 10 } },
      { quarto: 37, rotulo: '09:15', pessoas: 0, porPortao: {} },
      { quarto: 38, rotulo: '09:30', pessoas: 12, porPortao: { Norte: 12 } },
    ],
    barradosHoje: [{ resultado: 'ja_usado', n: 5 }, { resultado: 'invalido', n: 2 }],
  },
  comparacao: null,
}

const montarNovo = async (dados: any = NOVO, query: Record<string, string> = {}) => montarTela(await tela(), {
  rota: { params: { id: EV }, path: `/admin/evento/${EV}/dashboard`, query },
  respostas: { [`/api/admin/evento/${EV}/dashboard`]: dados },
})
const larguras = (w: any, parte: string) =>
  w.findAll(`[data-parte="${parte}"]`).map((b: any) => Number.parseFloat((b.element as HTMLElement).style.width))

describe('funil do site numa barra, não na rosca (ADM-16, ADM-17)', () => {
  it('sem nenhum finalizado, a manchete diz 0% — e não os 100% dos abandonados', async () => {
    const w = await montarNovo({ ...NOVO, funil: { criados: 3, finalizados: 0, devolvidos: 0, abandonados: 3, abertos: 0, contestados: 0, comEstorno: 0, outros: 0 } })
    expect(w.find('[data-parte="funil-pct"]').text(), 'a rosca escrevia "100% finalizados" com 3 abandonados').toBe('0%')
  })

  it('100% finalizados: a barra sai cheia (o arco de 360° não desenhava nada)', async () => {
    const w = await montarNovo({ ...NOVO, funil: { criados: 5, finalizados: 5, devolvidos: 0, abandonados: 0, abertos: 0, contestados: 0, comEstorno: 0, outros: 0 } })
    expect(w.find('[data-parte="funil-pct"]').text()).toBe('100%')
    const segmentos = w.find('[data-parte="funil-barra"]').findAll('div')
    expect(segmentos).toHaveLength(1)
    expect(Number.parseFloat((segmentos[0].element as HTMLElement).style.width)).toBe(100)
  })

  it('funilDoSite: a manchete é a fatia dos finalizados, sobre criados', async () => {
    const { funilDoSite } = await conta()
    expect(funilDoSite({ criados: 6, finalizados: 5, devolvidos: 1 })?.pctFinalizados).toBe(83)
    expect(funilDoSite({ criados: 4, finalizados: 0, abandonados: 4 })?.pctFinalizados).toBe(0)
    expect(funilDoSite({ criados: 0 })).toBeNull()
  })
})

describe('barras de canal e de forma, cada uma na sua escala; zero é trilha vazia (ADM-18, ADM-34)', () => {
  it('online R$ 1.000 e balcão R$ 200: 100% e 20% — não 166% (a escala era a das formas)', async () => {
    const w = await montarNovo()
    expect(larguras(w, 'barra-canal')).toEqual([100, 20, 0])
  })

  it('as formas: PIX 100%, crédito 66,7%, dinheiro 33,3% e cortesia R$ 0 sem risquinho', async () => {
    const w = await montarNovo()
    const l = larguras(w, 'barra-forma')
    expect(l[0]).toBe(100)
    expect(l[1]).toBeCloseTo(66.67, 1)
    expect(l[2]).toBeCloseTo(33.33, 1)
    expect(l[3], 'R$ 0,00 desenhado como se existisse (o mínimo de 2%)').toBe(0)
  })

  it('larguraDaBarra: zero é 0, nada passa de 100, o pequeno não some', async () => {
    const { larguraDaBarra } = await conta()
    expect(larguraDaBarra(0, 500)).toBe(0)
    expect(larguraDaBarra(900, 500)).toBe(100)
    expect(larguraDaBarra(1, 10_000)).toBe(1.5)
    expect(larguraDaBarra(5, 0)).toBe(0)
  })
})

describe('público na portaria no topo do painel (ADM-19)', () => {
  it('quem entrou (pessoas), quantos hoje e o comparecimento — o retrato do leitor', async () => {
    const w = await montarNovo()
    const card = w.find('[data-parte="kpi-publico"]').text().replace(/\s+/g, ' ')
    expect(w.find('[data-parte="publico-pessoas"]').text()).toBe('812')
    expect(card).toContain('312 hoje')
    expect(card).toContain('690 de 1.100 ingressos · 63%')
    expect(card).toContain('4 decididas sem rede')
  })

  it('portaria de hoje: entrou, barrados com o link do histórico já filtrado', async () => {
    const w = await montarNovo()
    const bloco = w.find('[data-parte="portaria-hoje"]')
    expect(bloco.text()).toContain('312')
    expect(bloco.text()).toContain('Já tinha entrado 5')
    const links = bloco.findAll('a').map((a) => a.attributes('href'))
    expect(links).toContain(`/admin/evento/${EV}/validacao/historico?resultado=ja_usado`)
  })
})

describe('vendas por dia: tempo contínuo, eixo que cabe (ADM-20)', () => {
  it('os dias sem venda são barras zero: três dias, três barras — e o eixo X com os três', async () => {
    const w = await montarNovo()
    expect(w.findAll('[data-parte="barra-dia"]')).toHaveLength(3)
    expect(w.findAll('[data-parte="rotulo-x"]').map((r) => r.text())).toEqual(['18/09', '19/09', '20/09'])
  })

  it('um dia só é UMA barra visível (antes era só uma bolinha)', async () => {
    const { graficoDeDias } = await conta()
    const g = graficoDeDias([{ dia: '2026-09-20', cobradoCents: 500_00, ingressos: 5 }])!
    expect(g.barras).toHaveLength(1)
    expect(g.barras[0].h).toBeGreaterThan(100)
  })

  it('365 dias: no máximo 8 rótulos, o primeiro e o último sempre', async () => {
    const { graficoDeDias, indicesDosRotulos } = await conta()
    const serie = Array.from({ length: 365 }, (_, i) => ({
      dia: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), cobradoCents: i % 3 ? 1000 : 0, ingressos: 1 }))
    const g = graficoDeDias(serie)!
    expect(g.rotulosX.length).toBeLessThanOrEqual(8)
    expect(g.rotulosX[0].texto).toBe('01/01')
    expect(g.rotulosX.at(-1)!.texto).toBe('31/12')
    expect(indicesDosRotulos(3)).toEqual([0, 1, 2])
  })

  it('o eixo é compacto — "R$ 12 mil", não "R$ 12.345,67" saindo pela borda', async () => {
    const { reaisCompacto, graficoDeDias } = await conta()
    expect(reaisCompacto(1_234_567)).toBe('R$ 12 mil')
    expect(reaisCompacto(123_456_789)).toBe('R$ 1,2 mi')
    expect(reaisCompacto(85_000)).toBe('R$ 850')
    const g = graficoDeDias([{ dia: '2026-09-20', cobradoCents: 1_234_567, ingressos: 1 }])!
    expect(g.grade.at(-1)!.esquerda).toBe('R$ 12 mil')
  })

  it('sem venda nenhuma: o vazio com ícone, frase e o botão pra ver todo o período', async () => {
    const w = await montarNovo({ ...NOVO, serie: [{ dia: '2026-09-20', cobradoCents: 0, liquidoCents: 0, ingressos: 0 }] }, { periodo: 'hoje' })
    const vazio = w.find('[data-parte="dias-vazio"]')
    expect(vazio.text()).toContain('Nenhuma venda paga neste período')
    expect(vazio.find('button').text()).toContain('Ver todo o período')
  })
})

describe('o período mora na URL e "Hoje" se atualiza sozinho (ADM-31)', () => {
  /** monta registrando o `query` do useFetch e as recargas */
  async function abrirRegistrando(query: Record<string, string>) {
    const pedidos: { url: string; op: any }[] = []
    let recargas = 0
    const original = (globalThis as any).useFetch
    vi.stubGlobal('useFetch', (url: any, op?: any) => {
      const u = String(typeof url === 'function' ? url() : url)
      pedidos.push({ url: u, op })
      return { ...original(url, op), refresh: async () => { recargas++ } }
    })
    try {
      const w = await montarNovo(NOVO, query)
      const consulta = () => {
        const q = pedidos.find((p) => p.url.endsWith('/dashboard'))?.op?.query
        return { ...unref(q) }
      }
      return { w, consulta, recargas: () => recargas }
    } finally { vi.unstubAllGlobals() }
  }

  it('?periodo=7d abre em 7 dias (chip aceso e a consulta certa); trocar volta pra URL', async () => {
    const { navegacoes } = await import('./.vitest-setup-dom')
    const { w, consulta } = await abrirRegistrando({ periodo: '7d' })
    expect(consulta(), 'o F5 voltava pra "Todo o período"').toEqual({ periodo: '7d' })
    expect(w.findAll('[data-parte="periodo"] button').find((b) => b.text() === '7 dias')!.classes()).toContain('chip-ativo')
    await w.findAll('[data-parte="periodo"] button').find((b) => b.text() === 'Ontem')!.trigger('click')
    expect(consulta()).toEqual({ periodo: 'ontem' })
    expect(navegacoes.at(-1)).toEqual({ query: { periodo: 'ontem' } })
  })

  it('período escolhido nas datas vai como ?de=&ate= e volta do link', async () => {
    const { navegacoes } = await import('./.vitest-setup-dom')
    const { w, consulta } = await abrirRegistrando({ de: '2026-09-01', ate: '2026-09-10' })
    expect(consulta()).toEqual({ de: '2026-09-01', ate: '2026-09-10' })
    expect((w.find('#painel-de').element as HTMLInputElement).value).toBe('2026-09-01')
    await w.find('#painel-ate').setValue('2026-09-15')
    expect(consulta()).toEqual({ de: '2026-09-01', ate: '2026-09-15' })
    expect(navegacoes.at(-1)).toEqual({ query: { de: '2026-09-01', ate: '2026-09-15' } })
  })

  it('em "Hoje", a página se atualiza a cada minuto e diz a hora da última leitura', async () => {
    vi.useFakeTimers()
    try {
      const { w, recargas } = await abrirRegistrando({ periodo: 'hoje' })
      expect(w.find('[data-parte="atualizado"]').text()).toContain('Atualizado às 14:32')
      expect(w.find('[data-parte="atualizado"]').text()).toContain('atualiza sozinho')
      vi.advanceTimersByTime(60_000)
      expect(recargas(), 'passou um minuto e o "Hoje" não se atualizou').toBe(1)
      vi.advanceTimersByTime(120_000)
      expect(recargas()).toBe(3)
    } finally { vi.useRealTimers() }
  })

  it('fora de "Hoje" não fica recarregando sozinho', async () => {
    vi.useFakeTimers()
    try {
      const { recargas } = await abrirRegistrando({ periodo: '7d' })
      vi.advanceTimersByTime(180_000)
      expect(recargas()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})

describe('os blocos novos: líquido em duas partes, tipo e cota de meia, próximos dias, comparação', () => {
  it('o líquido com as duas metades do Financeiro', async () => {
    const w = await montarNovo()
    expect(w.find('[data-parte="liquido-partes"]').text().replace(/\s+/g, ' '))
      .toBe('R$ 900,00 na plataforma · R$ 180,00 recebido direto')
  })

  it('cota de meia: perto avisa, passou grita, longe fica quieta', async () => {
    const w = await montarNovo()
    const bloco = w.find('[data-parte="cota-meia"]')
    expect(bloco.findAll('.faixa-aviso').map((f) => f.text())).toEqual(['Perto da cota: restam 4 meias neste lote.'])
    expect(bloco.findAll('.faixa-erro')).toHaveLength(1)
    expect(bloco.find('.faixa-erro').text()).toContain('41 meias num lote de 100 com cota de 40')
  })

  it('próximos dias: Lotado, N vagas, Sem teto', async () => {
    const w = await montarNovo()
    const texto = w.find('[data-parte="proximos-dias"]').text()
    expect(texto).toContain('Lotado')
    expect(texto).toContain('40 vagas')
    expect(texto).toContain('Sem teto')
  })

  it('comparação: as duas janelas lado a lado, a variação da rota e "sem base" quando antes era zero', async () => {
    const atual = { cobradoCents: 1200_00, liquidoCents: 1080_00, ingressosVendidos: 12, pedidosPagantes: 10,
                    ticketMedioPorPedidoCents: 120_00, criadosNoSite: 20, conversaoDoSitePct: 50, entradasNaPortaria: 30 }
    const anterior = { ...atual, cobradoCents: 1000_00, liquidoCents: 1200_00, entradasNaPortaria: 0, conversaoDoSitePct: 40 }
    const w = await montarNovo({
      ...NOVO, periodo: { ...NOVO.periodo, nome: '7d' },
      comparacao: { atual, anterior, duracaoEmDias: 7, ateAMesmaHora: true,
                    variacao: { cobrado: 20, liquido: -10, ingressos: 0, ticketPorPedido: 0, entradas: null, conversaoPp: 10 } },
    }, { periodo: '7d' })
    const linhas = w.find('[data-parte="comparacao"]').findAll('[data-parte="linha-comparacao"]')
      .map((l) => l.findAll('td').map((td) => td.text().replace(/\s+/g, ' ')))
    expect(linhas[0]).toEqual(['Total de vendas', 'R$ 1.200,00', 'R$ 1.000,00', '▲ 20%'])
    expect(linhas[1]).toEqual(['Líquido do produtor', 'R$ 1.080,00', 'R$ 1.200,00', '▼ 10%'])
    expect(linhas[4]).toEqual(['Entradas na portaria (pessoas)', '30', '0', 'sem base'])
    expect(w.find('[data-parte="contra-que"]').text()).toContain('vs os 7 dias anteriores até esta hora')
    expect(w.find('[data-parte="kpi-vendas"]').text()).toContain('▲ 20%')
  })

  it('"todo o período" não tem anterior: nem tabela, nem ▲▼', async () => {
    const w = await montarNovo()
    expect(w.find('[data-parte="comparacao"]').exists()).toBe(false)
    expect(w.find('[data-parte="kpi-vendas"]').text()).not.toMatch(/[▲▼]/)
  })
})

describe('aba Público: o que o checkout pergunta aparece; o aviso fica só com o que não pergunta (ADM-32)', () => {
  const PUBLICO = {
    evento: { id: EV, nome: 'Evento' },
    pessoas: { compradores: 10, novos: 8, recorrentes: 2, semTelefone: 1, ingressosPorPessoa: 1.6 },
    distribuicao: [{ rotulo: '1 ingresso', pessoas: 6, ingressos: 6 }], porDdd: [], porUf: [],
    horaDaCompra: [], topCompradores: [], titulares: { comNome: 10, semNome: 0 },
    presenca: { pessoas: 0, passagens: 0, ingressosComEntrada: 0, passagensOffline: 0, ultimaEm: null },
    idades: { informaram: 4, faixas: [{ faixa: 'Até 17 anos', pessoas: 0 }, { faixa: '18 a 24', pessoas: 3 }, { faixa: '25 a 34', pessoas: 1 },
                                      { faixa: '35 a 44', pessoas: 0 }, { faixa: '45 a 59', pessoas: 0 }, { faixa: '60 ou mais', pessoas: 0 }] },
    cidades: { informaram: 3, top: [{ cidade: 'Vitória Da Conquista', uf: 'BA', pessoas: 3 }] },
    naoColetado: ['gênero'],
  }

  it('?aba=publico abre a aba, com faixa etária, cidade e "1,6 ingressos por pessoa"', async () => {
    const w = await montarTela(await tela(), {
      rota: { params: { id: EV }, path: `/admin/evento/${EV}/dashboard`, query: { aba: 'publico' } },
      respostas: { [`/api/admin/evento/${EV}/dashboard`]: NOVO, [`/api/admin/evento/${EV}/publico`]: PUBLICO },
    })
    await new Promise((r) => setTimeout(r, 0))
    await w.vm.$nextTick()
    expect(w.find('[data-parte="faixa-etaria"]').text()).toContain('4 de 10 compradores informaram')
    expect(w.find('[data-parte="cidades"]').text()).toContain('Vitória Da Conquista')
    expect(w.text()).toContain('1,6 ingressos por pessoa')
    const aviso = w.find('[data-parte="nao-coletado"]').text()
    expect(aviso, 'a tela diz que o checkout não pergunta o que ele pergunta').not.toMatch(/nascimento|endereço/)
    expect(aviso).toContain('gênero')
  })
})
