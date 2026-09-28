// @vitest-environment happy-dom
/**
 * painel-relatorios.test.ts — a Visão geral redesenhada (27/09), olhando o que a TELA mostra.
 *
 * A rota já tem os números travados (`relatorios-organizacao.test.ts`, `relatorios-painel.test.ts`);
 * aqui a pergunta é se a tela desenha o número CERTO no lugar certo — a classe de bug que mais
 * passou neste projeto é a que não lança exceção nenhuma e só aparece olhando:
 *
 *   · REL-02: o líquido em destaque com a conta que fecha embaixo;
 *   · proposta 3: o selo de variação contra o período anterior (e nenhum selo sem base);
 *   · REL-03 + REL-01 (metade do navegador): a curva é CONTÍNUA (dia sem venda é barra zero) e o
 *     rótulo é o dia do parque mesmo com o navegador em Manaus;
 *   · REL-04: "Ver os clientes" só pra quem abre Clientes; REL-05: aviso do e-mail parcial;
 *   · REL-07: a tela LÊ a URL — o clique no menu (URL sem filtro) desfiltra a tela;
 *   · REL-06 / proposta 5: cortesia à parte; proposta 7: o funil soma os criados;
 *   · REL-11: um arquivo por tabela, com dinheiro como número que o Excel soma.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { montarTela, navegacoes } from './.vitest-setup-dom'

// montar a página inteira (com o SVG e os sete componentes do painel) passa dos 5 s do padrão na 1ª vez
vi.setConfig({ testTimeout: 30_000 })

const RELATORIOS = () => import('../pages/admin/relatorios.vue')

const EVENTO = '0b0e0c9a-1111-4222-8333-444455556666'

/** um recorte de 7 dias com venda em 3 deles — os números fecham entre si, como os da rota */
function relatorio(extra: Record<string, any> = {}) {
  return {
    filtro: { evento: null, de: '2026-09-21', ate: '2026-09-27', periodo: '7d', hoje: '2026-09-27', primeiroDia: '2026-08-18' },
    resumo: {
      pedidos: 4, ingressos: 9, clientes: 3, pedidosSemCliente: 1,
      cobradoCents: 38_000, faceCents: 38_000, taxaCents: 3_000, descontoCents: 3_000,
      estornadoNoLiquidoCents: 4_000, liquidoCents: 30_200,
      ticketMedioPorPedidoCents: 9_500, ticketMedioPorIngressoCents: 4_222,
      primeiraVenda: null, ultimaVenda: null,
      taxaPlataformaCents: 3_800, pedidosCortesia: 1, ingressosCortesia: 3, pedidosVenda: 3, ingressosVenda: 6,
      ticketMedioVendaCents: 12_667, devolvidoTotalCents: 9_500,
    },
    anterior: {
      de: '2026-09-14', ate: '2026-09-20',
      resumo: {
        pedidos: 3, ingressos: 6, cobradoCents: 40_000, liquidoCents: 20_000, ingressosVenda: 6,
        ticketMedioVendaCents: 12_667, pedidosVenda: 3,
      },
      porDia: [{ dia: '2026-09-15', pedidos: 3, cobradoCents: 40_000, liquidoCents: 20_000 }],
    },
    porDia: [
      { dia: '2026-09-21', pedidos: 2, cobradoCents: 30_000, liquidoCents: 23_000 },
      { dia: '2026-09-25', pedidos: 1, cobradoCents: 8_000, liquidoCents: 7_200 },
      { dia: '2026-09-26', pedidos: 1, cobradoCents: 0, liquidoCents: 0 },
    ],
    porEvento: [{ id: EVENTO, nome: 'Domingo no Parque', situacao: 'ativo', comeca: '2026-10-04T12:00:00.000Z', pedidos: 4, ingressos: 9, cobradoCents: 38_000, liquidoCents: 30_200 }],
    porForma: [{ forma: 'pix', pedidos: 2, cobradoCents: 30_000, liquidoCents: 23_000 }, { forma: 'dinheiro', pedidos: 1, cobradoCents: 8_000, liquidoCents: 7_200 }],
    porCanal: [
      { canal: 'online', pedidos: 2, ingressos: 4, cobradoCents: 30_000, liquidoCents: 23_000 },
      { canal: 'bilheteria', pedidos: 1, ingressos: 2, cobradoCents: 8_000, liquidoCents: 7_200 },
      { canal: 'cortesia', pedidos: 1, ingressos: 3, cobradoCents: 0, liquidoCents: 0 },
    ],
    porTipo: [{ tipo: 'Inteira', ingressos: 2, valorCents: 22_000 }, { tipo: 'Meia', ingressos: 2, valorCents: 11_000 }],
    clientes: {
      total: 3, comCadastro: 1, aceitamNovidades: 1, semIdade: 3, semCidade: 3, porCidade: [],
      porFaixa: [{ chave: 'ate17', rotulo: 'Até 17', clientes: 0 }],
    },
    topCompradores: [{ id: 'c1', nome: 'Ana', email: 'an***@teste.invalido', pedidos: 1, ingressos: 2, gastoCents: 19_000 }],
    cobranca: {
      criados: 8,
      porStatus: [
        { status: 'pago', pedidos: 3, cobradoCents: 27_000 },
        { status: 'estornado_parcial', pedidos: 1, cobradoCents: 11_000 },
        { status: 'aguardando_pagamento', pedidos: 2, cobradoCents: 9_900 },
        { status: 'expirado', pedidos: 1, cobradoCents: 5_000 },
        { status: 'estornado', pedidos: 1, cobradoCents: 5_500 },
      ],
    },
    ...extra,
  }
}

const eu = (papel: string) => ({ usuario: { nome: 'Fulano', email: 'f@t.invalido', papel } })

async function abrir(opcoes: { papel?: string; query?: Record<string, string>; dados?: any } = {}) {
  return montarTela(await RELATORIOS(), {
    rota: { path: '/admin/relatorios', query: opcoes.query ?? {} },
    respostas: {
      '/api/admin/relatorios': opcoes.dados ?? relatorio(),
      '/api/admin/eventos': [{ id: EVENTO, nome: 'Domingo no Parque' }],
      '/api/auth/eu': eu(opcoes.papel ?? 'master'),
    },
  })
}

const fusoOriginal = process.env.TZ
afterEach(() => { process.env.TZ = fusoOriginal })

describe('Visão geral — os números em destaque', () => {
  it('o líquido abre a tela com a conta que fecha embaixo (REL-02)', async () => {
    const tela = await abrir()
    expect(tela.find('h1').text()).toBe('Visão geral')
    const liquido = tela.find('[data-kpi="liquido"]')
    expect(liquido.find('[data-parte="kpi-valor"]').text()).toBe('R$ 302,00')
    const conta = liquido.findAll('[data-parte="conta-do-liquido"] > div')
      .map((linha) => [linha.find('dt').text(), linha.find('dd').text()])
    // 380 − 38 − 40 = 302: a conta fecha com o número em destaque
    expect(conta).toEqual([
      ['cobrado', 'R$ 380,00'], ['− taxa da plataforma', 'R$ 38,00'], ['− devolvido em parte', 'R$ 40,00'],
    ])
    // e o cobrado se explica com o cupom dentro (antes: "ingressos + taxa", que não somava)
    expect(tela.find('[data-parte="conta-do-cobrado"]').text().replace(/\s+/g, ' '))
      .toBe('ingressos R$ 380,00 − descontos R$ 30,00 + taxa R$ 30,00')
  })

  it('ingressos e ticket médio são de VENDA: a cortesia fica à parte (REL-06)', async () => {
    const tela = await abrir()
    expect(tela.find('[data-kpi="ingressos"] [data-parte="kpi-valor"]').text()).toBe('6')
    expect(tela.find('[data-kpi="ticket"] [data-parte="kpi-valor"]').text()).toBe('R$ 126,67')
    expect(tela.find('[data-parte="cortesias"]').text()).toBe('3')
    expect(tela.find('[data-parte="canal-cortesia"]').text()).toContain('3 cortesias emitidas')
  })

  it('o selo compara com o período anterior de mesmo tamanho, no sentido certo', async () => {
    const tela = await abrir()
    const selo = (kpi: string) => tela.find(`[data-kpi="${kpi}"] [data-parte="kpi-variacao"]`)
    // líquido 302 contra 200 = +51%; cobrado 380 contra 400 = −5%; ingressos 6 contra 6 = 0%
    expect(selo('liquido').text()).toBe('+51%')
    expect(selo('liquido').classes()).toContain('selo-ok')
    expect(selo('cobrado').text()).toBe('−5%')
    expect(selo('cobrado').classes()).toContain('selo-erro')
    expect(selo('ingressos').classes()).toContain('selo-neutro')
    expect(tela.find('[data-kpi="liquido"]').text()).toContain('contra 14/09 a 20/09/2026')
  })

  it('sem período anterior ("Tudo") não aparece selo nenhum — nunca uma porcentagem inventada', async () => {
    const tela = await abrir({ query: { periodo: 'tudo' }, dados: relatorio({ anterior: null, filtro: { evento: null, de: null, ate: null, periodo: 'tudo', hoje: '2026-09-27', primeiroDia: '2026-09-21' } }) })
    expect(tela.findAll('[data-parte="kpi-variacao"]')).toHaveLength(0)
  })
})

describe('Visão geral — a curva', () => {
  it('é contínua: 7 dias no recorte são 7 barras, com os dias sem venda em zero (REL-03)', async () => {
    const tela = await abrir()
    expect(tela.findAll('[data-parte="barra"]')).toHaveLength(7)
  })

  it('o rótulo é o dia do PARQUE mesmo com o navegador em Manaus (REL-01)', async () => {
    process.env.TZ = 'America/Manaus'
    const tela = await abrir()
    const eixo = tela.findAll('[data-parte="rotulo-eixo"]').map((r) => r.text())
    // o primeiro ponto é 21/09 (a chave do parque), não 20/09 (o instante lido em -04)
    expect(eixo[0]).toBe('21/09')
    expect(eixo).not.toContain('20/09')
    // o melhor dia, por extenso: segunda, 21/09
    expect(tela.text()).toContain('melhor dia: seg., 21/09/2026')
  })
})

describe('Visão geral — quem vê o quê', () => {
  it('master vê "Ver os clientes"; financeiro não (Clientes é só do master — REL-04)', async () => {
    const master = await abrir({ papel: 'master' })
    expect(master.find('[data-acao="ver-clientes"]').exists()).toBe(true)
    expect(master.find('[data-parte="email-parcial"]').exists()).toBe(false)

    const financeiro = await abrir({ papel: 'financeiro' })
    expect(financeiro.find('[data-acao="ver-clientes"]').exists()).toBe(false)
    // e diz por que o e-mail aparece pela metade (REL-05)
    expect(financeiro.find('[data-parte="email-parcial"]').text()).toContain('base de clientes')
    expect(financeiro.find('[data-parte="email-top"]').text()).toBe('an***@teste.invalido')
  })
})

describe('Visão geral — o recorte é a URL (REL-07)', () => {
  it('sem nada na URL abre em 30 dias; com ?periodo=7d o chip aceso é o de 7 dias', async () => {
    const padrao = await abrir()
    const aceso = (t: any) => t.findAll('button[aria-pressed="true"]').map((b: any) => b.text())
    expect(aceso(padrao)).toContain('30 dias')
    const sete = await abrir({ query: { periodo: '7d' } })
    expect(aceso(sete)).toContain('7 dias')
    expect(aceso(sete)).not.toContain('30 dias')
  })

  it('trocar o período ESCREVE na URL e mantém o evento; o padrão não suja a URL', async () => {
    const tela = await abrir({ query: { evento: EVENTO, periodo: '7d' } })
    const chip = (rotulo: string) => tela.findAll('button').find((b) => b.text() === rotulo)!
    await chip('Hoje').trigger('click')
    expect(navegacoes.at(-1)).toMatchObject({ path: '/admin/relatorios', query: { evento: EVENTO, periodo: 'hoje' } })
    await chip('30 dias').trigger('click')
    expect(navegacoes.at(-1)).toMatchObject({ query: { evento: EVENTO } })
    expect(navegacoes.at(-1).query.periodo).toBeUndefined()
  })

  it('o clique no menu (URL sem filtro) desfiltra a TELA, não só a URL', async () => {
    const tela = await abrir({ query: { evento: EVENTO, periodo: '7d' } })
    const select = tela.find('[data-parte="filtro-evento"]').element as HTMLSelectElement
    expect(select.value).toBe(EVENTO)
    expect(tela.find('[data-acao="limpar-filtros"]').exists()).toBe(true)

    // o que o NuxtLink do menu faz: a rota muda pra /admin/relatorios sem query
    const rota = (globalThis as any).useRoute()
    rota.query = {}
    await nextTick()
    expect((tela.find('[data-parte="filtro-evento"]').element as HTMLSelectElement).value).toBe('')
    expect(tela.find('[data-acao="limpar-filtros"]').exists()).toBe(false)
    expect(tela.findAll('button[aria-pressed="true"]').map((b) => b.text())).toContain('30 dias')
  })
})

describe('Visão geral — Cobrança', () => {
  it('os ramos somam os criados e a conversão é pagos ÷ criados', async () => {
    const tela = await abrir()
    const ramo = (k: string) => tela.find(`[data-ramo="${k}"]`).text().replace(/\s+/g, ' ')
    // pagos = pago 3 + estornado em parte 1 = 4 de 8 → 50%
    expect(tela.find('[data-parte="funil-topo"]').text().replace(/\s+/g, ' ')).toContain('50% de conversão')
    expect(ramo('pagos')).toContain('4')
    expect(ramo('aguardando')).toContain('Aguardando pagamento')
    expect(ramo('nao')).toContain('Expirou sem pagar')
    expect(ramo('devolvidos')).toContain('Estornado')
    const soma = ['pagos', 'aguardando', 'nao', 'devolvidos']
      .map((k) => Number(tela.find(`[data-ramo="${k}"] .titulo`).text()))
      .reduce((a, b) => a + b, 0)
    expect(soma).toBe(8)
  })

  it('sem venda paga: o vazio orienta e a Cobrança continua mostrando quem espera pagar', async () => {
    const vazio = relatorio({
      resumo: { ...relatorio().resumo, pedidos: 0, ingressos: 0, cobradoCents: 0, liquidoCents: 0 },
      porDia: [], porEvento: [], anterior: null,
      cobranca: { criados: 3, porStatus: [{ status: 'aguardando_pagamento', pedidos: 3, cobradoCents: 9_900 }] },
    })
    const tela = await abrir({ dados: vazio })
    expect(tela.find('[data-parte="vazio"]').text()).toContain('Nenhuma venda paga nesse recorte')
    expect(tela.find('[data-parte="vazio"]').text()).toContain('de 21/09 a 27/09/2026')
    expect(tela.find('[data-acao="ver-tudo"]').exists()).toBe(true)
    expect(tela.find('[data-parte="aguardando-no-vazio"]').text()).toContain('3 pedidos esperando pagamento')
    expect(tela.text()).toContain('Aguardando pagamento')
  })
})

describe('Visão geral — planilhas (REL-11)', () => {
  let blobs: Blob[] = []
  let original: any
  beforeEach(() => {
    blobs = []
    original = URL.createObjectURL
    URL.createObjectURL = ((b: Blob) => { blobs.push(b); return 'blob:teste' }) as any
    URL.revokeObjectURL = (() => {}) as any
  })
  afterEach(() => { URL.createObjectURL = original })

  it('um arquivo por tabela, e o dinheiro sai como número que o Excel brasileiro soma', async () => {
    const tela = await abrir()
    await tela.find('[data-acao="exportar"]').trigger('click')
    const botoes = tela.findAll('[data-planilha]').map((b) => b.attributes('data-planilha'))
    expect(botoes).toEqual(['resumo', 'por-dia', 'por-evento', 'por-tipo', 'por-canal', 'por-forma', 'cobranca', 'quem-mais-comprou'])

    await tela.find('[data-planilha="por-dia"]').trigger('click')
    const csv = (await blobs[0]!.text()).replace(/^﻿/, '')
    const linhas = csv.split('\r\n').map((l) => l.split(';').map((c) => c.replace(/^"|"$/g, '')))
    expect(linhas[0]).toEqual(['Dia', 'Pedidos', 'Cobrado (R$)', 'Líquido (R$)'])
    // os 7 dias do recorte, com zero onde não houve venda
    expect(linhas).toHaveLength(8)
    expect(linhas[1]).toEqual(['21/09/2026', '2', '300,00', '230,00'])
    expect(linhas[2]).toEqual(['22/09/2026', '0', '0,00', '0,00'])
    // a coluna soma o cobrado do resumo: é número, não "R$ 300,00"
    const soma = linhas.slice(1).reduce((s, l) => s + Math.round(Number(l[2]!.replace(',', '.')) * 100), 0)
    expect(soma).toBe(38_000)
  })
})
