// @vitest-environment happy-dom
/**
 * organizacao-telas.test.ts — as telas do painel da ORGANIZAÇÃO, com os dados na mão.
 *
 * Cada bloco trava um conserto que só aparece olhando (auditoria de 27/09, fatia F2): a tela monta
 * com a resposta que a rota daria e o caso pergunta o que ela MOSTROU. Cada um diz a mutação que o
 * deixa vermelho.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { limparTela, montarTela } from './.vitest-setup-dom'

afterEach(() => limparTela())

// ===========================================================================
// ORG-01 — o selo é o ambiente EFETIVO (o prefixo da chave), não o `<select>`
// ===========================================================================
const ORGANIZACAO = {
  id: 'org-1', nome: 'Fazenda Park', slug: 'fazenda-park', documento: null,
  ambienteAsaas: 'sandbox', carteiraAsaas: null,
  temChave: true, chaveFinal: 'TESTE1',
  eventos: 1, pessoas: 4, clientes: 10, criadoEm: '2026-09-01T12:00:00Z',
}

describe('ORG-01 — Configurações e Organização mostram para onde a cobrança VAI', () => {
  it('chave de produção com o select em Testes: selo PRODUÇÃO e a divergência gritada', async () => {
    // ← mutação: `ambienteMostrado` lendo `ambienteAsaas` devolve "TESTES" aqui e o caso fica vermelho
    const tela = await montarTela(await import('../pages/admin/configuracoes.vue'), {
      rota: { path: '/admin/configuracoes' },
      respostas: {
        '/api/admin/organizacao': { ...ORGANIZACAO, ambienteEfetivo: 'production', ambienteDivergente: true },
      },
    })
    expect(tela.get('[data-parte="selo-ambiente"]').text()).toBe('PRODUÇÃO')
    expect(tela.get('[data-parte="ambiente-divergente"]').text()).toMatch(/vão para\s+PRODUÇÃO — cobram de verdade/)
  })

  it('chave de sandbox com o select em Produção: selo TESTES (ninguém consegue pagar)', async () => {
    const tela = await montarTela(await import('../pages/admin/configuracoes.vue'), {
      rota: { path: '/admin/configuracoes' },
      respostas: {
        '/api/admin/organizacao': {
          ...ORGANIZACAO, ambienteAsaas: 'production', ambienteEfetivo: 'sandbox', ambienteDivergente: true,
        },
      },
    })
    expect(tela.get('[data-parte="selo-ambiente"]').text()).toBe('TESTES')
  })

  it('a lista de Organização pinta "RECEBENDO" só quando a cobrança vai mesmo pra produção', async () => {
    const linha = {
      id: 'org-1', nome: 'Fazenda Park', slug: 'fazenda-park', documento: null,
      ambienteAsaas: 'production', temAsaas: true, eventos: 1, eventosAtivos: 1, pessoas: 4,
      faturadoCents: 0, liquidoCents: 0, criadoEm: '2026-09-01T12:00:00Z',
    }
    const tela = await montarTela(await import('../pages/admin/organizacoes.vue'), {
      rota: { path: '/admin/organizacoes' },
      respostas: {
        '/api/admin/organizacoes': [{ ...linha, ambienteEfetivo: 'sandbox', ambienteDivergente: true }],
        '/api/admin/organizacao': { ...ORGANIZACAO, ambienteAsaas: 'production', ambienteEfetivo: 'sandbox', ambienteDivergente: true },
      },
    })
    expect(tela.text()).not.toContain('RECEBENDO')
    expect(tela.text()).toContain('EM TESTES')
    expect(tela.get('[data-parte="ambiente-divergente"]').text()).toMatch(/discordam/)
  })
})
