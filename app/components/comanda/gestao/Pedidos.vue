<script setup lang="ts">
/**
 * Pedidos (055): todos os pedidos lançados, um por linha — quando, onde, quem lançou, pra
 * quem, mesa, pulseira, conta, itens e valor. Filtra por período, local, atendente,
 * busca e situação; tocar abre a ficha da conta.
 */
import { chamar, mensagemDoErro } from '~/composables/comandaOffline'
import { dataHora, diaLocal, diaLocalMais, reais } from '~/composables/formato'

const de = ref(diaLocal())
const ate = ref(diaLocal())
const ponto = ref('')
const atendente = ref('')
const busca = ref('')
const situacao = ref('')
const d = ref<any>(null)
const opcoes = ref<{ pontos: any[]; equipe: any[] }>({ pontos: [], equipe: [] })
const erro = ref('')

async function carregar() {
  try {
    d.value = await chamar<any>('/api/comandas/gestao/pedidos', { query: {
      de: de.value, ate: ate.value, ponto: ponto.value || undefined, atendente: atendente.value || undefined,
      q: busca.value.trim() || undefined, situacao: situacao.value || undefined } })
    erro.value = ''
  } catch (e) { erro.value = mensagemDoErro(e) }
}
let espera: ReturnType<typeof setTimeout> | undefined
watch([de, ate, ponto, atendente, situacao], carregar, { immediate: true })
watch(busca, () => { clearTimeout(espera); espera = setTimeout(carregar, 350) })
onMounted(async () => {
  try {
    const [c, e] = await Promise.all([chamar<any>('/api/comandas/cardapio'), chamar<any>('/api/comandas/equipe')])
    opcoes.value = { pontos: c.pontos, equipe: e.pessoas ?? [] }
  } catch { /* filtros de local e atendente ficam vazios */ }
})

const total = computed(() => (d.value?.pedidos ?? []).reduce((s: number, p: any) => s + p.valorCents, 0))
const aberto = ref<string | null>(null)
const SIT: Record<string, string> = { aberta: 'aberta', paga: 'paga', paga_depois: 'paga depois', nao_paga: 'não paga', cobrada: 'cobrada', perdoada: 'perdoada', juntada: 'juntada' }
const corSit = (s: string) => s === 'paga' || s === 'paga_depois' ? 'selo-ok' : s === 'aberta' ? 'selo-neutro' : 'selo-erro'
</script>

<template>
  <div class="space-y-4">
    <div class="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
      <label class="block"><span class="rotulo">De</span><input v-model="de" type="date" class="campo"></label>
      <label class="block"><span class="rotulo">Até</span><input v-model="ate" type="date" class="campo"></label>
      <label class="block"><span class="rotulo">Local</span>
        <select v-model="ponto" class="campo"><option value="">Todos</option><option v-for="p in opcoes.pontos" :key="p.id" :value="p.id">{{ p.nome }}</option></select></label>
      <label class="block"><span class="rotulo">Atendente</span>
        <select v-model="atendente" class="campo"><option value="">Todos</option><option v-for="p in opcoes.equipe" :key="p.id" :value="p.id">{{ p.nome ?? p.name }}</option></select></label>
      <label class="block"><span class="rotulo">Mostrar</span>
        <select v-model="situacao" class="campo"><option value="">Todos os pedidos</option><option value="cancelado">Com item cancelado</option>
          <option value="sem_internet">Feitos sem internet</option><option value="depois_de_fechada">Chegaram após fechar</option></select></label>
      <label class="block"><span class="rotulo">Buscar</span><input v-model="busca" class="campo" placeholder="Cliente, mesa, item, pulseira"></label>
    </div>
    <div class="flex flex-wrap gap-2">
      <button type="button" class="chip" @click="de = diaLocal(); ate = diaLocal()">Hoje</button>
      <button type="button" class="chip" @click="de = diaLocalMais(-1); ate = diaLocalMais(-1)">Ontem</button>
      <button type="button" class="chip" @click="de = diaLocalMais(-6); ate = diaLocal()">7 dias</button>
    </div>
    <p v-if="erro" class="faixa-erro">{{ erro }}</p>

    <div v-if="d" class="card overflow-hidden">
      <div class="flex flex-wrap justify-between gap-2 border-b border-linha px-5 py-3 text-sm">
        <span><b>{{ d.pedidos.length }}</b> pedido(s)<span v-if="d.pedidos.length >= d.limite"> (mostrando os {{ d.limite }} mais novos)</span></span>
        <span>Total: <b class="tabular-nums">{{ reais(total) }}</b></span>
      </div>
      <p v-if="!d.pedidos.length" class="p-8 text-center text-ink-600">Nenhum pedido com esses filtros.</p>
      <ul class="divide-y divide-linha">
        <li v-for="p in d.pedidos" :key="p.id">
          <button type="button" class="flex w-full flex-wrap items-start gap-x-4 gap-y-1 px-5 py-3 text-left hover:bg-ink-50" @click="aberto = aberto === p.id ? null : p.id">
            <span class="w-28 shrink-0 text-sm text-ink-600">{{ dataHora(p.feitoEm) }}</span>
            <span class="min-w-[180px] flex-1">
              <b>{{ p.cliente || p.contaNome }}</b><span v-if="p.mesa" class="text-ink-700"> · {{ p.mesa }}</span>
              <span class="block text-xs text-ink-600">{{ p.itens.filter((i: any) => !i.cancelado).map((i: any) => `${i.quantidade}× ${i.nome}`).join(', ') || 'tudo cancelado' }}</span>
            </span>
            <span class="w-36 text-sm">{{ p.ponto ?? 'Sem local' }}<span class="block text-xs text-ink-600">por {{ p.atendente ?? '—' }}</span></span>
            <span class="flex flex-wrap gap-1">
              <span v-if="p.semInternet" class="selo-alerta">sem internet</span>
              <span v-if="p.depoisDeFechada" class="selo-erro">após fechar</span>
              <span v-if="p.temCancelado" class="selo-erro">cancelado</span>
            </span>
            <b class="ml-auto w-24 text-right tabular-nums">{{ reais(p.valorCents) }}</b>
          </button>
          <div v-if="aberto === p.id" class="space-y-3 bg-ink-50 px-5 py-4 text-sm">
            <div class="grid gap-2 sm:grid-cols-3">
              <p><span class="text-ink-600">Conta:</span> <b>nº {{ p.numero }} · {{ p.contaNome }}</b> <span :class="corSit(p.contaSituacao)">{{ SIT[p.contaSituacao] ?? p.contaSituacao }}</span></p>
              <p><span class="text-ink-600">Pulseira:</span> {{ p.pulseira ?? '—' }}</p>
              <p><span class="text-ink-600">Feito:</span> {{ dataHora(p.feitoEm) }} <span v-if="p.semInternet" class="text-ink-600">(chegou {{ dataHora(p.recebidoEm) }})</span></p>
              <p v-if="p.liberadoPor"><span class="text-ink-600">Liberado por:</span> {{ p.liberadoPor }}</p>
              <p v-if="p.observacao" class="sm:col-span-2"><span class="text-ink-600">Observação:</span> {{ p.observacao }}</p>
            </div>
            <table class="w-full">
              <tbody class="divide-y divide-linha">
                <tr v-for="(i, n) in p.itens" :key="n" :class="i.cancelado ? 'text-ink-500 line-through' : ''">
                  <td class="py-1.5">{{ i.quantidade }}× {{ i.nome }}<span v-if="i.cancelado && i.motivo" class="ml-1 no-underline"> — {{ i.motivo }}</span></td>
                  <td class="text-right tabular-nums">{{ reais(i.precoCents) }} un.</td>
                  <td class="text-right tabular-nums">{{ i.descontoCents ? `− ${reais(i.descontoCents)}` : '' }}</td>
                  <td class="w-24 text-right font-semibold tabular-nums">{{ reais(i.precoCents * i.quantidade - i.descontoCents) }}</td>
                </tr>
              </tbody>
            </table>
            <NuxtLink :to="`/admin/comandas/conta/${p.comandaId}`" class="btn-secundario inline-flex">Abrir a conta completa</NuxtLink>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
