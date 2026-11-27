<script setup lang="ts">
/**
 * Fechar conta (055): o cliente paga na MAQUININHA do parque e aqui só se anota como pagou.
 *
 * Aceita dividir (parte no Pix, parte no cartão…) e, no dinheiro, calcula o troco. Recebe uma
 * ou várias contas (o "pagar tudo junto" do grupo): o valor de cada forma é distribuído conta
 * por conta, na ordem, e cada conta fecha com o saldo exato — a pulseira de cada uma é
 * liberada na hora (é o servidor que solta, em `pagar.post.ts`).
 */
import { chamar, mensagemDoErro } from '~/composables/comandaOffline'
import { reais } from '~/composables/formato'
import CampoMoeda from '~/components/CampoMoeda.vue'

interface ContaAPagar { id: string; numero: number; nome: string; faltaCents: number }
const props = defineProps<{ contas: ContaAPagar[] }>()
const emit = defineEmits<{ pago: [resultado: { trocoCents: number; contas: number }]; voltar: [] }>()

type Forma = 'pix' | 'debito' | 'credito' | 'dinheiro'
const FORMAS: { id: Forma; nome: string }[] = [
  { id: 'pix', nome: 'Pix' }, { id: 'debito', nome: 'Débito' }, { id: 'credito', nome: 'Crédito' }, { id: 'dinheiro', nome: 'Dinheiro' },
]
const total = computed(() => props.contas.reduce((s, c) => s + c.faltaCents, 0))
const linhas = ref<{ forma: Forma; valorCents: number; recebidoCents: number }[]>([])
const enviando = ref(false)
const erro = ref('')

const somado = computed(() => linhas.value.reduce((s, l) => s + l.valorCents, 0))
const falta = computed(() => total.value - somado.value)
const troco = computed(() => linhas.value.filter((l) => l.forma === 'dinheiro')
  .reduce((s, l) => s + Math.max(0, l.recebidoCents - l.valorCents), 0))
const dinheiroCurto = computed(() => linhas.value.some((l) => l.forma === 'dinheiro' && l.recebidoCents > 0 && l.recebidoCents < l.valorCents))

function adicionar(forma: Forma) {
  const resto = Math.max(0, falta.value)
  linhas.value.push({ forma, valorCents: resto, recebidoCents: forma === 'dinheiro' ? resto : 0 })
}
watch(() => props.contas, () => { linhas.value = [] }, { immediate: true })

async function confirmar() {
  erro.value = ''
  if (falta.value !== 0) { erro.value = falta.value > 0 ? `Ainda faltam ${reais(falta.value)}.` : `Passou ${reais(-falta.value)} do total.`; return }
  if (dinheiroCurto.value) { erro.value = 'O valor recebido em dinheiro é menor que o valor da parte em dinheiro.'; return }
  enviando.value = true
  // distribui as formas pelas contas, na ordem
  const fila = linhas.value.filter((l) => l.valorCents > 0).map((l) => ({ ...l, resta: l.valorCents }))
  try {
    for (const c of props.contas) {
      let precisa = c.faltaCents
      const pagamentos: { forma: Forma; valorCents: number; recebidoCents?: number }[] = []
      for (const l of fila) {
        if (!precisa) break
        if (!l.resta) continue
        const v = Math.min(precisa, l.resta)
        l.resta -= v
        precisa -= v
        const p: { forma: Forma; valorCents: number; recebidoCents?: number } = { forma: l.forma, valorCents: v }
        // o dinheiro entregue: a última fatia daquela nota leva o troco
        if (l.forma === 'dinheiro') p.recebidoCents = l.resta === 0 ? v + Math.max(0, l.recebidoCents - l.valorCents) : v
        pagamentos.push(p)
      }
      try {
        await chamar(`/api/comandas/conta/${c.id}/pagar`, { method: 'POST', body: { pagamentos, fechar: true } })
      } catch (e: any) {
        // já paga numa tentativa anterior (a rede caiu no meio do grupo): segue para a próxima
        if (e?.data?.data?.codigo !== 'ja_fechada') throw e
      }
    }
    emit('pago', { trocoCents: troco.value, contas: props.contas.length })
  } catch (e) {
    erro.value = mensagemDoErro(e)
  } finally {
    enviando.value = false
  }
}
</script>

<template>
  <div data-parte="pagamento" class="space-y-4">
    <div class="card p-5">
      <p class="rotulo-kpi">Total a pagar</p>
      <p class="numero-kpi mt-1 text-[40px]">{{ reais(total) }}</p>
      <ul v-if="contas.length > 1" class="mt-3 space-y-1 text-sm text-ink-700">
        <li v-for="c in contas" :key="c.id">Conta nº {{ c.numero }} — {{ c.nome }}: <b>{{ reais(c.faltaCents) }}</b></li>
      </ul>
      <p class="mt-3 text-sm text-ink-600">Passe na maquininha do parque e marque aqui como o cliente pagou. Pode dividir em mais de uma forma.</p>
    </div>

    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <button v-for="f in FORMAS" :key="f.id" type="button" class="btn-secundario min-h-[56px] text-base"
              :disabled="falta <= 0" @click="adicionar(f.id)">+ {{ f.nome }}</button>
    </div>

    <div v-for="(l, i) in linhas" :key="i" class="card flex flex-wrap items-end gap-3 p-4">
      <div class="min-w-[110px]">
        <p class="rotulo">Forma</p>
        <p class="titulo text-lg font-semibold">{{ FORMAS.find((f) => f.id === l.forma)?.nome }}</p>
      </div>
      <label class="flex-1">
        <span class="rotulo">Valor</span>
        <CampoMoeda v-model="l.valorCents" />
      </label>
      <label v-if="l.forma === 'dinheiro'" class="flex-1">
        <span class="rotulo">Recebeu em mãos</span>
        <CampoMoeda v-model="l.recebidoCents" />
      </label>
      <button type="button" class="btn-secundario" @click="linhas.splice(i, 1)">Tirar</button>
    </div>

    <div class="card flex flex-wrap items-center justify-between gap-3 p-4">
      <p :class="falta === 0 ? 'text-ok' : 'text-alerta'" class="titulo text-lg font-semibold">
        {{ falta === 0 ? 'Valor completo ✓' : falta > 0 ? `Falta ${reais(falta)}` : `Passou ${reais(-falta)}` }}
      </p>
      <p v-if="troco > 0" data-parte="troco" class="titulo text-2xl font-bold text-acao">Troco: {{ reais(troco) }}</p>
    </div>

    <p v-if="erro" class="faixa-erro">{{ erro }}</p>
    <div class="flex gap-3">
      <button type="button" class="btn-secundario min-h-[56px] flex-1" @click="emit('voltar')">Voltar</button>
      <button type="button" data-acao="confirmar-pagamento" class="btn-primario min-h-[56px] flex-[2] text-lg"
              :disabled="enviando || falta !== 0 || !linhas.length" @click="confirmar">
        {{ enviando ? 'Fechando…' : 'Confirmar pagamento e liberar pulseira' }}
      </button>
    </div>
  </div>
</template>
