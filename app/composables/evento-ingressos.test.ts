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

// ===========================================================================
// Cupons (ADM-50, ADM-51), promoters (ADM-51) e sessões (ADM-40)
// ===========================================================================
import { vi } from 'vitest'

const CUPOM = (campos: Record<string, any> = {}) => ({
  id: 'c1', codigo: 'VERAO', tipo: 'percentual', valor: 1000, maxUsos: null, maxPorCliente: 1,
  comecaEm: null, terminaEm: null, loteIds: [], ativo: true, usos: 0, descontoDadoCents: 0,
  podeApagar: true, ...campos })

async function abrirCupons(cupons: any[] = [CUPOM()]) {
  return montarTela(await import('../pages/admin/evento/[id]/ingressos/cupons.vue'), {
    rota: { params: { id: EV } },
    respostas: { [`/api/admin/evento/${EV}/cupons`]: { cupons, lotes: [] } },
    stubs: { CampoMoeda, AbasSecao: true, ModalLateral: { template: '<div><slot /><slot name="acoes" /></div>' } },
  })
}
const envios = (metodo: string) => chamadas.filter((c) => c.opcoes?.method === metodo)

describe('cupom de valor fixo em centavos, pelo CampoMoeda (ADM-50)', () => {
  it('novo cupom fixo: o campo é o CampoMoeda e vai o centavo digitado, sem multiplicar', async () => {
    const w = await abrirCupons([])
    await w.findAll('button').find((b) => b.text().includes('Criar código'))!.trigger('click')
    await w.find('select').setValue('fixo')
    expect(w.find('input[type="number"][step="0.01"]').exists(), 'o desconto em reais voltou a ser type=number')
      .toBe(false)
    await w.find('input[placeholder="VERAO10"]').setValue('DEZ')
    await w.find('[data-campo-moeda]').setValue('1550')
    // o último "Criar código" é o do formulário (o primeiro abre o formulário)
    await w.findAll('button').filter((b) => b.text() === 'Criar código').at(-1)!.trigger('click')
    const post = envios('POST')[0]
    expect(post?.opcoes.body.tipo).toBe('fixo')
    expect(post?.opcoes.body.valor, 'R$ 15,50 não chegou como 1550 centavos').toBe(1550)
  })

  it('editar cupom fixo abre com os centavos gravados no CampoMoeda', async () => {
    const w = await abrirCupons([CUPOM({ tipo: 'fixo', valor: 1550 })])
    await w.find('button[title="Editar"]').trigger('click')
    expect((w.find('[data-campo-moeda]').element as HTMLInputElement).value).toBe('1550')
  })
})

describe('ligar/desligar com trava (ADM-51)', () => {
  it('cupom: dois cliques rápidos mandam UM pedido', async () => {
    const w = await abrirCupons()
    const b = w.find('[data-parte="alternar"]')
    b.trigger('click'); b.trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(envios('PATCH'), 'dois PATCH com valores opostos').toHaveLength(1)
  })

  it('divulgador: dois cliques rápidos mandam UM pedido', async () => {
    const w = await montarTela(await import('../pages/admin/evento/[id]/ingressos/promoters.vue'), {
      rota: { params: { id: EV } },
      respostas: { [`/api/admin/evento/${EV}/promoters`]: { promoters: [{
        id: 'p1', nome: 'Ana', codigo: 'ANA', email: null, telefone: null, comissaoBps: 1000, ativo: true,
        pedidos: 0, pedidosAtribuidos: 0, ingressos: 0, faturadoCents: 0, comissaoCents: 0, link: '/e/x?p=ANA',
        podeApagar: true }] } },
      stubs: { AbasSecao: true, ModalLateral: true },
    })
    const b = w.find('button[title="Desativar"]')
    b.trigger('click'); b.trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(envios('PATCH')).toHaveLength(1)
  })
})

describe('apagar dia em dois toques, sem confirm() do navegador (ADM-40)', () => {
  async function abrirSessoes(podeApagar = true) {
    return montarTela(await import('../pages/admin/evento/[id]/ingressos/sessoes.vue'), {
      rota: { params: { id: EV } },
      respostas: { [`/api/admin/evento/${EV}/sessoes`]: {
        evento: { id: EV, fuso: 'America/Bahia' }, lotes: [],
        sessoes: [{ id: 's1', titulo: 'Sábado 07/11', inicio: '2026-11-07T12:00:00Z', fim: '2026-11-07T20:00:00Z',
                    capacidade: 100, ocupadas: 0, vagas: 100, lotado: false, lotes: [], ingressosEmitidos: 0,
                    estoquePrometido: 0, excedeCapacidade: false, podeApagar }] } },
      stubs: { AbasSecao: true, ModalLateral: true },
    })
  }

  it('o 1º toque arma e diz "Confirmar"; o 2º apaga; confirm() nunca é chamado', async () => {
    const nativo = vi.fn(() => true)
    vi.stubGlobal('confirm', nativo)
    try {
      const w = await abrirSessoes()
      await w.find('[data-parte="apagar-dia"]').trigger('click')
      expect(envios('POST'), 'apagou no primeiro toque').toHaveLength(0)
      expect(w.find('[data-parte="apagar-dia"]').text()).toContain('Confirmar')
      await w.find('[data-parte="apagar-dia"]').trigger('click')
      expect(envios('POST').map((c) => c.opcoes.body)).toEqual([{ o: 'apagar', sessaoId: 's1' }])
      expect(nativo, 'o confirm() do navegador voltou').not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('o botão travado parece travado', async () => {
    const w = await abrirSessoes(false)
    const b = w.find('[data-parte="apagar-dia"]')
    expect(b.attributes('disabled')).toBeDefined()
    expect(b.classes()).toContain('disabled:opacity-40')
  })
})

// ===========================================================================
// Ordenar numa chamada só (ADM-41)
// ===========================================================================
describe('salvar a ordem manda UMA chamada com tudo (ADM-41)', () => {
  const SETORES = [
    { id: 's1', nome: 'Piscinas', tipo: 'ingresso', lotes: [{ id: 'l1', nome: '1º lote' }, { id: 'l2', nome: '2º lote' }] },
    { id: 's2', nome: 'Camarote', tipo: 'camarote', lotes: [{ id: 'l3', nome: 'Único' }] },
  ]
  async function abrirOrdenar() {
    return montarTela(await import('../pages/admin/evento/[id]/ingressos/ordenar.vue'), {
      rota: { params: { id: EV } },
      respostas: { [`/api/admin/evento/${EV}/ingressos`]: { setores: SETORES } },
      stubs: { AbasSecao: true, IconeMenu: true },
    })
  }
  const salvarOrdem = (w: any) => w.findAll('button').find((b: any) => b.text().includes('Salvar ordem'))!

  it('setores e lotes vão juntos: a rede caindo no meio não grava metade', async () => {
    const w = await abrirOrdenar()
    await w.find('button[aria-label="Descer setor"]').trigger('click')
    // depois da troca, o Piscinas (s1) é o 2º: o "Descer lote" do 1º lote dele
    await w.findAll('button[aria-label="Descer lote"]').filter((b: any) => b.attributes('disabled') === undefined)[0]!
      .trigger('click')
    await salvarOrdem(w).trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    const patches = envios('PATCH')
    expect(patches, 'um PATCH por setor: falha no meio deixa a ordem pela metade').toHaveLength(1)
    expect(patches[0].opcoes.body).toEqual({
      o: 'tudo', setores: ['s2', 's1'], lotes: [{ setorId: 's1', ids: ['l2', 'l1'] }],
    })
  })

  it('dois cliques rápidos no Salvar mandam a ordem uma vez', async () => {
    const w = await abrirOrdenar()
    await w.find('button[aria-label="Descer setor"]').trigger('click')
    const b = salvarOrdem(w)
    b.trigger('click'); b.trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(envios('PATCH')).toHaveLength(1)
  })
})

describe('cupom de 100% sem limite: a tela avisa e só grava confirmado', () => {
  it('100% sem limite: aviso, botão travado; marcar "de propósito" libera e manda a confirmação', async () => {
    const w = await abrirCupons([])
    await w.findAll('button').find((b) => b.text().includes('Criar código'))!.trigger('click')
    await w.find('input[placeholder="VERAO10"]').setValue('GRATIS')
    await w.find('#cupom-valor').setValue('100')
    expect(w.find('[data-parte="aviso-gratis-ilimitado"]').exists(), 'cupom grátis ilimitado sem aviso').toBe(true)
    const salvar = () => w.find('[data-parte="salvar-cupom"]')
    expect(salvar().attributes('disabled'), 'grava ingresso grátis ilimitado num clique').toBeDefined()
    await w.find('[data-parte="confirmar-ilimitado"]').setValue(true)
    expect(salvar().attributes('disabled')).toBeUndefined()
    await salvar().trigger('click')
    const post = envios('POST')[0]
    expect(post?.opcoes.body).toMatchObject({ tipo: 'percentual', valor: 10_000, maxUsos: null, semLimiteConfirmado: true })
  })

  it('com limite de usos não há aviso nem confirmação', async () => {
    const w = await abrirCupons([])
    await w.findAll('button').find((b) => b.text().includes('Criar código'))!.trigger('click')
    await w.find('input[placeholder="VERAO10"]').setValue('GRATIS')
    await w.find('#cupom-valor').setValue('100')
    await w.find('input[placeholder="sem limite"]').setValue('20')
    expect(w.find('[data-parte="aviso-gratis-ilimitado"]').exists()).toBe(false)
    await w.find('[data-parte="salvar-cupom"]').trigger('click')
    expect(envios('POST')[0]?.opcoes.body.semLimiteConfirmado).toBeUndefined()
  })
})
