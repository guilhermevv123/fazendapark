<script setup lang="ts">
/**
 * Checkout, em passos (28/09, pedido do dono):
 *
 *   1. **Conferir** — o resumo do carrinho, QUEM compra (a conta) e o cupom. Sem conta, a janela
 *      de entrar/criar abre sozinha; o formulário de nome, CPF e endereço que morava aqui saiu —
 *      os dados vêm da conta (034), preenchidos uma vez só.
 *   2. **Pagar** — Pix, crédito (com parcelas) ou débito. Ingresso GRÁTIS pula este passo
 *      inteiro: nada de Pix nem cartão na tela, só "Gerar ingresso".
 *   3. **Cobrança** — o QR do Pix ou o link do cartão, com o relógio da reserva.
 *   4. **Pago** — os ingressos, com o QR, na mesma tela.
 *
 * Três coisas que esta tela NÃO faz, e o porquê:
 *
 *  1. **Não calcula preço.** O total que ela mostra antes de pagar é o que a
 *     vitrine trouxe; o total que ela mostra DEPOIS é o que o checkout gravou
 *     no pedido. Quando os dois divergem (lote virou, cupom entrou), ela diz
 *     isso em voz alta em vez de escolher um dos dois em silêncio.
 *  2. **Não guarda cartão.** Cartão vai pro ambiente do Asaas, que é quem tem
 *     PCI — daqui sai só o link da fatura. Débito também: o Asaas não recebe
 *     cartão de débito pela API, então a fatura dele é que oferece o débito.
 *  3. **Não decide se o PIX caiu.** Quem manda é o webhook; esta tela pergunta
 *     ao servidor de quatro em quatro segundos e obedece.
 */
import {
  carimboDePago, destinoSemCarrinho, itensDoCheckout, pedidoVivo,
  LIMITES_DO_FORMULARIO as LIMITE, opcoesDeParcela as parcelasPossiveis, situacaoDaCobranca,
  totaisDoCarrinho, VERSAO_DO_CARRINHO, type LinhaDoPedido,
} from '~/composables/carrinhoDaVitrine'
import { apagarDaAba, gravarNaAba, lerDaAba } from '~/composables/armazenamentoDaAba'
import { cpfEscondido, telefoneLegivel, useContaDoCliente } from '~/composables/contaDoCliente'
import { conferirCartao, type ConferenciaDoCartao, type DadosDoCartao } from '~/composables/cartao'
import CartaoDeCredito from '~/components/CartaoDeCredito.vue'
import { MOTIVOS } from '~~/server/utils/meia-entrada'

const route = useRoute()
const slug = route.params.slug as string

/** `reais` vem de app/composables/formato.ts — uma formatação só no sistema. */

interface Carrinho {
  versao: number
  slug: string
  linhas: LinhaDoPedido[]
  totais: { face: number; taxa: number; total: number; n: number }
  /** quando a vitrine gravou (B13: carrinho mais novo que o pedido pendente = outra compra) */
  criadoEm?: number
  /** o código do link do promoter (B07) */
  promoter?: string | null
}

const CHAVE_CARRINHO = 'dt:carrinho'
const CHAVE_PEDIDO = 'dt:pedido'
/**
 * O último pedido JÁ PAGO nesta aba — só o código, só pra saber pra onde
 * mandar quem recarregar a tela de "deu certo".
 *
 * `dt:pedido` some no instante do pagamento, e tem que sumir mesmo: se ficasse,
 * a próxima compra nesta aba cairia no `onMounted` e reabriria o pedido velho
 * em vez de cobrar o novo carrinho. O efeito colateral é o F5 na tela de
 * sucesso não achar nada e voltar pra vitrine — a pessoa que acabou de pagar
 * reencontra "A partir de R$ 16,50 · Escolha seus ingressos" e conclui que a
 * compra não passou. Esta chave separa as duas coisas: não restaura tela
 * nenhuma, só troca o destino do desvio pela página do ingresso dela.
 */
const CHAVE_PAGO = 'dt:pago'

const carrinho = ref<Carrinho | null>(null)
const etapa = ref<'dados' | 'pagamento' | 'cobranca' | 'pago'>('dados')
const erro = ref('')
/** o servidor recusou um dado DA CONTA (o gateway não aceitou o celular, B12): o conserto é lá */
const erroNosDados = ref(false)
const enviando = ref(false)

/**
 * Quem compra: a conta do cliente (034). A tela nunca lê o cookie — pergunta ao servidor
 * (`/api/conta/eu`), e o checkout confere de novo do lado de lá.
 */
const { estado: contaEstado, abrir: abrirConta, sair: sairDaConta, garantir, carregar } = useContaDoCliente()
const conta = computed(() => contaEstado.value.conta)
const MOTIVO_DA_JANELA = 'Pra comprar, entre na sua conta — ou crie uma em menos de um minuto.'

/**
 * O estado do cupom, num lugar só.
 *
 * Antes o comprador digitava o código e só descobria que ele não servia no
 * clique de pagar. Código de cupom vem de story, panfleto ou promoter: errar é
 * o caso comum, e a hora de saber é a hora de digitar. `POST /api/cupom/conferir`
 * responde com a MESMA régua do checkout (utils/cupom.ts), então o sim daqui não
 * briga com o não de lá.
 *
 * `nao_vale` cobre os dois caminhos que existem — a conferência prévia e o 409
 * do checkout — porque são a mesma notícia pro comprador e o mesmo lugar na
 * tela. Dois estados separados para a mesma frase é como as duas acabam
 * aparecendo juntas.
 *
 * `parcial` é o cupom conferido sem CPF (a conta ainda não entrou): tudo confere
 * menos "uma vez por pessoa", que precisa do documento. A tela avisa em vez de
 * prometer.
 */
const cupom = reactive({
  estado: 'vazio' as 'vazio' | 'conferindo' | 'vale' | 'nao_vale',
  recado: '',
  descontoCents: null as number | null,
  parcial: false,
})
/**
 * O campo de cupom está ESCONDIDO por enquanto (pedido do dono, 28/09): o parque ainda não usa
 * cupom no site. A régua inteira continua de pé, aqui e no servidor — voltar é trocar pra `true`.
 */
const MOSTRAR_CUPOM = false
const pedido = ref<any>(null)
const ingressos = ref<any[]>([])
const copiado = ref(false)
const restante = ref(0)
/** Preencheu quando o servidor cobrou um total diferente do que a tela prometeu. */
const avisoDePreco = ref('')
/** O pagamento entrou depois do prazo e o lugar já tinha sido vendido. */
const pagoSemIngresso = ref(false)
/**
 * B13: o pedido pendente desta aba quando a pessoa voltou e montou OUTRO
 * carrinho. A tela avisa, deixa voltar pra ele, e — se ela pagar o novo —
 * desiste do anterior antes (o lugar dele volta e ele sai do teto do CPF).
 */
const pedidoAnterior = ref<any>(null)
/** as linhas do pedido em cobrança (a etapa de cobrança mostrava só código e total) */
const linhasDoPedido = ref<LinhaDoPedido[]>([])
/** B34: em análise, devolvido, contestado — a frase da cobrança quando não é só "aguardando" */
const situacao = ref<ReturnType<typeof situacaoDaCobranca>>(null)
const statusDaCobranca = ref('')
const desistindo = ref(false)

/**
 * O que sobrou do formulário: o cupom. É gravado em sessionStorage junto do pedido (F5), então
 * nada de dado pessoal aqui dentro — a conta mora no servidor.
 */
const form = reactive({ cupom: '' })
/** o e-mail que a tela de "deu certo" cita — o da conta, ou o do pedido reaberto depois do F5 */
const emailDoPedido = ref('')
/** B23: o leitor de tela também precisa saber qual campo está errado */
const campoComErro = ref('')
const marca = (campo: string) => (campoComErro.value === campo ? 'ring-2 ring-danger-600' : '')
const invalido = (campo: string) => (campoComErro.value === campo ? 'true' : undefined)

/**
 * Pix, crédito ou débito. Débito vai pro servidor como `debito` e ele cobra como cartão à vista
 * (a fatura do Asaas é que oferece o débito — ver `checkout.post.ts`).
 */
type Forma = 'pix' | 'credito' | 'debito'
const forma = ref<Forma>('pix')
const parcelas = ref(1)

/*
 * Cartão de crédito digitado NO SITE (dono, 05/10) — só quando o servidor diz que está ligado
 * (`CARTAO_NO_SITE=1` + Asaas pronto: /api/pagamento/cartao). Desligado, o crédito segue pela
 * fatura do Asaas como sempre. Débito nunca: a API do Asaas não aceita dado de cartão de débito.
 * Os dados do cartão moram SÓ nesta memória: não vão pro sessionStorage, e saem dela depois do envio.
 */
const cartaoNoSite = ref(false)
const vazioDoCartao = (): DadosDoCartao => ({ numero: '', titular: '', mes: '', ano: '', cvv: '' })
const cartao = ref<DadosDoCartao>(vazioDoCartao())
const enderecoDoCartao = reactive({ cep: '', numero: '' })
const outroTitular = ref(false)
const cpfDoTitular = ref('')
const conferenciaDoCartao = ref<ConferenciaDoCartao | null>(null)
const formularioDoCartao = ref<InstanceType<typeof CartaoDeCredito> | null>(null)
const usaCartaoNoSite = computed(() => cartaoNoSite.value && forma.value === 'credito')
/*
 * A tela do cartão (dono, 06/10): escolhe "Cartão de crédito" → Continuar → uma tela SÓ do cartão,
 * que entra animado e se preenche com o que a pessoa digita. Trocar a forma, ou sair do passo 2,
 * volta pra lista.
 */
const naTelaDoCartao = ref(false)
watch(forma, () => { naTelaDoCartao.value = false })
watch(etapa, (e) => { if (e !== 'pagamento') naTelaDoCartao.value = false })
function sairDaTelaDoCartao() {
  naTelaDoCartao.value = false
  erro.value = ''
}
onMounted(async () => {
  try { cartaoNoSite.value = !!(await $fetch<any>('/api/pagamento/cartao', { query: { evento: slug } }))?.ligado }
  catch { cartaoNoSite.value = false }
})
/** O que falta no cartão, pra frase de cima do botão (o campo diz o resto). `null` = pode pagar. */
function faltaNoCartao(): string | null {
  const c = conferirCartao(cartao.value)
  if (!c.ok) { formularioDoCartao.value?.mostrarErros(); return 'Confira os dados do cartão.' }
  if (enderecoDoCartao.cep.replace(/\D/g, '').length !== 8) return 'Digite o CEP do endereço da fatura do cartão (8 números).'
  if (!enderecoDoCartao.numero.trim()) return 'Digite o número do endereço da fatura do cartão (ou S/N).'
  if (outroTitular.value && cpfDoTitular.value.replace(/\D/g, '').length !== 11) return 'Digite o CPF de quem é o cartão.'
  return null
}

/**
 * Quantas parcelas cabem, e de quanto — sobre o total que VAI SER COBRADO, com
 * o cupom (B21). O piso de R$ 5,00 por parcela é do Asaas; a porta
 * (`server/api/checkout.post.ts`, `maxParcelas`) aplica a MESMA conta — o
 * teste `checkout-parcelas.test.ts` compara o piso daqui com o de lá.
 */
const PARCELA_MINIMA_CENTS = 500
/**
 * Volte Mais (037): o desconto de fidelidade da conta NESTE carrinho, mostrado ANTES de pagar (o
 * cliente vê o desconto, o que sobra e o regulamento). A decisão de verdade é do checkout, com a
 * trava do CPF — esta é a mesma conta, só que sem gravar (`/api/fidelidade/previa`).
 */
type PreviaDaFidelidade = {
  disponivel: boolean; nome?: string; descontoCents?: number; ingressos?: number; descontoPct?: number
  restantesDepois?: number | null; validoAte?: string | null; consumacaoPct?: number; regulamento?: string; motivo?: string
}
const fidelidade = ref<PreviaDaFidelidade | null>(null)
async function conferirFidelidade() {
  fidelidade.value = null
  if (!conta.value || !carrinho.value?.linhas?.length) return
  try {
    fidelidade.value = await $fetch<PreviaDaFidelidade>('/api/fidelidade/previa', {
      method: 'POST', body: { eventSlug: slug, itens: itensDoCheckout(carrinho.value.linhas) },
    })
  } catch {
    fidelidade.value = null   // sem prévia, o checkout decide sozinho — só não há o aviso antes
  }
}
/** cupom e fidelidade não acumulam: com cupom valendo, vale o cupom */
const fidelidadeVale = computed(() => !!fidelidade.value?.disponivel && cupom.estado !== 'vale')
const dataCurta = (iso?: string | null) => (iso ? iso.split('-').reverse().join('/') : '')

const totalACobrar = computed(() => {
  const total = carrinho.value?.totais.total ?? 0
  const desconto = cupom.estado === 'vale' ? Number(cupom.descontoCents ?? 0)
    : fidelidadeVale.value ? Number(fidelidade.value?.descontoCents ?? 0) : 0
  return Math.max(0, total - desconto)
})
const opcoesDeParcela = computed(() => parcelasPossiveis(totalACobrar.value, PARCELA_MINIMA_CENTS))
watch(opcoesDeParcela, (o) => { if (parcelas.value > o.length) parcelas.value = o.length })
/**
 * Ingresso grátis (o carrinho, ou o cupom, zerou o total): a compra não passa por gateway nenhum
 * e a tela não mostra NADA de pagamento — nem Pix, nem cartão. Só "Gerar ingresso".
 */
const gratis = computed(() => !!carrinho.value && totalACobrar.value === 0)
const nIngressos = computed(() => carrinho.value?.totais.n ?? 0)

const FORMAS: { id: Forma; titulo: string; frase: string }[] = [
  { id: 'pix', titulo: 'Pix', frase: 'Aprovação na hora. Pague pelo app do seu banco.' },
  { id: 'credito', titulo: 'Cartão de crédito', frase: 'Em até 12× sem juros, conforme o valor.' },
  { id: 'debito', titulo: 'Cartão de débito', frase: 'À vista, direto da sua conta.' },
]
/*
 * Com o cartão no site ligado, o débito SAI da lista (dono, 06/10: "não vamos usar o checkout do
 * Asaas nunca, tudo nosso"). A API do Asaas não aceita cartão de débito — ele só existia pela
 * fatura do Asaas, que é justamente o que o dono não quer. À vista fica o Pix.
 * Débito digitado aqui pelo Mercado Pago também não serve: o GET /v1/payment_methods da conta do
 * parque (06/10) só libera `debelo` (Elo Débito) — Visa e Master débito seriam recusados. O dono
 * escolheu tirar o débito e deixar o Pix no lugar.
 */
const formasNaTela = computed(() => (cartaoNoSite.value ? FORMAS.filter((f) => f.id !== 'debito') : FORMAS))
watch(cartaoNoSite, (ligado) => { if (ligado && forma.value === 'debito') forma.value = 'pix' })
const rotuloDoBotao = computed(() => {
  if (enviando.value) return usaCartaoNoSite.value ? 'Confirmando com o banco…' : 'Gerando a cobrança…'
  const total = reais(totalACobrar.value)
  if (forma.value === 'pix') return `Pagar ${total} com Pix`
  if (forma.value === 'debito') return `Pagar ${total} no débito`
  if (usaCartaoNoSite.value && !naTelaDoCartao.value) return 'Continuar com cartão de crédito'
  const n = parcelas.value
  return n > 1 ? `Pagar em ${n}× no crédito` : `Pagar ${total} no crédito`
})

const lerJson = (chave: string) => {
  try { return JSON.parse(lerDaAba(chave) || 'null') } catch { return null }
}

onMounted(() => {
  const bruto = lerJson(CHAVE_CARRINHO)
  // Carrinho de build antiga não tem a declaração de meia e morreria com 422
  // na última tela. Volta pra vitrine, onde ele se refaz em dois cliques.
  const c: Carrinho | null = bruto?.versao === VERSAO_DO_CARRINHO && bruto.slug === slug && bruto.linhas?.length
    ? bruto : null
  if (bruto && !c) apagarDaAba(CHAVE_CARRINHO)

  // Pedido já criado nesta aba tem prioridade sobre o carrinho: recarregar a
  // página enquanto o PIX não cai é o gesto mais comum que existe aqui, e sem
  // isto ele jogava o comprador de volta pra vitrine com o lote já reservado
  // no nome dele — que é como se perde uma venda já feita.
  const p = lerJson(CHAVE_PEDIDO)
  if (p) {
    if (p?.slug === slug && p?.pedido?.pedidoId) {
      // B13: o carrinho foi montado DEPOIS deste pedido — a pessoa voltou e
      // escolheu outra coisa. Reabrir o pedido velho ignorava o carrinho novo;
      // agora a tela mostra o novo, avisa do anterior e deixa voltar pra ele.
      if (c?.criadoEm && p.criadoEm && c.criadoEm > p.criadoEm) {
        pedidoAnterior.value = p
        carrinho.value = c
        pedirConta()
        return
      }
      retomarCobranca(p)
      return
    }
    apagarDaAba(CHAVE_PEDIDO)
  }

  if (!c) return void semCarrinho()
  carrinho.value = c
  pedirConta()
})

/** Lê a conta; quem chegou sem ela vê a janela de entrar abrir sozinha. */
async function pedirConta() {
  const s = await garantir(slug)
  if (!s.conta && etapa.value === 'dados') abrirConta('entrar', MOTIVO_DA_JANELA)
}

// a conta entrou (ou trocou) com cupom no campo: a conferência deixa de ser parcial
watch(() => conta.value?.cpf, (cpf, antes) => {
  if (cpf && cpf !== antes && form.cupom.trim()) void conferirCupom()
})

/** Volta pra cobrança do pedido guardado nesta aba (F5, ou "voltar ao pedido anterior"). */
function retomarCobranca(p: any) {
  pedidoAnterior.value = null
  pedido.value = p.pedido
  linhasDoPedido.value = p.linhas ?? []
  emailDoPedido.value = p.email ?? ''
  form.cupom = typeof p.cupom === 'string' ? p.cupom : ''
  forma.value = p.pedido.pagamento?.forma === 'credito' ? 'credito' : 'pix'
  etapa.value = 'cobranca'
  comecarContagem(p.pedido.expiraEm)
  vigiarPagamento(p.pedido.pedidoId)
  conferirAgora(p.pedido.pedidoId)
}

/**
 * Chegou no pagamento sem nada pra pagar. Se esta aba acabou de comprar, o
 * lugar certo é o ingresso — não a vitrine.
 */
function semCarrinho() {
  let pago: any = null
  try { pago = JSON.parse(lerDaAba(CHAVE_PAGO) || 'null') }
  catch { /* chave estragada não pode impedir o desvio de acontecer */ }
  navigateTo(destinoSemCarrinho(slug, pago))
}

/** Os itens do carrinho como id + quantidade — nunca preço (ver `itensDoCheckout`). */
const itensCrus = () => (carrinho.value?.linhas ?? []).map((l) => ({
  lotId: l.loteId, ticketTypeId: l.tipoId ?? null, quantidade: l.quantidade,
}))

/**
 * Confere o cupom agora, sem cobrar nada.
 *
 * Chamada quando o comprador sai do campo do cupom e quando a conta entra (aí a
 * conferência deixa de ser parcial). Não grava nada e não reserva o uso: quem dá
 * a palavra final continua sendo o checkout, com a linha do cupom travada — por
 * isso o recado de sucesso não promete, só informa.
 *
 * Falha de rede NÃO vira erro vermelho: o cupom não foi recusado, só não deu
 * pra perguntar. Pintar de vermelho aqui faria o comprador tirar um cupom bom.
 */
async function conferirCupom() {
  const codigo = form.cupom.trim()
  if (!codigo) {
    Object.assign(cupom, { estado: 'vazio', recado: '', descontoCents: null, parcial: false })
    return
  }
  cupom.estado = 'conferindo'
  try {
    const r = await $fetch<any>('/api/cupom/conferir', {
      method: 'POST',
      body: {
        eventSlug: slug, codigo,
        documento: conta.value?.cpf || undefined,
        itens: itensCrus(),
      },
    })
    Object.assign(cupom, {
      estado: r.ok ? 'vale' : 'nao_vale',
      recado: r.recado ?? '',
      descontoCents: r.descontoCents ?? null,
      parcial: Boolean(r.parcial),
    })
  } catch (e: any) {
    console.error('[pagamento] não deu pra conferir o cupom', e?.data ?? e)
    Object.assign(cupom, { estado: 'vazio', recado: '', descontoCents: null, parcial: false })
  }
}

/**
 * Larga um pedido pendente desta aba (B13). Devolve o lugar na hora e a
 * varredura cancela a cobrança no gateway. Pedido que já tinha acabado conta
 * como largado; pago ou em análise, não (a rota responde 409 com a frase).
 */
async function largarPedido(pedidoId: string): Promise<boolean> {
  try {
    await $fetch(`/api/pedido/${encodeURIComponent(pedidoId)}/desistir`, { method: 'POST', body: {} })
    return true
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || e?.statusMessage
      || 'Não deu pra cancelar o pedido anterior agora. Tente de novo.'
    return false
  }
}

/** Sem conta não há passo 2: a janela abre, e a tela diz por quê. */
function precisaDaConta(): boolean {
  if (conta.value) return false
  abrirConta('entrar', MOTIVO_DA_JANELA)
  return true
}

/**
 * "Avançar" do passo 1. O cupom digitado e ainda não conferido é conferido ANTES (quem apertou
 * Enter no campo do cupom não pode chegar no pagamento com um cupom que não vale); o grátis não
 * tem passo 2 — gera o ingresso aqui mesmo.
 */
async function avancar() {
  erro.value = ''
  erroNosDados.value = false
  campoComErro.value = ''
  if (!carrinho.value || enviando.value || precisaDaConta()) return
  if (form.cupom.trim() && cupom.estado === 'vazio') await conferirCupom()
  if (cupom.estado === 'nao_vale' || cupom.estado === 'conferindo') return
  if (gratis.value) return void pagar()
  etapa.value = 'pagamento'
  conferirFidelidade()
  if (import.meta.client) window.scrollTo({ top: 0 })
}

/**
 * Manda o pedido.
 *
 * `semDeclaracao` existe por causa de um caso só, descrito em
 * `pedeDeclaracaoDeMeia`: a vitrine pública não recebe a espécie do tipo, e um
 * ingresso de preço cheio que exige documento é classificado como inteira pelo
 * banco e como meia por ela. Quando o servidor diz `meia_em_inteira`, a tela
 * reenvia sem a declaração — reclamar de um campo que o servidor recusa
 * deixaria o comprador preso numa tela sem saída.
 *
 * Quem compra NÃO vai no corpo: o servidor tira da sessão da conta (034) — mandar daqui seria
 * deixar a tela dizer em nome de quem sai o ingresso.
 */
async function pagar(semDeclaracao = false) {
  if (!carrinho.value) return
  erro.value = ''
  erroNosDados.value = false
  campoComErro.value = ''
  if (precisaDaConta()) return
  if (!gratis.value && usaCartaoNoSite.value && !naTelaDoCartao.value) {
    naTelaDoCartao.value = true
    if (import.meta.client) window.scrollTo({ top: 0, behavior: 'smooth' })
    return
  }
  if (!gratis.value && usaCartaoNoSite.value) {
    const falta = faltaNoCartao()
    if (falta) { erro.value = falta; return }
    // o cartão "respira" enquanto o banco responde: sobe a tela até ele
    if (import.meta.client) window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  enviando.value = true
  try {
    // B13: vai pagar o carrinho novo — o pedido anterior desta aba sai antes
    if (pedidoAnterior.value) {
      if (!(await largarPedido(pedidoAnterior.value.pedido.pedidoId))) return
      pedidoAnterior.value = null
      apagarDaAba(CHAVE_PEDIDO)
    }
    // o grátis não escolhe forma nenhuma (o servidor nem chega no gateway); `pix` é só o padrão
    const f: Forma = gratis.value ? 'pix' : forma.value
    const r = await $fetch<any>('/api/checkout', {
      method: 'POST',
      body: {
        eventSlug: slug,
        itens: itensDoCheckout(carrinho.value.linhas, { semDeclaracao }),
        cupom: form.cupom.trim() || undefined,
        // B07: a venda que veio pelo link do promoter é dele
        promoter: carrinho.value.promoter || undefined,
        forma: f,
        parcelas: f === 'credito' ? parcelas.value : 1,
        ...(f === 'credito' && usaCartaoNoSite.value ? {
          cartao: {
            ...cartao.value,
            cep: enderecoDoCartao.cep.replace(/\D/g, ''),
            numeroEndereco: enderecoDoCartao.numero.trim(),
            cpfTitular: outroTitular.value ? cpfDoTitular.value.replace(/\D/g, '') : undefined,
          },
        } : {}),
      },
    })
    // o cartão foi: some da memória da tela (o número e o código não ficam esperando um F5)
    cartao.value = vazioDoCartao()
    pedido.value = r
    linhasDoPedido.value = carrinho.value.linhas
    emailDoPedido.value = conta.value?.email ?? ''
    conferirOPrecoCobrado(r)
    apagarDaAba(CHAVE_CARRINHO)

    // Pedido que já nasce pago: total zero não passa por gateway nenhum
    // (checkout.post.ts devolve `status: 'pago'` na hora). Sem carimbo aqui, o
    // F5 nesta mesma tela devolvia pra vitrine quem acabou de receber o
    // ingresso — o carrinho já foi apagado na linha de cima e `dt:pedido` nunca
    // chega a existir neste caminho.
    if (r.status === 'pago') {
      lembrarPago(r)
      etapa.value = 'pago'
      await buscarIngressos(r.pedidoId)
      return
    }

    // Guardado pra o F5 não perder a cobrança (ver onMounted) — com as linhas,
    // que a etapa de cobrança mostra e que voltam pro carrinho se a pessoa
    // desistir deste pedido pra pagar de outro jeito. Da pessoa, só o e-mail
    // que a tela de "deu certo" cita.
    gravarNaAba(CHAVE_PEDIDO, JSON.stringify({
      slug, pedido: r, email: emailDoPedido.value, cupom: form.cupom.trim(), linhas: carrinho.value?.linhas ?? [],
      criadoEm: Date.now(),
    }))
    etapa.value = 'cobranca'
    comecarContagem(r.expiraEm)
    vigiarPagamento(r.pedidoId)
  } catch (e: any) {
    // A mensagem do servidor é a útil ("Lote esgotado", "Cupom inválido").
    // Trocar por "erro ao processar" esconde justamente o que resolve.
    const corpo = e?.data ?? {}
    const recado = corpo.statusMessage || corpo.message || e?.statusMessage
      || 'Não foi possível concluir. Tente de novo.'
    const tipo = corpo.data?.tipo

    if (tipo === 'meia_em_inteira' && !semDeclaracao) {
      enviando.value = false
      return await pagar(true)
    }
    // A sessão da conta caiu no meio (expirou, saiu em outra aba): relê e pede de novo.
    if (tipo === 'conta') {
      await carregar(slug)
      etapa.value = 'dados'
      abrirConta('entrar', recado)
      return
    }
    // Erro de cupom fica COLADO no campo do cupom, com o botão de seguir sem
    // ele. Numa faixa geral, o comprador relê a tela inteira procurando o que
    // errou. O campo mora no passo 1: a tela volta pra ele.
    if (tipo === 'cupom' && MOSTRAR_CUPOM) {
      Object.assign(cupom, { estado: 'nao_vale', recado, descontoCents: null, parcial: false })
      etapa.value = 'dados'
      return
    }
    // Dado da conta recusado (o gateway não aceitou o celular — B12): o conserto é em "Meus dados".
    // O documento da meia não mora na conta: esse recado vem com o caminho de volta pra vitrine.
    // Cartão recusado pelo banco, ou dado do cartão torto: a frase vem do servidor e o lugar já
    // voltou. O código de segurança sai da tela (a pessoa digita de novo, ou usa outro cartão).
    if (tipo === 'cartao_recusado' || tipo === 'cartao' || tipo === 'cartao_sem_resposta') {
      cartao.value = { ...cartao.value, cvv: '' }
      erro.value = recado
      return
    }
    erroNosDados.value = tipo === 'cadastro' && !String(corpo.data?.campo ?? '').startsWith('meia_')
    erro.value = recado
  } finally {
    enviando.value = false
  }
}

/** Tira o cupom recusado do caminho e segue, sem desconto. */
async function seguirSemCupom() {
  form.cupom = ''
  Object.assign(cupom, { estado: 'vazio', recado: '', descontoCents: null, parcial: false })
  await avancar()
}

/** "Não é você? Sair": a conta sai e a janela abre pra a pessoa certa entrar. */
async function trocarDeConta() {
  await sairDaConta()
  abrirConta('entrar', MOTIVO_DA_JANELA)
}

/**
 * O total cobrado bate com o que a tela prometeu?
 *
 * A diferença legítima é o desconto do cupom — o resto é preço que mudou entre
 * a vitrine e o botão (lote virou, tipo esgotou e caiu pra outro preço). Se
 * mudou, a tela DIZ. Trocar o número em silêncio é como nasce o chamado de
 * "cobraram diferente do que estava escrito".
 */
function conferirOPrecoCobrado(r: any) {
  avisoDePreco.value = ''
  const prometido = carrinho.value?.totais.total ?? 0
  const esperado = prometido - Number(r.descontoCents ?? 0)
  const cobrado = Number(r.totalCents ?? 0)
  if (!prometido || cobrado === esperado) return
  avisoDePreco.value = `O preço mudou entre a escolha e o pagamento: a tela mostrava `
    + `${reais(esperado)} e a cobrança saiu em ${reais(cobrado)}. `
    + 'Se não quiser seguir, é só não pagar — a reserva cai sozinha.'
}

let timerContagem: any, timerVigia: any, timerQr: any
function comecarContagem(expiraEm: string) {
  clearInterval(timerContagem)
  const fim = new Date(expiraEm).getTime()
  const tick = () => { restante.value = Math.max(0, Math.floor((fim - Date.now()) / 1000)) }
  tick()
  timerContagem = setInterval(tick, 1000)
}
const relogio = computed(() => {
  const m = Math.floor(restante.value / 60), s = restante.value % 60
  return `${m}:${String(s).padStart(2, '0')}`
})

/**
 * Pergunta ao servidor se o pagamento caiu. O webhook é quem manda; isto só
 * olha.
 *
 * O catch NÃO é mudo de propósito. Um `catch {}` aqui já transformou um erro
 * 500 do servidor numa tela que fica girando pra sempre: o comprador pagou,
 * o ingresso foi emitido, e a página nunca mudou — sem nada no console, sem
 * teste vermelho, sem exceção. Falha de rede é normal e se resolve no próximo
 * tick; falha que se repete precisa aparecer pra alguém.
 */
function vigiarPagamento(id: string) {
  clearInterval(timerVigia)
  buscarQrLogo(id)
  let seguidas = 0
  timerVigia = setInterval(async () => {
    try {
      const r = await $fetch<any>(`/api/pedido/${id}`)
      seguidas = 0
      aplicarEstado(r)
    } catch (e: any) {
      console.error('[pagamento] consulta do pedido falhou', e?.data ?? e)
      if (++seguidas >= 3) {
        erro.value = 'Não estamos conseguindo confirmar o pagamento automaticamente. '
          + 'Se você já pagou, guarde o número do pedido e atualize a página.'
      }
    }
  }, 4000)
}

/**
 * O QR do Pix que não veio no checkout (o Asaas às vezes gera um segundo depois): pergunta a cada
 * 1,5 s até ele chegar (no máximo ~30 s; depois segue o vigia de 4 s). Antes a tela oferecia "Abrir
 * a fatura" — a página do Asaas, que o dono não quer (06/10).
 */
function buscarQrLogo(id: string) {
  clearTimeout(timerQr)
  let tentativas = 0
  const passo = async () => {
    if (etapa.value !== 'cobranca' || !ehPix.value || pedido.value?.pagamento?.pixPayload || ++tentativas > 20) return
    await conferirAgora(id)
    timerQr = setTimeout(passo, 1500)
  }
  timerQr = setTimeout(passo, 1200)
}

/** Uma consulta avulsa — usada quando a tela é recuperada depois do F5. */
async function conferirAgora(id: string) {
  try { aplicarEstado(await $fetch<any>(`/api/pedido/${id}`)) } catch { /* o vigia tenta de novo */ }
}

/**
 * O ÚNICO lugar que grava `dt:pago`. Os dois caminhos que levam a tela pra
 * "Ingressos emitidos" passam por aqui — o vigia do PIX e o pedido que já nasce
 * pago. Enquanto o `setItem` morava só dentro de `aplicarEstado`, o segundo
 * caminho chegava na tela de sucesso sem carimbo nenhum.
 */
function lembrarPago(r: any) {
  const carimbo = carimboDePago(slug, r, pedido.value?.pedido)
  if (carimbo) gravarNaAba(CHAVE_PAGO, JSON.stringify(carimbo))
}

function aplicarEstado(r: any) {
  situacao.value = situacaoDaCobranca(r.status)
  statusDaCobranca.value = r.status
  // O QR do PIX que não veio no checkout (o Asaas ainda não tinha gerado) chega numa consulta
  // seguinte — o servidor pergunta de novo ao gateway. Sem trazer pra cá, a tela seguia em
  // "O QR está sendo gerado" com o código já pronto do outro lado.
  if (r.status === 'aguardando_pagamento' && r.pagamento && pedido.value
      && !pedido.value.pagamento?.pixPayload && r.pagamento.pixPayload) {
    pedido.value = { ...pedido.value, pagamento: { ...pedido.value.pagamento, ...r.pagamento } }
  }
  if (r.status === 'em_analise') {
    // B34: o relógio da reserva PARA — em análise o pedido não vence (a
    // varredura pergunta ao gateway antes de soltar o lugar) — e o vigia segue.
    clearInterval(timerContagem)
    return
  }
  if (situacao.value?.final) {
    apagarDaAba(CHAVE_PEDIDO)
    return void pararRelogios()
  }
  // `estornado_parcial` é venda de pé (B01): parte do dinheiro voltou e os
  // ingressos seguem valendo — a tela mostra os ingressos, como no pago
  if (pedidoVivo(r.status)) {
    pedido.value = { ...pedido.value, ...r }
    ingressos.value = r.ingressos ?? []
    etapa.value = 'pago'
    apagarDaAba(CHAVE_PEDIDO)
    lembrarPago(r)
    pararRelogios()
  } else if (r.pagoSemIngresso) {
    // O dinheiro ENTROU e o lugar não voltou (PIX pago depois do prazo, com o
    // lote já vendido pra outra pessoa). "Expirou" aqui seria mentir pra quem
    // pagou — e mandaria a pessoa comprar de novo, pagando duas vezes.
    erro.value = ''
    pagoSemIngresso.value = true
    apagarDaAba(CHAVE_PEDIDO)
    pararRelogios()
  } else if (['expirado', 'cancelado', 'falhou'].includes(r.status)) {
    // O vigia NÃO para no 'expirado'. O PIX da tela pode ter sido pago no
    // último minuto e a confirmação chegar agora: o servidor refaz a reserva
    // e o pedido vira 'pago' — e esta tela precisa virar junto, em vez de
    // ficar dizendo "expirou" pra quem pagou. Cancelado e falhou são finais.
    erro.value = r.status === 'expirado'
      ? 'O tempo da reserva acabou. Se você já pagou, espere nesta tela: a confirmação '
        + 'ainda pode chegar e os ingressos aparecem aqui. Se não pagou, escolha de novo — '
        + 'leva dois cliques.'
      : 'Esta reserva não está mais valendo e os ingressos voltaram para a venda. '
        + 'Escolha de novo — leva dois cliques.'
    apagarDaAba(CHAVE_PEDIDO)
    if (r.status !== 'expirado') return void pararRelogios()
    clearInterval(timerContagem)
    // Uma hora de espera basta: a varredura cancela a cobrança no gateway
    // logo depois de a reserva cair, então pagamento mais tardio que isso é
    // caso de bilheteria, não de tela aberta consultando a cada 4 s.
    expiradoDesde ||= Date.now()
    if (Date.now() - expiradoDesde > 60 * 60_000) pararRelogios()
  }
}
let expiradoDesde = 0

function pararRelogios() { clearInterval(timerVigia); clearInterval(timerContagem); clearTimeout(timerQr) }
onUnmounted(pararRelogios)

/**
 * "Trocar a forma de pagamento ou desistir" (B13): larga este pedido e volta
 * pra escolha da forma de pagamento com o MESMO carrinho, pra pagar de outro
 * jeito — o "Voltar" de lá leva ao resumo, pra mudar a escolha. Não havia
 * saída: a cobrança mostrava só código e total.
 */
async function trocarPagamento() {
  if (!pedido.value?.pedidoId || desistindo.value) return
  desistindo.value = true
  erro.value = ''
  try {
    if (!(await largarPedido(pedido.value.pedidoId))) return
    pararRelogios()
    apagarDaAba(CHAVE_PEDIDO)
    const linhas = linhasDoPedido.value
    if (!linhas.length) return void navigateTo(`/e/${slug}`)
    const c: Carrinho = {
      versao: VERSAO_DO_CARRINHO, slug, linhas, totais: totaisDoCarrinho(linhas),
      criadoEm: Date.now(), promoter: carrinho.value?.promoter ?? null,
    }
    gravarNaAba(CHAVE_CARRINHO, JSON.stringify(c))
    carrinho.value = c
    pedido.value = null
    situacao.value = null
    etapa.value = c.totais.total > 0 ? 'pagamento' : 'dados'
    // o cupom do pedido largado segue no campo; conferido de novo, o total da escolha já sai com ele
    Object.assign(cupom, { estado: 'vazio', recado: '', descontoCents: null, parcial: false })
    await garantir(slug)
    if (form.cupom.trim()) await conferirCupom()
  } finally {
    desistindo.value = false
  }
}

/** Depois de pago: os ingressos emitidos, pra mostrar o QR aqui mesmo. */
async function buscarIngressos(id: string) {
  try {
    const r = await $fetch<any>(`/api/pedido/${id}`)
    pedido.value = { ...pedido.value, ...r }
    ingressos.value = r.ingressos ?? []
  } catch (e: any) {
    // A compra está feita; o que falhou foi só a vitrine do ingresso. O link
    // do pedido embaixo continua valendo, e é isso que a tela diz.
    console.error('[pagamento] não deu pra listar os ingressos', e?.data ?? e)
  }
}

async function copiarPix() {
  try {
    await navigator.clipboard.writeText(pedido.value.pagamento.pixPayload)
    copiado.value = true
    setTimeout(() => (copiado.value = false), 2500)
  } catch { /* sem permissão de área de transferência: o texto está na tela */ }
}

/**
 * Só aparece com o gateway simulado (nunca em produção).
 *
 * Trava de duplo clique e erro na tela: sem as duas, o segundo clique mandava
 * outro "pagamento" e uma falha (409, servidor fora) virava promessa rejeitada
 * sem ninguém ver — o botão parecia não fazer nada.
 */
const simulando = ref(false)
async function simularPagamento() {
  if (simulando.value) return
  simulando.value = true
  try {
    await $fetch('/api/dev/pagar', { method: 'POST', body: { pedido: pedido.value.pedidoId } })
    await conferirAgora(pedido.value.pedidoId)
  } catch (e: any) {
    console.error('[pagamento] simulação de pagamento falhou', e?.data ?? e)
    erro.value = e?.data?.statusMessage || e?.statusMessage
      || 'Não deu pra simular o pagamento agora. Tente de novo.'
  } finally {
    simulando.value = false
  }
}

const ehPix = computed(() => (pedido.value?.pagamento?.forma ?? 'pix') === 'pix')
/**
 * B20: o prazo do PIX venceu — a varredura já cancelou a cobrança no gateway,
 * então o QR e o copia-e-cola SOMEM (pagar um QR cancelado é dinheiro que não
 * chega). A tela segue consultando: o pagamento feito no último minuto ainda
 * pode chegar.
 */
const pixVencido = computed(() => etapa.value === 'cobranca' && restante.value <= 0
  && !!pedido.value?.expiraEm && statusDaCobranca.value !== 'em_analise')

/** Na tela de "deu certo": o e-mail pra onde vai a confirmação. */
const emailDaConfirmacao = computed(() => emailDoPedido.value || conta.value?.email || '')
/** O pedido que acabou de sair é grátis — a tela de "deu certo" não fala de pagamento. */
const pedidoGratis = computed(() => Number(pedido.value?.totalCents ?? -1) === 0)

useHead({ title: 'Pagamento' })
</script>

<template>
  <div class="min-h-screen">
    <CabecalhoPublico :para="`/e/${slug}`" largura="max-w-2xl" :evento="slug" />

    <div class="mx-auto max-w-2xl px-4 py-6">
      <!-- ------------------------------------------ passo 1 · conferir -->
      <section v-if="etapa === 'dados'">
        <NuxtLink :to="`/e/${slug}`" class="text-sm text-acao hover:underline">← Voltar</NuxtLink>
        <div class="mt-3 flex items-baseline justify-between gap-3">
          <h1 class="titulo text-2xl font-semibold text-tinta">
            {{ gratis ? (nIngressos === 1 ? 'Seu ingresso grátis' : 'Seus ingressos grátis') : 'Finalizar compra' }}
          </h1>
          <p v-if="!gratis" class="shrink-0 text-xs font-semibold uppercase tracking-wide text-tinta-fraca">
            Passo 1 de 2
          </p>
        </div>

        <div v-if="carrinho" class="card mt-4">
          <p class="rotulo-kpi">Resumo</p>
          <ul class="mt-2 space-y-1 text-sm">
            <li v-for="(l, i) in carrinho.linhas" :key="i" class="flex justify-between gap-3">
              <span class="min-w-0">
                <span class="font-medium tabular-nums text-tinta">{{ l.quantidade }}×</span>
                <span class="text-tinta-corpo"> {{ l.nome }}</span>
                <span class="block text-xs text-tinta-fraca">
                  {{ l.setor }}
                  <template v-if="l.declaracao?.motivo">
                    · meia-entrada: {{ MOTIVOS[l.declaracao.motivo]?.rotulo ?? l.declaracao.motivo }}
                  </template>
                </span>
              </span>
              <span class="shrink-0 tabular-nums text-tinta">
                {{ l.unitTotalCents ? reais(l.unitTotalCents * l.quantidade) : 'Grátis' }}
              </span>
            </li>
          </ul>
          <div class="mt-3 flex items-baseline justify-between border-t border-linha pt-3">
            <span class="text-tinta-corpo">
              {{ nIngressos }} {{ nIngressos === 1 ? 'ingresso' : 'ingressos' }}
            </span>
            <span class="titulo text-2xl font-bold tabular-nums text-tinta">
              {{ carrinho.totais.total ? reais(carrinho.totais.total) : 'Grátis' }}
            </span>
          </div>
          <p v-if="carrinho.totais.taxa" class="mt-1 text-right text-xs text-tinta-fraca">
            {{ reais(carrinho.totais.face) }} de ingressos + {{ reais(carrinho.totais.taxa) }} de taxa de serviço
          </p>
        </div>

        <!-- B13: a pessoa voltou e montou OUTRO carrinho com um pedido ainda
             aberto nesta aba. Pagar este larga o anterior (o lugar dele volta). -->
        <div v-if="pedidoAnterior" class="faixa-aviso mt-4" role="status">
          <p class="font-semibold text-tinta">Você tem um pedido aguardando pagamento.</p>
          <p class="mt-1">
            Pedido <strong class="text-tinta">{{ pedidoAnterior.pedido.pedido }}</strong>
            ({{ reais(pedidoAnterior.pedido.totalCents) }}). Se você seguir com a escolha abaixo, esse pedido
            é cancelado e os ingressos dele voltam para a venda.
          </p>
          <button type="button" class="btn-secundario mt-2 w-full py-2" @click="retomarCobranca(pedidoAnterior)">
            Voltar para o pedido anterior
          </button>
        </div>

        <!-- -------------------------------------------- quem compra -->
        <div v-if="!contaEstado.carregada" class="card mt-4 h-36 animate-pulse bg-ink-50" aria-busy="true"
             aria-label="Carregando a sua conta" />
        <div v-else-if="conta" class="card mt-4" data-parte="seus-dados">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="rotulo-kpi">{{ nIngressos === 1 ? 'O ingresso sai no nome de' : 'Os ingressos saem no nome de' }}</p>
              <p class="titulo mt-1 truncate text-lg font-semibold text-tinta">{{ conta.nome }}</p>
            </div>
            <NuxtLink :to="`/conta?volta=${encodeURIComponent(`/e/${slug}/pagamento`)}`"
                      class="shrink-0 text-sm font-semibold text-acao hover:underline">
              Editar
            </NuxtLink>
          </div>
          <dl class="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr_auto]">
            <div>
              <dt class="text-xs text-tinta-fraca">CPF</dt>
              <dd class="tabular-nums text-tinta">{{ cpfEscondido(conta.cpf) }}</dd>
            </div>
            <div class="min-w-0">
              <dt class="text-xs text-tinta-fraca">E-mail</dt>
              <dd class="break-all text-tinta">{{ conta.email }}</dd>
            </div>
            <div>
              <dt class="text-xs text-tinta-fraca">Celular</dt>
              <dd class="tabular-nums text-tinta">{{ telefoneLegivel(conta.telefone) }}</dd>
            </div>
          </dl>
          <p class="mt-3 border-t border-linha pt-3 text-xs text-tinta-suave">
            {{ nIngressos === 1 ? 'O ingresso chega' : 'Os ingressos chegam' }} no seu e-mail e ficam
            guardados em <NuxtLink to="/conta" class="font-semibold text-acao hover:underline">Minha conta</NuxtLink>.
            <button type="button" class="ml-1 font-semibold text-tinta-suave underline hover:text-tinta"
                    @click="trocarDeConta">
              Não é você? Sair
            </button>
          </p>
        </div>
        <div v-else class="card mt-4 text-center" data-parte="entre-para-comprar">
          <p class="titulo text-lg font-semibold text-tinta">Entre para continuar</p>
          <p class="mx-auto mt-1 max-w-sm text-sm text-tinta-suave">
            A compra fica guardada na sua conta e os ingressos chegam no seu e-mail. Criar a conta leva
            menos de um minuto.
          </p>
          <div class="mt-4 grid gap-2 sm:grid-cols-2">
            <button type="button" class="btn-cta py-3" @click="abrirConta('criar', null)">Criar conta</button>
            <button type="button" class="btn-secundario py-3" @click="abrirConta('entrar', null)">
              Já tenho conta
            </button>
          </div>
        </div>

        <form class="mt-5 space-y-4" novalidate @submit.prevent="avancar">
          <div v-if="MOSTRAR_CUPOM">
            <label for="cupom" class="rotulo">Cupom <span class="font-normal text-tinta-fraca">(opcional)</span></label>
            <!-- `@blur` e não `@input`: conferir a cada tecla mandaria uma
                 requisição por letra e diria "não encontramos o cupom ZZB"
                 enquanto a pessoa ainda digita ZZBOM. -->
            <input id="cupom" v-model="form.cupom" class="campo uppercase" autocomplete="off"
                   :maxlength="LIMITE.cupom"
                   :class="[cupom.estado === 'nao_vale' ? 'border-erro' : '', marca('cupom')]"
                   :aria-invalid="cupom.estado === 'nao_vale' ? 'true' : invalido('cupom')"
                   @blur="conferirCupom">
            <p v-if="cupom.estado === 'conferindo'" class="mt-2 text-sm text-tinta-suave">
              Conferindo o cupom…
            </p>
            <!-- O cupom que VALE também precisa dizer isso, e com o número: o
                 comprador digitou o código pra ganhar desconto e até aqui só
                 descobria se funcionou depois de pagar. -->
            <div v-else-if="cupom.estado === 'vale'"
                 class="mt-2 rounded-card border border-ok/40 bg-ok-claro p-3 text-sm text-ok">
              <p>
                {{ cupom.recado }}
                <template v-if="cupom.descontoCents">
                  Desconto de <span class="font-semibold tabular-nums">{{ reais(cupom.descontoCents) }}</span>.
                </template>
              </p>
              <p v-if="cupom.parcial" class="mt-1 text-tinta-suave">
                O limite de uso por CPF é conferido quando você entrar na conta.
              </p>
            </div>
            <!-- O recado do cupom mora COLADO no campo, e vem com a saída:
                 sem o botão, quem digitou um cupom vencido fica preso — a
                 tela inteira está certa e o botão de seguir não passa. -->
            <div v-else-if="cupom.estado === 'nao_vale'" class="faixa-erro mt-2" role="alert">
              <p>{{ cupom.recado }}</p>
              <button type="button" class="btn-secundario mt-2 w-full py-2" :disabled="enviando"
                      @click="seguirSemCupom">
                Continuar sem o cupom
              </button>
            </div>
          </div>

          <div v-if="erro" class="faixa-erro" role="alert">
            <p>{{ erro }}</p>
            <NuxtLink v-if="/meia-entrada/.test(erro)" :to="`/e/${slug}`"
                      class="mt-1 block font-semibold text-acao hover:underline">
              Corrigir na escolha dos ingressos →
            </NuxtLink>
            <NuxtLink v-else-if="erroNosDados" :to="`/conta?volta=${encodeURIComponent(`/e/${slug}/pagamento`)}`"
                      class="mt-1 block font-semibold text-acao hover:underline">
              Corrigir em Meus dados →
            </NuxtLink>
          </div>

          <button type="submit" :disabled="enviando || !conta" class="btn-cta w-full py-3 text-base"
                  data-parte="avancar">
            <template v-if="gratis">
              {{ enviando ? 'Gerando…' : (nIngressos === 1 ? 'Gerar ingresso' : 'Gerar ingressos') }}
            </template>
            <template v-else>Avançar para o pagamento</template>
          </button>
          <p v-if="!conta && contaEstado.carregada" class="-mt-2 text-center text-xs text-tinta-fraca">
            Entre na sua conta para seguir.
          </p>
        </form>
      </section>

      <!-- ----------------------------------------- passo 2 · pagamento -->
      <section v-else-if="etapa === 'pagamento'">
        <button v-if="naTelaDoCartao" type="button" class="text-sm text-acao hover:underline" data-parte="trocar-forma"
                :disabled="enviando" @click="sairDaTelaDoCartao">← Trocar a forma de pagamento</button>
        <button v-else type="button" class="text-sm text-acao hover:underline" @click="etapa = 'dados'">← Voltar</button>
        <div class="mt-3 flex items-baseline justify-between gap-3">
          <h1 class="titulo text-2xl font-semibold text-tinta">{{ naTelaDoCartao ? 'Cartão de crédito' : 'Como você quer pagar?' }}</h1>
          <p class="shrink-0 text-xs font-semibold uppercase tracking-wide text-tinta-fraca">Passo 2 de 2</p>
        </div>
        <p class="mt-1 text-tinta-suave">
          {{ nIngressos }} {{ nIngressos === 1 ? 'ingresso' : 'ingressos' }} ·
          <span class="font-semibold tabular-nums text-tinta">{{ reais(totalACobrar) }}</span>
          <span v-if="cupom.estado === 'vale' && cupom.descontoCents" class="text-ok"> · com o cupom</span>
          <span v-else-if="fidelidadeVale" class="text-ok"> · com o {{ fidelidade?.nome }}</span>
        </p>
        <div v-if="fidelidadeVale && fidelidade" class="mt-3 rounded-card border border-ok/40 bg-ok-claro p-3 text-sm text-ok"
             data-parte="fidelidade-previa">
          <p>
            <strong>{{ fidelidade.nome }}</strong>: {{ fidelidade.descontoPct }}% em
            {{ fidelidade.ingressos }} {{ fidelidade.ingressos === 1 ? 'ingresso' : 'ingressos' }} —
            <span class="font-semibold tabular-nums">−{{ reais(fidelidade.descontoCents ?? 0) }}</span>.
          </p>
          <p class="mt-1 text-tinta-corpo">
            <template v-if="fidelidade.restantesDepois == null">O desconto vale em todas as suas próximas visitas<template v-if="fidelidade.validoAte"> (até {{ dataCurta(fidelidade.validoAte) }})</template>.</template>
            <template v-else>Depois desta compra {{ fidelidade.restantesDepois === 1 ? 'sobra 1 retorno' : `sobram ${fidelidade.restantesDepois} retornos` }}
            com desconto<template v-if="fidelidade.validoAte"> (visitas até {{ dataCurta(fidelidade.validoAte) }})</template>.</template>
            <template v-if="fidelidade.consumacaoPct">No dia, {{ fidelidade.consumacaoPct }}% na consumação: o cupom vem junto com o ingresso — mostre no caixa do bar com um documento.</template>
          </p>
          <details v-if="fidelidade.regulamento" class="mt-1 text-tinta-corpo">
            <summary class="cursor-pointer underline">Regulamento</summary>
            <pre class="mt-1 whitespace-pre-wrap font-sans text-xs leading-5">{{ fidelidade.regulamento }}</pre>
          </details>
        </div>

        <form class="mt-5 space-y-4" novalidate @submit.prevent="pagar()">
          <fieldset v-if="!naTelaDoCartao">
            <legend class="sr-only">Forma de pagamento</legend>
            <div class="space-y-3">
              <label v-for="f in formasNaTela" :key="f.id" :data-forma="f.id"
                     class="flex cursor-pointer items-center gap-4 rounded-card border bg-white p-4 transition-colors focus-within:ring-2 focus-within:ring-acao"
                     :class="forma === f.id ? 'border-acao bg-acao-fraco' : 'border-ink-200 hover:border-ink-300'">
                <input v-model="forma" type="radio" name="forma" :value="f.id" class="sr-only">
                <span class="grid h-11 w-11 shrink-0 place-items-center rounded-lg"
                      :class="forma === f.id ? 'bg-acao text-white' : 'bg-ink-100 text-ink-700'" aria-hidden="true">
                  <svg v-if="f.id === 'pix'" viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M12 3l3.2 3.2a2 2 0 0 0 1.4.6H18l3 3-3 3h-1.4a2 2 0 0 0-1.4.6L12 16.6l-3.2-3.2a2 2 0 0 0-1.4-.6H6l-3-3 3-3h1.4a2 2 0 0 0 1.4-.6z" stroke-linejoin="round" />
                    <path d="M12 21l-2.5-2.5M12 21l2.5-2.5" stroke-linecap="round" />
                  </svg>
                  <svg v-else viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="1.8">
                    <rect x="2.5" y="5" width="19" height="14" rx="2" />
                    <path d="M2.5 9.5h19" />
                    <path d="M6 15h4" stroke-linecap="round" />
                  </svg>
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block font-semibold text-tinta">{{ f.titulo }}</span>
                  <span class="block text-sm text-tinta-suave">{{ f.frase }}</span>
                </span>
                <span class="grid h-5 w-5 shrink-0 place-items-center rounded-full border-2"
                      :class="forma === f.id ? 'border-acao' : 'border-ink-300'" aria-hidden="true">
                  <span v-if="forma === f.id" class="h-2.5 w-2.5 rounded-full bg-acao" />
                </span>
              </label>
            </div>
          </fieldset>

          <div v-if="forma === 'credito' && !usaCartaoNoSite">
            <label for="parcelas" class="rotulo">Parcelas</label>
            <select id="parcelas" v-model.number="parcelas" class="campo">
              <option v-for="o in opcoesDeParcela" :key="o.n" :value="o.n">{{ o.rotulo }}</option>
            </select>
            <p class="mt-1 text-xs text-tinta-fraca">
              Parcelas sem juros, sobre o total{{ cupom.estado === 'vale' ? ' já com o cupom' : '' }}.
            </p>
          </div>
          <div v-if="usaCartaoNoSite && naTelaDoCartao" class="grid gap-4" data-parte="cartao-no-site">
            <CartaoDeCredito ref="formularioDoCartao" v-model="cartao" :desabilitado="enviando"
                             @conferencia="conferenciaDoCartao = $event" />
            <div class="grid grid-cols-[1fr_7rem] gap-3">
              <div>
                <label for="cartao-cep" class="rotulo">CEP da fatura do cartão</label>
                <input id="cartao-cep" v-model="enderecoDoCartao.cep" class="campo tabular-nums" inputmode="numeric"
                       autocomplete="billing postal-code" placeholder="00000-000" maxlength="9" data-parte="campo-cep">
              </div>
              <div>
                <label for="cartao-numero-endereco" class="rotulo">Número</label>
                <input id="cartao-numero-endereco" v-model="enderecoDoCartao.numero" class="campo" maxlength="10"
                       autocomplete="billing address-line2" placeholder="123 ou S/N" data-parte="campo-numero-endereco">
              </div>
            </div>
            <div>
              <label for="parcelas" class="rotulo">Parcelas</label>
              <select id="parcelas" v-model.number="parcelas" class="campo" :disabled="enviando">
                <option v-for="o in opcoesDeParcela" :key="o.n" :value="o.n">{{ o.rotulo }}</option>
              </select>
              <p class="mt-1 text-xs text-tinta-fraca">
                Parcelas sem juros, sobre o total{{ cupom.estado === 'vale' ? ' já com o cupom' : '' }}.
              </p>
            </div>
            <label class="flex items-center gap-2 text-sm text-tinta-corpo">
              <input v-model="outroTitular" type="checkbox" class="h-5 w-5" data-parte="outro-titular">
              O cartão é de outra pessoa
            </label>
            <div v-if="outroTitular">
              <label for="cartao-cpf-titular" class="rotulo">CPF de quem é o cartão</label>
              <input id="cartao-cpf-titular" v-model="cpfDoTitular" class="campo tabular-nums" inputmode="numeric"
                     placeholder="000.000.000-00" maxlength="14" data-parte="campo-cpf-titular">
            </div>
          </div>
          <p v-if="forma === 'debito' || (forma === 'credito' && !usaCartaoNoSite)" class="text-xs text-tinta-fraca">
            Os dados do cartão são digitados no ambiente seguro do Asaas — eles não passam por aqui.
            <template v-if="forma === 'debito'">Lá, escolha a opção de débito.</template>
          </p>

          <div v-if="erro" class="faixa-erro" role="alert">
            <p>{{ erro }}</p>
            <NuxtLink v-if="/meia-entrada/.test(erro)" :to="`/e/${slug}`"
                      class="mt-1 block font-semibold text-acao hover:underline">
              Corrigir na escolha dos ingressos →
            </NuxtLink>
            <NuxtLink v-else-if="erroNosDados" :to="`/conta?volta=${encodeURIComponent(`/e/${slug}/pagamento`)}`"
                      class="mt-1 block font-semibold text-acao hover:underline">
              Corrigir em Meus dados →
            </NuxtLink>
          </div>

          <button type="submit" :disabled="enviando" class="btn-cta w-full py-3 text-base" data-parte="pagar">
            {{ rotuloDoBotao }}
          </button>
        </form>
      </section>

      <!-- ------------------------------------------------------- cobrança -->
      <section v-else-if="etapa === 'cobranca'">
        <h1 class="titulo text-2xl font-semibold text-tinta">
          {{ ehPix ? 'Pague com PIX' : 'Pague com cartão' }}
        </h1>
        <p class="mt-1 text-tinta-suave">
          Pedido <span class="font-medium text-tinta">{{ pedido.pedido }}</span> ·
          <span class="font-medium tabular-nums text-tinta">{{ reais(pedido.totalCents) }}</span>
        </p>
        <p v-if="pedido.descontoCents" class="mt-0.5 text-sm text-ok">
          {{ pedido.fidelidade ? pedido.fidelidade.nome : 'Cupom aplicado' }}: −{{ reais(pedido.descontoCents) }}
        </p>
        <!-- o que está sendo pago (a cobrança mostrava só código e total — B13) -->
        <ul v-if="linhasDoPedido.length" class="mt-2 space-y-0.5 text-sm text-tinta-corpo">
          <li v-for="(l, i) in linhasDoPedido" :key="i">
            <span class="font-medium tabular-nums text-tinta">{{ l.quantidade }}×</span> {{ l.nome }}
            <span class="text-tinta-fraca">· {{ l.setor }}</span>
          </li>
        </ul>
        <p v-if="avisoDePreco" class="faixa-aviso mt-3">{{ avisoDePreco }}</p>

        <!-- B34: em análise, devolvido, contestado — a cobrança diz o que houve -->
        <div v-if="situacao" class="mt-4" :class="situacao.final ? 'faixa-erro' : 'faixa-aviso'" role="status">
          <p class="font-semibold text-tinta">{{ situacao.titulo }}</p>
          <p class="mt-1">{{ situacao.frase }}</p>
        </div>

        <!-- PIX vencido: a cobrança foi cancelada no gateway, o QR não serve mais (B20) -->
        <div v-if="ehPix && pixVencido && !situacao" class="card mt-4 text-center">
          <p class="font-semibold text-tinta">O prazo deste PIX venceu</p>
          <p class="mt-1 text-sm text-tinta-suave">
            O código foi cancelado e não pode mais ser pago. Se você pagou nos últimos minutos, espere
            nesta tela: a confirmação ainda pode chegar.
          </p>
        </div>

        <!-- PIX -->
        <div v-else-if="ehPix && !situacao" class="card mt-4 text-center">
          <img v-if="pedido.pagamento?.pixQrBase64"
               :src="`data:image/png;base64,${pedido.pagamento.pixQrBase64}`"
               alt="QR Code do PIX" class="mx-auto h-56 w-56 max-w-full">
          <p v-else-if="pedido.pagamento?.pixPayload" class="py-8 text-sm text-tinta-suave">
            O QR está sendo gerado. Use o código copia e cola abaixo.
          </p>
          <!-- Nem QR nem copia e cola ainda (o gateway não gerou no segundo da compra): a página
               pergunta de novo a cada 1,5 s (buscarQrLogo). Sem link pra fatura do Asaas: o
               pagamento é todo no nosso site (dono, 06/10). -->
          <div v-else class="flex flex-col items-center gap-3 py-10" role="status" data-parte="gerando-pix">
            <span class="h-10 w-10 animate-spin rounded-full border-4 border-pool-200 border-t-pool-700" aria-hidden="true" />
            <p class="text-sm font-semibold text-tinta">Gerando o código Pix…</p>
            <p class="text-xs text-tinta-suave">Leva só alguns segundos. Não feche esta tela.</p>
          </div>

          <div v-if="pedido.pagamento?.pixPayload" class="mt-4">
            <p class="break-all rounded-card bg-fundo-cinza p-3 text-left font-mono text-[11px] text-tinta-corpo">
              {{ pedido.pagamento.pixPayload }}
            </p>
            <button type="button" class="btn-secundario mt-3 w-full py-2.5" @click="copiarPix">
              {{ copiado ? 'Copiado!' : 'Copiar código PIX' }}
            </button>
          </div>
        </div>

        <!-- cartão: o pagamento acontece no ambiente do Asaas -->
        <div v-else-if="!ehPix && !situacao && pedido.pagamento?.cartaoNoSite" class="card mt-4 text-center"
             data-parte="aguardando-banco">
          <p class="font-semibold text-tinta">Aguardando a aprovação do banco…</p>
          <p class="mt-1 text-sm text-tinta-suave">
            O cartão já foi enviado. Esta tela muda sozinha quando o banco responder — não feche nem pague de novo.
          </p>
        </div>
        <div v-else-if="!ehPix && !situacao" class="card mt-4">
          <p class="text-tinta-corpo">
            O cartão é digitado no ambiente seguro do Asaas. Termine o pagamento por lá e
            <strong class="text-tinta">volte para esta aba</strong> — ela muda sozinha quando a
            confirmação chegar.
          </p>
          <a v-if="pedido.pagamento?.linkFatura" :href="pedido.pagamento.linkFatura"
             target="_blank" rel="noopener" class="btn-cta mt-4 w-full py-3">
            Abrir pagamento com cartão
          </a>
          <p v-else class="faixa-aviso mt-3">
            O link do cartão não veio do gateway. Guarde o pedido
            <strong class="text-tinta">{{ pedido.pedido }}</strong> e fale com a bilheteria — a
            reserva continua de pé até o prazo abaixo.
          </p>
        </div>

        <!-- o relógio da reserva vale pros dois meios de pagamento; em análise
             ou já resolvido, ele não se aplica -->
        <p v-if="!situacao && restante > 0" class="mt-4 text-center text-sm text-tinta-suave">
          Seus ingressos estão reservados por
          <span class="font-semibold tabular-nums text-acao">{{ relogio }}</span>
        </p>
        <div v-else-if="!situacao" class="mt-4 text-center">
          <p class="text-sm font-medium text-erro">Tempo de reserva esgotado</p>
          <p class="mt-1 text-sm text-tinta-suave">
            Se você pagou nos últimos minutos, espere: a confirmação ainda pode chegar.
          </p>
        </div>

        <p v-if="!situacao?.final" class="mt-3 text-center text-sm text-tinta-suave">
          Assim que o pagamento cair, esta tela muda sozinha.
        </p>

        <!-- B13: a saída que não existia — trocar a forma de pagamento ou largar o pedido -->
        <button v-if="!situacao && !pagoSemIngresso && restante > 0" type="button"
                class="btn-secundario mt-4 w-full py-2.5" :disabled="desistindo" @click="trocarPagamento">
          {{ desistindo ? 'Cancelando este pedido…' : 'Trocar a forma de pagamento ou mudar os ingressos' }}
        </button>
        <!-- `div`, não `p`: o navegador fecha um `<p>` sozinho quando aparece
             bloco dentro, e o layout quebra sem avisar. -->
        <div v-if="pagoSemIngresso" class="faixa-aviso mt-3">
          <p class="font-semibold text-tinta">Recebemos o seu pagamento.</p>
          <p class="mt-1">
            Ele chegou depois do prazo da reserva e, nesse meio-tempo, os ingressos dessa opção
            foram vendidos. Você não precisa pagar de novo: a bilheteria vai resolver com você —
            outro ingresso ou a devolução do valor. Guarde o pedido
            <strong class="text-tinta">{{ pedido.pedido }}</strong>.
          </p>
        </div>
        <div v-else-if="erro" class="faixa-erro mt-3" role="alert">
          <p>{{ erro }}</p>
          <NuxtLink :to="`/e/${slug}`" class="mt-2 block font-semibold text-acao hover:underline">
            Escolher os ingressos de novo →
          </NuxtLink>
        </div>

        <!-- Só existe com o gateway de mentira; em produção nem é renderizado
             porque o checkout nunca devolve `simulado`. -->
        <div v-if="pedido.simulado" class="mt-6 rounded-card border border-dashed border-alerta bg-alerta-claro p-3 text-center">
          <p class="text-xs font-semibold uppercase text-alerta">Ambiente de teste</p>
          <button type="button" class="btn-secundario mt-2" :disabled="simulando"
                  @click="simularPagamento">
            {{ simulando ? 'Simulando…' : 'Simular pagamento recebido' }}
          </button>
        </div>
      </section>

      <!-- ----------------------------------------------------------- pago -->
      <section v-else>
        <div class="card border-ok/40 bg-ok-claro text-center">
          <span class="pago-pulo mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-ok text-white">
            <IconeMenu nome="check" :tamanho="26" />
          </span>
          <p class="text-xs font-semibold uppercase tracking-wide text-ok">
            {{ pedidoGratis ? 'Ingresso grátis' : 'Pagamento confirmado' }}
          </p>
          <h1 class="titulo mt-1 text-2xl font-semibold text-tinta">
            {{ pedidoGratis ? (ingressos.length === 1 ? 'Ingresso gerado' : 'Ingressos gerados') : 'Ingressos emitidos' }}
          </h1>
          <!--
            Diz "se não chegar", nunca "enviamos". Esta tela não sabe se o
            e-mail saiu: ela só viu `/api/pedido/:code` virar `pago`, e essa
            rota não consulta `email_sends`. Afirmar o envio é afirmar o que
            não foi conferido — e erra justamente nos casos em que a pessoa
            está olhando pra cá porque nada chegou (envio que terminou em
            `falhou`, worker parado, endereço com erro de digitação). É a mesma
            regra escrita por extenso em app/pages/ingressos/[code].vue; as
            duas telas precisam contar a mesma história, senão uma desmente a
            outra na mesma compra.
          -->
          <p class="mt-2 text-tinta-corpo">
            Pedido <span class="font-medium">{{ pedido.pedido }}</span>.
            O ingresso está logo abaixo e no link desta página — ele vale sozinho, sem depender
            de e-mail. Se a confirmação não chegar em
            <span class="font-medium break-all">{{ emailDaConfirmacao || 'seu e-mail' }}</span>, procure por
            <span class="font-medium">Conquista Park</span> no spam.
          </p>
        </div>

        <!-- O ingresso aparece AQUI, não só num link. Quem acabou de pagar
             quer ver o que comprou; mandar pro e-mail e torcer é o jeito mais
             comum de a bilheteria receber a ligação de "não chegou nada". -->
        <div v-if="ingressos.length" class="mt-4 space-y-3">
          <article v-for="(t, i) in ingressos" :key="t.id"
                   class="card flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
            <!--
              `eager`, não `lazy`. Este QR é o motivo de a pessoa estar aqui, e
              ele entra no DOM num `v-else` que só aparece DEPOIS de a consulta
              flipar pra pago — imagem preguiçosa nesse momento depende do
              observador de interseção rodar num bloco recém-inserido, e o que
              eu medi no navegador foi `complete: false` com o PNG respondendo
              200 e 3.979 bytes: quadrado vazio na tela de "deu certo", sem erro
              no console. São poucos QRs por pedido; adiar o único pixel que
              importa não economiza nada.
            -->
            <img v-if="t.qr" :src="`/api/ingresso/${t.id}/qr.png?pedido=${pedido.pedido}`"
                 :alt="`QR do ingresso ${t.codigo}`"
                 class="h-32 w-32 shrink-0 rounded-card border border-linha bg-white p-1"
                 loading="eager" decoding="async">
            <!-- sem QR = ingresso que não entra mais por este pedido (a API manda `qr: null`) -->
            <p v-else class="flex h-32 w-32 shrink-0 items-center justify-center rounded-card border border-linha p-2 text-center text-xs text-tinta-suave">
              {{ t.status === 'transferido' ? 'Ingresso transferido'
                 : t.status === 'usado' ? 'Ingresso já utilizado' : 'Ingresso cancelado' }}
            </p>
            <div class="min-w-0">
              <p class="titulo text-base font-semibold text-tinta">
                {{ t.tipo ?? 'Ingresso' }} {{ i + 1 }}/{{ ingressos.length }}
              </p>
              <p class="text-sm text-tinta-suave">
                {{ t.setor }}<template v-if="t.lote"> · {{ t.lote }}</template>
              </p>
              <p v-if="t.sessao" class="text-sm text-tinta-suave">{{ t.sessao }}</p>
              <p class="mt-2 font-mono text-sm font-medium tracking-wider text-tinta">{{ t.codigo }}</p>
            </div>
          </article>
        </div>

        <NuxtLink :to="`/ingressos/${pedido.pedido}`" class="btn-cta mt-4 w-full py-3">
          Ver e guardar meus ingressos
        </NuxtLink>
        <p class="mt-2 text-center text-xs text-tinta-fraca">
          Guarde o link desta página de ingressos: ele vale sozinho na portaria.
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* o ✓ do "Pagamento confirmado" chega com um pulo e uma onda (dono, 06/10: fechar o fluxo do cartão) */
.pago-pulo { position: relative; animation: pulo 0.6s cubic-bezier(0.2, 1.4, 0.4, 1) both; }
.pago-pulo::after {
  content: ''; position: absolute; inset: 0; border-radius: 9999px;
  box-shadow: 0 0 0 0 currentColor; color: rgb(22 163 74 / 0.45);
  animation: onda 1.1s 0.35s ease-out both;
}
@keyframes pulo { from { transform: scale(0.3); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes onda { from { box-shadow: 0 0 0 0 currentColor; } to { box-shadow: 0 0 0 18px transparent; } }
@media (prefers-reduced-motion: reduce) { .pago-pulo, .pago-pulo::after { animation: none; } }
</style>
