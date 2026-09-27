// @vitest-environment happy-dom
/**
 * Cortesias — a cota que não salvava (ADM-05) e o status sem acento (ADM-44).
 *
 * `v-model` em `input type="number"` entrega NÚMERO (o Vue converte sozinho), e a tela fazia
 * `v.trim()` nele: TypeError, "Não foi possível salvar a cota.", e o teto de cortesia nunca se
 * definia pela tela. O caso montado digita 30 no campo de verdade e confere o que a tela MANDOU.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { chamadas, limparTela, montarTela } from './.vitest-setup-dom'

const tela = () => import('../pages/admin/evento/[id]/ingressos/cortesias.vue')
const EV = 'ev-cortesias'

const DADOS = {
  evento: { id: EV, nome: 'Evento' },
  cota: { eventoCota: null, eventoUsadas: 12, eventoRestam: null },
  resumo: { total: 14, usados: 3, cancelados: 2, ocupando: 12, semRastro: 0, valorDadoCents: 36000 },
  lotes: [{ id: 'l1', nome: 'Lote 1', setor: 'Piscinas', setorId: 's1', faceCents: 3000, disponivel: 80,
            cota: null, cortesias: 12, cotaRestam: null }],
  ingressos: [{ id: 't1', codigo: 'CON-AAAA', status: 'valido', nome: 'Ana', email: null, documento: null,
                emitidoEm: '2026-09-20T12:00:00Z', entrouEm: null, setor: 'Piscinas', lote: 'Lote 1',
                tipo: null, pedido: 'CRT-1', pedidoId: 'p1', motivo: 'Imprensa', pedidaPor: 'João',
                autorizadaPor: 'Dono', autorizadaPorEmail: null, autorizadaEm: '2026-09-20T12:00:00Z',
                faceCents: 3000 }],
}

/** o drawer da casa, reduzido ao que importa: o conteúdo e a barra de ações */
const ModalLateral = defineComponent({
  setup: (_p, { slots }) => () => h('div', { 'data-parte': 'drawer' }, [slots.default?.(), slots.acoes?.()]),
})

afterEach(() => limparTela())

describe('cortesias — cota', () => {
  it('número, texto, vazio e zero', async () => {
    const { numeroOuNulo } = await tela()
    expect(numeroOuNulo(30), 'número do input type=number estourava .trim()').toBe(30)
    expect(numeroOuNulo('30')).toBe(30)
    expect(numeroOuNulo(' 7 ')).toBe(7)
    expect(numeroOuNulo(''), 'vazio é SEM teto').toBeNull()
    expect(numeroOuNulo(null)).toBeNull()
    expect(numeroOuNulo(0), 'zero é teto de verdade').toBe(0)
    expect(numeroOuNulo('0')).toBe(0)
    expect(numeroOuNulo(-3)).toBe(0)
    expect(numeroOuNulo(12.9)).toBe(12)
  })

  it('montada: digitar 30 e salvar manda 30 pra rota (não "Não foi possível salvar")', async () => {
    const w = await montarTela(await tela(), {
      rota: { params: { id: EV } },
      respostas: {
        [`/api/admin/evento/${EV}/cortesias`]: DADOS,
        '/api/auth/eu': { usuario: { papel: 'master' } },
      },
      stubs: { ModalLateral, AbasSecao: true, InfoDica: true },
    })
    await w.findAll('button').find((b) => b.text().includes('Definir cota'))!.trigger('click')
    const campo = w.find('[data-parte="drawer"] input[type="number"]')
    await campo.setValue('30')
    await w.findAll('button').find((b) => b.text().includes('Salvar cota'))!.trigger('click')
    await new Promise((r) => setTimeout(r, 0))

    const post = chamadas.find((c) => c.opcoes?.method === 'POST')
    expect(post, 'a tela nem chamou a rota — o erro estourou antes').toBeTruthy()
    expect(post!.opcoes.body.cotaEvento).toBe(30)
    expect(post!.opcoes.body.lotes).toEqual([{ id: 'l1', cota: null }])
    expect(w.text()).not.toContain('Não foi possível salvar a cota')
  })

  it('status com acento, não o valor do banco em caixa alta (ADM-44)', async () => {
    const w = await montarTela(await tela(), {
      rota: { params: { id: EV } },
      respostas: {
        [`/api/admin/evento/${EV}/cortesias`]: DADOS,
        '/api/auth/eu': { usuario: { papel: 'master' } },
      },
      stubs: { ModalLateral, AbasSecao: true, InfoDica: true },
    })
    expect(w.text()).toContain('VÁLIDO')
    expect(w.text()).not.toContain('VALIDO')
  })
})
