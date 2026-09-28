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

describe('Eventos — sem a faixa de números (28/09, pedido do dono)', () => {
  it('a lista abre sem os cartões de dinheiro: os números moram em Relatórios', async () => {
    const tela = await abrir({ papel: 'master' })
    expect(tela.find('[data-parte="faixa-do-dia"]').exists()).toBe(false)
    expect(tela.find('[data-kpi]').exists()).toBe(false)
    // e não gasta ida ao servidor com o que ninguém mostra
    expect(buscas.some((b) => b.url.startsWith('/api/admin/relatorios') || b.url.startsWith('/api/admin/financeiro'))).toBe(false)
    expect(tela.find('a[href="/admin/relatorios"]').text()).toContain('Relatórios')
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
