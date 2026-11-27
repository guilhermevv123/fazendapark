<script setup lang="ts">
/**
 * O tablet do atendente (055). Dois jeitos de começar, os dois terminam no MESMO "confirmar":
 *
 * 1. **Pedido primeiro**: "Novo pedido" → escolhe os itens → encosta a pulseira → confere o
 *    NOME na tela com o cliente → Confirmar.
 * 2. **Pulseira primeiro**: encosta a pulseira na tela inicial → aparece o menu dela:
 *    Adicionar pedido · Ver conta · Fechar conta · Voltar.
 *
 * Sem internet: a pulseira é reconhecida pela cópia guardada no tablet e o pedido vai pra
 * fila (`comandaOffline.ts`) — sobe sozinho quando a rede volta, uma vez só.
 * Depois de confirmar, o atendente tem alguns minutos pra desfazer (o prazo vem do gerente).
 */
import { bip, useLeitorDePulseira } from '~/composables/comandaLeitor'
import {
  chamar, contaDaPulseiraGuardada, ehFaltaDeRede, enfileirar, estado, faixaLarga, mensagemDoErro, noAppDoTablet, novoIdLocal, online, sincronizar,
  type ContaGuardada,
} from '~/composables/comandaOffline'
import { dataHora, reais } from '~/composables/formato'
import { iconeDaCategoria, iconeDoItem } from '~/composables/comandaIcones'
import ComandaIcone from '~/components/comanda/Icone.vue'
import FotoDoItem from '~/components/comanda/FotoDoItem.vue'
import ComandaAbrirConta from '~/components/comanda/AbrirConta.vue'
import ComandaConta from '~/components/comanda/Conta.vue'
import ComandaPagamento from '~/components/comanda/Pagamento.vue'


type Tela = 'inicio' | 'menu' | 'cardapio' | 'identificar' | 'ler' | 'confirmar' | 'feito' | 'cancelado' | 'conta' | 'abrir' | 'fechar' | 'pago'
const tela = ref<Tela>('inicio')
watch(tela, (t) => { faixaLarga.value = t === 'cardapio' }, { immediate: true })
onBeforeUnmount(() => { faixaLarga.value = false })
const erro = ref('')
const carregando = ref(false)

/* ------------------------------------------------------------------ a pulseira lida */

interface Leitura {
  uid: string
  tipo: string // em_uso | livre | nao_cadastrada | bloqueada | descartada
  conta: (ContaGuardada & { faltaCents?: number; pagoCents?: number; abertaEm?: string; responsavelTelefone?: string | null }) | null
  grupo: any[]
  podeFechar: boolean
  daCopia: boolean // sem internet: veio da cópia guardada
  motivo?: string | null
  nova?: boolean // cadastrada agora, na primeira leitura
}
const lida = ref<Leitura | null>(null)

async function lerPulseira(uid: string): Promise<Leitura> {
  try {
    const r = await chamar<any>(`/api/comandas/pulseira/${encodeURIComponent(uid)}`)
    return { uid, tipo: r.tipo, conta: r.conta ?? null, grupo: r.grupo ?? [], podeFechar: !!r.podeFechar, daCopia: false, motivo: r.motivo, nova: !!r.nova }
  } catch (e) {
    if (!ehFaltaDeRede(e)) throw e
    online.value = false
    const c = contaDaPulseiraGuardada(uid)
    return { uid, tipo: c ? 'em_uso' : 'desconhecida', conta: c, grupo: [], podeFechar: false, daCopia: true }
  }
}

const SITUACAO_RUIM: Record<string, string> = {
  bloqueada: 'Esta pulseira está BLOQUEADA (foi dada como perdida). Recolha e chame o caixa.',
  descartada: 'Esta pulseira foi descartada. Recolha e entregue outra pulseira.',
  desconhecida: 'Sem internet e esta pulseira não tem conta na cópia do tablet. Abrir conta precisa de internet.',
}

async function aoLer(uid: string) {
  if (!['inicio', 'ler', 'menu', 'feito', 'cancelado', 'pago'].includes(tela.value)) return
  erro.value = ''
  carregando.value = true
  try {
    const l = await lerPulseira(uid)
    lida.value = l
    bip(l.tipo === 'em_uso' || ['livre', 'nao_cadastrada'].includes(l.tipo) ? 'ok' : 'erro')
    if (tela.value === 'ler') {
      // pedido primeiro: com conta vai direto pro confirmar
      if (['em_uso', 'livre', 'nao_cadastrada'].includes(l.tipo)) { tela.value = 'confirmar'; pin.value = ''; precisaPin.value = '' }
      else tela.value = 'menu'
      return
    }
    tela.value = 'menu'
  } catch (e) {
    bip('erro')
    erro.value = mensagemDoErro(e)
  } finally { carregando.value = false }
}
useLeitorDePulseira(aoLer)


/* ------------------------------------------------------------------ o carrinho */

const categoria = ref<string>('')
const carrinho = ref<{ itemId: string; nome: string; precoCents: number; quantidade: number; maior18: boolean }[]>([])
const mesa = ref('')
const clienteNome = ref('')
/** "12" vira "Mesa 12"; "Quiosque 3" fica como está */
const mesaTexto = computed(() => /^\d+$/.test(mesa.value.trim()) ? `Mesa ${mesa.value.trim()}` : mesa.value.trim())
const campoNome = ref<HTMLInputElement | null>(null)
const observacao = ref('')
const pontoId = ref<string>('')
onMounted(() => {
  try { pontoId.value = localStorage.getItem('dt_comanda_ponto') ?? '' } catch { /* sem storage */ }
})
watch(pontoId, (v) => { try { localStorage.setItem('dt_comanda_ponto', v) } catch { /* sem storage */ } })

const pontoAtual = computed(() => estado.value?.pontos.find((p) => p.id === pontoId.value) ?? null)
/** o dono prendeu esta pessoa a local(is) (056): a lista já vem só com eles; com um só, ele vem marcado */
const pontoFixo = computed(() => !!estado.value?.eu.pontoFixo)
watch(() => [pontoFixo.value, pontoId.value, estado.value?.pontos.map((p) => p.id).join(',')] as const, () => {
  const lista = estado.value?.pontos ?? []
  if (!pontoFixo.value || !lista.length) return
  if (!lista.some((p) => p.id === pontoId.value)) pontoId.value = lista[0]!.id
}, { immediate: true })

// Divide os locais em linhas do mesmo tamanho (5 = 3+2, 4 = 2+2, 7 = 4+3), sem buraco no fim.
function porLinha(n: number, max: number): number[] {
  if (!n) return []
  const linhas = Math.ceil(n / max)
  const base = Math.floor(n / linhas)
  const sobra = n % linhas
  const tamanhos: number[] = []
  for (let l = 0; l < linhas; l++) {
    const k = base + (l < sobra ? 1 : 0)
    for (let i = 0; i < k; i++) tamanhos.push(k)
  }
  return tamanhos
}
const larguraDoLocal = computed(() => {
  const n = estado.value?.pontos.length ?? 0
  const celular = porLinha(n, 2)
  const grande = porLinha(n, n <= 8 ? 4 : 5)
  const largura = (k: number) => `calc((100% - ${(k - 1) * 0.5}rem) / ${k})`
  return celular.map((k, i) => ({ '--l': largura(k), '--l-sm': largura(grande[i]) }))
})
/**
 * As categorias do Novo pedido ("Tudo" + as do local), em linhas iguais do tablet pra cima.
 * Quantas cabem por linha sai da largura de verdade da faixa (cada botão precisa de ~150px),
 * medida ao vivo: o mesmo cardápio fica certo no tablet em pé, deitado e no computador.
 */
const faixaCategorias = ref<HTMLElement | null>(null)
const larguraDaFaixa = ref(0)
let medidor: ResizeObserver | null = null
watch(faixaCategorias, (el) => {
  medidor?.disconnect()
  if (!el) return
  // no próximo quadro e só se a largura mudou: senão o próprio rearranjo dispara outra medida (laço)
  medidor = new ResizeObserver(([e]) => {
    const w = Math.round(e?.contentRect.width ?? 0)
    if (w !== larguraDaFaixa.value) requestAnimationFrame(() => { larguraDaFaixa.value = w })
  })
  medidor.observe(el)
})
onBeforeUnmount(() => medidor?.disconnect())
const larguraDaCategoria = computed(() => {
  const n = (categoriasDoLocal.value?.length ?? 0) + 1
  const cabem = Math.max(1, Math.floor((larguraDaFaixa.value + 8) / (150 + 8)))
  const largura = (k: number) => `calc((100% - ${(k - 1) * 0.5}rem) / ${k})`
  return porLinha(n, cabem).map((k) => ({ '--l-sm': largura(k) }))
})
/** o que ESTE local vende (o gerente escolhe em Gestão → Configurações → Locais de venda); sem local, tudo */
const categoriasDoLocal = computed(() => {
  const todas = estado.value?.categorias ?? []
  const so = pontoAtual.value?.categorias
  return so ? todas.filter((c) => so.includes(c.id)) : todas
})
const buscaItem = ref('')
const itensVisiveis = computed(() => {
  const ids = new Set(categoriasDoLocal.value.map((c) => c.id))
  const b = buscaItem.value.trim().toLowerCase()
  return (estado.value?.itens ?? []).filter((i) => ids.has(i.categoriaId)
    && (b ? i.nome.toLowerCase().includes(b) : !categoria.value || i.categoriaId === categoria.value))
})
/** os produtos separados por categoria, na ordem do cardápio (em "Tudo" cada uma ganha um título) */
const gruposVisiveis = computed(() => categoriasDoLocal.value
  .map((c) => ({ ...c, icone: iconeDaCategoria(c), itens: itensVisiveis.value.filter((i) => i.categoriaId === c.id) }))
  .filter((g) => g.itens.length))
const catDoItem = (id: string) => estado.value?.categorias.find((c) => c.id === id)
const iconeDe = (i: { nome: string; icone?: string | null; categoriaId: string }) => iconeDoItem(i, catDoItem(i.categoriaId))
const qtdNoCarrinho = (id: string) => carrinho.value.find((c) => c.itemId === id)?.quantidade ?? 0
watch(pontoId, () => { categoria.value = '' })

/* locais de venda: o gerente cria, renomeia e exclui num painel, sem sair do tablet */
const gerindoLocais = ref(false)
const novoLocal = ref('')
const renomeando = ref<{ id: string; nome: string } | null>(null)
const excluindo = ref<{ id: string; nome: string } | null>(null)
const erroLocal = ref('')
const salvandoLocal = ref(false)
function abrirLocais() { gerindoLocais.value = true; novoLocal.value = ''; renomeando.value = null; excluindo.value = null; erroLocal.value = '' }
async function salvarLocal(corpo: Record<string, unknown>, depois: (r: any) => void) {
  erroLocal.value = ''
  salvandoLocal.value = true
  try {
    const r = await chamar<any>('/api/comandas/cardapio', { method: 'POST', body: { tipo: 'ponto', ...corpo } })
    await sincronizar()
    depois(r)
  } catch (e) { erroLocal.value = mensagemDoErro(e) } finally { salvandoLocal.value = false }
}
const criarLocal = () => salvarLocal({ nome: novoLocal.value.trim() }, (r) => { pontoId.value = r.id; novoLocal.value = '' })
const renomearLocal = () => renomeando.value && salvarLocal({ id: renomeando.value.id, nome: renomeando.value.nome.trim() }, () => { renomeando.value = null })
const excluirLocal = () => excluindo.value && salvarLocal({ id: excluindo.value.id, excluir: true }, () => {
  if (pontoId.value === excluindo.value?.id) pontoId.value = ''
  excluindo.value = null
})
const totalCarrinho = computed(() => carrinho.value.reduce((s, i) => s + i.precoCents * i.quantidade, 0))
const qtdCarrinho = computed(() => carrinho.value.reduce((s, i) => s + i.quantidade, 0))

function por(item: { id: string; nome: string; precoCents: number; maior18: boolean; esgotado: boolean }) {
  if (item.esgotado) return
  const l = carrinho.value.find((c) => c.itemId === item.id)
  if (l) l.quantidade++
  else carrinho.value.push({ itemId: item.id, nome: item.nome, precoCents: item.precoCents, quantidade: 1, maior18: item.maior18 })
}
function tirar(itemId: string) {
  const l = carrinho.value.find((c) => c.itemId === itemId)
  if (!l) return
  l.quantidade--
  if (l.quantidade <= 0) carrinho.value = carrinho.value.filter((c) => c.itemId !== itemId)
}
function limparPedido() {
  carrinho.value = []
  mesa.value = ''
  clienteNome.value = ''
  observacao.value = ''
  buscaItem.value = ''
}

const semLocal = () => {
  if (pontoAtual.value) return false
  erro.value = 'Escolha primeiro, lá em cima, o local de venda deste tablet.'
  bip('erro')
  return true
}
function novoPedido() {
  if (semLocal()) { tela.value = 'inicio'; return }
  limparPedido()
  lida.value = null
  tela.value = 'cardapio'
}
function adicionarNaConta() {
  if (semLocal()) { tela.value = 'inicio'; return }
  limparPedido()
  tela.value = 'cardapio'
}
/** Itens escolhidos → pede o NOME do cliente (obrigatório) e a mesa (opcional), antes da pulseira. */
function continuar() {
  if (!carrinho.value.length) return
  tela.value = 'identificar'
  nextTick(() => campoNome.value?.focus())
}
function identificado() {
  if (clienteNome.value.trim().length < 2) return
  pin.value = ''
  precisaPin.value = ''
  tela.value = lida.value && ['em_uso', 'livre', 'nao_cadastrada'].includes(lida.value.tipo) ? 'confirmar' : 'ler'
}
function voltarInicio() {
  lida.value = null
  limparPedido()
  erro.value = ''
  tela.value = 'inicio'
}

/* ------------------------------------------------------------------ confirmar */

const pin = ref('')
const precisaPin = ref('')
const avisosConfirmar = computed(() => {
  const c = lida.value?.conta
  if (!c) return []
  const a: string[] = []
  const novoTotal = c.totalCents + totalCarrinho.value
  if (c.menorDeIdade && carrinho.value.some((i) => i.maior18)) a.push('Pulseira de MENOR DE 18: tem bebida alcoólica no pedido.')
  if (c.limiteCents && novoTotal > c.limiteCents) a.push(`Passa do limite da conta (${reais(c.limiteCents)}).`)
  if (estado.value?.config.avisoContaAltaCents && novoTotal > estado.value.config.avisoContaAltaCents) a.push(`Conta alta: vai a ${reais(novoTotal)}.`)
  return a
})

interface Feito { idLocal: string; lancamentoId?: string; nome: string; valorCents: number; totalCents?: number; naFila: boolean; em: Date; resumo: string }
const cancelando = ref(false)
const cancelado = ref<Feito | null>(null)
const feito = ref<Feito | null>(null)
const enviando = ref(false)

const resumoCarrinho = () => carrinho.value.map((i) => `${i.quantidade}× ${i.nome}`).join(', ')
  + (clienteNome.value.trim() ? ` — para ${clienteNome.value.trim()}${mesaTexto.value ? `, ${mesaTexto.value}` : ''}` : '')

async function confirmar() {
  const l = lida.value
  if (!l || !carrinho.value.length || enviando.value) return
  erro.value = ''
  enviando.value = true
  if (!l.conta) {
    if (!online.value || l.daCopia) {
      enviando.value = false
      erro.value = 'Sem internet: pulseira nova só abre conta com internet. Use uma pulseira que já tem conta ou espere a internet voltar.'
      return
    }
    try {
      const r = await chamar<any>('/api/comandas/abrir', { method: 'POST', body: { modo: 'rapido', uid: l.uid, nome: clienteNome.value.trim(), pontoId: pontoId.value || null } })
      l.conta = r.conta
      l.tipo = 'em_uso'
    } catch (e) {
      enviando.value = false
      bip('erro')
      erro.value = mensagemDoErro(e)
      return
    }
  }
  const pedido = {
    idLocal: novoIdLocal(), uid: l.uid, comandaId: l.conta.id,
    itens: carrinho.value.map((i) => ({ itemId: i.itemId, quantidade: i.quantidade })),
    mesa: mesaTexto.value || null, cliente: clienteNome.value.trim() || null, observacao: observacao.value || null, pontoId: pontoId.value || null,
    feitoEm: new Date().toISOString(), pin: pin.value || null,
  }
  const guardarNaFila = () => {
    enfileirar({
      pedido: { ...pedido, pin: undefined, semInternet: true } as any, nome: l.conta!.nome, valorCents: totalCarrinho.value,
      resumo: carrinho.value.map((i) => `${i.quantidade}× ${i.nome}`).join(', '), tentativas: 0,
    })
    feito.value = { idLocal: pedido.idLocal, nome: l.conta!.nome, valorCents: totalCarrinho.value, naFila: true, em: new Date(), resumo: resumoCarrinho() }
    cancelando.value = false
    bip('ok')
    tela.value = 'feito'
  }
  try {
    if (l.daCopia || !online.value) { guardarNaFila(); return }
    const r = await chamar<{ resultados: any[] }>('/api/comandas/pedidos', { method: 'POST', body: { pedidos: [pedido] } })
    const res = r.resultados[0]
    if (!res.ok) {
      bip('erro')
      if (['limite', 'menor_de_idade'].includes(res.codigo)) { precisaPin.value = res.mensagem; return }
      erro.value = res.mensagem
      return
    }
    feito.value = { idLocal: pedido.idLocal, lancamentoId: res.lancamentoId, nome: res.nome, valorCents: totalCarrinho.value, totalCents: res.totalCents, naFila: false, em: new Date(), resumo: resumoCarrinho() }
    cancelando.value = false
    bip('ok')
    tela.value = 'feito'
    sincronizar().catch(() => {})
  } catch (e) {
    if (ehFaltaDeRede(e)) { online.value = false; guardarNaFila(); return }
    bip('erro')
    erro.value = mensagemDoErro(e)
  } finally { enviando.value = false }
}

/* ------------------------------------------------------------------ desfazer */

const agora = ref(Date.now())
let tique: ReturnType<typeof setInterval> | undefined
onMounted(() => { tique = setInterval(() => { agora.value = Date.now() }, 1000) })
onBeforeUnmount(() => clearInterval(tique))
const segundosParaDesfazer = computed(() => {
  if (!feito.value) return 0
  const prazo = (estado.value?.config.minutosParaDesfazer ?? 5) * 60
  return Math.max(0, prazo - Math.floor((agora.value - feito.value.em.getTime()) / 1000))
})

async function desfazer() {
  if (!feito.value) return
  erro.value = ''
  if (feito.value.naFila) {
    // ainda não subiu: tira da fila do próprio tablet
    try {
      const fila = JSON.parse(localStorage.getItem('dt_comanda_fila') ?? '[]')
      const resta = fila.filter((f: any) => f.pedido.idLocal !== feito.value!.idLocal)
      if (resta.length !== fila.length) {
        localStorage.setItem('dt_comanda_fila', JSON.stringify(resta))
        cancelado.value = feito.value
        feito.value = null
        tela.value = 'cancelado'
        return
      }
    } catch { /* cai no servidor */ }
  }
  try {
    await chamar(`/api/comandas/pedidos/${feito.value.lancamentoId ?? feito.value.idLocal}/desfazer`, { method: 'POST', body: { motivo: 'cancelado pelo atendente logo depois de lançar' } })
    cancelado.value = feito.value
    feito.value = null
    tela.value = 'cancelado'
    sincronizar().catch(() => {})
  } catch (e) { erro.value = mensagemDoErro(e) }
}

/* ------------------------------------------------------------------ fechar */

const aPagar = ref<{ id: string; numero: number; nome: string; faltaCents: number }[]>([])
const troco = ref(0)
function irFechar(conta?: any, grupo: any[] = []) {
  const c = conta ?? lida.value?.conta
  if (!c) return
  aPagar.value = [{ id: c.id, numero: c.numero, nome: c.nome, faltaCents: c.faltaCents ?? c.totalCents }]
  grupoParaJuntar.value = grupo.filter((g: any) => g.id !== c.id && g.situacao === 'aberta' && g.faltaCents > 0)
  tela.value = 'fechar'
}
const grupoParaJuntar = ref<any[]>([])
function pagarGrupoJunto() {
  aPagar.value = [...aPagar.value, ...grupoParaJuntar.value.map((g) => ({ id: g.id, numero: g.numero, nome: g.nome, faltaCents: g.faltaCents }))]
  grupoParaJuntar.value = []
}
async function fecharSemValor() {
  const c = aPagar.value[0]
  try {
    await chamar(`/api/comandas/conta/${c.id}/pagar`, { method: 'POST', body: { pagamentos: [], fechar: true } })
    troco.value = 0
    tela.value = 'pago'
  } catch (e) { erro.value = mensagemDoErro(e) }
}
function pago(r: { trocoCents: number }) {
  troco.value = r.trocoCents
  bip('ok')
  tela.value = 'pago'
  sincronizar().catch(() => {})
}

/* ------------------------------------------------------------------ conta aberta agora */

function contaAberta(conta: any) {
  bip('ok')
  lida.value = { uid: lida.value!.uid, tipo: 'em_uso', conta, grupo: [], podeFechar: false, daCopia: false }
  sincronizar().catch(() => {})
  tela.value = carrinho.value.length ? 'confirmar' : 'menu'
}

const grupoDe = (l: Leitura | null) => l?.conta && l.conta.nome !== l.conta.responsavelNome ? l.conta.responsavelNome : ''
</script>

<template>
  <!-- o cardápio usa a largura toda (alinhado com a faixa de cima); as outras telas ficam no meio -->
  <div :class="tela === 'cardapio' ? 'w-full' : 'mx-auto max-w-4xl'">
    <p v-if="erro" class="faixa-erro mb-4" data-parte="erro">{{ erro }}</p>

    <!-- INÍCIO -->
    <section v-if="tela === 'inicio'" class="space-y-4">
      <div class="card p-5" data-parte="ponto-de-venda">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p class="text-xs font-bold uppercase tracking-wider text-ink-600">Ponto de venda</p>
            <p class="titulo mt-0.5 text-lg font-semibold">{{ pontoAtual?.nome ?? 'Onde este tablet atende?' }}</p>
          </div>
          <div class="flex items-center gap-2">
            <span v-if="pontoFixo" class="selo-neutro">Definido pelo dono</span>
            <span v-else-if="pontoAtual" class="selo-ok">Selecionado</span>
            <span v-else class="selo-alerta">Escolha um</span>
            <button v-if="estado?.eu.nivel === 'gerente'" type="button" data-acao="gerenciar-locais" class="btn-secundario px-3 py-1.5 text-sm"
                    @click="abrirLocais">Gerenciar locais</button>
          </div>
        </div>
        <div v-if="!pontoFixo || (estado?.pontos.length ?? 0) > 1" class="mt-4 flex flex-wrap gap-2">
          <button v-for="(p, i) in estado?.pontos" :key="p.id" type="button" :style="larguraDoLocal[i]"
                  class="flex min-h-[52px] shrink-0 grow-0 basis-[var(--l)] items-center justify-center gap-2 rounded-card border px-3 text-center text-sm font-semibold transition sm:basis-[var(--l-sm)]"
                  :class="pontoId === p.id ? 'border-acao bg-acao text-white' : 'border-linha bg-white text-ink-800 hover:border-acao'"
                  @click="pontoId = p.id">
            <svg v-if="pontoId === p.id" viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M20 6L9 17l-5-5" /></svg>
            {{ p.nome }}
          </button>
        </div>
        <p v-if="!estado?.pontos.length" class="mt-3 text-sm text-ink-600">Nenhum local cadastrado. Toque em "Gerenciar locais" para criar.</p>
      </div>

      <ModalLateral v-if="gerindoLocais" titulo="Locais de venda" @fechar="gerindoLocais = false">
        <div class="space-y-6">
          <form class="space-y-2" @submit.prevent="criarLocal">
            <label class="rotulo" for="novo-local">Adicionar local</label>
            <div class="flex gap-2">
              <input id="novo-local" v-model="novoLocal" class="campo flex-1" placeholder="Ex.: Quiosque da piscina" maxlength="60">
              <button type="submit" class="btn-primario" :disabled="!novoLocal.trim() || salvandoLocal">Adicionar</button>
            </div>
            <p class="text-xs text-ink-600">O local novo vende tudo do cardápio. Para escolher o que ele vende, use Gestão → Configurações → Locais de venda.</p>
          </form>

          <div>
            <p class="rotulo">Locais cadastrados ({{ estado?.pontos.length ?? 0 }})</p>
            <ul class="mt-2 divide-y divide-linha rounded-card border border-linha">
              <li v-for="p in estado?.pontos" :key="p.id" class="p-3">
                <!-- renomear -->
                <form v-if="renomeando?.id === p.id" class="flex gap-2" @submit.prevent="renomearLocal">
                  <input v-model="renomeando.nome" class="campo flex-1" maxlength="60" aria-label="Novo nome do local">
                  <button type="button" class="btn-secundario px-3" @click="renomeando = null">Cancelar</button>
                  <button type="submit" class="btn-primario px-3" :disabled="!renomeando.nome.trim() || salvandoLocal">Salvar</button>
                </form>
                <!-- confirmar exclusão -->
                <div v-else-if="excluindo?.id === p.id" class="space-y-2">
                  <p class="text-sm"><b>Excluir {{ p.nome }}?</b> Ele some dos tablets. As vendas que já foram feitas nele continuam nos relatórios.</p>
                  <div class="flex justify-end gap-2">
                    <button type="button" class="btn-secundario px-3" @click="excluindo = null">Não</button>
                    <button type="button" class="btn-primario bg-danger-600 px-3 hover:bg-danger-600" :disabled="salvandoLocal" @click="excluirLocal">Sim, excluir</button>
                  </div>
                </div>
                <div v-else class="flex items-center justify-between gap-2">
                  <span class="font-semibold text-ink-900">{{ p.nome }}<span v-if="pontoId === p.id" class="ml-2 text-xs font-normal text-acao">este tablet</span></span>
                  <span class="flex gap-1">
                    <button type="button" class="rounded-card px-3 py-1.5 text-sm font-semibold text-acao hover:bg-acao-claro"
                            @click="renomeando = { id: p.id, nome: p.nome }; excluindo = null">Renomear</button>
                    <button type="button" class="rounded-card px-3 py-1.5 text-sm font-semibold text-danger-600 hover:bg-ink-50"
                            @click="excluindo = { id: p.id, nome: p.nome }; renomeando = null">Excluir</button>
                  </span>
                </div>
              </li>
            </ul>
          </div>
          <p v-if="erroLocal" class="faixa-erro">{{ erroLocal }}</p>
        </div>
      </ModalLateral>
      <div class="card flex flex-col items-center gap-2 px-6 py-8 text-center">
        <div class="flex h-16 w-16 items-center justify-center rounded-full bg-acao-claro text-acao" :class="carregando ? 'animate-pulse' : ''">
          <svg viewBox="0 0 24 24" class="h-8 w-8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 8.3a6 6 0 010 7.4M9.5 6a10 10 0 010 12M13 3.8a14 14 0 010 16.4" /></svg>
        </div>
        <p class="titulo mt-1 text-xl font-bold">Encoste a pulseira no leitor</p>
        <p class="text-sm text-ink-600">para ver a conta, lançar pedido ou fechar.</p>
      </div>
      <div class="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <button type="button" data-acao="novo-pedido" class="btn-primario min-h-[64px] text-lg" :class="pontoAtual ? '' : 'opacity-50'" @click="novoPedido">
          {{ pontoAtual ? '+ Novo pedido' : 'Escolha o local acima para fazer pedido' }}
        </button>
        <NuxtLink :to="noAppDoTablet ? { query: { aba: 'pagar' } } : '/admin/comandas/pagar'" data-acao="pagar" class="btn-secundario flex min-h-[64px] items-center justify-center text-lg">Pagar conta</NuxtLink>
      </div>
    </section>

    <!-- MENU DA PULSEIRA -->
    <section v-else-if="tela === 'menu' && lida" class="space-y-4">
      <div v-if="lida.tipo === 'em_uso' && lida.conta" class="card p-6 text-center">
        <p class="text-sm font-semibold text-ink-600">Pulseira {{ lida.uid }} · conta nº {{ lida.conta.numero }}</p>
        <p class="titulo mt-1 text-4xl font-bold text-ink-900" data-parte="nome-cliente">{{ lida.conta.nome }}</p>
        <p v-if="grupoDe(lida)" class="mt-1 text-lg text-ink-700">grupo de <b>{{ grupoDe(lida) }}</b></p>
        <p class="mt-3 text-lg">Conta: <b class="titulo text-2xl">{{ reais(lida.conta.totalCents) }}</b>
          <span v-if="lida.conta.limiteCents" class="text-sm text-ink-600"> · limite {{ reais(lida.conta.limiteCents) }}</span></p>
        <p v-if="lida.conta.abertaEm" class="text-sm text-ink-600">aberta {{ dataHora(lida.conta.abertaEm) }}</p>
        <p v-if="lida.conta.menorDeIdade" class="selo-alerta mt-2">Menor de 18</p>
        <p v-if="lida.daCopia" class="faixa-aviso mt-3">Sem internet: valor aproximado, da última atualização do tablet.</p>
      </div>
      <div v-else-if="['livre', 'nao_cadastrada'].includes(lida.tipo)" class="card p-6 text-center">
        <p class="text-sm font-semibold text-ink-600">Pulseira {{ lida.uid }}</p>
        <p class="titulo mt-1 text-3xl font-bold">Pulseira sem conta</p>
        <p class="mt-2 text-ink-600">{{ lida.nova ? 'Pulseira nova: foi cadastrada agora, na primeira leitura.' : 'Livre para abrir uma conta nova.' }}</p>
        <p v-if="carrinho.length" class="faixa-aviso mt-3">O pedido de {{ reais(totalCarrinho) }} está guardado: abra a conta e ele é lançado em seguida.</p>
      </div>
      <div v-else class="card p-6 text-center">
        <p class="titulo text-2xl font-bold text-erro">Não dá para usar esta pulseira</p>
        <p class="mt-2">{{ SITUACAO_RUIM[lida.tipo] ?? 'Situação desconhecida.' }}</p>
        <p v-if="lida.motivo" class="mt-1 text-sm text-ink-600">{{ lida.motivo }}</p>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <template v-if="lida.tipo === 'em_uso'">
          <button type="button" data-acao="adicionar" class="btn-primario min-h-[72px] text-xl" @click="adicionarNaConta">+ Adicionar pedido</button>
          <button type="button" class="btn-secundario min-h-[72px] text-xl" :disabled="lida.daCopia" @click="tela = 'conta'">Ver conta</button>
          <button v-if="lida.podeFechar" type="button" class="btn-secundario min-h-[72px] text-xl" :disabled="lida.daCopia" @click="irFechar()">Fechar conta</button>
          <div v-else class="card flex min-h-[72px] items-center justify-center p-3 text-center text-sm text-ink-700">Para fechar, mande o cliente ao caixa.</div>
        </template>
        <template v-else-if="['livre', 'nao_cadastrada'].includes(lida.tipo)">
          <button type="button" data-acao="fazer-pedido" class="btn-primario min-h-[72px] text-xl" :disabled="!online" @click="adicionarNaConta">
            {{ online ? '+ Fazer pedido' : 'Pulseira nova precisa de internet' }}
          </button>
          <button type="button" data-acao="abrir-conta" class="btn-secundario min-h-[72px] text-lg" :disabled="!online" @click="tela = 'abrir'">Abrir conta pelo ingresso</button>
        </template>
        <button type="button" data-acao="voltar" class="btn-secundario min-h-[72px] text-xl" @click="voltarInicio">Voltar</button>
      </div>
    </section>

    <!-- CARDÁPIO -->
    <section v-else-if="tela === 'cardapio'" class="grid items-start gap-5 pb-24 lg:grid-cols-[minmax(0,1fr)_360px] lg:pb-0">
      <div class="min-w-0 space-y-4">
        <!-- topo: local, conta e busca -->
        <div class="flex flex-wrap items-center gap-3">
          <div class="min-w-0 flex-1">
            <p class="titulo text-2xl font-bold">Novo pedido</p>
            <p class="text-sm text-ink-600">{{ pontoAtual?.nome }}<span v-if="lida?.conta"> · na conta de <b>{{ lida.conta.nome }}</b> (nº {{ lida.conta.numero }})</span></p>
          </div>
          <div class="flex w-full gap-2 sm:w-auto">
            <div class="relative flex-1 sm:w-64 sm:flex-none">
              <svg viewBox="0 0 24 24" class="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-500" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
              <input v-model="buscaItem" class="campo min-h-[48px] pl-10" placeholder="Buscar produto" autocomplete="off">
            </div>
            <!-- gerente cadastra produto novo sem caçar a tela -->
            <NuxtLink v-if="estado?.eu.nivel === 'gerente' && !noAppDoTablet" :to="{ path: '/admin/comandas', query: { aba: 'produtos', novo: '1' } }"
                      class="btn-secundario flex min-h-[48px] shrink-0 items-center whitespace-nowrap px-4" data-acao="cadastrar-produto">+ Produto</NuxtLink>
          </div>
        </div>

        <!-- categorias -->
        <!-- celular: uma fila que rola de lado; tablet pra cima: linhas iguais, sem buraco no fim -->
        <div v-if="!buscaItem.trim()" ref="faixaCategorias" class="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sem-barra sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0" data-parte="categorias">
          <button type="button" :style="larguraDaCategoria[0]"
                  class="flex min-h-[56px] shrink-0 items-center gap-2.5 whitespace-nowrap rounded-card border px-4 font-semibold transition sm:min-w-0 sm:basis-[var(--l-sm)] sm:justify-center"
                  :class="!categoria ? 'border-acao bg-acao text-white' : 'border-linha bg-white text-ink-800 hover:border-acao'" @click="categoria = ''">
            <ComandaIcone icone="🍽️" :tamanho="30" /> Tudo
          </button>
          <button v-for="(c, i) in categoriasDoLocal" :key="c.id" type="button" :style="larguraDaCategoria[i + 1]"
                  class="flex min-h-[56px] shrink-0 items-center gap-2.5 whitespace-nowrap rounded-card border px-4 font-semibold transition sm:min-w-0 sm:basis-[var(--l-sm)] sm:justify-center"
                  :class="categoria === c.id ? 'border-acao bg-acao text-white' : 'border-linha bg-white text-ink-800 hover:border-acao'" @click="categoria = c.id">
            <ComandaIcone :icone="iconeDaCategoria(c)" :tamanho="30" /> <span class="truncate">{{ c.nome }}</span>
          </button>
        </div>

        <!-- produtos, separados por categoria -->
        <div v-for="g in gruposVisiveis" :key="g.id" class="space-y-2">
          <p v-if="!categoria || buscaItem.trim()" class="flex items-center gap-2 pt-1 text-sm font-bold uppercase tracking-wide text-ink-600">
            <ComandaIcone :icone="g.icone" :tamanho="22" />{{ g.nome }}
          </p>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            <div v-for="i in g.itens" :key="i.id" class="relative">
              <button type="button" :disabled="i.esgotado" data-parte="produto"
                      class="flex h-full w-full flex-col overflow-hidden rounded-card border bg-white text-left shadow-sm transition active:scale-[0.97] disabled:opacity-40"
                      :class="qtdNoCarrinho(i.id) ? 'border-acao ring-2 ring-acao' : 'border-linha hover:border-acao hover:shadow'" @click="por(i)">
                <FotoDoItem :item="i" :categoria="catDoItem(i.categoriaId)" :tamanho="76" class="h-28 w-full bg-gradient-to-b from-ink-50 to-white" />
                <span class="flex w-full flex-1 flex-col justify-between gap-1 px-3 pb-3 pt-2">
                  <span class="line-clamp-2 min-h-[2.5rem] font-semibold leading-tight text-ink-900">{{ i.nome }}</span>
                  <span class="flex items-center justify-between gap-2">
                    <span class="titulo text-lg font-bold text-acao">{{ reais(i.precoCents) }}</span>
                    <span v-if="i.esgotado" class="selo-erro">esgotado</span>
                  </span>
                </span>
                <span v-if="i.maior18 && !i.esgotado" class="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-bold text-ink-700 shadow-sm ring-1 ring-linha">+18</span>
              </button>
              <!-- já no pedido: tira e põe sem sair do produto -->
              <div v-if="qtdNoCarrinho(i.id)" class="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-acao p-0.5 text-white shadow">
                <button type="button" class="flex h-8 w-8 items-center justify-center rounded-full text-lg font-bold hover:bg-acao-escuro" :aria-label="`Tirar um ${i.nome}`" @click.stop="tirar(i.id)">−</button>
                <span class="min-w-[1.25rem] text-center font-bold">{{ qtdNoCarrinho(i.id) }}</span>
              </div>
            </div>
          </div>
        </div>
        <p v-if="!gruposVisiveis.length" class="card p-8 text-center text-ink-600">
          {{ buscaItem.trim() ? `Nenhum produto com "${buscaItem.trim()}".` : 'Este local ainda não tem produtos. Cadastre em Gestão → Produtos.' }}
        </p>
      </div>

      <!-- o pedido -->
      <aside class="card hidden h-fit space-y-3 p-4 lg:sticky lg:top-24 lg:block">
        <div class="flex items-center justify-between">
          <p class="titulo text-lg font-bold">Pedido</p>
          <span v-if="qtdCarrinho" class="selo-neutro">{{ qtdCarrinho }} item(ns)</span>
        </div>
        <p v-if="!carrinho.length" class="rounded-card bg-ink-50 p-4 text-center text-sm text-ink-600">Toque nos produtos para adicionar.</p>
        <ul class="max-h-[50vh] space-y-2 overflow-y-auto">
          <li v-for="c in carrinho" :key="c.itemId" class="flex items-center gap-2 rounded-card bg-ink-50 p-2">
            <FotoDoItem :item="estado!.itens.find((x) => x.id === c.itemId) ?? { nome: c.nome }" :categoria="catDoItem(estado!.itens.find((x) => x.id === c.itemId)?.categoriaId ?? '')" :tamanho="34" class="h-10 w-10 shrink-0 rounded-card" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-semibold leading-tight">{{ c.nome }}</span>
              <span class="text-xs text-ink-600">{{ reais(c.precoCents * c.quantidade) }}</span>
            </span>
            <button type="button" class="flex h-9 w-9 items-center justify-center rounded-full border border-linha bg-white text-lg font-bold" :aria-label="`Tirar um ${c.nome}`" @click="tirar(c.itemId)">−</button>
            <span class="w-6 text-center font-bold">{{ c.quantidade }}</span>
            <button type="button" class="flex h-9 w-9 items-center justify-center rounded-full border border-linha bg-white text-lg font-bold" :aria-label="`Mais um ${c.nome}`" @click="c.quantidade++">+</button>
          </li>
        </ul>
        <input v-model="observacao" class="campo" placeholder="Observação (ex.: sem gelo, bem passado)">
        <p class="flex items-baseline justify-between border-t border-linha pt-3"><span class="font-semibold">Total</span><b class="titulo text-2xl">{{ reais(totalCarrinho) }}</b></p>
        <button type="button" data-acao="continuar" class="btn-primario min-h-[60px] w-full text-lg" :disabled="!carrinho.length" @click="continuar">Continuar</button>
        <button type="button" class="w-full py-2 text-sm font-semibold text-ink-600 hover:text-erro" @click="voltarInicio">Cancelar pedido</button>
      </aside>

      <!-- celular/tablet em pé: o pedido vira uma barra embaixo -->
      <div class="fixed inset-x-0 bottom-0 z-30 border-t border-linha bg-white p-3 shadow-lg lg:hidden">
        <input v-if="carrinho.length" v-model="observacao" class="campo mb-2" placeholder="Observação (ex.: sem gelo)">
        <div class="flex items-center gap-3">
          <button type="button" class="btn-secundario min-h-[56px]" @click="voltarInicio">Cancelar</button>
          <div class="flex-1 text-right"><p class="text-xs text-ink-600">{{ qtdCarrinho }} item(ns)</p><p class="titulo text-xl font-bold">{{ reais(totalCarrinho) }}</p></div>
          <button type="button" class="btn-primario min-h-[56px] px-6 text-lg" :disabled="!carrinho.length" @click="continuar">Continuar</button>
        </div>
      </div>
    </section>

    <!-- NOME E MESA (antes da pulseira) -->
    <section v-else-if="tela === 'identificar'" class="mx-auto max-w-xl space-y-4">
      <form class="card space-y-5 p-6" data-parte="nome-e-mesa" @submit.prevent="identificado">
        <div>
          <p class="titulo text-2xl font-bold">De quem é o pedido?</p>
          <p class="text-sm text-ink-600">{{ qtdCarrinho }} item(ns) · {{ reais(totalCarrinho) }}</p>
        </div>
        <label class="block">
          <span class="rotulo">Nome do cliente <span class="text-erro">*</span></span>
          <input ref="campoNome" v-model="clienteNome" class="campo min-h-[56px] text-xl" placeholder="Digite o nome ou sobrenome"
                 autocomplete="off" autocapitalize="words" maxlength="60" required minlength="2">
        </label>
        <label class="block">
          <span class="rotulo">Mesa <span class="font-normal text-ink-600">(opcional)</span></span>
          <input v-model="mesa" class="campo min-h-[56px] text-xl" placeholder="Ex.: 12, Quiosque 3, Piscina" autocomplete="off" maxlength="40">
        </label>
        <div class="grid grid-cols-2 gap-3">
          <button type="button" class="btn-secundario min-h-[60px] text-lg" @click="tela = 'cardapio'">Voltar</button>
          <button type="submit" data-acao="ir-para-pulseira" class="btn-primario min-h-[60px] text-lg" :disabled="clienteNome.trim().length < 2">
            {{ lida?.tipo === 'em_uso' ? 'Continuar' : 'Passar a pulseira' }}
          </button>
        </div>
      </form>
    </section>

    <!-- LER PULSEIRA (pedido primeiro) -->
    <section v-else-if="tela === 'ler'" class="space-y-4">
      <div class="card flex flex-col items-center gap-3 p-10 text-center">
        <div class="flex h-24 w-24 animate-pulse items-center justify-center rounded-full bg-acao-claro text-acao">
          <svg viewBox="0 0 24 24" class="h-12 w-12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 8.3a6 6 0 010 7.4M9.5 6a10 10 0 010 12M13 3.8a14 14 0 010 16.4" /></svg>
        </div>
        <p class="titulo text-2xl font-bold">Agora encoste a pulseira do cliente</p>
        <p class="text-ink-600">Pedido de <b>{{ clienteNome }}</b><span v-if="mesa"> · {{ mesaTexto }}</span> · {{ qtdCarrinho }} item(ns) · {{ reais(totalCarrinho) }}</p>
      </div>
      <button type="button" class="btn-secundario min-h-[56px] w-full" @click="tela = 'identificar'">Voltar</button>
    </section>

    <!-- CONFIRMAR -->
    <section v-else-if="tela === 'confirmar' && lida" class="space-y-4">
      <div class="card p-6 text-center">
        <p class="text-sm font-semibold text-ink-600">Confira com o cliente — é esta pessoa?</p>
        <p class="titulo mt-1 text-4xl font-bold" data-parte="nome-confirmar">{{ clienteNome.trim() || lida.conta?.nome }}</p>
        <p v-if="lida.conta && clienteNome.trim() && lida.conta.nome.toLowerCase() !== clienteNome.trim().toLowerCase()" class="faixa-aviso mt-2">
          Esta pulseira já está na conta de <b>{{ lida.conta.nome }}</b>. O pedido vai para essa conta.
        </p>
        <p v-if="grupoDe(lida)" class="text-lg text-ink-700">grupo de <b>{{ grupoDe(lida) }}</b></p>
        <p v-if="lida.conta" class="mt-1 text-sm text-ink-600">Pulseira {{ lida.uid }} · conta nº {{ lida.conta.numero }}</p>
        <p v-else class="mt-2 selo-ok">Pulseira {{ lida.uid }} · nova — a conta abre agora, no nome de {{ clienteNome }}</p>
      </div>
      <div class="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <!-- o pedido -->
        <div class="card overflow-hidden">
          <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-linha px-5 py-3">
            <p class="titulo-bloco">Resumo do pedido</p>
            <p class="text-sm text-ink-600">{{ pontoAtual?.nome ?? 'Sem local' }} · {{ dataHora(new Date().toISOString()) }} · {{ estado?.eu.nome }}</p>
          </div>
          <table class="w-full text-sm">
            <thead class="bg-fundo-cinza text-left text-xs uppercase tracking-wide text-ink-600">
              <tr><th class="px-5 py-2">Produto</th><th class="text-right">Qtd.</th><th class="text-right">Preço un.</th><th class="px-5 text-right">Subtotal</th></tr>
            </thead>
            <tbody class="divide-y divide-linha">
              <tr v-for="c in carrinho" :key="c.itemId" class="text-base">
                <td class="px-5 py-2.5 font-semibold">{{ c.nome }}</td>
                <td class="text-right tabular-nums">{{ c.quantidade }}</td>
                <td class="text-right tabular-nums text-ink-600">{{ reais(c.precoCents) }}</td>
                <td class="px-5 text-right font-semibold tabular-nums">{{ reais(c.precoCents * c.quantidade) }}</td>
              </tr>
            </tbody>
          </table>
          <div class="space-y-1 border-t border-linha px-5 py-3 text-sm">
            <p><span class="text-ink-600">Para:</span> <b>{{ clienteNome }}</b><span v-if="mesa"> · {{ mesaTexto }}</span></p>
            <p v-if="observacao"><span class="text-ink-600">Observação:</span> {{ observacao }}</p>
          </div>
          <p class="flex items-baseline justify-between border-t border-linha bg-fundo-cinza px-5 py-3">
            <span class="font-semibold">Total deste pedido <span class="font-normal text-ink-600">({{ qtdCarrinho }} item(ns))</span></span>
            <b class="titulo text-2xl">{{ reais(totalCarrinho) }}</b>
          </p>
        </div>

        <!-- a conta -->
        <div class="card p-5">
          <p class="titulo-bloco">{{ lida.conta ? `Conta nº ${lida.conta.numero}` : 'Conta nova' }}</p>
          <p class="text-sm text-ink-600">
            {{ lida.conta ? lida.conta.nome : clienteNome }} · pulseira {{ lida.uid }}
            <span v-if="lida.conta?.abertaEm" class="block">aberta em {{ dataHora(lida.conta.abertaEm) }}</span>
          </p>
          <dl class="mt-4 space-y-2 text-sm">
            <div class="flex justify-between"><dt class="text-ink-600">Consumido até agora</dt><dd class="tabular-nums">{{ reais(lida.conta?.totalCents ?? 0) }}</dd></div>
            <div class="flex justify-between"><dt class="text-ink-600">+ Este pedido</dt><dd class="tabular-nums">{{ reais(totalCarrinho) }}</dd></div>
            <div class="flex justify-between border-t border-linha pt-2 font-semibold"><dt>Total consumido</dt><dd class="tabular-nums">{{ reais((lida.conta?.totalCents ?? 0) + totalCarrinho) }}</dd></div>
            <div v-if="lida.conta?.pagoCents" class="flex justify-between text-ok"><dt>− Já pago</dt><dd class="tabular-nums">{{ reais(lida.conta.pagoCents) }}</dd></div>
            <div class="flex items-baseline justify-between border-t border-linha pt-2"><dt class="font-semibold">A pagar na saída</dt>
              <dd class="titulo text-xl font-bold text-acao tabular-nums">{{ reais(Math.max(0, (lida.conta?.totalCents ?? 0) + totalCarrinho - (lida.conta?.pagoCents ?? 0))) }}</dd></div>
          </dl>
          <p class="mt-3 text-xs text-ink-600">O cliente paga tudo no fim, ao fechar a conta.</p>
        </div>
      </div>
      <p v-for="a in avisosConfirmar" :key="a" class="faixa-aviso">{{ a }}</p>
      <p v-if="!online || lida.daCopia" class="faixa-aviso">Sem internet: o pedido fica guardado no tablet e sobe sozinho.</p>
      <div v-if="precisaPin" class="card space-y-2 p-4">
        <p class="faixa-erro">{{ precisaPin }}</p>
        <p class="text-sm text-ink-700">Só o gerente libera isto: peça para ele lançar este pedido no tablet dele.</p>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <button type="button" class="btn-secundario min-h-[72px] text-lg" @click="tela = 'identificar'">Não é / voltar</button>
        <button type="button" data-acao="confirmar" class="btn-primario min-h-[72px] text-xl" :disabled="enviando || (!!precisaPin && estado?.eu.nivel !== 'gerente')" @click="confirmar">
          {{ enviando ? 'Lançando…' : 'Confirmar pedido' }}
        </button>
      </div>
    </section>

    <!-- FEITO -->
    <section v-else-if="tela === 'feito' && feito" class="space-y-4">
      <div class="card p-8 text-center">
        <div class="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-success-100 text-ok">
          <svg viewBox="0 0 24 24" class="h-10 w-10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M20 6L9 17l-5-5" /></svg>
        </div>
        <p class="titulo mt-3 text-3xl font-bold">{{ feito.naFila ? 'Pedido guardado' : 'Pedido lançado' }}</p>
        <p class="mt-1 text-lg">{{ reais(feito.valorCents) }} para <b>{{ clienteNome.trim() || feito.nome }}</b></p>
        <p v-if="clienteNome.trim() && feito.nome.toLowerCase() !== clienteNome.trim().toLowerCase()" class="text-ink-700">na conta de {{ feito.nome }}</p>
        <p class="text-ink-700">{{ feito.resumo }}</p>
        <p v-if="feito.totalCents" class="mt-1 text-ink-600">Total da conta agora: <b>{{ reais(feito.totalCents) }}</b></p>
        <p class="text-sm text-ink-600">{{ feito.em.toLocaleString('pt-BR', { timeZone: 'America/Bahia' }) }}</p>
        <p v-if="feito.naFila" class="faixa-aviso mt-3">Sem internet: sobe sozinho quando a internet voltar.</p>
      </div>

      <!-- corrigir na hora: só dentro do prazo, e pedindo confirmação -->
      <div v-if="segundosParaDesfazer > 0" class="card flex flex-wrap items-center justify-between gap-3 p-4" data-parte="cancelar-pedido">
        <template v-if="!cancelando">
          <div>
            <p class="font-semibold">Lançou errado?</p>
            <p class="text-sm text-ink-600">Você pode cancelar este pedido por mais
              <b class="tabular-nums">{{ Math.floor(segundosParaDesfazer / 60) }}:{{ String(segundosParaDesfazer % 60).padStart(2, '0') }}</b>. Depois disso, só o caixa.</p>
          </div>
          <button type="button" data-acao="cancelar-pedido" class="btn-secundario min-h-[48px]" @click="cancelando = true">Cancelar este pedido</button>
        </template>
        <template v-else>
          <p class="flex-1 font-semibold">Cancelar {{ feito.resumo }} ({{ reais(feito.valorCents) }}) da conta de {{ feito.nome }}?</p>
          <div class="flex gap-2">
            <button type="button" class="btn-secundario min-h-[48px]" @click="cancelando = false">Não</button>
            <button type="button" data-acao="confirmar-cancelamento" class="btn-erro min-h-[48px]" @click="desfazer">Sim, cancelar</button>
          </div>
        </template>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <button type="button" class="btn-primario min-h-[72px] text-xl" @click="novoPedido">+ Novo pedido</button>
        <button type="button" class="btn-secundario min-h-[72px] text-lg" @click="voltarInicio">Início</button>
      </div>
    </section>

    <!-- CANCELADO -->
    <section v-else-if="tela === 'cancelado' && cancelado" class="space-y-4">
      <div class="card p-8 text-center">
        <p class="titulo text-3xl font-bold">Pedido cancelado</p>
        <p class="mt-1 text-lg">{{ cancelado.resumo }} ({{ reais(cancelado.valorCents) }}) saiu da conta de <b>{{ cancelado.nome }}</b>.</p>
        <p class="text-sm text-ink-600">Fica registrado no histórico da conta, com o seu nome e a hora.</p>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <button type="button" class="btn-primario min-h-[72px] text-xl" @click="novoPedido">+ Novo pedido</button>
        <button type="button" class="btn-secundario min-h-[72px] text-lg" @click="voltarInicio">Início</button>
      </div>
    </section>

    <!-- VER CONTA -->
    <section v-else-if="tela === 'conta' && lida?.conta" class="space-y-4">
      <button type="button" class="btn-secundario" @click="tela = 'menu'">← Voltar</button>
      <ComandaConta :id="lida.conta.id" :itens-do-cardapio="estado?.itens" @fechar="(c, g) => irFechar(c, g)" />
    </section>

    <!-- ABRIR CONTA -->
    <section v-else-if="tela === 'abrir' && lida">
      <ComandaAbrirConta :uid="lida.uid" :nome-inicial="clienteNome" :ponto-id="pontoId || null" :limite-padrao-cents="estado?.config.limitePadraoCents ?? 0"
                         :gerente="estado?.eu.nivel === 'gerente'" @aberta="contaAberta" @voltar="tela = 'menu'" />
    </section>

    <!-- FECHAR -->
    <section v-else-if="tela === 'fechar'" class="space-y-4">
      <div v-if="grupoParaJuntar.length" class="faixa-aviso flex flex-wrap items-center justify-between gap-2">
        <span>O grupo tem mais {{ grupoParaJuntar.length }} conta(s) aberta(s): {{ grupoParaJuntar.map((g) => g.nome).join(', ') }}.</span>
        <button type="button" class="btn-secundario" @click="pagarGrupoJunto">Pagar tudo junto</button>
      </div>
      <div v-if="aPagar.length === 1 && aPagar[0].faltaCents <= 0" class="card space-y-3 p-6 text-center">
        <p class="titulo text-2xl font-bold">Nada a pagar</p>
        <button type="button" class="btn-primario min-h-[56px] w-full" @click="fecharSemValor">Fechar conta e liberar pulseira</button>
        <button type="button" class="btn-secundario w-full" @click="tela = 'menu'">Voltar</button>
      </div>
      <ComandaPagamento v-else :contas="aPagar" @pago="pago" @voltar="tela = 'menu'" />
    </section>

    <!-- PAGO -->
    <section v-else-if="tela === 'pago'" class="space-y-4">
      <div class="card p-8 text-center">
        <p class="titulo text-3xl font-bold text-ok">Conta paga ✓</p>
        <p v-if="troco" class="titulo mt-2 text-4xl font-bold text-acao">Troco: {{ reais(troco) }}</p>
        <p class="mt-2 text-lg">Pulseira liberada — pode recolher e usar em outro cliente.</p>
      </div>
      <button type="button" class="btn-primario min-h-[72px] w-full text-xl" @click="voltarInicio">Início</button>
    </section>
  </div>
</template>
