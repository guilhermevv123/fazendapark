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
