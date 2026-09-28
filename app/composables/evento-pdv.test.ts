// @vitest-environment happy-dom
/**
 * Balcão (PDV › Vender) — o que a tela manda pro servidor.
 *
 *  1. **F5 no meio da venda gerava venda em dobro (ADM-08).** A chave da venda só existia na
 *     memória da aba: a resposta a caminho, o operador aperta F5, refaz o carrinho e vende de
 *     novo — chave NOVA, e o servidor enxerga duas vendas (dois pedidos, dois jogos de
 *     ingresso, dinheiro contado duas vezes na gaveta). Agora a venda em andamento (chave +
 *     carrinho) fica no `sessionStorage` da aba até o recibo aparecer.
 *  2. **Meia sem motivo (ADM-02).** A linha de meia pergunta o motivo e o botão Vender fica
 *     travado até ele ser escolhido; a declaração vai na linha, como no site.
 *
 * As funções vêm DA TELA (o `<script>` não-setup de `pdv/vender.vue`) — o código que o guichê
 * roda, não uma cópia.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chamadas, limparTela, montarTela } from './.vitest-setup-dom'

const tela = () => import('../pages/admin/evento/[id]/pdv/vender.vue')

const EV = 'ev-pdv'
const TURNO = 'turno-1'
const CHAVE = '11111111-2222-4333-8444-555555555555'

const CATALOGO = {
  evento: { id: EV, nome: 'Evento PDV', status: 'ativo' },
  lotes: [{
    id: 'lote-1', nome: 'Lote 1', setor: 'Piscinas', setorId: 's1', faceCents: 4000, balcaoCents: 4000,
    disponivel: 50, minimo: 1, maximo: 10,
    tipos: [
      { id: 'tipo-meia', nome: 'Meia', faceCents: 2000, balcaoCents: 2000, exigeDocumento: true, especie: 'meia', disponivel: 20 },
      { id: 'tipo-inteira', nome: 'Inteira', faceCents: 4000, balcaoCents: 4000, exigeDocumento: false, especie: 'inteira', disponivel: 30 },
    ],
  }],
  bloqueados: [],
}
const TURNO_ABERTO = {
  turno: { id: TURNO, status: 'aberto', ponto: 'Guichê 1', operador: 'Ana', formas: ['dinheiro', 'debito'] },
  contagem: { pedidos: 0, dinheiroCents: 0, eletronicoCents: 0 },
}
const RECIBO = { ok: true, pedido: 'PDV-AAAA-BBBB', pedidoId: 'p1', totalCents: 2000, forma: 'debito', trocoCents: null, recebidoCents: null, ingressos: [] }

const respostas = () => ({
  [`/api/admin/evento/${EV}/pdv/catalogo`]: CATALOGO,
  [`/api/admin/evento/${EV}/pdv/turno`]: TURNO_ABERTO,
  [`/api/admin/evento/${EV}/pdv/venda`]: RECIBO,
})

const montar = async () => montarTela(await tela(), {
  rota: { params: { id: EV }, query: { turno: TURNO } },
  respostas: respostas(),
  stubs: { AbasSecao: true, CampoMoeda: true, FichasImpressas: true },
})

/** a meia pede o CPF do cliente (regra de antes, que continua): o dado pessoal NÃO é guardado na aba */
async function digitarCpf(w: any) {
  await w.find('input[placeholder="CPF (só números)"]').setValue('52998224725')
}

const linhaDeMeia = (motivo = '') => ({
  chave: 'lote-1|tipo-meia', lotId: 'lote-1', ticketTypeId: 'tipo-meia', nome: 'Lote 1 — Meia',
  setor: 'Piscinas', precoCents: 2000, exigeDocumento: true, especie: 'meia', motivo, documentoMeia: '',
  quantidade: 1, teto: 20,
})

beforeEach(() => { sessionStorage.clear(); limparTela() })
afterEach(() => { sessionStorage.clear(); limparTela() })

describe('balcão — regras puras da venda', () => {
  it('venda guardada ilegível, sem chave ou com chave torta não é usada', async () => {
    const { lerVendaGuardada } = await tela()
    const armazem = (v: string | null) => ({ getItem: () => v })
    expect(lerVendaGuardada(armazem(null), 'k')).toBeNull()
    expect(lerVendaGuardada(armazem('{quebrado'), 'k')).toBeNull()
    expect(lerVendaGuardada(armazem(JSON.stringify({ carrinho: [] })), 'k')).toBeNull()
    expect(lerVendaGuardada(armazem(JSON.stringify({ chave: 'x' })), 'k')).toBeNull()
    const ok = lerVendaGuardada(armazem(JSON.stringify({ chave: CHAVE, carrinho: [1], forma: 'pix' })), 'k')
    expect(ok).toEqual({ chave: CHAVE, carrinho: [1], forma: 'pix' })
    // armazenamento bloqueado (aba anônima): não derruba a venda
    expect(lerVendaGuardada({ getItem: () => { throw new Error('bloqueado') } }, 'k')).toBeNull()
  })

  it('guardar com o armazenamento bloqueado não lança', async () => {
    const { guardarVenda } = await tela()
    expect(() => guardarVenda({ setItem: () => { throw new Error('cheio') } }, 'k',
      { chave: CHAVE, carrinho: [], forma: '' })).not.toThrow()
  })

  it('a chave de guarda é por evento E por caixa', async () => {
    const { chaveDaVendaGuardada } = await tela()
    expect(chaveDaVendaGuardada('a', 't1')).not.toBe(chaveDaVendaGuardada('a', 't2'))
    expect(chaveDaVendaGuardada('a', 't1')).not.toBe(chaveDaVendaGuardada('b', 't1'))
  })

  it('meia sem motivo trava a venda; inteira não pede motivo', async () => {
    const { faltaMotivoDeMeia, itemDaVenda } = await tela()
    expect(faltaMotivoDeMeia([linhaDeMeia('')])).toBe(true)
    expect(faltaMotivoDeMeia([linhaDeMeia('idoso')])).toBe(false)
    expect(faltaMotivoDeMeia([{ especie: 'inteira', motivo: '' }])).toBe(false)
    expect(itemDaVenda(linhaDeMeia('estudante')).meia).toEqual({ motivo: 'estudante', documento: null })
    expect(itemDaVenda({ ...linhaDeMeia('estudante'), especie: 'inteira' }).meia).toBeNull()
  })
})

describe('balcão — a tela', () => {
  it('F5 no meio: a chave e o carrinho voltam, e "Vender" manda a MESMA chave (ADM-08)', async () => {
    const { chaveDaVendaGuardada } = await tela()
    sessionStorage.setItem(chaveDaVendaGuardada(EV, TURNO),
      JSON.stringify({ chave: CHAVE, carrinho: [linhaDeMeia('idoso')], forma: 'debito' }))

    const w = await montar()
    expect(w.text(), 'o carrinho da venda em andamento não voltou depois do F5').toContain('Lote 1 — Meia')
    await digitarCpf(w)

    const vender = w.findAll('button').find((b) => /Vender R\$/.test(b.text()))!
    expect(vender.attributes('disabled'), 'a venda restaurada ficou travada').toBeUndefined()
    await vender.trigger('click')
    await new Promise((r) => setTimeout(r, 0))

    const venda = chamadas.find((c) => c.url.endsWith('/pdv/venda'))
    expect(venda, 'a tela não chamou a rota da venda').toBeTruthy()
    expect(venda!.opcoes.body.chave, 'a chave mudou no F5 — o servidor veria duas vendas').toBe(CHAVE)
    expect(venda!.opcoes.body.itens[0].meia).toEqual({ motivo: 'idoso', documento: null })
  })

  it('depois do recibo a chave é trocada (a próxima venda é outra venda)', async () => {
    const { chaveDaVendaGuardada } = await tela()
    sessionStorage.setItem(chaveDaVendaGuardada(EV, TURNO),
      JSON.stringify({ chave: CHAVE, carrinho: [linhaDeMeia('idoso')], forma: 'debito' }))
    const w = await montar()
    await digitarCpf(w)
    await w.findAll('button').find((b) => /Vender R\$/.test(b.text()))!.trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    await w.vm.$nextTick()
    const guardada = JSON.parse(sessionStorage.getItem(chaveDaVendaGuardada(EV, TURNO)) ?? '{}')
    expect(guardada.chave).toBeTruthy()
    expect(guardada.chave, 'a chave da venda que já saiu seguiu guardada').not.toBe(CHAVE)
    expect(guardada.carrinho).toEqual([])
  })

  it('linha de meia sem motivo: Vender travado e o seletor de motivo na linha (ADM-02)', async () => {
    const { chaveDaVendaGuardada } = await tela()
    sessionStorage.setItem(chaveDaVendaGuardada(EV, TURNO),
      JSON.stringify({ chave: CHAVE, carrinho: [linhaDeMeia('')], forma: 'debito' }))
    const w = await montar()
    await digitarCpf(w)
    const vender = w.findAll('button').find((b) => /Vender R\$/.test(b.text()))!
    expect(vender.attributes('disabled'), 'vende meia sem motivo').toBeDefined()
    expect(w.text()).toContain('Motivo da meia-entrada')
    const opcoes = w.findAll('select option').map((o) => o.text())
    expect(opcoes).toContain('Estudante')
    expect(opcoes).toContain('Idoso (60 anos ou mais)')
  })
})

// ===========================================================================
// Conferência de caixa (pdv/caixa.vue) — cega de verdade (ADM-07) e trocar de caixa zera o
// formulário (ADM-21)
// ===========================================================================
import { defineComponent, h } from 'vue'

const caixa = () => import('../pages/admin/evento/[id]/pdv/caixa.vue')

/** o CampoMoeda da casa, reduzido a um input que emite o que a tela escuta */
const CampoMoeda = defineComponent({
  props: { modelValue: Number },
  emits: ['update:modelValue', 'input'],
  setup: (p, { emit }) => () => h('input', {
    'data-parte': 'campo-moeda', value: p.modelValue,
    onInput: (e: any) => { emit('update:modelValue', Number(e.target.value)); emit('input', e) },
  }),
})

const LISTA_DE_CAIXAS = { turnos: [
  { id: 'A', status: 'aberto', ponto: 'Guichê A', operador: 'Ana', abriuEm: '2026-10-10T12:00:00Z' },
  { id: 'B', status: 'aberto', ponto: 'Guichê B', operador: 'Bia', abriuEm: '2026-10-10T12:00:00Z' },
] }
const TURNO_CEGO = {
  turno: { id: 'A', status: 'aberto', ponto: 'Guichê A', operador: 'Ana', abriuEm: '2026-10-10T12:00:00Z',
           fechouEm: null, fundoCents: 10000, contadoCents: null, esperadoNoFechamentoCents: null, observacao: null },
  contagem: { cega: true, esperadoCents: null, aberturaCents: null, dinheiroCents: null, sangriaCents: null,
              suprimentoCents: null, devolvidoDinheiroCents: null, eletronicoCents: 5000, pedidos: 3, ingressos: 4,
              porForma: [{ forma: 'debito', pedidos: 1, totalCents: 5000 }], devolvidoEletronicoCents: 0,
              cancelamentos: [] },
  movimentos: [], vendas: [],
}

async function montarCaixa(turno: any = TURNO_CEGO) {
  return montarTela(await caixa(), {
    rota: { params: { id: EV }, query: { turno: 'A' } },
    respostas: {
      [`/api/admin/evento/${EV}/pdv/turno`]: turno,
      [`/api/admin/evento/${EV}/pdv`]: LISTA_DE_CAIXAS,
    },
    stubs: { AbasSecao: true, FichasImpressas: true, CampoMoeda },
  })
}

describe('conferência de caixa — a tela', () => {
  it('caixa aberto e cego: nada de fundo, vendas em dinheiro ou esperado na tela (ADM-07)', async () => {
    const w = await montarCaixa()
    const texto = w.text()
    expect(w.find('[data-parte="conferencia-cega"]').exists()).toBe(true)
    expect(texto).not.toContain('Vendas em dinheiro')
    expect(texto).not.toContain('Fundo de troco')
    expect(texto).not.toContain('Sangrias:')
    expect(texto).toContain('Cartão e pix')
  })

  it('trocar de caixa zera a contagem e o resultado do anterior (ADM-21)', async () => {
    const w = await montarCaixa()
    const fechar = () => w.findAll('button').find((b) => b.text().includes('Conferir e fechar'))!
    await w.find('#contado').setValue('50000')
    expect(fechar().attributes('disabled'), 'contou e o botão não liberou').toBeUndefined()
    await fechar().trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(w.text()).toContain('Resultado da conferência')

    await w.find('select').setValue('B')
    await w.vm.$nextTick()
    expect(w.text(), 'o resultado do caixa A continuou na tela do B').not.toContain('Resultado da conferência')
    expect(fechar().attributes('disabled'), 'o caixa B veio com a contagem do A').toBeDefined()
  })
})

// ===========================================================================
// A ficha da térmica: o @page que o navegador aceita (ADM-60)
// ===========================================================================
describe('ficha impressa na bobina de 80mm (ADM-60)', () => {
  it('o tamanho da página tem duas medidas — "80mm auto" o Chrome joga fora e imprime em Carta', async () => {
    const { PAGINA_DA_FICHA } = await import('../components/FichasImpressas.vue')
    expect(PAGINA_DA_FICHA, 'altura "auto" não é valor de size').toMatch(/^80mm \d+(\.\d+)?mm$/)
  })

  it('imprimir põe o @page com esse tamanho e tira depois', async () => {
    const { mount } = await import('@vue/test-utils')
    const Fichas = (await import('../components/FichasImpressas.vue')).default
    const w = mount(Fichas, { props: { evento: 'Evento', pedido: 'DT-1', ingressos: [] }, attachTo: document.body })
    const estilos: string[] = []
    const antes = window.print
    ;(window as any).print = () => {
      estilos.push(...[...document.head.querySelectorAll('style')].map((s) => s.textContent ?? ''))
    }
    try {
      await (w.vm as any).imprimir()
      expect(estilos.some((e) => /@page \{ size: 80mm \d+mm; margin: 0 \}/.test(e)),
        `o @page da ficha não entrou (ou entrou inválido): ${JSON.stringify(estilos)}`).toBe(true)
    } finally {
      ;(window as any).print = antes
      window.dispatchEvent(new Event('afterprint'))
      w.unmount()
    }
    expect([...document.head.querySelectorAll('style')].some((s) => (s.textContent ?? '').includes('@page')),
      'o @page da térmica ficou pro borderô imprimir em 80mm').toBe(false)
  })
})
