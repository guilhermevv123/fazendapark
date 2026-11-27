<script setup lang="ts">
/**
 * Contas de hoje (055) — o que o atendente vê para resolver sozinho: achar o cliente pelo nome,
 * número ou pulseira, abrir a conta, receber e trocar pulseira perdida. Sem total vendido do dia
 * e sem outros dias.
 */
import { chamar, estado, mensagemDoErro, sincronizar } from '~/composables/comandaOffline'
import { bip } from '~/composables/comandaLeitor'
import { reais } from '~/composables/formato'
import ComandaConta from '~/components/comanda/Conta.vue'
import ComandaPagamento from '~/components/comanda/Pagamento.vue'

const SITUACAO: Record<string, [string, string]> = {
  aberta: ['Aberta', 'selo-alerta'], paga: ['Paga', 'selo-ok'], paga_depois: ['Pagou depois', 'selo-ok'],
  nao_paga: ['Saiu sem pagar', 'selo-erro'], cobrada: ['Cobrada', 'selo-erro'], perdoada: ['Perdoada', 'selo-neutro'],
}
const FILTROS = [{ id: 'abertas', nome: 'Abertas' }, { id: 'pagas', nome: 'Pagas' }, { id: 'todas', nome: 'Todas' }]

const contas = ref<any[]>([])
const busca = ref('')
const filtro = ref('abertas')
const erro = ref('')
const carregando = ref(true)
let espera: ReturnType<typeof setTimeout> | undefined
async function carregar() {
  try {
    contas.value = (await chamar<any>('/api/comandas/hoje', { query: { q: busca.value.trim() || undefined } })).contas
    erro.value = ''
  } catch (e) { erro.value = mensagemDoErro(e) } finally { carregando.value = false }
}
watch(busca, () => { clearTimeout(espera); espera = setTimeout(carregar, 300) })
let laco: ReturnType<typeof setInterval> | undefined
onMounted(() => { carregar(); laco = setInterval(() => { if (!contaId.value) carregar() }, 20_000) })
onBeforeUnmount(() => { clearInterval(laco); clearTimeout(espera) })

const visiveis = computed(() => contas.value.filter((c) =>
  filtro.value === 'todas' || (filtro.value === 'abertas' ? c.situacao === 'aberta' : c.situacao !== 'aberta')))
const qtd = (id: string) => contas.value.filter((c) => id === 'todas' || (id === 'abertas' ? c.situacao === 'aberta' : c.situacao !== 'aberta')).length
const hora = (d: string) => new Date(d).toLocaleTimeString('pt-BR', { timeZone: 'America/Bahia', hour: '2-digit', minute: '2-digit' })

/* uma conta aberta na tela, e o pagamento dela */
const contaId = ref<string | null>(null)
const contaRef = ref<any>(null)
const aPagar = ref<any[] | null>(null)
const pago = ref('')
function fechar(conta: any) {
  aPagar.value = [{ id: conta.id, numero: conta.numero, nome: conta.nome, faltaCents: conta.faltaCents }]
}
async function fecharSemValor() {
  try {
    await chamar(`/api/comandas/conta/${aPagar.value![0].id}/pagar`, { method: 'POST', body: { pagamentos: [], fechar: true } })
    aoPagar()
  } catch (e) { erro.value = mensagemDoErro(e) }
}
function aoPagar() {
  bip('ok')
  pago.value = 'Pagamento registrado. A pulseira está livre.'
  aPagar.value = null
  contaRef.value?.carregar()
  sincronizar().catch(() => {})
  carregar()
}
function voltar() { contaId.value = null; aPagar.value = null; pago.value = ''; carregar() }
</script>

<template>
  <div class="mx-auto max-w-4xl space-y-4">
    <p v-if="erro" class="faixa-erro">{{ erro }}</p>

    <template v-if="contaId">
      <button type="button" class="btn-secundario" @click="voltar">← Voltar para a lista</button>
      <p v-if="pago" class="faixa-aviso font-semibold">{{ pago }}</p>
      <template v-if="aPagar">
        <div v-if="aPagar[0].faltaCents <= 0" class="card space-y-3 p-6 text-center">
          <p class="titulo text-xl font-bold">Nada a pagar</p>
          <button type="button" class="btn-primario w-full" @click="fecharSemValor">Fechar conta e liberar pulseira</button>
        </div>
        <ComandaPagamento v-else :contas="aPagar" @pago="aoPagar" @voltar="aPagar = null" />
      </template>
      <ComandaConta v-else :id="contaId" ref="contaRef" :itens-do-cardapio="estado?.itens" @fechar="fechar" />
    </template>

    <template v-else>
      <div class="card space-y-3 p-5">
        <div class="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p class="titulo-bloco">Contas de hoje</p>
            <p class="text-sm text-ink-600">Toque numa conta para ver o consumo, receber ou trocar a pulseira.</p>
          </div>
          <div class="grid w-full grid-cols-3 rounded-card border border-linha bg-white p-1 sm:inline-flex sm:w-auto">
            <button v-for="f in FILTROS" :key="f.id" type="button" class="min-h-[40px] rounded-card px-3 text-sm font-semibold transition"
                    :class="filtro === f.id ? 'bg-acao text-white' : 'text-ink-700 hover:bg-ink-50'" @click="filtro = f.id">
              {{ f.nome }} <span class="opacity-75">({{ qtd(f.id) }})</span>
            </button>
          </div>
        </div>
        <input v-model="busca" class="campo w-full" placeholder="Buscar por nome, nº da conta ou pulseira" aria-label="Buscar conta">
      </div>

      <div class="card overflow-hidden">
        <p v-if="carregando" class="p-6 text-center text-ink-600">Carregando…</p>
        <p v-else-if="!visiveis.length" class="p-6 text-center text-ink-600">Nenhuma conta {{ filtro === 'abertas' ? 'aberta' : '' }} {{ busca ? 'com essa busca' : 'hoje' }}.</p>
        <ul v-else class="divide-y divide-linha">
          <li v-for="c in visiveis" :key="c.id">
            <button type="button" class="flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition hover:bg-ink-50"
                    @click="contaId = c.id; pago = ''">
              <span class="min-w-0">
                <span class="block truncate font-semibold text-ink-900">{{ c.nome }}</span>
                <span class="block text-xs text-ink-600">Conta nº {{ c.numero }} · pulseira {{ c.pulseira ?? '—' }} · aberta às {{ hora(c.abertaEm) }}</span>
              </span>
              <span class="flex shrink-0 items-center gap-3">
                <span class="text-right">
                  <span class="block font-semibold tabular-nums">{{ reais(c.totalCents) }}</span>
                  <span v-if="c.faltaCents > 0" class="block text-xs text-danger-600">falta {{ reais(c.faltaCents) }}</span>
                </span>
                <span :class="SITUACAO[c.situacao]?.[1] ?? 'selo-neutro'">{{ SITUACAO[c.situacao]?.[0] ?? c.situacao }}</span>
              </span>
            </button>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
