// @vitest-environment happy-dom
/**
 * reconciliacao-tela.test.ts — a Reconciliação depois de 27/09.
 *
 *   · REL-07: o recorte é o que a URL diz, a cada troca — o menu (URL limpa) volta ao padrão;
 *   · proposta 10: o período no vocabulário do painel, SEM "Tudo" (o extrato precisa de começo),
 *     com as datas que a rota resolveu (o dia do parque);
 *   · "Registrar conferência" registra o período que a rota resolveu, não o que o navegador acha.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { chamadas, limparTela, montarTela, navegacoes } from './.vitest-setup-dom'

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => limparTela())

const RESPOSTA = {
  periodo: { de: '2026-09-21', ate: '2026-09-27', dias: 7, atalho: '7d' },
  evento: null, organizacao: 'Fazenda Park',
  fonte: { tipo: 'simulado', ambiente: null, rotulo: 'Gateway simulado', aviso: null, completa: true, truncado: false, erro: null },
  veredito: { conferido: false, tom: 'alerta', selo: 'NÃO CONFERIDO COM O ASAAS' },
  totais: { pedidos: 0, nossoCents: 0, cobrancas: 0, gatewayCents: 0, diferencaCents: 0, conferidos: 0,
    naoConferidos: 0, naoConferidosCents: 0, webhookPerdido: 0, semCobranca: 0, valorDiferente: 0, cobrancaRepetida: 0 },
  divergencias: [], naoConferidos: [], catalogo: {}, tetoDaLista: 300, ultimaConferencia: null,
  registro: { gravado: false, quando: null, porque: null },
}

async function abrir(query: Record<string, string> = {}) {
  return montarTela(await import('../pages/admin/reconciliacao.vue'), {
    rota: { path: '/admin/reconciliacao', query },
    respostas: {
      '/api/admin/reconciliacao': RESPOSTA,
      '/api/admin/eventos': [{ id: 'e1', nome: 'Domingo no Parque' }],
    },
  })
}
const chips = (tela: any) => tela.findAll('[role="group"][aria-label="Período"] button')
const ativo = (tela: any) => tela.findAll('[role="group"][aria-label="Período"] [aria-pressed="true"]').map((b: any) => b.text())

describe('Reconciliação — período e evento na URL', () => {
  it('o vocabulário do painel, sem "Tudo"; as datas são as que a rota resolveu', async () => {
    const tela = await abrir({ periodo: '7d', eventoId: 'e1' })
    expect(chips(tela).map((b: any) => b.text()).slice(0, 6))
      .toEqual(['Hoje', '7 dias', '30 dias', 'Este mês', 'Mês passado', 'Este ano'])
    expect(chips(tela).map((b: any) => b.text())).not.toContain('Tudo')
    expect(ativo(tela)).toEqual(['7 dias'])
    expect(tela.find('[data-parte="periodo-resolvido"]').text()).toBe('21/09 a 27/09/2026')
    expect((tela.find('[data-parte="filtro-evento"]').element as HTMLSelectElement).value).toBe('e1')
  })

  it('o clique no menu (URL limpa) volta ao padrão: este mês, todos os eventos', async () => {
    const tela = await abrir({ periodo: '7d', eventoId: 'e1' })
    ;(globalThis as any).useRoute().query = {}
    await nextTick(); await nextTick()
    expect(ativo(tela)).toEqual(['Este mês'])
    expect((tela.find('[data-parte="filtro-evento"]').element as HTMLSelectElement).value).toBe('')
  })

  it('escolher escreve na URL; o evento também', async () => {
    const tela = await abrir()
    await chips(tela)[0]!.trigger('click')
    expect(navegacoes.at(-1)).toEqual({ path: '/admin/reconciliacao', query: { periodo: 'hoje' } })
    await tela.find('[data-parte="filtro-evento"]').setValue('e1')
    expect(navegacoes.at(-1)).toEqual({ path: '/admin/reconciliacao', query: { eventoId: 'e1' } })
  })

  it('Registrar conferência leva as datas resolvidas pela rota', async () => {
    const tela = await abrir({ periodo: '7d' })
    const botao = tela.findAll('button').find((b: any) => b.text() === 'Registrar conferência')!
    await botao.trigger('click')
    await vi.waitFor(() => expect(chamadas.some((c) => c.url === '/api/admin/reconciliacao')).toBe(true))
    const c = chamadas.find((x) => x.url === '/api/admin/reconciliacao')!
    expect(c.opcoes.query).toEqual({ registrar: '1', de: '2026-09-21', ate: '2026-09-27' })
    expect(c.opcoes.headers).toEqual({ 'x-diamond-conferencia': '1' })
  })
})
