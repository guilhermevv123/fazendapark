// @vitest-environment happy-dom
/**
 * organizacao-cartao.test.ts — ORG-02: a Organização é um CARTÃO, não uma tabela de uma linha com
 * busca e chips fora da URL. Os números têm o nome e a conta da Visão geral (Líquido do produtor,
 * Total cobrado); o CNPJ de exemplo da instalação aparece como "a preencher".
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { limparTela, montarTela } from './.vitest-setup-dom'

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => limparTela())

const ORG = {
  id: 'org-1', nome: 'Fazenda Park', slug: 'fazenda-park', documento: '12ABC34501DE35',
  ambienteAsaas: 'sandbox', ambienteEfetivo: 'sandbox', ambienteDivergente: false, temAsaas: true,
  eventos: 3, eventosAtivos: 2, pessoas: 4, faturadoCents: 758_400, liquidoCents: 684_470, criadoEm: '2026-09-01T12:00:00Z',
}
const abrir = async (orgs: any[]) => montarTela(await import('../pages/admin/organizacoes.vue'), {
  rota: { path: '/admin/organizacoes' }, respostas: { '/api/admin/organizacoes': orgs },
})

describe('Organização — o cartão (ORG-02)', () => {
  it('sem busca nem chips; os números da Visão geral com o mesmo nome', async () => {
    const tela = await abrir([ORG])
    expect(tela.find('input').exists(), 'busca sobre uma linha só é controle sem efeito').toBe(false)
    expect(tela.text()).not.toMatch(/Sem cobrança\s*$|Todos/)
    const kpi = (k: string) => tela.find(`[data-kpi="${k}"] [data-parte="kpi-valor"]`).text()
    expect(kpi('liquido')).toBe('R$ 6.844,70')
    expect(kpi('cobrado')).toBe('R$ 7.584,00')
    expect(kpi('eventos')).toBe('3')
    expect(tela.find('[data-kpi="eventos"]').text()).toContain('2 publicados')
    expect(tela.find('[data-parte="documento"]').text()).toBe('CNPJ/CPF 12.ABC.345/01DE-35')
    expect(tela.find('[data-parte="selo-situacao"]').text()).toBe('EM TESTES')
    const links = tela.findAll('a').map((a: any) => a.attributes('href'))
    expect(links).toContain('/admin/configuracoes')
    expect(links).toContain(JSON.stringify({ path: '/admin/relatorios', query: { periodo: 'tudo' } }))
  })

  it('o CNPJ de exemplo da instalação não é documento de ninguém: "a preencher"', async () => {
    const tela = await abrir([{ ...ORG, documento: '00000000000191' }])
    expect(tela.find('[data-parte="documento"]').text()).toBe('CNPJ/CPF a preencher em Dados e cobrança')
  })

  it('sem organização no acesso: vazio que diz o porquê', async () => {
    const tela = await abrir([])
    expect(tela.find('[data-parte="vazio"]').text()).toContain('Nenhuma organização no seu acesso')
  })
})
