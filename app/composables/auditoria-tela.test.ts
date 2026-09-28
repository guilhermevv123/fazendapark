// @vitest-environment happy-dom
/**
 * auditoria-tela.test.ts — a tela de Auditoria depois da rodada de 27/09.
 *
 *   · REL-07 (mesmo padrão): o recorte é o que a URL diz, a cada troca — o clique no item do menu
 *     (URL limpa) desfiltra a tela, e mexer num filtro ESCREVE na URL;
 *   · proposta 10: o período fala o vocabulário do painel inteiro (Hoje … Tudo), com o dia que a
 *     ROTA resolveu (o do parque);
 *   · AUD-03: a devolução pela fila aparece com nome de gente e em vermelho (dinheiro saindo);
 *   · GER-01: 400 (data torta colada no link) oferece limpar o filtro, não repetir o erro; 403 diz o
 *     motivo sem "Tentar de novo".
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { limparTela, montarTela, navegacoes } from './.vitest-setup-dom'

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => limparTela())

const RESPOSTA = {
  filtros: { periodo: null, de: '', ate: '' },
  opcoes: {
    pessoas: [{ id: 'u1', nome: 'Dono', email: 'dono@x.teste', atos: 3 }],
    atos: [{ valor: 'empurrar_fila', atos: 1 }, { valor: 'editado', atos: 2 }],
    entidades: [{ valor: 'estorno', atos: 1 }, { valor: 'evento', atos: 2 }],
  },
  total: 1, semAutor: 0, pessoas: 1, maisAntigo: null, truncado: false,
  linhas: [{
    id: 7, quando: '2026-09-27T22:10:00-03:00', entidade: 'estorno', entidadeId: 'a1b2c3d4-0000-4000-8000-000000000000',
    acao: 'empurrar_fila', antes: { status: 'na_fila' }, depois: { status: 'estornado', valorCents: 11_000 }, ip: null,
    autor: { id: 'u1', nome: 'Dono', email: 'dono@x.teste', removido: false },
  }],
}

async function abrir(query: Record<string, string> = {}, resposta: any = RESPOSTA) {
  return montarTela(await import('../pages/admin/auditoria.vue'), {
    rota: { path: '/admin/auditoria', query },
    respostas: { '/api/admin/auditoria': resposta },
  })
}

const chipAtivo = (tela: any) => tela.findAll('[aria-pressed="true"]').map((b: any) => b.text())

describe('Auditoria — o recorte mora na URL (REL-07)', () => {
  it('abre com o que a URL diz e o clique no menu (URL limpa) desfiltra', async () => {
    const tela = await abrir({ periodo: 'hoje', pessoa: 'u1', entidade: 'estorno', busca: 'DT-1' })
    expect(chipAtivo(tela)).toEqual(['Hoje'])
    expect((tela.find('[data-parte="filtro-pessoa"]').element as HTMLSelectElement).value).toBe('u1')
    expect((tela.find('[data-parte="filtro-entidade"]').element as HTMLSelectElement).value).toBe('estorno')
    expect((tela.find('[data-parte="busca"]').element as HTMLInputElement).value).toBe('DT-1')
    expect(tela.find('[data-acao="limpar"]').exists()).toBe(true)

    ;(globalThis as any).useRoute().query = {}
    await nextTick(); await nextTick()
    expect(chipAtivo(tela)).toEqual(['Tudo'])
    expect((tela.find('[data-parte="filtro-pessoa"]').element as HTMLSelectElement).value).toBe('')
    expect((tela.find('[data-parte="filtro-entidade"]').element as HTMLSelectElement).value).toBe('')
    expect((tela.find('[data-parte="busca"]').element as HTMLInputElement).value).toBe('')
    expect(tela.find('[data-acao="limpar"]').exists()).toBe(false)
  })

  it('mexer num filtro escreve na URL, com o vocabulário de período do painel', async () => {
    const tela = await abrir({ pessoa: 'u1' })
    const rotulos = tela.findAll('[role="group"][aria-label="Período"] button').map((b: any) => b.text())
    expect(rotulos.slice(0, 7)).toEqual(['Hoje', '7 dias', '30 dias', 'Este mês', 'Mês passado', 'Este ano', 'Tudo'])

    await tela.findAll('[role="group"][aria-label="Período"] button')[1]!.trigger('click')
    expect(navegacoes.at(-1)).toEqual({ path: '/admin/auditoria', query: { periodo: '7d', pessoa: 'u1' } })

    await tela.find('[data-parte="filtro-entidade"]').setValue('estorno')
    expect(navegacoes.at(-1)).toEqual({ path: '/admin/auditoria', query: { pessoa: 'u1', entidade: 'estorno' } })

    const busca = tela.find('[data-parte="busca"]')
    ;(busca.element as HTMLInputElement).value = '  DT-4K9 '
    await busca.trigger('change')
    expect(navegacoes.at(-1)).toEqual({ path: '/admin/auditoria', query: { pessoa: 'u1', busca: 'DT-4K9' } })
  })

  it('o período mostrado é o que a ROTA resolveu (o dia do parque)', async () => {
    const tela = await abrir({ periodo: 'hoje' }, { ...RESPOSTA, filtros: { periodo: 'hoje', de: '2026-09-27', ate: '2026-09-27' } })
    expect(tela.find('[data-parte="periodo-resolvido"]').text()).toBe('27/09/2026')
  })
})

describe('Auditoria — a devolução pela fila (AUD-03)', () => {
  it('aparece com nome de gente, em vermelho, e o valor em reais', async () => {
    const tela = await abrir()
    const linha = tela.find('tbody tr')
    expect(linha.text()).toContain('devolução pela fila (Empurrar a fila)')
    expect(linha.text()).toMatch(/Devolução\s+· a1b2c3d4/)
    expect(linha.find('.text-erro').text()).toBe('devolução pela fila (Empurrar a fila)')
    expect(linha.text()).toContain('R$ 110,00')
    expect(linha.text()).toContain('Dono')
    const opcoes = tela.find('[data-parte="filtro-entidade"]').findAll('option').map((o: any) => o.text())
    expect(opcoes).toContain('Devolução (1)')
  })
})

describe('Auditoria — quando a rota recusa (GER-01)', () => {
  const falhaCom = async (statusCode: number, statusMessage: string) => montarTela(
    await import('../components/painel/Falha.vue'), {
      rota: { path: '/admin/auditoria' },
      props: { falha: { statusCode, data: { statusMessage } }, oQue: 'a auditoria', tentar: () => {}, limpar: () => {} },
    })

  it('400 de data torta: a frase, e a saída é limpar o filtro — não repetir o mesmo erro', async () => {
    const tela = await falhaCom(400, 'A data "De" do filtro veio escrita como "abc", que não é uma data.')
    expect(tela.find('[data-parte="falha-frase"]').text()).toContain('não é uma data')
    expect(tela.find('[data-acao="limpar-filtro"]').exists()).toBe(true)
    expect(tela.find('[data-acao="tentar-de-novo"]').exists()).toBe(false)
  })

  it('403: o motivo, sem "Tentar de novo"', async () => {
    const tela = await falhaCom(403, 'Seu acesso (portaria) não inclui a auditoria.')
    expect(tela.text()).toContain('não inclui a auditoria')
    expect(tela.find('[data-acao="tentar-de-novo"]').exists()).toBe(false)
  })

  it('servidor fora: aí sim, Tentar de novo', async () => {
    const tela = await falhaCom(502, 'Bad Gateway')
    expect(tela.find('[data-acao="tentar-de-novo"]').exists()).toBe(true)
    expect(tela.find('[data-acao="limpar-filtro"]').exists()).toBe(false)
  })
})
