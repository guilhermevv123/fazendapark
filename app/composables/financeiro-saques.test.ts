// @vitest-environment happy-dom
/**
 * O botão que faltava: "Enviar saques pendentes", no financeiro da organização.
 *
 * O pedido de saque só grava 'solicitada'; quem tira o dinheiro da plataforma
 * é `POST /api/admin/payout/executar` — e nenhuma tela chamava essa rota. O
 * saque ficava "solicitada" pra sempre, com o produtor esperando o pix.
 *
 * O que este arquivo trava:
 *  - master e financeiro veem o botão; portaria não;
 *  - o clique pergunta antes, na janela DO SISTEMA (nunca o `confirm` do navegador, 05/10), e só
 *    UMA chamada sai mesmo com dois cliques;
 *  - a frase da rota aparece na tela — inclusive o recado de gateway não
 *    configurado (503), que é o caso mais comum numa instalação nova;
 *  - o recebido direto no balcão aparece nomeado, fora do saldo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chamadas, limparTela, montarTela } from './.vitest-setup-dom'

afterEach(() => { limparTela(); vi.unstubAllGlobals() })

const FINANCEIRO = {
  diasDeRetencao: 2,
  totais: {
    faceCents: 97_500, taxaCents: 0, estornadoCents: 0, liquidoCents: 97_500,
    naPlataformaCents: 84_000, recebidoDiretoCents: 13_500,
    transferidoCents: 50_000, emCursoCents: 34_000, retidoCents: 0, disponivelCents: 0,
    saldoCents: 0,
  },
  eventos: [{
    id: 'ev1', nome: 'ZZQA Evento', status: 'ativo', comeca: null, termina: null,
    liberado: true, liberaEm: null, pedidos: 2, pedidosFechados: 2,
    faceCents: 97_500, taxaCents: 0, estornadoCents: 0, liquidoCents: 97_500,
    naPlataformaCents: 84_000, recebidoDiretoCents: 13_500,
    transferidoCents: 50_000, emCursoCents: 34_000, retidoCents: 0, disponivelCents: 0,
    saldoCents: 0,
  }],
  porMes: [],
  porForma: [],
  transferencias: [{
    id: 'p1', codigo: 'ZZQA-P1', beneficiario: 'Fulano', valorCents: 34_000,
    status: 'solicitada', destinoTipo: 'pix', evento: 'ZZQA Evento', pedidoPor: 'Dono',
    solicitadaEm: '2026-09-20T12:00:00Z', processadaEm: null,
  }],
}

const eu = (papel: string) => ({ usuario: { papel, nome: 'ZZQA' } })

async function abrir(papel: string, executar: any = { ok: true, mensagem: '1 transferência enviada (R$ 340,00).' }) {
  return montarTela(await import('../pages/admin/financeiro.vue'), {
    rota: { path: '/admin/financeiro' },
    respostas: {
      '/api/admin/financeiro': FINANCEIRO,
      '/api/auth/eu': eu(papel),
      '/api/admin/payout/executar': executar,
    },
    stubs: { teleport: true },
  })
}

const execucoes = () => chamadas.filter((c) => c.url === '/api/admin/payout/executar')
/** responde a janela de confirmação do sistema */
async function responder(tela: any, sim: boolean) {
  await tela.vm.$nextTick()
  const janela = tela.find('[data-parte="janela-confirmar"]')
  expect(janela.exists(), 'o envio não perguntou antes').toBe(true)
  await janela.find(`[data-acao="${sim ? 'confirmar' : 'cancelar'}"]`).trigger('click')
  await new Promise((r) => setTimeout(r, 0))
  await tela.vm.$nextTick()
}

describe('financeiro da organização — enviar saques', () => {
  it('master vê o botão com a contagem da fila', async () => {
    const tela = await abrir('master')
    const btn = tela.find('[data-acao="enviar-saques"]')
    expect(btn.exists(), 'o botão de executar a fila não apareceu pro master').toBe(true)
    expect(btn.text()).toContain('Enviar saques pendentes (1)')
  })

  it('financeiro também vê; portaria não', async () => {
    expect((await abrir('financeiro')).find('[data-acao="enviar-saques"]').exists()).toBe(true)
    limparTela()
    expect((await abrir('portaria')).find('[data-acao="enviar-saques"]').exists()).toBe(false)
  })

  it('pergunta antes, na janela do sistema; recusou, nada sai', async () => {
    const nativo = vi.fn(() => true)
    vi.stubGlobal('confirm', nativo)
    const tela = await abrir('master')
    await tela.find('[data-acao="enviar-saques"]').trigger('click')
    await responder(tela, false)
    expect(execucoes()).toHaveLength(0)
    expect(nativo, 'o confirm() do navegador voltou').not.toHaveBeenCalled()
  })

  it('dois cliques seguidos mandam UMA execução, e a frase da rota aparece', async () => {
    const tela = await abrir('master')
    const btn = tela.find('[data-acao="enviar-saques"]').element as HTMLButtonElement
    btn.click()
    btn.click()
    await tela.vm.$nextTick()
    expect(tela.findAll('[data-parte="janela-confirmar"]'), 'o 2º clique abriu outra pergunta').toHaveLength(1)
    await responder(tela, true)

    expect(execucoes(), 'duplo clique executou a fila duas vezes').toHaveLength(1)
    expect(execucoes()[0].opcoes?.method).toBe('POST')
    expect(tela.find('[data-parte="recado-envio"]').text())
      .toContain('1 transferência enviada (R$ 340,00).')
  })

  it('gateway não configurado: o recado da rota vai pra tela, não um erro genérico', async () => {
    const recusa = Object.assign(new Error('503'), {
      statusCode: 503,
      data: { statusMessage: 'Transferência indisponível: esta organização ainda não tem o Asaas configurado.' },
    })
    const tela = await abrir('master', recusa)
    await tela.find('[data-acao="enviar-saques"]').trigger('click')
    await responder(tela, true)
    const recado = tela.find('[data-parte="recado-envio"]')
    expect(recado.exists()).toBe(true)
    expect(recado.text()).toContain('ainda não tem o Asaas configurado')
    expect(recado.classes()).toContain('faixa-erro')
  })

  it('o recebido direto aparece nomeado, fora do saldo', async () => {
    const tela = await abrir('master')
    const linha = tela.find('[data-parte="recebido-direto"]')
    expect(linha.exists(), 'o dinheiro do balcão sumiu da tela').toBe(true)
    expect(linha.text().replace(/ /g, ' ')).toContain('R$ 135,00')
  })
})
