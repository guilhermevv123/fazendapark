// @vitest-environment happy-dom
/**
 * painel-eventos.test.ts — a tela de Eventos (/admin) redesenhada em 27/09.
 *
 *   · EVT-04: busca e situação moram na URL — o F5 e o link mantêm, o clique no menu limpa;
 *   · EVT-05: todo status do banco tem selo (cancelado em vermelho, adiado em alerta), o chip
 *     aparece quando existe evento assim, e o "pausado" (que o banco não tem) sumiu;
 *   · EVT-13 / proposta 15: a barra é dos PAGOS com a cortesia marcada à parte, e o líquido do
 *     evento só aparece pra quem vê o caixa;
 *   · a faixa do dia usa os números das MESMAS rotas (Visão geral e Financeiro), e a operação
 *     recebe uma faixa sem dinheiro.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { buscas, limparTela, montarTela, navegacoes } from './.vitest-setup-dom'

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { limparTela(); vi.useRealTimers() })

const EVENTOS = (comDinheiro = true) => [
  { id: 'e1', nome: 'Domingo no Parque', status: 'ativo', inicio: '2031-03-10T12:00:00Z', organizacao: 'Fazenda Park', cidade: 'Ubatã', estado: 'BA',
    estoque: { total: 10, vendidos: 5, cortesias: 2, pagos: 3 }, ...(comDinheiro ? { cobradoCents: 15_000, liquidoCents: 13_500, pedidos: 2, ingressos: 3 } : {}) },
  { id: 'e2', nome: 'Sábado Kids', status: 'rascunho', inicio: '2031-04-10T12:00:00Z', organizacao: 'Fazenda Park', cidade: 'Itabuna', estado: 'BA',
    estoque: { total: 0, vendidos: 0, cortesias: 0, pagos: 0 }, ...(comDinheiro ? { cobradoCents: 0, liquidoCents: 0, pedidos: 0, ingressos: 0 } : {}) },
  { id: 'e3', nome: 'Feriado Cancelado', status: 'cancelado', inicio: '2030-11-15T12:00:00Z', organizacao: 'Fazenda Park', cidade: 'Ubatã', estado: 'BA',
    estoque: { total: 50, vendidos: 0, cortesias: 0, pagos: 0 } },
  { id: 'e4', nome: 'Carnaval Adiado', status: 'adiado', inicio: '2031-02-15T12:00:00Z', organizacao: 'Fazenda Park', cidade: 'Ubatã', estado: 'BA',
    estoque: { total: 50, vendidos: 1, cortesias: 0, pagos: 1 } },
]

async function abrir(opcoes: { papel?: string; query?: Record<string, string>; eventos?: any[]; extra?: Record<string, any> } = {}) {
  const papel = opcoes.papel ?? 'master'
  return montarTela(await import('../pages/admin/index.vue'), {
    rota: { path: '/admin', query: opcoes.query ?? {} },
    respostas: {
      '/api/admin/eventos': opcoes.eventos ?? EVENTOS(papel === 'master' || papel === 'financeiro'),
      '/api/auth/eu': { usuario: { papel } },
      ...(opcoes.extra ?? {}),
    },
  })
}

const nomes = (tela: any) => tela.findAll('li[data-evento] h2').map((h: any) => h.text())

describe('Eventos — busca e situação na URL (EVT-04)', () => {
  it('abre filtrado pelo que a URL diz: situação e busca', async () => {
    const tela = await abrir({ query: { situacao: 'ativo', busca: 'domingo' } })
    expect(nomes(tela)).toEqual(['Domingo no Parque'])
    expect(tela.find('[data-situacao="ativo"]').attributes('aria-pressed')).toBe('true')
    expect((tela.find('[data-parte="busca"]').element as HTMLInputElement).value).toBe('domingo')
  })

  it('o clique no menu (URL limpa) desfiltra a tela', async () => {
    const tela = await abrir({ query: { situacao: 'rascunho', busca: 'kids' } })
    expect(nomes(tela)).toEqual(['Sábado Kids'])
    const rota = (globalThis as any).useRoute()
    rota.query = {}
    await nextTick(); await nextTick()
    expect(nomes(tela)).toHaveLength(4)
    expect((tela.find('[data-parte="busca"]').element as HTMLInputElement).value).toBe('')
  })

  it('o chip e a busca ESCREVEM na URL (é o que o F5 relê)', async () => {
    vi.useFakeTimers()
    const tela = await abrir()
    await tela.find('[data-situacao="rascunho"]').trigger('click')
    expect(navegacoes.at(-1)).toMatchObject({ path: '/admin', query: { situacao: 'rascunho' } })
    await tela.find('[data-parte="busca"]').setValue('kids')
    vi.advanceTimersByTime(350)
    expect(navegacoes.at(-1)).toMatchObject({ path: '/admin', query: { busca: 'kids' } })
  })
})

describe('Eventos — um selo pra cada status (EVT-05)', () => {
  it('cancelado em vermelho e adiado em alerta, com chip porque existem; nada de "pausado"', async () => {
    const tela = await abrir()
    const selo = (id: string) => tela.find(`li[data-evento="${id}"] [data-parte="selo"]`)
    expect(selo('e3').text()).toBe('CANCELADO')
    expect(selo('e3').classes()).toContain('selo-erro')
    expect(selo('e4').text()).toBe('ADIADO')
    expect(selo('e4').classes()).toContain('selo-alerta')
    expect(tela.find('[data-situacao="cancelado"]').exists()).toBe(true)
    expect(tela.find('[data-situacao="adiado"]').exists()).toBe(true)
    expect(tela.find('[data-situacao="oculto"]').exists(), 'sem evento oculto, sem chip').toBe(false)
    expect(tela.text()).not.toContain('PAUSADO')
  })
})

describe('Eventos — o cartão (EVT-13, proposta 15)', () => {
  it('a barra é dos pagos, com a cortesia marcada à parte', async () => {
    const tela = await abrir()
    const cartao = tela.find('li[data-evento="e1"]')
    expect(cartao.find('[data-parte="pagos"]').text().replace(/\s/g, '')).toBe('3/10')
    expect(cartao.find('[data-parte="cortesias-do-evento"]').text()).toContain('+ 2 cortesias')
  })

  it('o líquido do evento aparece pra quem vê o caixa, e não pra operação', async () => {
    const master = await abrir({ papel: 'master' })
    expect(master.find('li[data-evento="e1"] [data-parte="dinheiro-do-evento"]').text()).toContain('R$ 135,00 líquido')
    limparTela()
    const operacao = await abrir({ papel: 'operacao' })
    expect(operacao.find('[data-parte="dinheiro-do-evento"]').exists()).toBe(false)
    expect(operacao.text()).not.toContain('R$ 135,00')
  })
})

describe('Eventos — a faixa do dia', () => {
  it('pra quem vê o caixa: os números das MESMAS rotas da Visão geral e do Financeiro', async () => {
    const tela = await abrir({
      extra: {
        '/api/admin/relatorios': {
          filtro: { periodo: '30d', de: '2026-08-29', ate: '2026-09-27', hoje: '2026-09-27' },
          resumo: { liquidoCents: 208_908 },
          anterior: { de: '2026-07-30', ate: '2026-08-28', resumo: { liquidoCents: 373_000 } },
          porDia: [{ dia: '2026-09-26', pedidos: 1, cobradoCents: 9_000 }, { dia: '2026-09-27', pedidos: 2, cobradoCents: 17_500 }],
        },
        '/api/admin/financeiro': { totais: { disponivelCents: 10_500, retidoCents: 585_270 } },
      },
    })
    const valor = (k: string) => tela.find(`[data-kpi="${k}"] [data-parte="kpi-valor"]`).text()
    expect(valor('liquido-30')).toBe('R$ 2.089,08')
    expect(valor('hoje')).toBe('R$ 175,00')
    expect(valor('disponivel')).toBe('R$ 105,00')
    expect(valor('a-venda')).toBe('1')
    expect(tela.find('[data-kpi="liquido-30"] [data-parte="kpi-variacao"]').text()).toBe('−44%')
  })

  it('pra operação: sem dinheiro nenhum, com o que ela usa', async () => {
    const tela = await abrir({ papel: 'operacao' })
    expect(tela.find('[data-kpi="liquido-30"]').exists()).toBe(false)
    expect(tela.find('[data-kpi="disponivel"]').exists()).toBe(false)
    const valor = (k: string) => tela.find(`[data-kpi="${k}"] [data-parte="kpi-valor"]`).text()
    // só o evento publicado entra: 3 pagos e 2 cortesias
    expect(valor('pagos')).toBe('3')
    expect(valor('cortesias')).toBe('2')
    expect(tela.find('[data-parte="faixa-do-dia"]').text()).not.toMatch(/R\$/)
  })
})

describe('a portaria a caminho do leitor', () => {
  // login da portaria (28/09): a tela pedia a lista, levava 403 e só então perguntava quais leitores
  // abrir — o 403 aparecia como erro vermelho no console de todo porteiro. Agora a MESMA régua da
  // rota (`decidirAcesso`) decide antes; o servidor continua sendo quem tranca.
  const pediuAListaLogo = () => buscas.find((b) => b.url === '/api/admin/eventos')?.opcoes?.immediate !== false

  it('a portaria não pede a lista de eventos, e a tela segue pelo caminho do leitor', async () => {
    const tela = await abrir({ papel: 'portaria', extra: { '/api/portaria/destino': { eventos: [] } } })
    expect(pediuAListaLogo(), 'a portaria pediu a lista que a rota recusa').toBe(false)
    expect(tela.text()).toContain('O seu acesso é o leitor de entrada')
    expect(tela.text()).not.toContain('Nenhum evento aqui ainda')
  })

  it('master, financeiro e operação pedem a lista como sempre', async () => {
    for (const papel of ['master', 'financeiro', 'operacao']) {
      await abrir({ papel })
      expect(pediuAListaLogo(), papel).toBe(true)
      limparTela()
    }
  })

  it('papel que a tela não conhece pede — e quem decide é o servidor', async () => {
    await abrir({ papel: 'estagiario' })
    expect(pediuAListaLogo()).toBe(true)
  })
})
