// @vitest-environment happy-dom
/**
 * Ingressos › Setores e lotes — o "preço redondo" (ADM-23).
 *
 * A conta inversa do navegador arredondava diferente da `precificar` do servidor: com taxa de 10%
 * repassada, pedir R$ 10,06 sugeria a face R$ 9,15 e dizia "= R$ 10,06" — e o checkout cobrava
 * R$ 10,07. Esse total NÃO existe com essa taxa (9,14 → 10,05; 9,15 → 10,07): a tela agora usa a
 * conta do servidor (`faceParaTotal`) e diz os dois vizinhos em vez de prometer um valor que não
 * sai.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { chamadas, limparTela, montarTela } from './.vitest-setup-dom'

const EV = 'ev-ingressos'

/** o CampoMoeda da casa, reduzido ao contrato: centavos inteiros no v-model */
const CampoMoeda = defineComponent({
  props: { modelValue: { type: Number, default: 0 } },
  emits: ['update:modelValue'],
  setup: (p, { emit }) => () => h('input', {
    'data-campo-moeda': '', value: p.modelValue,
    onInput: (e: any) => emit('update:modelValue', Number(e.target.value)),
  }),
})

const INGRESSOS = {
  evento: { id: EV, nome: 'Evento', status: 'ativo', inicio: '2026-10-18T12:00:00Z',
            taxaBps: 1000, modoTaxaOnline: 'repassar', modoTaxaPdv: 'absorver', giroAutomatico: false },
  sessoes: [],
  setores: [{
    id: 's1', nome: 'Piscinas', tipo: 'ingresso', sessaoId: null, descricao: null, capacidade: null,
    maxPorCliente: null, ordem: 0, admite: 1, sessoesCobertas: 1,
    lotes: [{ id: 'l1', nome: '1º lote', descricao: null, faceCents: 2727, taxaCents: 273, totalCents: 3000,
              produtorRecebeCents: 2727, quantidade: 100, vendidos: 0, reservados: 0, disponivel: 100,
              minPorCompra: 1, maxPorCompra: 10, canais: ['online'], visivel: true, abreEm: null,
              expiraEm: null, ordem: 0, podeApagar: true, tipos: [] }],
  }],
}

async function abrirRedondo(total: number) {
  const w = await montarTela(await import('../pages/admin/evento/[id]/ingressos/index.vue'), {
    rota: { params: { id: EV } },
    respostas: {
      [`/api/admin/evento/${EV}/ingressos`]: INGRESSOS,
      '/api/auth/eu': { usuario: { papel: 'master' } },
    },
    stubs: { CampoMoeda, AbasSecao: true, ModalLateral: true },
  })
  await w.find('button[title="Preço redondo"]').trigger('click')
  await w.find('[data-campo-moeda]').setValue(String(total))
  return w
}

afterEach(() => limparTela())

describe('preço redondo — a conta do checkout, não uma cópia', () => {
  it('R$ 10,06 com 10% repassada não existe: a tela diz os vizinhos em vez de prometer', async () => {
    const w = await abrirRedondo(1006)
    const previa = w.find('[data-parte="previa-redondo"]').text().replace(/\s+/g, ' ')
    expect(previa, 'a prévia prometeu um total que o checkout não cobra')
      .toBe('face R$ 9,14 + taxa R$ 0,91 = R$ 10,05')
    const aviso = w.find('[data-parte="redondo-nao-existe"]')
    expect(aviso.exists(), 'a tela não avisou que R$ 10,06 não sai exato').toBe(true)
    expect(aviso.text()).toContain('R$ 10,05')
    expect(aviso.text()).toContain('R$ 10,07')
  })

  it('Aplicar grava a face que o checkout cobra como mostrado', async () => {
    const w = await abrirRedondo(1006)
    await w.findAll('button').find((b) => b.text() === 'Aplicar')!.trigger('click')
    const patch = chamadas.find((c) => c.opcoes?.method === 'PATCH')
    expect(patch?.opcoes.body).toEqual({ o: 'lote', id: 'l1', campos: { faceCents: 914 } })
  })

  it('R$ 30,00 sai exato (face R$ 27,27) e não há aviso', async () => {
    const w = await abrirRedondo(3000)
    expect(w.find('[data-parte="previa-redondo"]').text().replace(/\s+/g, ' '))
      .toBe('face R$ 27,27 + taxa R$ 2,73 = R$ 30,00')
    expect(w.find('[data-parte="redondo-nao-existe"]').exists()).toBe(false)
  })
})
