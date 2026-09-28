// @vitest-environment happy-dom
/**
 * A recusa de uma janela lateral aparece DENTRO dela (achado da rodada de E2E, 28/09).
 *
 * Oito janelas do evento gravam e, quando o servidor recusa, ficam abertas — mas escreviam a
 * recusa na faixa do alto da PÁGINA, atrás do painel e do fundo escuro: emitir cortesia em evento
 * cancelado, baixar a cota abaixo das emitidas, pedir transferência acima do saldo, editar o dia,
 * cadastrar divulgador, configurar passaporte, gerar mapa. Quem clicava via a janela parada, sem
 * resposta nenhuma, e clicava de novo. `ingressos/index.vue` e `cupons.vue` já faziam certo.
 *
 * Cada caso abre a janela, preenche o mínimo, faz o servidor recusar e confere que a frase está
 * na janela. As respostas das rotas são as de verdade (capturadas do servidor de E2E), enxutas.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { chamadas, limparTela, montarTela } from './.vitest-setup-dom'

const EV = 'ev-janelas'
const LOTE = { id: 'l1', nome: '1º lote', setor: 'Piscinas', setorId: 's1', faceCents: 3000, disponivel: 100,
               cota: null, cortesias: 0, cotaRestam: null }
const SESSAO = { id: 'se1', titulo: 'Sexta 23/10', inicio: '2026-10-23T12:00:00.000Z', fim: '2026-10-23T20:00:00.000Z',
                 capacidade: null, ocupadas: 0, vagas: null, lotado: false, estoquePrometido: 0, excedeCapacidade: false,
                 ingressosEmitidos: 0, setoresPresos: 0, podeApagar: true, lotes: [] }
const LOTE_DA_SESSAO = { id: 'l1', nome: '1º lote', setor: 'Piscinas', tipoSetor: 'ingresso', quantidade: 100, vendidos: 0,
                         visivel: true, canais: ['online', 'bilheteria'], sessoes: [], sessaoDoSetor: null, dias: 0,
                         escolheDia: false, cobreTodosOsDias: false }
const LOTE_INGRESSOS = { id: 'l2', nome: 'Mesa', descricao: null, faceCents: 20000, taxaCents: 2000, totalCents: 22000,
                         produtorRecebeCents: 20000, quantidade: 10, vendidos: 0, reservados: 0, disponivel: 10,
                         minPorCompra: 1, maxPorCompra: 10, canais: ['online', 'bilheteria'], visivel: true, abreEm: null,
                         expiraEm: null, ordem: 1, podeApagar: true, tipos: [] }

const DADOS: Record<string, any> = {
  cortesias: {
    evento: { id: EV, nome: 'Evento' },
    cota: { eventoCota: null, eventoUsadas: 0, eventoRestam: null },
    resumo: { total: 0, usados: 0, cancelados: 0, ocupando: 0, semRastro: 0, valorDadoCents: 0 },
    lotes: [LOTE], ingressos: [],
  },
  sessoes: {
    evento: { id: EV, nome: 'Evento', status: 'ativo', fuso: 'America/Bahia', inicio: '2026-10-18T13:00:00.000Z', fim: '2026-10-18T21:00:00.000Z' },
    sessoes: [SESSAO], lotes: [LOTE_DA_SESSAO],
  },
  promoters: { evento: { id: EV, nome: 'Evento', slug: 'evento' }, promoters: [] },
  ingressos: {
    evento: { id: EV, nome: 'Evento', status: 'ativo', inicio: '2026-10-18T13:00:00.000Z', taxaBps: 1000,
              modoTaxaOnline: 'repassar', modoTaxaPdv: 'absorver', giroAutomatico: true },
    sessoes: [],
    setores: [{ id: 's2', nome: 'Mesa VIP', tipo: 'mesa', sessaoId: null, descricao: null, capacidade: null,
                maxPorCliente: null, ordem: 2, admite: 1, sessoesCobertas: null, lotes: [LOTE_INGRESSOS] }],
  },
  financeiro: {
    evento: { id: EV, nome: 'Evento', status: 'encerrado', fim: '2026-09-01T21:00:00.000Z', liberaEm: '2026-09-03T21:00:00.000Z',
              liberado: true, diasDeRetencao: 2 },
    resumo: { brutoCents: 50000, descontosCents: 0, estornadoCents: 0, taxasCents: 5000, liquidoCents: 45000,
              naPlataformaCents: 45000, recebidoDiretoCents: 0, retidoCents: 0, transferidoCents: 0, emCursoCents: 0,
              disponivelCents: 45000, saldoCents: 45000, pedidos: 1, pedidosPagos: 1, transferencias: 0 },
    transferencias: [],
  },
  assentos: {
    evento: { id: EV, nome: 'Evento' },
    setores: [{ id: 's1', nome: 'Piscinas', numerado: false, capacidade: null, estoque: 100, vendidos: 0, total: 0,
                livres: 0, vendidosNoMapa: 0, reservados: 0, bloqueados: 0, fileiras: [] }],
  },
}

/** a janela da casa reduzida ao que importa: o conteúdo e a barra de ações, marcados */
const ModalLateral = defineComponent({
  setup: (_p, { slots }) => () => h('div', { 'data-janela': '' }, [slots.default?.(), slots.acoes?.()]),
})
/** o campo de dinheiro reduzido ao contrato: centavos no v-model */
const CampoMoeda = defineComponent({
  props: { modelValue: { type: Number, default: 0 } },
  emits: ['update:modelValue'],
  setup: (p, { emit }) => () => h('input', {
    'data-campo-moeda': '', value: p.modelValue,
    onInput: (e: any) => emit('update:modelValue', Number(e.target.value)),
  }),
})

/** a recusa como o `$fetch` de verdade entrega: a frase do servidor em `.data` */
function recusa(frase: string) {
  return Object.assign(new Error(`[POST] 409 ${frase}`), {
    statusCode: 409, statusMessage: frase, data: { statusCode: 409, statusMessage: frase, message: frase },
  })
}

/** import estático: o Vite não resolve `import()` com variável a mais de um nível */
const TELAS: Record<string, () => Promise<any>> = {
  'ingressos/cortesias': () => import('../pages/admin/evento/[id]/ingressos/cortesias.vue'),
  'ingressos/sessoes': () => import('../pages/admin/evento/[id]/ingressos/sessoes.vue'),
  'ingressos/promoters': () => import('../pages/admin/evento/[id]/ingressos/promoters.vue'),
  'ingressos/passaportes': () => import('../pages/admin/evento/[id]/ingressos/passaportes.vue'),
  'financeiro/index': () => import('../pages/admin/evento/[id]/financeiro/index.vue'),
  assentos: () => import('../pages/admin/evento/[id]/assentos.vue'),
}

/** monta a tela; devolve também o objeto de respostas (a tela lê dele a cada `$fetch`) */
async function montar(pagina: string, rota: keyof typeof DADOS) {
  const respostas: Record<string, any> = {
    [`/api/admin/evento/${EV}/${rota}`]: DADOS[rota],
    '/api/auth/eu': { usuario: { papel: 'master' } },
  }
  const w = await montarTela(await TELAS[pagina](), {
    rota: { params: { id: EV } }, respostas,
    stubs: { ModalLateral, CampoMoeda, AbasSecao: true, InfoDica: true },
  })
  /** daqui pra frente a gravação é recusada com esta frase */
  const recusar = (frase: string, alvo: string = rota) => { respostas[`/api/admin/evento/${EV}/${alvo}`] = recusa(frase) }
  return { w, recusar }
}

const botao = (w: any, texto: string) => {
  const b = w.findAll('button').find((x: any) => x.text().includes(texto))
  expect(b, `botão "${texto}" não achado`).toBeTruthy()
  return b
}
const assentar = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)) }

/** a frase tem de estar DENTRO da janela, e a janela tem de continuar aberta */
async function recusaNaJanela(w: any, frase: string) {
  await assentar()
  const janela = w.find('[data-janela]')
  expect(janela.exists(), 'a janela fechou com a recusa').toBe(true)
  const dentro = janela.find('[data-parte="erro-na-janela"]')
  expect(dentro.exists(), 'a recusa do servidor não apareceu dentro da janela (ficou atrás, no alto da página)').toBe(true)
  expect(dentro.text()).toContain(frase)
}

afterEach(() => limparTela())

describe('a recusa do servidor aparece dentro da janela que a pediu', () => {
  it('cortesias › Emitir: evento cancelado', async () => {
    const { w, recusar } = await montar('ingressos/cortesias', 'cortesias')
    await botao(w, 'Emitir cortesia').trigger('click')
    await w.find('[data-janela] input[placeholder^="Imprensa"]').setValue('Imprensa')
    await w.find('[data-janela] input[placeholder="Nome de quem solicitou"]').setValue('Diretoria')
    await w.find('[data-janela] input[placeholder="Nome"]').setValue('Convidada')
    const frase = 'Este evento está cancelado: não se emite cortesia.'
    recusar(frase)
    await botao(w, 'cortesia(s)').trigger('click')
    expect(chamadas.some((c) => c.opcoes?.method === 'POST'), 'a tela nem pediu a emissão').toBe(true)
    await recusaNaJanela(w, frase)
  })

  it('cortesias › Definir cota: abaixo das emitidas', async () => {
    const { w, recusar } = await montar('ingressos/cortesias', 'cortesias')
    await botao(w, 'Definir cota').trigger('click')
    await w.find('[data-janela] input[type="number"]').setValue('2')
    const frase = 'Já foram emitidas 12 cortesias: cancele antes de baixar a cota para 2.'
    recusar(frase)
    await botao(w, 'Salvar cota').trigger('click')
    await recusaNaJanela(w, frase)
  })

  it('sessões › Editar dia: capacidade abaixo do ocupado', async () => {
    const { w, recusar } = await montar('ingressos/sessoes', 'sessoes')
    await w.find('button[aria-label="Editar Sexta 23/10"]').trigger('click')
    await w.find('[data-janela] #e-cap').setValue('1')
    const frase = 'Este dia já tem 3 pessoas: a capacidade não pode ficar em 1.'
    recusar(frase)
    await w.find('[data-janela] button.btn-primario').trigger('click')
    await recusaNaJanela(w, frase)
  })

  it('sessões › Ingressos do dia', async () => {
    const { w, recusar } = await montar('ingressos/sessoes', 'sessoes')
    await w.find('button[aria-label="Ingressos de Sexta 23/10"]').trigger('click')
    const frase = 'O lote "1º lote" já vende pelo setor neste dia.'
    recusar(frase)
    await w.find('[data-janela] button.btn-primario').trigger('click')
    await recusaNaJanela(w, frase)
  })

  it('divulgadores › Cadastrar: código repetido', async () => {
    const { w, recusar } = await montar('ingressos/promoters', 'promoters')
    await botao(w, 'Cadastrar divulgador').trigger('click')
    await w.find('[data-janela] input[placeholder="Nome de quem divulga"]').setValue('Maria Divulga')
    const frase = 'Já existe um divulgador com o código MARIA neste evento.'
    recusar(frase)
    await w.find('[data-janela] button.btn-primario').trigger('click')
    await recusaNaJanela(w, frase)
  })

  it('passaportes › Configurar grupo', async () => {
    const { w, recusar } = await montar('ingressos/passaportes', 'ingressos')
    await w.find('button[aria-label="Configurar Mesa VIP"]').trigger('click')
    const frase = 'Pessoas por unidade: use um número de 1 a 100.'
    recusar(frase)
    await w.find('[data-janela] button.btn-primario').trigger('click')
    await recusaNaJanela(w, frase)
  })

  it('financeiro › Pedir transferência: acima do saldo (a trava do servidor)', async () => {
    const { w, recusar } = await montar('financeiro/index', 'financeiro')
    await botao(w, 'Pedir transferência').trigger('click')
    await w.find('[data-janela] input[placeholder="Nome de quem recebe"]').setValue('Fazenda Park Ltda')
    const destino = w.findAll('[data-janela] input.campo').find((i: any) => !i.attributes('placeholder')?.includes('Nome')
      && !i.attributes('placeholder')?.includes('só números'))
    await destino!.setValue('chave@pix.invalido')
    const frase = 'O saldo disponível agora é R$ 300,00: outra transferência foi pedida no meio.'
    recusar(frase)
    await w.findAll('[data-janela] button.btn-primario').at(-1)!.trigger('click')
    expect(chamadas.some((c) => c.opcoes?.method === 'POST'), 'a tela nem pediu a transferência').toBe(true)
    await recusaNaJanela(w, frase)
  })

  it('assentos › Gerar mapa: substituir com lugar vendido', async () => {
    const { w, recusar } = await montar('assentos', 'assentos')
    await botao(w, 'Gerar mapa deste setor').trigger('click')
    const frase = 'Este setor já tem lugar vendido no mapa: não dá pra substituir.'
    recusar(frase)
    await w.findAll('[data-janela] button.btn-primario').at(-1)!.trigger('click')
    await recusaNaJanela(w, frase)
  })
})
