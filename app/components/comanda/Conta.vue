<script setup lang="ts">
/**
 * A conta inteira (055), igual pra todos — o que muda é o que cada um pode fazer (o servidor
 * manda em `pode`): o atendente vê e desfaz o próprio pedido no prazo; o caixa corrige, move,
 * junta e troca pulseira; o gerente dá desconto, reabre, perdoa e cobra.
 *
 * Nada some: item cancelado continua na lista, riscado, com quem cancelou, quando e o motivo.
 * Todo item mostra dia e hora, quem lançou, onde, e se foi feito sem internet.
 */
import { chamar, mensagemDoErro } from '~/composables/comandaOffline'
import { dataHora, diaMesHora, reais } from '~/composables/formato'
import CampoMoeda from '~/components/CampoMoeda.vue'
import ModalLateral from '~/components/ModalLateral.vue'

const props = defineProps<{ id: string; itensDoCardapio?: { id: string; nome: string; precoCents: number }[] }>()
const emit = defineEmits<{ fechar: [conta: any, grupo: any[]]; mudou: [] }>()

const dados = ref<any>(null)
const erro = ref('')
async function carregar() {
  try {
    dados.value = await chamar<any>(`/api/comandas/conta/${props.id}`)
    erro.value = ''
  } catch (e) { erro.value = mensagemDoErro(e, 'Não consegui abrir a conta. Confira a internet.') }
}
watch(() => props.id, carregar, { immediate: true })

const conta = computed(() => dados.value?.conta)
const pode = computed(() => dados.value?.pode ?? {})
const aberta = computed(() => conta.value?.situacao === 'aberta')
const SITUACAO: Record<string, [string, string]> = {
  aberta: ['Aberta', 'selo-ok'], paga: ['Paga', 'selo-neutro'], paga_depois: ['Paga depois', 'selo-neutro'],
  nao_paga: ['NÃO PAGA', 'selo-erro'], cobrada: ['Cobrada', 'selo-alerta'], perdoada: ['Perdoada', 'selo-neutro'], juntada: ['Juntada', 'selo-neutro'],
}
const FORMA: Record<string, string> = { pix: 'Pix', debito: 'Débito', credito: 'Crédito', dinheiro: 'Dinheiro' }

/* ------------------------------------------------------------------ correções */

type Acao = { acao: string; titulo: string; campos: string[]; gerente?: boolean; extra?: Record<string, any>; texto?: string }
const correcao = ref<Acao | null>(null)
const form = reactive<Record<string, any>>({})
const enviando = ref(false)
const erroForm = ref('')
const selecionados = ref<string[]>([])

function abrirCorrecao(a: Acao, iniciais: Record<string, any> = {}) {
  for (const k of Object.keys(form)) delete form[k]
  Object.assign(form, { motivo: '', pin: '', ...iniciais })
  erroForm.value = ''
  correcao.value = a
}

async function enviarCorrecao() {
  if (!correcao.value) return
  erroForm.value = ''
  enviando.value = true
  try {
    const corpo: Record<string, any> = { acao: correcao.value.acao, ...correcao.value.extra, ...form }
    if (corpo.destino) {
      const d = String(corpo.destino).trim()
      if (/^\d{1,6}$/.test(d)) corpo.destinoNumero = Number(d)
      else corpo.destinoUid = d
      delete corpo.destino
    }
    await chamar(`/api/comandas/conta/${props.id}/corrigir`, { method: 'POST', body: corpo })
    correcao.value = null
    selecionados.value = []
    await carregar()
    emit('mudou')
  } catch (e) {
    erroForm.value = mensagemDoErro(e)
  } finally { enviando.value = false }
}

async function desfazer(lancamentoId: string) {
  try {
    await chamar(`/api/comandas/pedidos/${lancamentoId}/desfazer`, { method: 'POST', body: { motivo: 'desfeito pelo atendente' } })
    await carregar()
    emit('mudou')
  } catch (e) { erro.value = mensagemDoErro(e) }
}

/* ------------------------------------------------------------------ cobrança */

const cobranca = ref<any>(null)
async function prepararCobranca(enviar = false) {
  try {
    cobranca.value = await chamar<any>(`/api/comandas/conta/${props.id}/cobrar`, { method: 'POST', body: { enviar } })
    if (enviar) await carregar()
  } catch (e) { erro.value = mensagemDoErro(e) }
}

defineExpose({ carregar })
</script>

<template>
  <div data-parte="conta" class="space-y-4">
    <p v-if="erro" class="faixa-erro">{{ erro }}</p>
    <div v-if="!dados && !erro" class="py-10 text-center text-ink-600">Carregando a conta…</div>

    <template v-if="conta">
      <!-- cabeçalho -->
      <div class="card p-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p class="text-sm font-semibold text-ink-600">Conta nº {{ conta.numero }} · pulseira {{ conta.pulseira ?? '—' }}</p>
            <p class="titulo text-2xl font-bold text-ink-900">{{ conta.nome }}</p>
            <p v-if="conta.nome !== conta.responsavelNome" class="text-sm text-ink-700">Grupo de <b>{{ conta.responsavelNome }}</b> (quem paga)</p>
            <p class="mt-1 text-sm text-ink-600">Aberta {{ dataHora(conta.abertaEm) }}<span v-if="conta.abertaPor"> por {{ conta.abertaPor }}</span>
              <span v-if="conta.fechadaEm"> · fechada {{ dataHora(conta.fechadaEm) }}<span v-if="conta.fechadaPor"> por {{ conta.fechadaPor }}</span></span></p>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <span :class="SITUACAO[conta.situacao]?.[1] ?? 'selo-neutro'">{{ SITUACAO[conta.situacao]?.[0] ?? conta.situacao }}</span>
            <span v-if="conta.menorDeIdade" class="selo-alerta">Menor de 18</span>
            <span v-if="conta.dadosConfirmados" class="selo-ok">Contato confirmado</span>
            <span v-else class="selo-alerta">Contato NÃO confirmado</span>
          </div>
        </div>
        <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div><p class="rotulo-kpi">Consumido</p><p class="numero-kpi">{{ reais(conta.totalCents) }}</p></div>
          <div><p class="rotulo-kpi">Pago</p><p class="numero-kpi">{{ reais(conta.pagoCents) }}</p></div>
          <div><p class="rotulo-kpi">Falta</p><p class="numero-kpi" :class="conta.faltaCents > 0 ? 'text-erro' : ''">{{ reais(conta.faltaCents) }}</p></div>
          <div><p class="rotulo-kpi">Limite</p><p class="numero-kpi">{{ conta.limiteCents ? reais(conta.limiteCents) : 'sem' }}</p></div>
        </div>
        <p v-if="conta.limiteCents && conta.totalCents > conta.limiteCents" class="faixa-aviso mt-3">Passou do limite da conta.</p>
        <p v-if="conta.juntadaNumero" class="faixa-aviso mt-3">Esta conta foi juntada na conta nº {{ conta.juntadaNumero }} — o que estava aqui foi pra lá.</p>
      </div>

      <!-- responsável -->
      <div class="card p-5">
        <p class="titulo-bloco">Responsável pela conta</p>
        <dl class="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt class="inline text-ink-600">Nome: </dt><dd class="inline font-semibold">{{ conta.responsavelNome }}</dd></div>
          <div><dt class="inline text-ink-600">WhatsApp: </dt><dd class="inline font-semibold">{{ conta.responsavelTelefone ?? '—' }}</dd></div>
          <div v-if="conta.responsavelEmail"><dt class="inline text-ink-600">E-mail: </dt><dd class="inline">{{ conta.responsavelEmail }}</dd></div>
          <div v-if="conta.responsavelDocumento"><dt class="inline text-ink-600">CPF: </dt><dd class="inline">{{ conta.responsavelDocumento }}</dd></div>
          <div><dt class="inline text-ink-600">Como foi confirmado: </dt><dd class="inline">{{ conta.origem === 'ingresso' ? `pela compra do ingresso${conta.pedidoCodigo ? ' (pedido ' + conta.pedidoCodigo + ')' : ''}` : conta.origem === 'whatsapp' ? 'código no WhatsApp' : conta.origem === 'atendimento' ? 'aberta no atendimento, só com o nome' : 'liberado pelo gerente, sem confirmação' }}</dd></div>
          <div v-if="conta.observacao"><dt class="inline text-ink-600">Observação: </dt><dd class="inline">{{ conta.observacao }}</dd></div>
        </dl>
        <div v-if="dados.grupo?.length" class="mt-3 border-t border-linha pt-3">
          <p class="text-sm font-semibold text-ink-700">Contas do mesmo grupo</p>
          <ul class="mt-1 text-sm">
            <li v-for="g in dados.grupo" :key="g.id">nº {{ g.numero }} · {{ g.nome }} · {{ SITUACAO[g.situacao]?.[0] ?? g.situacao }} · falta {{ reais(g.faltaCents) }}</li>
          </ul>
        </div>
      </div>

      <!-- ações principais -->
      <div class="flex flex-wrap gap-2">
        <button v-if="aberta && pode.fechar && conta.faltaCents > 0" type="button" data-acao="fechar-conta" class="btn-primario min-h-[52px]"
                @click="emit('fechar', conta, dados.grupo ?? [])">Fechar conta</button>
        <button v-if="aberta && pode.fechar && conta.faltaCents <= 0" type="button" class="btn-primario min-h-[52px]"
                @click="emit('fechar', conta, dados.grupo ?? [])">Fechar conta (nada a pagar)</button>
        <button v-if="['nao_paga', 'cobrada'].includes(conta.situacao) && pode.fechar && conta.faltaCents > 0" type="button" class="btn-primario min-h-[52px]"
                @click="emit('fechar', conta, [])">Receber pagamento</button>
        <template v-if="pode.corrigir">
          <button v-if="aberta" type="button" class="btn-secundario" @click="abrirCorrecao({ acao: 'trocar_pulseira', titulo: 'Trocar pulseira', campos: ['uid', 'perdida', 'motivo'] }, { perdida: true })">Trocar pulseira</button>
          <button v-if="aberta" type="button" class="btn-secundario" @click="abrirCorrecao({ acao: 'juntar', titulo: 'Juntar esta conta em outra', campos: ['destino', 'motivo'], texto: 'Tudo desta conta vai para a outra, e a pulseira desta passa a apontar para lá.' })">Juntar com outra conta</button>
          <button type="button" class="btn-secundario" @click="abrirCorrecao({ acao: 'dados', titulo: 'Mudar nome / observação', campos: ['nome', 'observacao', 'motivo'] }, { nome: conta.nome, observacao: conta.observacao ?? '' })">Mudar nome</button>
          <button v-if="aberta" type="button" class="btn-secundario" @click="abrirCorrecao({ acao: 'menor', titulo: conta.menorDeIdade ? 'Tirar marca de menor' : 'Marcar como menor de 18', campos: ['motivo'], extra: { menor: !conta.menorDeIdade } })">{{ conta.menorDeIdade ? 'Não é menor' : 'É menor de 18' }}</button>
        </template>
        <template v-if="pode.gerente">
          <button v-if="aberta" type="button" class="btn-secundario" @click="abrirCorrecao({ acao: 'limite', titulo: 'Mudar limite', campos: ['limiteCents', 'motivo'] }, { limiteCents: conta.limiteCents })">Mudar limite</button>
          <button v-if="aberta" type="button" class="btn-secundario" @click="abrirCorrecao({ acao: 'desconto_conta', titulo: 'Desconto na conta', campos: ['descontoCents', 'motivo'] }, { descontoCents: conta.descontoCents })">Desconto</button>
          <button v-if="!aberta && conta.situacao !== 'juntada'" type="button" class="btn-secundario" @click="abrirCorrecao({ acao: 'reabrir', titulo: 'Reabrir conta', campos: ['motivo'] })">Reabrir</button>
          <button v-if="['nao_paga','cobrada'].includes(conta.situacao)" type="button" class="btn-secundario" @click="abrirCorrecao({ acao: 'perdoar', titulo: 'Perdoar a dívida', campos: ['motivo'], texto: 'O parque assume o valor. Fica registrado.' })">Perdoar</button>
          <button v-if="['nao_paga','cobrada'].includes(conta.situacao)" type="button" data-acao="cobrar" class="btn-primario" @click="prepararCobranca(false)">Cobrar no WhatsApp</button>
        </template>
      </div>

      <!-- cobrança -->
      <div v-if="cobranca" class="card space-y-3 p-5">
        <p class="titulo-bloco">Mensagem de cobrança</p>
        <pre class="whitespace-pre-wrap rounded-card bg-fundo-cinza p-3 font-corpo text-sm">{{ cobranca.texto }}</pre>
        <p v-if="cobranca.enviado" class="faixa-aviso">Enviada{{ cobranca.simulado ? ' (modo de teste: no sistema de verdade sai pelo WhatsApp do parque)' : '' }}.</p>
        <div class="flex flex-wrap gap-2">
          <button v-if="!cobranca.enviado" type="button" class="btn-primario" @click="prepararCobranca(true)">Enviar pelo WhatsApp do parque</button>
          <a :href="cobranca.link" target="_blank" rel="noopener" class="btn-secundario">Abrir no meu WhatsApp</a>
          <button type="button" class="btn-secundario" @click="cobranca = null">Fechar</button>
        </div>
      </div>

      <!-- itens -->
      <div class="card p-5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="titulo-bloco">O que foi consumido</p>
          <button v-if="pode.corrigir && aberta && selecionados.length" type="button" class="btn-secundario"
                  @click="abrirCorrecao({ acao: 'mover_itens', titulo: `Mover ${selecionados.length} item(ns) para outra conta`, campos: ['destino', 'motivo'], extra: { itens: selecionados } })">
            Mover {{ selecionados.length }} selecionado(s)
          </button>
        </div>
        <p v-if="!dados.itens.length" class="mt-2 text-sm text-ink-600">Nenhum pedido ainda.</p>
        <ul class="mt-2 divide-y divide-linha">
          <li v-for="i in dados.itens" :key="i.id" class="flex flex-wrap items-start gap-3 py-3" :class="i.cancelado ? 'opacity-60' : ''">
            <input v-if="pode.corrigir && aberta && !i.cancelado" v-model="selecionados" type="checkbox" :value="i.id" class="mt-1.5 h-5 w-5" :aria-label="`Selecionar ${i.nome}`">
            <div class="min-w-0 flex-1">
              <p class="font-semibold" :class="i.cancelado ? 'line-through' : ''">{{ i.quantidade }}× {{ i.nome }} <span class="font-normal text-ink-600">({{ reais(i.precoCents) }} cada)</span></p>
              <p class="text-xs text-ink-600">
                {{ dataHora(i.feitoEm) }} · {{ i.atendente ?? '—' }}<span v-if="i.ponto"> · {{ i.ponto }}</span><span v-if="i.cliente"> · para {{ i.cliente }}</span><span v-if="i.mesa"> · {{ i.mesa }}</span>
                <span v-if="i.semInternet" class="font-semibold text-alerta"> · feito sem internet (chegou {{ diaMesHora(i.recebidoEm) }})</span>
                <span v-if="i.aposFechar" class="font-semibold text-erro"> · chegou depois de fechada</span>
                <span v-if="i.veioDeOutra"> · veio de outra conta</span>
              </p>
              <p v-if="i.observacao" class="text-xs text-ink-700">Obs.: {{ i.observacao }}</p>
              <p v-if="i.descontoCents" class="text-xs text-ok">Desconto {{ reais(i.descontoCents) }} — {{ i.descontoMotivo }}</p>
              <p v-if="i.cancelado" class="text-xs font-semibold text-erro">Cancelado {{ dataHora(i.canceladoEm) }} por {{ i.canceladoPor ?? '—' }}: {{ i.canceladoMotivo }}</p>
            </div>
            <p class="titulo font-semibold tabular-nums" :class="i.cancelado ? 'line-through' : ''">{{ reais(i.subtotalCents) }}</p>
            <div v-if="!i.cancelado && aberta" class="flex w-full flex-wrap justify-end gap-1.5 sm:w-auto">
              <button v-if="i.desfazSozinho && !pode.corrigir" type="button" class="btn-secundario text-sm" @click="desfazer(i.lancamentoId)">Desfazer</button>
              <template v-if="pode.corrigir">
                <button type="button" class="btn-secundario text-sm" @click="abrirCorrecao({ acao: 'cancelar_item', titulo: `Cancelar ${i.nome}`, campos: ['motivo'], extra: { itemId: i.id } })">Cancelar</button>
                <button type="button" class="btn-secundario text-sm" @click="abrirCorrecao({ acao: 'quantidade', titulo: `Quantidade de ${i.nome}`, campos: ['quantidade', 'motivo'], extra: { itemId: i.id } }, { quantidade: i.quantidade })">Qtd.</button>
                <button v-if="itensDoCardapio?.length" type="button" class="btn-secundario text-sm" @click="abrirCorrecao({ acao: 'trocar_item', titulo: `Trocar ${i.nome} por outro`, campos: ['novoItemId', 'quantidade', 'motivo'], extra: { itemId: i.id } }, { quantidade: i.quantidade, novoItemId: '' })">Trocar</button>
                <button v-if="pode.gerente" type="button" class="btn-secundario text-sm" @click="abrirCorrecao({ acao: 'desconto_item', titulo: `Desconto em ${i.nome}`, campos: ['descontoCents', 'motivo'], extra: { itemId: i.id } }, { descontoCents: i.descontoCents })">Desconto</button>
              </template>
            </div>
          </li>
        </ul>
      </div>

      <!-- pagamentos -->
      <div v-if="dados.pagamentos.length" class="card p-5">
        <p class="titulo-bloco">Pagamentos</p>
        <ul class="mt-2 divide-y divide-linha">
          <li v-for="p in dados.pagamentos" :key="p.id" class="flex flex-wrap items-center gap-3 py-2.5" :class="p.anulado ? 'opacity-60' : ''">
            <div class="flex-1">
              <p class="font-semibold" :class="p.anulado ? 'line-through' : ''">{{ FORMA[p.forma] }} · {{ reais(p.valorCents) }}
                <span v-if="p.trocoCents" class="font-normal text-ink-600">(recebeu {{ reais(p.recebidoCents) }}, troco {{ reais(p.trocoCents) }})</span></p>
              <p class="text-xs text-ink-600">{{ dataHora(p.feitoEm) }} · {{ p.feitoPor ?? '—' }}</p>
              <p v-if="p.anulado" class="text-xs font-semibold text-erro">Anulado {{ dataHora(p.anuladoEm) }} por {{ p.anuladoPor }}: {{ p.anuladoMotivo }}</p>
            </div>
            <template v-if="!p.anulado">
              <button v-if="pode.corrigir" type="button" class="btn-secundario text-sm" @click="abrirCorrecao({ acao: 'forma_pagamento', titulo: 'Corrigir a forma de pagamento', campos: ['forma', 'motivo'], extra: { pagamentoId: p.id } }, { forma: p.forma })">Mudar forma</button>
              <button v-if="pode.gerente" type="button" class="btn-secundario text-sm" @click="abrirCorrecao({ acao: 'anular_pagamento', titulo: 'Anular pagamento', campos: ['motivo'], extra: { pagamentoId: p.id }, texto: 'Se a conta estava paga, ela volta a ficar aberta.' })">Anular</button>
            </template>
          </li>
        </ul>
      </div>

      <!-- pulseiras e linha do tempo -->
      <div class="grid gap-4 lg:grid-cols-2">
        <div class="card p-5">
          <p class="titulo-bloco">Pulseiras desta conta</p>
          <ul class="mt-2 space-y-1 text-sm">
            <li v-for="p in dados.pulseiras" :key="p.uid + p.inicioEm">
              <b>{{ p.uid }}</b> · de {{ dataHora(p.inicioEm) }}
              <span v-if="p.fimEm"> até {{ dataHora(p.fimEm) }} ({{ { paga: 'liberada no pagamento', perdida: 'perdida', trocada: 'trocada', encerrada: 'liberada no fim do dia', juntada: 'conta juntada' }[p.fimMotivo as string] ?? p.fimMotivo }})</span>
              <span v-else class="font-semibold text-ok"> · em uso agora</span>
            </li>
          </ul>
        </div>
        <div class="card p-5">
          <p class="titulo-bloco">Tudo o que aconteceu</p>
          <ol class="mt-2 max-h-80 space-y-2 overflow-y-auto text-sm">
            <li v-for="(h, n) in dados.historico" :key="n">
              <p class="text-xs text-ink-600">{{ dataHora(h.quando) }} · {{ h.quem ?? 'sistema' }}<span v-if="h.aparelho"> · {{ h.aparelho }}</span></p>
              <p>{{ h.descricao }}</p>
            </li>
          </ol>
        </div>
      </div>
    </template>

    <!-- janela de correção -->
    <ModalLateral v-if="correcao" :titulo="correcao.titulo" @fechar="correcao = null">
      <form class="space-y-4" @submit.prevent="enviarCorrecao">
        <p v-if="correcao.texto" class="faixa-aviso">{{ correcao.texto }}</p>
        <label v-if="correcao.campos.includes('uid')" class="block">
          <span class="rotulo">Número da pulseira NOVA</span>
          <input v-model="form.uid" class="campo" inputmode="numeric" placeholder="Encoste a pulseira nova no leitor ou digite">
        </label>
        <label v-if="correcao.campos.includes('perdida')" class="flex items-center gap-2">
          <input v-model="form.perdida" type="checkbox" class="h-5 w-5"> A antiga foi perdida (bloquear para ninguém usar)
        </label>
        <label v-if="correcao.campos.includes('destino')" class="block">
          <span class="rotulo">Conta de destino (número da conta ou da pulseira)</span>
          <input v-model="form.destino" class="campo" inputmode="numeric">
        </label>
        <label v-if="correcao.campos.includes('nome')" class="block">
          <span class="rotulo">Nome na conta</span>
          <input v-model="form.nome" class="campo">
        </label>
        <label v-if="correcao.campos.includes('observacao')" class="block">
          <span class="rotulo">Observação</span>
          <input v-model="form.observacao" class="campo">
        </label>
        <label v-if="correcao.campos.includes('quantidade')" class="block">
          <span class="rotulo">Quantidade certa</span>
          <input v-model.number="form.quantidade" type="number" min="1" max="999" class="campo">
        </label>
        <label v-if="correcao.campos.includes('novoItemId')" class="block">
          <span class="rotulo">Trocar por</span>
          <select v-model="form.novoItemId" class="campo">
            <option value="" disabled>Escolha o item</option>
            <option v-for="it in itensDoCardapio" :key="it.id" :value="it.id">{{ it.nome }} — {{ reais(it.precoCents) }}</option>
          </select>
        </label>
        <label v-if="correcao.campos.includes('descontoCents')" class="block">
          <span class="rotulo">Valor do desconto</span>
          <CampoMoeda v-model="form.descontoCents" />
        </label>
        <label v-if="correcao.campos.includes('limiteCents')" class="block">
          <span class="rotulo">Limite (R$ 0 = sem limite)</span>
          <CampoMoeda v-model="form.limiteCents" />
        </label>
        <label v-if="correcao.campos.includes('forma')" class="block">
          <span class="rotulo">Forma certa</span>
          <select v-model="form.forma" class="campo">
            <option v-for="(n, k) in FORMA" :key="k" :value="k">{{ n }}</option>
          </select>
        </label>
        <label class="block">
          <span class="rotulo">Motivo (fica registrado)</span>
          <input v-model="form.motivo" class="campo" required minlength="3" placeholder="Ex.: cliente desistiu, lançado errado…">
        </label>
        <label v-if="!pode.gerente && ['desconto_item','desconto_conta','limite','reabrir','perdoar','anular_pagamento'].includes(correcao.acao)" class="block">
          <span class="rotulo">PIN do gerente</span>
          <input v-model="form.pin" class="campo" type="password" inputmode="numeric" autocomplete="off">
        </label>
        <p v-if="erroForm" class="faixa-erro">{{ erroForm }}</p>
        <div class="flex gap-2">
          <button type="button" class="btn-secundario flex-1" @click="correcao = null">Voltar</button>
          <button type="submit" class="btn-primario flex-1" :disabled="enviando">{{ enviando ? 'Salvando…' : 'Confirmar' }}</button>
        </div>
      </form>
    </ModalLateral>
  </div>
</template>
