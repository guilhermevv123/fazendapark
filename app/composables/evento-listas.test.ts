// @vitest-environment happy-dom
/**
 * As listas do evento que viram planilha — Histórico de leituras e Participantes (ADM-14, ADM-44).
 *
 * As duas montavam o CSV à mão, só com aspas: o código lido pelo leitor (a leitura inválida é
 * gravada como veio) e o nome digitado no checkout PÚBLICO iam crus pro Excel, e
 * `=HYPERLINK("http://x";"clique")` virava link ativo no computador de quem confere. O arquivo
 * agora sai pelo `baixarCsv`, que põe o apóstrofo na frente de `= + - @`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { limparTela, montarTela } from './.vitest-setup-dom'

const EV = 'ev-listas'
const FORMULA = '=HYPERLINK("http://x";"clique")'
const NEUTRA = `"'=HYPERLINK(""http://x"";""clique"")"`

/** captura o arquivo que a tela "baixou" */
function capturarCsv() {
  const pego: { blob: Blob | null } = { blob: null }
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: any) => { pego.blob = b; return 'blob:teste' })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return async () => {
    expect(pego.blob, 'a tela não gerou arquivo nenhum').toBeTruthy()
    return (pego.blob as Blob).text()
  }
}

afterEach(() => { limparTela(); vi.restoreAllMocks() })

describe('histórico de leituras — exportação', () => {
  it('o código lido que parece fórmula sai neutralizado', async () => {
    const lerCsv = capturarCsv()
    const w = await montarTela(await import('../pages/admin/evento/[id]/validacao/historico.vue'), {
      rota: { params: { id: EV } },
      respostas: {
        [`/api/admin/evento/${EV}/checkins`]: {
          evento: { id: EV, nome: 'Evento' },
          resumo: { leituras: 1, aceitas: 0, recusadas: 1, entraram: 0, pessoas: 0, aptos: 0, faltam: 0, comparecimentoPct: 0 },
          porHora: [], portoes: [], pagina: 1, paginas: 1,
          leituras: [{ id: 'c1', codigo: FORMULA, resultado: 'invalido', motivo: 'Código inválido',
                       gate: 'Portão A', quando: '2026-09-20T23:30:05.000Z', operador: 'Operador',
                       titular: null, setor: null, lote: null }],
        },
        '/api/portaria/sincronizar': { publico: { pessoas: 0, entradas: 0, offline: 0, ingressos: 0, aptos: 0, comparecimentoPct: 0 }, conflitos: [] },
      },
      stubs: { AbasSecao: true },
    })
    await w.findAll('button').find((b) => b.text().includes('Exportar'))!.trigger('click')
    const csv = await lerCsv()
    expect(csv, 'fórmula crua no CSV do histórico').toContain(NEUTRA)
    expect(csv).not.toContain(`"${FORMULA.replace(/"/g, '""')}"`)
  })
})

describe('participantes — exportação e situação', () => {
  const PARTICIPANTES = {
    evento: { id: EV, nome: 'Evento' },
    setores: [{ id: 's1', nome: 'Piscinas' }],
    resumo: { total: 2, entraram: 1, cortesias: 0, cortesiasCanceladas: 0, gratuitos: 0, cortesiasSemOrigem: 0 },
    pagina: 1, paginas: 1,
    participantes: [
      { id: 't1', codigo: 'CON-AAAA', status: 'valido', cortesia: false, gratuito: false, origemNaoRegistrada: false,
        nome: FORMULA, email: null, documento: null, emitidoEm: '2026-09-20T12:00:00Z', entrouEm: null,
        validadoPor: null, setor: 'Piscinas', lote: '1º lote', tipo: 'Inteira', pedido: 'CON-1', pedidoId: 'p1',
        canal: 'online', comprador: '@SOMA(1;2)', compradorEmail: null },
      { id: 't2', codigo: 'CON-BBBB', status: 'usado', cortesia: false, gratuito: false, origemNaoRegistrada: false,
        nome: 'Ana', email: null, documento: null, emitidoEm: '2026-09-20T12:00:00Z', entrouEm: '2026-09-20T13:00:00Z',
        validadoPor: 'Portaria', setor: 'Piscinas', lote: '1º lote', tipo: 'Inteira', pedido: 'CON-2', pedidoId: 'p2',
        canal: 'online', comprador: 'Ana', compradorEmail: null },
    ],
  }
  const montar = async () => montarTela(await import('../pages/admin/evento/[id]/vendas/participantes.vue'), {
    rota: { params: { id: EV } },
    respostas: { [`/api/admin/evento/${EV}/participantes`]: PARTICIPANTES },
    stubs: { AbasSecao: true, ModalLateral: true },
  })

  it('nome do portador e do comprador que parecem fórmula saem neutralizados', async () => {
    const lerCsv = capturarCsv()
    const w = await montar()
    await w.findAll('button').find((b) => b.text().includes('Exportar'))!.trigger('click')
    const csv = await lerCsv()
    expect(csv, 'fórmula crua no nome do portador').toContain(NEUTRA)
    expect(csv, 'fórmula crua no nome do comprador').toContain(`"'@SOMA(1;2)"`)
    // a situação na planilha é a palavra da tela, não o valor do banco
    expect(csv).toContain('"Já entrou"')
    expect(csv).not.toContain('"usado"')
  })

  it('a situação na lista vem com acento, como no filtro (ADM-44)', async () => {
    const w = await montar()
    expect(w.text()).toContain('VÁLIDO')
    expect(w.text()).toContain('JÁ ENTROU')
    expect(w.text()).not.toMatch(/\bVALIDO\b|\bUSADO\b/)
  })
})

describe('vendas — os cards com os nomes e as réguas do painel (ADM-29)', () => {
  const VENDAS = {
    evento: { id: EV, nome: 'Evento' }, pagina: 1, porPagina: 50, total: 3,
    totais: { pedidos: 3, cobradoCents: 200_00, liquidoCents: 180_00, pendenteCents: 0, estornadoCents: 0,
              ingressosVendidos: 3, cortesias: 2 },
    pedidos: [],
  }
  it('"Total de vendas" com o líquido embaixo, e "Ingressos vendidos" sem a cortesia', async () => {
    const w = await montarTela(await import('../pages/admin/evento/[id]/vendas/index.vue'), {
      rota: { params: { id: EV } },
      respostas: { [`/api/admin/evento/${EV}/vendas`]: VENDAS },
      stubs: { AbasSecao: true, ModalLateral: true },
    })
    const total = w.find('[data-parte="total-vendas"]').text().replace(/\s+/g, ' ')
    expect(total, '"Recebido" com o bruto voltou').toContain('Total de vendas')
    expect(total).toContain('R$ 200,00')
    expect(total, 'o líquido do produtor não está no card').toContain('líquido do produtor R$ 180,00')
    const ingressos = w.find('[data-parte="ingressos-vendidos"]').text().replace(/\s+/g, ' ')
    expect(ingressos).toContain('Ingressos vendidos')
    expect(ingressos).toContain('3')
    expect(ingressos, 'a cortesia sumiu sem aviso').toContain('+ 2 de cortesia')
    expect(w.text()).not.toContain('Recebido')
  })
})

describe('vendas — filtro de contestação e "Cancelar pedido" só pra quem pode (ADM-64)', () => {
  const VENDAS = {
    evento: { id: EV, nome: 'Evento' }, pagina: 1, porPagina: 50, total: 0,
    totais: { pedidos: 0, cobradoCents: 0, liquidoCents: 0, pendenteCents: 0, estornadoCents: 0,
              ingressosVendidos: 0, cortesias: 0 },
    pedidos: [],
  }
  const FICHA = {
    pedido: { codigo: 'DT-1', situacao: 'pago', eventoNome: 'Evento', totalCents: 100_00, descontoCents: 0,
              criadoEm: '2026-09-20T12:00:00Z', pagoEm: '2026-09-20T12:01:00Z', canceladoEm: null, estornadoEm: null },
    cliente: { nome: 'Ana', email: 'ana@teste.invalido', documento: null, telefone: null },
    itens: [], ingressos: [], gateway: [],
    acoes: { reimprimir: false, reenviar: false, cancelar: false,
             impedimento: 'Cancelar pedido é do financeiro ou do dono da conta.', devolucaoPendente: false,
             aDevolverCents: 0, arrependimento: false, arrependimentoMotivo: '', passouPelaPlataforma: true },
  }
  const abrir = async (papel: string) => montarTela(await import('../pages/admin/evento/[id]/vendas/index.vue'), {
    rota: { params: { id: EV }, query: { pedido: 'p1' } },
    respostas: {
      [`/api/admin/evento/${EV}/vendas`]: VENDAS,
      '/api/admin/pedido/p1': FICHA,
      '/api/auth/eu': { usuario: { papel } },
    },
    stubs: { AbasSecao: true, ModalLateral: { template: '<div><slot /><slot name="acoes" /></div>' } },
  })

  it('o filtro de situação acha chargeback e disputa', async () => {
    const w = await abrir('master')
    const opcoes = w.findAll('select option').map((o) => o.attributes('value'))
    expect(opcoes, 'pedido contestado não se filtra').toEqual(expect.arrayContaining(['chargeback', 'disputa']))
  })

  it('Operação não vê o botão que só devolveria "é do financeiro"; o dono vê', async () => {
    const op = await abrir('operacao')
    expect(op.find('[data-parte="cancelar-pedido"]').exists(), 'botão que não funciona pra Operação').toBe(false)
    limparTela()
    const dono = await abrir('master')
    expect(dono.find('[data-parte="cancelar-pedido"]').exists()).toBe(true)
  })
})

describe('transferências — "Link copiado" só quando copiou (ADM-55)', () => {
  const TRANSF = {
    evento: { id: EV, permite: true },
    resumo: { aguardando: 0, concluido: 0, cancelado: 0, expirado: 0 },
    transferencias: [],
  }
  async function criarEPedirCopia() {
    const w = await montarTela(await import('../pages/admin/evento/[id]/vendas/transferencias.vue'), {
      rota: { params: { id: EV } },
      respostas: { [`/api/admin/evento/${EV}/transferencias`]: { ...TRANSF, transferencia: { link: '/transferencia/abc' } } },
      stubs: { AbasSecao: true, ModalLateral: true },
    })
    // cria (a resposta do POST traz o link) e pede a cópia
    const inputs = w.findAll('input')
    for (const i of inputs) if ((i.attributes('type') ?? 'text') !== 'checkbox') await i.setValue('CON-AAAA-BBBB')
    await w.find('form').trigger('submit')
    await new Promise((r) => setTimeout(r, 0))
    await w.find('.faixa-aviso button').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    return w
  }

  it('sem área de transferência (http na LAN), a tela mostra o link pra copiar — não diz "copiado"', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    try {
      const w = await criarEPedirCopia()
      const aviso = w.find('.faixa-aviso').text()
      expect(aviso, 'disse "copiado" sem ter copiado').not.toContain('Link copiado')
      expect(aviso).toContain('/transferencia/abc')
    } finally { vi.unstubAllGlobals() }
  })

  it('com área de transferência, copia e diz que copiou', async () => {
    const escrito: string[] = []
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async (t: string) => { escrito.push(t) } } })
    try {
      const w = await criarEPedirCopia()
      expect(w.find('.faixa-aviso').text()).toContain('Link copiado')
      expect(escrito[0]).toMatch(/\/transferencia\/abc$/)
    } finally { vi.unstubAllGlobals() }
  })
})

// ===========================================================================
// Filtros na URL (ADM-31): vendas, histórico de leituras e transferências
// ===========================================================================
import { unref } from 'vue'

describe('filtros na URL — F5 e link mantêm o recorte (ADM-31)', () => {
  /** monta registrando o `query` que cada useFetch recebeu */
  async function montarRegistrando(tela: any, query: Record<string, string>, respostas: Record<string, any>) {
    const pedidos: { url: string; op: any }[] = []
    const original = (globalThis as any).useFetch
    vi.stubGlobal('useFetch', (url: any, op?: any) => {
      pedidos.push({ url: String(typeof url === 'function' ? url() : url), op })
      return original(url, op)
    })
    try {
      const w = await montarTela(tela, {
        rota: { params: { id: EV }, query }, respostas,
        stubs: { AbasSecao: true, ModalLateral: true },
      })
      const consulta = (fim: string) => {
        const q = pedidos.find((p) => p.url.endsWith(fim))?.op?.query ?? {}
        return Object.fromEntries(Object.entries(q).map(([k, v]) => [k, unref(v as any)]))
      }
      return { w, consulta }
    } finally { vi.unstubAllGlobals() }
  }
  const espera = (ms = 350) => new Promise((r) => setTimeout(r, ms))

  it('vendas: busca, situação, canal e página vêm da URL e voltam pra ela', async () => {
    const { navegacoes } = await import('./.vitest-setup-dom')
    const VENDAS = {
      evento: { id: EV, nome: 'Evento' }, pagina: 3, porPagina: 50, total: 200,
      totais: { pedidos: 200, cobradoCents: 0, liquidoCents: 0, pendenteCents: 0, estornadoCents: 0,
                ingressosVendidos: 0, cortesias: 0 },
      pedidos: [],
    }
    const { w, consulta } = await montarRegistrando(
      await import('../pages/admin/evento/[id]/vendas/index.vue'),
      { busca: 'ana', situacao: 'pago', canal: 'online', pagina: '3' },
      { [`/api/admin/evento/${EV}/vendas`]: VENDAS })
    expect(consulta('/vendas'), 'o F5 voltou pra primeira página de tudo')
      .toEqual({ busca: 'ana', situacao: 'pago', canal: 'online', pagina: 3 })
    expect((w.find('input.campo').element as HTMLInputElement).value).toBe('ana')
    expect(w.text()).toContain('página 3 de 4')

    await w.findAll('select')[0].setValue('estornado')
    await espera()
    // (o temporizador de busca de uma tela de outro caso pode cair aqui: olha só as desta tela)
    expect(navegacoes.filter((n) => 'situacao' in (n.query ?? {})).at(-1), 'o filtro não foi pra URL (a página volta pra 1)')
      .toEqual({ query: { busca: 'ana', situacao: 'estornado', canal: 'online' } })
  })

  it('histórico: resultado, portão e página vêm da URL e voltam pra ela', async () => {
    const { navegacoes } = await import('./.vitest-setup-dom')
    const CHECKINS = {
      evento: { id: EV, nome: 'Evento' },
      resumo: { leituras: 0, aceitas: 0, recusadas: 0, entraram: 0, pessoas: 0, aptos: 0, faltam: 0, comparecimentoPct: 0 },
      porHora: [], pagina: 2, paginas: 5, leituras: [],
      portoes: [{ gate: 'Portão A', filtro: 'Portão A', leituras: 10 }, { gate: 'Portão B', filtro: 'Portão B', leituras: 4 }],
    }
    const { w, consulta } = await montarRegistrando(
      await import('../pages/admin/evento/[id]/validacao/historico.vue'),
      { resultado: 'ja_usado', portao: 'Portão B', pagina: '2' },
      {
        [`/api/admin/evento/${EV}/checkins`]: CHECKINS,
        '/api/portaria/sincronizar': { publico: { pessoas: 0, entradas: 0, offline: 0, ingressos: 0, aptos: 0, comparecimentoPct: 0 }, conflitos: [] },
      })
    expect(consulta('/checkins')).toEqual({ resultado: 'ja_usado', gate: 'Portão B', busca: '', pagina: 2 })
    expect((w.find('select#r').element as HTMLSelectElement).value).toBe('ja_usado')
    expect((w.find('select#g').element as HTMLSelectElement).value).toBe('Portão B')

    await w.find('select#r').setValue('invalido')
    await espera()
    expect(navegacoes.filter((n) => 'resultado' in (n.query ?? {})).at(-1))
      .toEqual({ query: { resultado: 'invalido', portao: 'Portão B' } })
  })

  it('transferências: busca e situação vêm da URL; a busca espera parar de digitar e vai pra URL', async () => {
    const { navegacoes } = await import('./.vitest-setup-dom')
    const TRANSF = { evento: { id: EV, permite: true },
                     resumo: { aguardando: 0, concluido: 0, cancelado: 0, expirado: 0 }, transferencias: [] }
    const { w, consulta } = await montarRegistrando(
      await import('../pages/admin/evento/[id]/vendas/transferencias.vue'),
      { busca: 'ana@', status: 'aguardando' },
      { [`/api/admin/evento/${EV}/transferencias`]: TRANSF })
    expect(consulta('/transferencias')).toEqual({ busca: 'ana@', status: 'aguardando' })
    const chip = w.findAll('button').find((b) => b.text() === 'Aguardando')!
    expect(chip.classes()).toContain('chip-ativo')

    const campo = w.find('input[placeholder^="Busque por e-mail"]')
    const antes = navegacoes.length
    await campo.setValue('bia')
    expect(consulta('/transferencias').busca, 'cada tecla virou consulta').toBe('ana@')
    await espera()
    expect(consulta('/transferencias').busca).toBe('bia')
    expect(navegacoes.slice(antes).filter((n) => n.query?.status === 'aguardando').at(-1))
      .toEqual({ query: { busca: 'bia', status: 'aguardando' } })
  })
})
