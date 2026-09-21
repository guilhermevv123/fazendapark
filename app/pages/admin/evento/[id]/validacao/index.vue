<script setup lang="ts">
/**
 * Leitor de entrada — a tela que roda com gente na fila.
 *
 * Três decisões que vieram de como a porta funciona de verdade:
 *
 * 1. O campo de código NUNCA perde o foco. Leitor de código de barras é um
 *    teclado: ele digita e dá Enter. Se o foco escapar pra outro lugar (um
 *    clique, um alerta), a próxima leitura some no vazio e o operador só
 *    descobre quando a fila para.
 *
 * 2. A resposta é GRANDE e colorida. Quem opera olha a tela de relance com o
 *    celular na mão; um texto de 14px dizendo "já usado" não é lido a tempo.
 *
 * 3. "Só conferir" existe porque perguntar é diferente de deixar entrar. O
 *    operador precisa poder checar um ingresso sem queimá-lo.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const codigo = ref('')
const gate = ref('')
const apenasConsultar = ref(false)
const lendo = ref(false)
const campo = ref<HTMLInputElement | null>(null)

type Resposta = {
  ok: boolean; resultado: string; mensagem: string; consulta?: boolean
  titular?: string | null; entrouEm?: string | null
  ingresso?: { titular: string | null; setor: string; lote: string; tipo: string | null }
}
const ultima = ref<Resposta | null>(null)
const historico = ref<(Resposta & { codigo: string; quando: Date })[]>([])

const { data, refresh } = await useFetch<any>(`/api/admin/evento/${id}/checkins`)

// Gate fica no navegador: é propriedade do PORTÃO, não do usuário. O mesmo
// login opera a portaria norte hoje e a sul amanhã, e o servidor não tem como
// adivinhar em qual das duas aquele tablet está.
onMounted(() => {
  gate.value = localStorage.getItem(`dt_gate_${id}`) ?? ''
  campo.value?.focus()
})
watch(gate, (v) => {
  try { localStorage.setItem(`dt_gate_${id}`, v) } catch { /* aba anônima */ }
})

const CLASSE: Record<string, string> = {
  ok: 'bg-ok text-white',
  ja_usado: 'bg-alerta text-white',
  invalido: 'bg-erro text-white',
  cancelado: 'bg-erro text-white',
  fora_da_sessao: 'bg-alerta text-white',
  evento_errado: 'bg-erro text-white',
}

async function ler() {
  const c = codigo.value.trim()
  if (!c || lendo.value) return
  lendo.value = true
  try {
    const r = await $fetch<Resposta>('/api/checkin', {
      method: 'POST',
      body: { qr: c, eventId: id, gate: gate.value || undefined,
              apenasConsultar: apenasConsultar.value },
    })
    ultima.value = r
    historico.value.unshift({ ...r, codigo: c, quando: new Date() })
    historico.value = historico.value.slice(0, 12)
    // Só repinta os contadores quando alguém realmente entrou — recontar a
    // cada leitura recusada bate no banco no pior momento possível.
    if (r.ok && !r.consulta) refresh()
  } catch (e: any) {
    ultima.value = { ok: false, resultado: 'invalido',
                     mensagem: e?.data?.statusMessage || 'Falha ao ler' }
  } finally {
    codigo.value = ''
    lendo.value = false
    // nextTick: o input só volta a existir depois do repintar
    nextTick(() => campo.value?.focus())
  }
}

useHead({ title: 'Leitor de entrada' })
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Leitor de entrada</h1>
        <p class="mt-1 text-tinta-suave">
          Leia o QR ou digite o código. O campo já fica no foco — pode apontar o leitor.
        </p>
      </div>
      <!-- o botão de histórico saiu: virou aba logo abaixo, e dois caminhos
           pro mesmo lugar na mesma altura da tela só fazem o operador
           hesitar -->
    </div>

    <AbasSecao :evento-id="id" />

    <div v-if="data" class="grid gap-3 sm:grid-cols-4">
      <div class="card">
        <p class="rotulo-kpi">Já entraram</p>
        <p class="numero-kpi mt-1">{{ data.resumo.entraram }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">de {{ data.resumo.aptos }} aptos</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Faltam entrar</p>
        <p class="numero-kpi mt-1">{{ data.resumo.faltam }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Comparecimento</p>
        <p class="numero-kpi mt-1">{{ data.resumo.comparecimentoPct }}%</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Recusadas</p>
        <p class="numero-kpi mt-1" :class="data.resumo.recusadas ? 'text-erro' : ''">
          {{ data.resumo.recusadas }}
        </p>
        <p class="mt-1 text-xs text-tinta-fraca">{{ data.resumo.leituras }} leituras no total</p>
      </div>
    </div>

    <div class="card mt-4">
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="ler">
        <div class="min-w-[280px] flex-1">
          <label for="cod" class="rotulo">Código do ingresso</label>
          <input id="cod" ref="campo" v-model="codigo" autocomplete="off"
                 class="campo font-mono text-lg tracking-wider"
                 placeholder="CON-XXXX-XXXX ou leitura do QR">
        </div>
        <div class="w-40">
          <label for="gate" class="rotulo">Portão</label>
          <input id="gate" v-model="gate" class="campo" placeholder="Norte, VIP…">
        </div>
        <button type="submit" class="btn-primario h-[42px] px-8" :disabled="lendo || !codigo.trim()">
          {{ lendo ? 'Lendo…' : 'Ler' }}
        </button>
      </form>
      <label class="mt-3 flex items-center gap-2 text-sm text-tinta-suave">
        <input v-model="apenasConsultar" type="checkbox" class="h-4 w-4 accent-acao">
        Só conferir (não marca entrada)
      </label>
    </div>

    <div v-if="ultima" class="mt-4 rounded-card px-6 py-8 text-center entra-resposta"
         :class="CLASSE[ultima.resultado] ?? 'bg-erro text-white'">
      <p class="titulo text-4xl font-bold">
        {{ ultima.consulta ? 'VÁLIDO' : ultima.ok ? 'PODE ENTRAR' : 'BARRADO' }}
      </p>
      <p class="mt-2 text-lg opacity-95">{{ ultima.mensagem }}</p>
      <p v-if="ultima.ingresso" class="mt-3 text-lg">
        <strong>{{ ultima.ingresso.titular || 'sem nome' }}</strong>
        · {{ ultima.ingresso.setor }} · {{ ultima.ingresso.lote }}
        <template v-if="ultima.ingresso.tipo"> · {{ ultima.ingresso.tipo }}</template>
      </p>
      <p v-else-if="ultima.titular" class="mt-3 text-lg"><strong>{{ ultima.titular }}</strong></p>
      <p v-if="ultima.entrouEm" class="mt-1 opacity-90">
        entrou em {{ new Date(ultima.entrouEm).toLocaleString('pt-BR') }}
      </p>
    </div>

    <div v-if="historico.length" class="card mt-4 p-0">
      <p class="titulo border-b border-linha px-4 py-3 text-sm font-bold text-tinta-rotulo">
        Últimas leituras nesta tela
      </p>
      <ul>
        <li v-for="(h, i) in historico" :key="i"
            class="flex items-center gap-3 border-b border-linha px-4 py-2 text-sm last:border-0">
          <span class="w-2.5 h-2.5 shrink-0 rounded-full"
                :class="h.ok ? 'bg-ok' : 'bg-erro'" />
          <span class="font-mono text-xs text-tinta-suave">{{ h.codigo }}</span>
          <span class="flex-1 text-tinta">{{ h.mensagem }}</span>
          <span class="text-xs text-tinta-fraca tabular-nums">
            {{ h.quando.toLocaleTimeString('pt-BR') }}
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
/* Sem <Transition>: com a aba em segundo plano o Vue deixa a entrada parada
   em opacidade 0 (o rAF congela) e a resposta some da tela. Animação de
   montagem em CSS puro roda de qualquer jeito. */
@keyframes entra-resposta-kf {
  from { transform: scale(.97); opacity: 0 }
  to   { transform: none;       opacity: 1 }
}
.entra-resposta { animation: entra-resposta-kf .14s ease-out both }
</style>
