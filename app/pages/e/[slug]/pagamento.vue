<script setup lang="ts">
/**
 * Checkout: identificação + pagamento.
 *
 * Fica numa página só de propósito. Cada passo extra de wizard derruba
 * conversão, e aqui só há três blocos: quem é você, onde mora (o cadastro que o
 * parque guarda pra falar com quem compra) e como paga.
 *
 * Três coisas que esta tela NÃO faz, e o porquê:
 *
 *  1. **Não calcula preço.** O total que ela mostra antes de pagar é o que a
 *     vitrine trouxe; o total que ela mostra DEPOIS é o que o checkout gravou
 *     no pedido. Quando os dois divergem (lote virou, cupom entrou), ela diz
 *     isso em voz alta em vez de escolher um dos dois em silêncio.
 *  2. **Não guarda cartão.** Cartão vai pro ambiente do Asaas, que é quem tem
 *     PCI — daqui sai só o link da fatura.
 *  3. **Não decide se o PIX caiu.** Quem manda é o webhook; esta tela pergunta
 *     ao servidor de quatro em quatro segundos e obedece.
 */
import {
  carimboDePago, itensDoCheckout, destinoSemCarrinho, VERSAO_DO_CARRINHO,
  type LinhaDoPedido,
} from '~/composables/carrinhoDaVitrine'
import { MOTIVOS } from '~~/server/utils/meia-entrada'
import { UFS } from '~~/server/utils/cadastro'

const route = useRoute()
const slug = route.params.slug as string

/** `reais` vem de app/composables/formato.ts — uma formatação só no sistema. */

interface Carrinho {
  versao: number
  slug: string
  linhas: LinhaDoPedido[]
  totais: { face: number; taxa: number; total: number; n: number }
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
const etapa = ref<'dados' | 'cobranca' | 'pago'>('dados')
const erro = ref('')
const enviando = ref(false)

/**
 * O estado do cupom, num lugar só.
 *
 * Antes o comprador digitava o código e só descobria que ele não servia no
 * clique de pagar — depois de nome, e-mail, CPF e forma de pagamento. Código de
 * cupom vem de story, panfleto ou promoter: errar é o caso comum, e a hora de
 * saber é a hora de digitar. `POST /api/cupom/conferir` responde com a MESMA
 * régua do checkout (utils/cupom.ts), então o sim daqui não briga com o não de
 * lá.
 *
 * `nao_vale` cobre os dois caminhos que existem — a conferência prévia e o 409
 * do checkout — porque são a mesma notícia pro comprador e o mesmo lugar na
 * tela. Dois estados separados para a mesma frase é como as duas acabam
 * aparecendo juntas.
 *
 * `parcial` é o cupom conferido sem CPF: tudo confere menos "uma vez por
 * pessoa", que precisa do documento. A tela avisa em vez de prometer.
 */
const cupom = reactive({
  estado: 'vazio' as 'vazio' | 'conferindo' | 'vale' | 'nao_vale',
  recado: '',
  descontoCents: null as number | null,
  parcial: false,
})
const pedido = ref<any>(null)
const ingressos = ref<any[]>([])
const copiado = ref(false)
const restante = ref(0)
/** Preencheu quando o servidor cobrou um total diferente do que a tela prometeu. */
const avisoDePreco = ref('')
/** O pagamento entrou depois do prazo e o lugar já tinha sido vendido. */
const pagoSemIngresso = ref(false)

const form = reactive({ nome: '', email: '', documento: '', telefone: '', cupom: '' })

/**
 * O cadastro do cliente: o que o parque guarda pra falar com quem compra.
 *
 * FICA FORA de `form` DE PROPÓSITO. O `form` inteiro é gravado em sessionStorage
 * (`{ ...form }` em `pagar`) pra o F5 não perder a cobrança, e a senha nunca pode
 * ir parar lá — sessionStorage é legível por qualquer script da página.
 */
const cadastro = reactive({
  nascimento: '', instagram: '',
  cep: '', rua: '', numero: '', bairro: '', cidade: '', estado: '',
  senha: '', aceitaNovidades: false,
})
const verSenha = ref(false)
const buscandoCep = ref(false)
const avisoDeCep = ref('')
/** O `id` do campo que o servidor (ou esta tela) apontou — ganha contorno e foco. */
const campoComErro = ref('')
const marca = (campo: string) => (campoComErro.value === campo ? 'ring-2 ring-danger-600' : '')
const forma = ref<'pix' | 'credito'>('pix')
const parcelas = ref(1)

/**
 * Quantas parcelas cabem. O piso de R$ 5,00 por parcela é do Asaas: oferecer
 * 12× num pedido de R$ 33,00 é oferecer uma opção que o gateway recusa depois
 * de o comprador já ter escolhido.
 *
 * A porta (`server/api/checkout.post.ts`, `maxParcelas`) aplica a MESMA conta
 * e limita o que passar dela — o teste `checkout-parcelas.test.ts` compara o
 * piso daqui com o de lá.
 */
const PARCELA_MINIMA_CENTS = 500
const maxParcelas = computed(() => {
  const total = carrinho.value?.totais.total ?? 0
  return Math.max(1, Math.min(12, Math.floor(total / PARCELA_MINIMA_CENTS)))
})
const opcoesDeParcela = computed(() =>
  Array.from({ length: maxParcelas.value }, (_, i) => {
    const n = i + 1
    const total = carrinho.value?.totais.total ?? 0
    return { n, rotulo: n === 1 ? `À vista — ${reais(total)}` : `${n}× de ${reais(Math.ceil(total / n))}` }
  }))

onMounted(() => {
  // Pedido já criado nesta aba tem prioridade sobre o carrinho: recarregar a
  // página enquanto o PIX não cai é o gesto mais comum que existe aqui, e sem
  // isto ele jogava o comprador de volta pra vitrine com o lote já reservado
  // no nome dele — que é como se perde uma venda já feita.
  const cru = sessionStorage.getItem(CHAVE_PEDIDO)
  if (cru) {
    const p = JSON.parse(cru)
    if (p?.slug === slug && p?.pedido?.pedidoId) {
      pedido.value = p.pedido
      Object.assign(form, p.comprador ?? {})
      forma.value = p.pedido.pagamento?.forma === 'credito' ? 'credito' : 'pix'
      etapa.value = 'cobranca'
      comecarContagem(p.pedido.expiraEm)
      vigiarPagamento(p.pedido.pedidoId)
      conferirAgora(p.pedido.pedidoId)
      return
    }
    sessionStorage.removeItem(CHAVE_PEDIDO)
  }

  const bruto = sessionStorage.getItem(CHAVE_CARRINHO)
  if (!bruto) return void semCarrinho()
  const c = JSON.parse(bruto)
  // Carrinho de build antiga não tem a declaração de meia e morreria com 422
  // na última tela. Volta pra vitrine, onde ele se refaz em dois cliques.
  if (c?.versao !== VERSAO_DO_CARRINHO || c.slug !== slug || !c.linhas?.length) {
    sessionStorage.removeItem(CHAVE_CARRINHO)
    return void semCarrinho()
  }
  carrinho.value = c
})

/**
 * Chegou no pagamento sem nada pra pagar. Se esta aba acabou de comprar, o
 * lugar certo é o ingresso — não a vitrine.
 */
function semCarrinho() {
  let pago: any = null
  try { pago = JSON.parse(sessionStorage.getItem(CHAVE_PAGO) || 'null') }
  catch { /* chave estragada não pode impedir o desvio de acontecer */ }
  navigateTo(destinoSemCarrinho(slug, pago))
}

function mascaraCpf(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 11)
  return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2')
          .replace(/(\d{3})(\d{1,2})$/, '$1-$2')
}
function mascaraTel(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 11)
  if (d.length <= 10) return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d)/, '$1-$2')
  return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d)/, '$1-$2')
}
function mascaraData(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 8)
  return d.replace(/(\d{2})(\d)/, '$1/$2').replace(/(\d{2}\/\d{2})(\d)/, '$1/$2')
}
function mascaraCep(v: string) {
  return v.replace(/\D/g, '').slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2')
}

/** `25/12/1990` → `1990-12-25`; o que não tiver esse formato vira null (o servidor confere se a data existe). */
function nascimentoEmIso(texto: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto.trim())
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

/** Marca o campo, diz o que houve e leva o foco até ele (que rola a tela junto). */
function recusar(campo: string, recado: string) {
  campoComErro.value = campo
  erro.value = recado
  document.getElementById(campo)?.focus()
}

/**
 * Digitou o CEP inteiro: pergunta ao ViaCEP e preenche cidade, estado, rua e
 * bairro. CEP é conveniência — serviço fora do ar ou CEP que não existe NÃO
 * trava a compra, a pessoa digita o resto (mesmo desenho do formulário de
 * criação de evento no painel).
 */
async function buscarCep() {
  const cep = cadastro.cep.replace(/\D/g, '')
  avisoDeCep.value = ''
  if (cep.length !== 8) return
  buscandoCep.value = true
  try {
    const r: any = await $fetch(`https://viacep.com.br/ws/${cep}/json/`)
    // digitou outro CEP enquanto a resposta vinha: essa resposta é velha
    if (cadastro.cep.replace(/\D/g, '') !== cep) return
    if (r.erro) { avisoDeCep.value = 'Não achamos esse CEP. Preencha a cidade e o estado.'; return }
    cadastro.cidade = r.localidade || cadastro.cidade
    cadastro.estado = r.uf || cadastro.estado
    cadastro.rua = r.logradouro || cadastro.rua
    cadastro.bairro = r.bairro || cadastro.bairro
  } catch {
    avisoDeCep.value = 'Não deu pra buscar o CEP agora. Preencha o endereço abaixo.'
  } finally { buscandoCep.value = false }
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
 */
/** Os itens do carrinho como id + quantidade — nunca preço (ver `itensDoCheckout`). */
const itensCrus = () => (carrinho.value?.linhas ?? []).map((l) => ({
  lotId: l.loteId, ticketTypeId: l.tipoId ?? null, quantidade: l.quantidade,
}))

/**
 * Confere o cupom agora, sem cobrar nada.
 *
 * Chamada quando o comprador sai do campo do cupom e quando ele termina o CPF
 * (aí a conferência deixa de ser parcial). Não grava nada e não reserva o uso:
 * quem dá a palavra final continua sendo o checkout, com a linha do cupom
 * travada — por isso o recado de sucesso não promete, só informa.
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
        documento: form.documento.replace(/\D/g, '') || undefined,
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
 * O CPF acabou de ser preenchido: se há cupom no campo, vale reconferir.
 * A conferência sem CPF é parcial — "uma vez por pessoa" só dá pra responder
 * com o documento na mão, e é justamente esse o limite que mais recusa.
 */
function revisarCupomComCpf() {
  if (form.cupom.trim()) void conferirCupom()
}

async function pagar(semDeclaracao = false) {
  if (!carrinho.value) return
  erro.value = ''
  campoComErro.value = ''
  const nascimento = nascimentoEmIso(cadastro.nascimento)
  if (!nascimento) {
    return void recusar('nascimento', 'Confira a data de nascimento: dia, mês e ano (ex.: 25/12/1990).')
  }
  enviando.value = true
  try {
    const r = await $fetch<any>('/api/checkout', {
      method: 'POST',
      body: {
        eventSlug: slug,
        itens: itensDoCheckout(carrinho.value.linhas, { semDeclaracao }),
        comprador: {
          nome: form.nome.trim(),
          email: form.email.trim(),
          documento: form.documento.replace(/\D/g, ''),
          telefone: form.telefone.replace(/\D/g, '') || undefined,
          nascimento,
          instagram: cadastro.instagram.trim() || undefined,
          endereco: {
            cep: cadastro.cep.replace(/\D/g, '') || undefined,
            rua: cadastro.rua.trim() || undefined,
            numero: cadastro.numero.trim() || undefined,
            bairro: cadastro.bairro.trim() || undefined,
            cidade: cadastro.cidade.trim(),
            estado: cadastro.estado,
          },
          senha: cadastro.senha,
          // só manda quando marcou: desmarcado é "não disse nada", não "revogou"
          aceitaNovidades: cadastro.aceitaNovidades ? true : undefined,
        },
        cupom: form.cupom.trim() || undefined,
        forma: forma.value,
        parcelas: forma.value === 'credito' ? parcelas.value : 1,
      },
    })
    pedido.value = r
    cadastro.senha = ''
    conferirOPrecoCobrado(r)
    sessionStorage.removeItem(CHAVE_CARRINHO)

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

    // Guardado pra o F5 não perder a cobrança (ver onMounted).
    sessionStorage.setItem(CHAVE_PEDIDO, JSON.stringify({
      slug, pedido: r, comprador: { ...form },
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
    // Erro de cadastro fica no campo que o servidor apontou.
    if (tipo === 'cadastro') return void recusar(corpo.data.campo, recado)
    // Erro de cupom fica COLADO no campo do cupom, com o botão de seguir sem
    // ele. Numa faixa geral, o comprador relê o formulário inteiro procurando
    // o que errou.
    if (tipo === 'cupom') {
      Object.assign(cupom, { estado: 'nao_vale', recado, descontoCents: null, parcial: false })
    } else erro.value = recado
  } finally {
    enviando.value = false
  }
}

/** Tira o cupom recusado do caminho e tenta de novo, sem desconto. */
async function seguirSemCupom() {
  form.cupom = ''
  Object.assign(cupom, { estado: 'vazio', recado: '', descontoCents: null, parcial: false })
  await pagar()
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

let timerContagem: any, timerVigia: any
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
  if (carimbo) sessionStorage.setItem(CHAVE_PAGO, JSON.stringify(carimbo))
}

function aplicarEstado(r: any) {
  if (r.status === 'pago') {
    pedido.value = { ...pedido.value, ...r }
    ingressos.value = r.ingressos ?? []
    etapa.value = 'pago'
    sessionStorage.removeItem(CHAVE_PEDIDO)
    lembrarPago(r)
    pararRelogios()
  } else if (r.pagoSemIngresso) {
    // O dinheiro ENTROU e o lugar não voltou (PIX pago depois do prazo, com o
    // lote já vendido pra outra pessoa). "Expirou" aqui seria mentir pra quem
    // pagou — e mandaria a pessoa comprar de novo, pagando duas vezes.
    erro.value = ''
    pagoSemIngresso.value = true
    sessionStorage.removeItem(CHAVE_PEDIDO)
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
    sessionStorage.removeItem(CHAVE_PEDIDO)
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

function pararRelogios() { clearInterval(timerVigia); clearInterval(timerContagem) }
onUnmounted(pararRelogios)

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

useHead({ title: 'Pagamento' })
</script>

<template>
  <div class="min-h-screen">
    <CabecalhoPublico :para="`/e/${slug}`" largura="max-w-2xl" />

    <div class="mx-auto max-w-2xl px-4 py-6">
      <!-- ---------------------------------------------- dados do comprador -->
      <section v-if="etapa === 'dados'">
        <NuxtLink :to="`/e/${slug}`" class="text-sm text-acao hover:underline">← Voltar</NuxtLink>
        <h1 class="titulo mt-3 text-2xl font-semibold text-tinta">Finalizar compra</h1>

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
                {{ reais(l.unitTotalCents * l.quantidade) }}
              </span>
            </li>
          </ul>
          <div class="mt-3 flex items-baseline justify-between border-t border-linha pt-3">
            <span class="text-tinta-corpo">
              {{ carrinho.totais.n }} {{ carrinho.totais.n === 1 ? 'ingresso' : 'ingressos' }}
            </span>
            <span class="titulo text-2xl font-bold tabular-nums text-tinta">
              {{ reais(carrinho.totais.total) }}
            </span>
          </div>
          <p v-if="carrinho.totais.taxa" class="mt-1 text-right text-xs text-tinta-fraca">
            {{ reais(carrinho.totais.face) }} de ingressos + {{ reais(carrinho.totais.taxa) }} de taxa de serviço
          </p>
        </div>

        <form class="mt-5 space-y-4" @submit.prevent="pagar()">
          <div>
            <label for="nome" class="rotulo">Nome completo</label>
            <input id="nome" v-model="form.nome" required minlength="3" autocomplete="name" class="campo">
          </div>
          <div>
            <label for="email" class="rotulo">E-mail</label>
            <input id="email" v-model="form.email" type="email" required autocomplete="email" class="campo">
            <p class="mt-1 text-xs text-tinta-fraca">É pra onde vão os ingressos.</p>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label for="cpf" class="rotulo">CPF</label>
              <input id="cpf" :value="form.documento" required inputmode="numeric" class="campo tabular-nums"
                     autocomplete="off"
                     @input="form.documento = mascaraCpf(($event.target as HTMLInputElement).value)"
                     @blur="revisarCupomComCpf">
              <p class="mt-1 text-xs text-tinta-fraca">Vai impresso no ingresso.</p>
            </div>
            <div>
              <label for="tel" class="rotulo">Celular</label>
              <input id="tel" :value="form.telefone" inputmode="numeric" autocomplete="tel"
                     class="campo tabular-nums"
                     @input="form.telefone = mascaraTel(($event.target as HTMLInputElement).value)">
            </div>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label for="nascimento" class="rotulo">Data de nascimento</label>
              <!-- `autocomplete="off"` de propósito: o navegador preenche a data no formato
                   DELE, e a máscara daqui (dd/mm/aaaa) embaralharia o que chegasse pronto. -->
              <input id="nascimento" :value="cadastro.nascimento" required inputmode="numeric"
                     maxlength="10" placeholder="dd/mm/aaaa" autocomplete="off"
                     class="campo tabular-nums" :class="marca('nascimento')"
                     @input="cadastro.nascimento = mascaraData(($event.target as HTMLInputElement).value)">
            </div>
            <div>
              <label for="instagram" class="rotulo">
                Instagram <span class="font-normal text-tinta-fraca">(opcional)</span>
              </label>
              <input id="instagram" v-model="cadastro.instagram" placeholder="@seunome"
                     autocomplete="off" autocapitalize="none" class="campo" :class="marca('instagram')">
            </div>
          </div>

          <!-- ------------------------------------------------- onde mora -->
          <div class="border-t border-linha pt-4">
            <p class="titulo text-base font-semibold text-tinta">Onde você mora</p>
            <p class="mt-0.5 text-xs text-tinta-fraca">
              Ajuda o parque a saber de onde vem o público. Digite o CEP e o resto vem sozinho.
            </p>
          </div>
          <div class="grid grid-cols-[1fr_5.5rem] gap-4 sm:grid-cols-[9rem_1fr_6rem]">
            <div class="col-span-2 sm:col-span-1">
              <label for="cep" class="rotulo">CEP</label>
              <input id="cep" :value="cadastro.cep" inputmode="numeric" maxlength="9" placeholder="00000-000"
                     autocomplete="postal-code" class="campo tabular-nums" :class="marca('cep')"
                     @input="cadastro.cep = mascaraCep(($event.target as HTMLInputElement).value); buscarCep()">
            </div>
            <div>
              <label for="cidade" class="rotulo">Cidade</label>
              <input id="cidade" v-model="cadastro.cidade" required autocomplete="address-level2"
                     class="campo" :class="marca('cidade')">
            </div>
            <div>
              <label for="estado" class="rotulo">Estado</label>
              <select id="estado" v-model="cadastro.estado" required autocomplete="address-level1"
                      class="campo" :class="marca('estado')">
                <option value="" disabled>UF</option>
                <option v-for="uf in UFS" :key="uf" :value="uf">{{ uf }}</option>
              </select>
            </div>
          </div>
          <p v-if="buscandoCep" class="-mt-2 text-xs text-tinta-suave">Buscando o endereço…</p>
          <p v-else-if="avisoDeCep" class="-mt-2 text-xs text-tinta-suave">{{ avisoDeCep }}</p>
          <div class="grid grid-cols-[1fr_5.5rem] gap-4 sm:grid-cols-[1fr_7rem]">
            <div>
              <label for="rua" class="rotulo">
                Rua <span class="font-normal text-tinta-fraca">(opcional)</span>
              </label>
              <input id="rua" v-model="cadastro.rua" autocomplete="address-line1" class="campo">
            </div>
            <div>
              <label for="numero" class="rotulo">Número</label>
              <input id="numero" v-model="cadastro.numero" autocomplete="off" class="campo">
            </div>
          </div>
          <div>
            <label for="bairro" class="rotulo">
              Bairro <span class="font-normal text-tinta-fraca">(opcional)</span>
            </label>
            <input id="bairro" v-model="cadastro.bairro" autocomplete="off" class="campo">
          </div>

          <!-- --------------------------------------------------- a conta -->
          <div class="border-t border-linha pt-4">
            <p class="titulo text-base font-semibold text-tinta">Sua conta</p>
          </div>
          <div>
            <label for="senha" class="rotulo">Crie uma senha</label>
            <div class="relative">
              <input id="senha" v-model="cadastro.senha" :type="verSenha ? 'text' : 'password'" required
                     minlength="8" maxlength="72" autocomplete="new-password"
                     class="campo pr-24" :class="marca('senha')">
              <button type="button"
                      class="absolute inset-y-0 right-3.5 text-sm font-semibold text-acao hover:underline"
                      @click="verSenha = !verSenha">
                {{ verSenha ? 'Ocultar' : 'Mostrar' }}
              </button>
            </div>
            <p class="mt-1 text-xs text-tinta-fraca">
              Pelo menos 8 caracteres. Guardamos só uma versão codificada dela.
            </p>
          </div>
          <label class="flex items-start gap-2.5 text-sm text-tinta-corpo">
            <input v-model="cadastro.aceitaNovidades" type="checkbox" class="mt-1 h-4 w-4 accent-pool-600">
            <span>Quero receber novidades e ofertas do parque por WhatsApp, e-mail e Instagram.</span>
          </label>

          <div>
            <label for="cupom" class="rotulo">Cupom (opcional)</label>
            <!-- `@blur` e não `@input`: conferir a cada tecla mandaria uma
                 requisição por letra e diria "não encontramos o cupom ZZB"
                 enquanto a pessoa ainda digita ZZBOM. -->
            <input id="cupom" v-model="form.cupom" class="campo uppercase" autocomplete="off"
                   :class="cupom.estado === 'nao_vale' ? 'border-erro' : ''"
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
                O limite de uso por CPF é conferido quando você preencher o CPF.
              </p>
            </div>
            <!-- O recado do cupom mora COLADO no campo, e vem com a saída:
                 sem o botão, quem digitou um cupom vencido fica preso — o
                 formulário inteiro está certo e o botão de pagar não passa. -->
            <div v-else-if="cupom.estado === 'nao_vale'" class="faixa-erro mt-2">
              <p>{{ cupom.recado }}</p>
              <button type="button" class="btn-secundario mt-2 w-full py-2" :disabled="enviando"
                      @click="seguirSemCupom">
                Continuar sem o cupom
              </button>
            </div>
          </div>

          <!-- ------------------------------------------ forma de pagamento -->
          <div>
            <span class="rotulo">Como você quer pagar</span>
            <div class="flex flex-wrap gap-2">
              <button type="button" :class="forma === 'pix' ? 'chip-ativo' : 'chip'"
                      @click="forma = 'pix'">PIX — na hora</button>
              <button type="button" :class="forma === 'credito' ? 'chip-ativo' : 'chip'"
                      @click="forma = 'credito'">Cartão de crédito</button>
            </div>
            <div v-if="forma === 'credito'" class="mt-3">
              <label for="parcelas" class="rotulo">Parcelas</label>
              <select id="parcelas" v-model.number="parcelas" class="campo">
                <option v-for="o in opcoesDeParcela" :key="o.n" :value="o.n">{{ o.rotulo }}</option>
              </select>
              <p class="mt-1 text-xs text-tinta-fraca">
                Os dados do cartão são digitados no ambiente do Asaas — eles não passam por aqui.
              </p>
            </div>
          </div>

          <p v-if="erro" class="faixa-erro">{{ erro }}</p>

          <button type="submit" :disabled="enviando" class="btn-cta w-full py-3">
            <template v-if="enviando">Gerando cobrança…</template>
            <template v-else-if="forma === 'pix'">Pagar com PIX</template>
            <template v-else>Pagar com cartão</template>
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
          Cupom aplicado: −{{ reais(pedido.descontoCents) }}
        </p>
        <p v-if="avisoDePreco" class="faixa-aviso mt-3">{{ avisoDePreco }}</p>

        <!-- PIX -->
        <div v-if="ehPix" class="card mt-4 text-center">
          <img v-if="pedido.pagamento?.pixQrBase64"
               :src="`data:image/png;base64,${pedido.pagamento.pixQrBase64}`"
               alt="QR Code do PIX" class="mx-auto h-56 w-56 max-w-full">
          <p v-else class="py-8 text-sm text-tinta-suave">
            O QR está sendo gerado. Use o código copia e cola abaixo.
          </p>

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
        <div v-else class="card mt-4">
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

        <!-- o relógio da reserva vale pros dois meios de pagamento -->
        <p v-if="restante > 0" class="mt-4 text-center text-sm text-tinta-suave">
          Seus ingressos estão reservados por
          <span class="font-semibold tabular-nums text-acao">{{ relogio }}</span>
        </p>
        <div v-else class="mt-4 text-center">
          <p class="text-sm font-medium text-erro">Tempo de reserva esgotado</p>
          <p class="mt-1 text-sm text-tinta-suave">
            Se você pagou nos últimos minutos, espere: a confirmação ainda pode chegar.
          </p>
        </div>

        <p class="mt-3 text-center text-sm text-tinta-suave">
          Assim que o pagamento cair, esta tela muda sozinha.
        </p>
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
        <div v-else-if="erro" class="faixa-erro mt-3">
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
          <span class="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-ok text-white">
            <IconeMenu nome="check" :tamanho="26" />
          </span>
          <p class="text-xs font-semibold uppercase tracking-wide text-ok">Pagamento confirmado</p>
          <h1 class="titulo mt-1 text-2xl font-semibold text-tinta">Ingressos emitidos</h1>
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
            <span class="font-medium break-all">{{ form.email }}</span>, procure por
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
