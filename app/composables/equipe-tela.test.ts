// @vitest-environment happy-dom
/**
 * equipe-tela.test.ts — a tela de Equipe.
 *
 *   · EQP-01: trocar o papel no select NÃO grava na hora. A linha mostra o que vai acontecer (com o
 *     nome e as sessões que caem) e só o "Confirmar troca" manda o PATCH; "Cancelar" devolve o
 *     select ao papel verdadeiro sem chamar o servidor;
 *   · a linha "você" tem o select travado com a dica de por quê (matriz, caso 189).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chamadas, limparTela, montarTela } from './.vitest-setup-dom'

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => limparTela())

const EQUIPE = {
  organizacao: { nome: 'Fazenda Park' },
  eu: 'u-dono',
  papeis: [
    { valor: 'master', rotulo: 'Master', resumo: 'Tudo.', areas: [] },
    { valor: 'financeiro', rotulo: 'Financeiro', resumo: 'Dinheiro.', areas: [] },
    { valor: 'operacao', rotulo: 'Operação', resumo: 'Eventos.', areas: [] },
    { valor: 'portaria', rotulo: 'Portaria', resumo: 'Portão.', areas: [] },
  ],
  pessoas: [
    { id: 'u-dono', nome: 'Dono', email: 'dono@x.teste', papel: 'master', ativo: true, ultimaEntrada: null, leituras: 0, sessoesAbertas: 1 },
    { id: 'u-porta', nome: 'Júlia Portão', email: 'julia@x.teste', papel: 'portaria', ativo: true, ultimaEntrada: null, leituras: 12, sessoesAbertas: 2 },
  ],
}

async function abrir() {
  return montarTela(await import('../pages/admin/equipe.vue'), {
    rota: { path: '/admin/equipe' },
    respostas: { '/api/admin/equipe': EQUIPE },
  })
}
const selectDa = (tela: any, nome: string) => tela.find(`select[aria-label="Papel de ${nome}"]`)
const patches = () => chamadas.filter((c) => c.url === '/api/admin/equipe' && c.opcoes?.method === 'PATCH')

describe('Equipe — trocar o papel pede confirmação (EQP-01)', () => {
  it('o select só arma: diz quem cai e quantas sessões, e nada é gravado ainda', async () => {
    const tela = await abrir()
    await selectDa(tela, 'Júlia Portão').setValue('operacao')
    expect(patches(), 'gravou no primeiro toque — e derrubou o celular do portão').toHaveLength(0)
    const aviso = tela.find('[data-parte="confirmar-papel"]').text()
    expect(aviso).toContain('Mudar Júlia Portão de Portaria para Operação?')
    expect(aviso).toContain('Isso desconecta Júlia Portão agora (2 sessões abertas)')
  })

  it('Confirmar troca manda o PATCH com o papel escolhido', async () => {
    const tela = await abrir()
    await selectDa(tela, 'Júlia Portão').setValue('operacao')
    await tela.find('[data-acao="confirmar-papel"]').trigger('click')
    expect(patches()).toHaveLength(1)
    expect(patches()[0]!.opcoes.body).toEqual({ id: 'u-porta', papel: 'operacao' })
  })

  it('Cancelar devolve o select ao papel verdadeiro, sem chamar o servidor', async () => {
    const tela = await abrir()
    await selectDa(tela, 'Júlia Portão').setValue('operacao')
    await tela.find('[data-acao="cancelar-papel"]').trigger('click')
    expect(patches()).toHaveLength(0)
    expect(tela.find('[data-parte="confirmar-papel"]').exists()).toBe(false)
    expect((selectDa(tela, 'Júlia Portão').element as HTMLSelectElement).value).toBe('portaria')
  })

  it('a linha "você" tem o select travado, com a dica', async () => {
    const tela = await abrir()
    const meu = selectDa(tela, 'Dono')
    expect((meu.element as HTMLSelectElement).disabled).toBe(true)
    expect(meu.attributes('title')).toContain('peça a outro master')
  })
})
