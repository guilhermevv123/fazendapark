// @vitest-environment happy-dom
/**
 * clientes-tela.test.ts — a tela de Clientes depois da rodada de 27/09.
 *
 *   · REL-07: o recorte é o que a URL diz, a cada troca — o clique em "Clientes" no menu (URL
 *     limpa) desfiltra; mexer num filtro ESCREVE na URL e volta pra página 1;
 *   · proposta 16: os números do topo são do RECORTE, com "de N na base" embaixo;
 *   · CLI-02: as faixas de idade vêm da rota; CLI-03: a cidade da URL aparece no select;
 *   · CLI-04: a exportação manda o cabeçalho da tela.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { chamadas, limparTela, montarTela, navegacoes } from './.vitest-setup-dom'

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => limparTela())

const RESPOSTA = {
  resumo: { total: 6, compraram: 3, comCadastro: 2, aceitamNovidades: 1, comInstagram: 1 },
  recorte: { total: 1, compraram: 1, comCadastro: 1, aceitamNovidades: 1, comInstagram: 1 },
  faixas: [{ chave: 'ate17', rotulo: 'Até 17' }, { chave: '18a24', rotulo: '18 a 24' }],
  paginacao: { pagina: 1, porPagina: 50, total: 120 },
  cidades: [{ cidade: 'Salvador', estado: 'BA', clientes: 4 }, { cidade: 'Ubaitaba', estado: 'BA', clientes: 0 }],
  itens: [{ id: 'c1', nome: 'Ana Silva', email: 'ana@x.teste', cpf: '***.982.247-**', telefone: '73998260963',
    instagram: 'ana', cidade: 'Salvador', estado: 'BA', idade: 30, faixa: '25a34', aceitaNovidades: true,
    cadastrado: true, criadoEm: '2026-09-01T12:00:00Z', pedidos: 2, gastoCents: 33_000, ultimaCompraEm: '2026-09-20T12:00:00Z' }],
}

async function abrir(query: Record<string, string> = {}, extra: Record<string, any> = {}) {
  return montarTela(await import('../pages/admin/clientes.vue'), {
    rota: { path: '/admin/clientes', query },
    respostas: { '/api/admin/clientes': RESPOSTA, ...extra },
  })
}
const valor = (tela: any, sel: string) => (tela.find(sel).element as HTMLInputElement | HTMLSelectElement).value

describe('Clientes — o recorte mora na URL (REL-07)', () => {
  it('abre com o que a URL diz; o clique no menu (URL limpa) desfiltra a tela', async () => {
    const tela = await abrir({ q: 'ana', novidades: '1', faixa: '18a24' })
    expect(valor(tela, '[data-parte="busca"]')).toBe('ana')
    expect(valor(tela, '[data-parte="filtro-faixa"]')).toBe('18a24')
    expect(tela.find('[data-parte="chip-novidades"]').attributes('aria-pressed')).toBe('true')
    expect(tela.find('[data-acao="limpar"]').exists()).toBe(true)

    ;(globalThis as any).useRoute().query = {}
    await nextTick(); await nextTick()
    expect(valor(tela, '[data-parte="busca"]')).toBe('')
    expect(valor(tela, '[data-parte="filtro-faixa"]')).toBe('')
    expect(tela.find('[data-parte="chip-novidades"]').attributes('aria-pressed')).toBe('false')
    expect(tela.find('[data-acao="limpar"]').exists()).toBe(false)
  })

  it('mexer num filtro escreve na URL e volta pra página 1; a paginação também mora lá', async () => {
    const tela = await abrir({ pagina: '2', ordem: 'nome' }) // 51–100 de 120
    await tela.find('[data-parte="filtro-faixa"]').setValue('18a24')
    expect(navegacoes.at(-1)).toEqual({ path: '/admin/clientes', query: { faixa: '18a24', ordem: 'nome' } })
    await tela.find('[data-parte="chip-cadastro"]').trigger('click')
    expect(navegacoes.at(-1)).toEqual({ path: '/admin/clientes', query: { cadastro: '1', ordem: 'nome' } })
    await tela.find('[data-acao="proxima"]').trigger('click')
    expect(navegacoes.at(-1)).toEqual({ path: '/admin/clientes', query: { ordem: 'nome', pagina: '3' } })
  })

  it('Limpar zera o recorte e mantém a ordem', async () => {
    const tela = await abrir({ q: 'ana', ordem: 'gasto' })
    await tela.find('[data-acao="limpar"]').trigger('click')
    expect(navegacoes.at(-1)).toEqual({ path: '/admin/clientes', query: { ordem: 'gasto' } })
  })
})

describe('Clientes — o topo conta o recorte (proposta 16)', () => {
  it('com filtro: o número do recorte, e a base embaixo', async () => {
    const tela = await abrir({ novidades: '1' })
    const kpi = (k: string) => tela.find(`[data-kpi="${k}"]`)
    expect(kpi('clientes').find('[data-parte="kpi-valor"]').text()).toBe('1')
    expect(kpi('clientes').find('[data-parte="kpi-base"]').text()).toBe('de 6 na base')
    expect(kpi('novidades').find('[data-parte="kpi-base"]').text()).toBe('de 1 na base')
  })

  it('sem filtro: a base, com as frases de sempre', async () => {
    const tela = await abrir({}, { '/api/admin/clientes': { ...RESPOSTA, recorte: RESPOSTA.resumo } })
    expect(tela.find('[data-kpi="clientes"] [data-parte="kpi-valor"]').text()).toBe('6')
    expect(tela.find('[data-kpi="clientes"] [data-parte="kpi-base"]').text()).toBe('todos que passaram por aqui')
  })
})

describe('Clientes — faixas, cidade da URL e exportação (CLI-02, CLI-03, CLI-04)', () => {
  it('as faixas do select são as da rota', async () => {
    const tela = await abrir()
    const opcoes = tela.find('[data-parte="filtro-faixa"]').findAll('option').map((o: any) => o.text())
    expect(opcoes).toEqual(['Todas', 'Até 17', '18 a 24'])
  })

  it('a cidade pedida na URL aparece selecionada', async () => {
    const tela = await abrir({ uf: 'BA', cidade: 'Ubaitaba' })
    expect(valor(tela, '[data-parte="filtro-cidade"]')).toBe('BA|Ubaitaba')
  })

  it('exportar manda o cabeçalho da tela e o mesmo recorte', async () => {
    const tela = await abrir({ novidades: '1' }, {
      '/api/admin/clientes/exportar': { total: 1, linhas: [] },
    })
    const botao = tela.findAll('button').find((b: any) => b.text().startsWith('Exportar'))!
    await botao.trigger('click')
    await vi.waitFor(() => expect(chamadas.some((c) => c.url === '/api/admin/clientes/exportar')).toBe(true))
    const c = chamadas.find((x) => x.url === '/api/admin/clientes/exportar')!
    expect(c.opcoes.headers).toEqual({ 'x-diamond-exportacao': '1' })
    expect(c.opcoes.query).toMatchObject({ novidades: '1' })
  })
})

describe('Clientes — vazio que orienta', () => {
  it('recorte sem ninguém: diz o tamanho da base e oferece limpar', async () => {
    const tela = await abrir({ novidades: '1' }, {
      '/api/admin/clientes': { ...RESPOSTA, itens: [], paginacao: { pagina: 1, porPagina: 50, total: 0 } },
    })
    const vazio = tela.find('[data-parte="vazio"]')
    expect(vazio.text()).toContain('Nenhum cliente com esses filtros')
    expect(vazio.text()).toContain('A base tem 6 clientes')
    await vazio.find('button').trigger('click')
    expect(navegacoes.at(-1)).toEqual({ path: '/admin/clientes', query: {} })
  })
})
