<script setup lang="ts">
/**
 * /consumo/<token> — o cupom de consumação do Volte Mais (042). UMA página pra dois públicos:
 *
 *  · o CLIENTE abre pelo ingresso/e-mail: o cupom grande, relógio correndo (print parado se
 *    denuncia: o segundo não anda), o estado que o servidor responde agora, o QR e o código;
 *  · a ATENDENTE do bar aponta a câmera do celular dela pro QR — o app de câmera abre esta mesma
 *    página e, como ela está logada no painel (acesso de portaria), aparece embaixo a tela do caixa
 *    com o botão de dar baixa. Sem app, sem leitor: a câmera do celular basta.
 *
 * O relógio e a animação são reforço; a trava de verdade é o servidor dizer "JÁ USADO".
 */
import CaixaDoCupom from '~/components/CaixaDoCupom.vue'
import { diaDoCupomBR, salvarCupomComoImagem, type CupomNoCaixa } from '~/composables/cupomImagem'

const route = useRoute()
const token = String(route.params.token ?? '')
useHead({ title: 'Cupom do bar', meta: [{ name: 'robots', content: 'noindex' }] })

type CupomPublico = {
  estado: CupomNoCaixa['estado']; recado: string; consumacaoPct: number; dia: string; hoje: string
  codigo: string; programa: string; evento: string; pedido: string; titular: string | null
  diaTodo: boolean; usosMax: number; usos: { em: string }[]; restam: number | null; entrouHoje: boolean
}
const { data, error: falha, refresh } = await useFetch<CupomPublico>(`/api/consumo/${encodeURIComponent(token)}`, {
  key: `consumo-${token}`,
})

// a atendente logada: a versão do caixa (nome inteiro, CPF, botão). 401/403 = é o cliente.
const caixa = ref<CupomNoCaixa | null>(null)
async function lerComoCaixa() {
  try {
    caixa.value = (await $fetch<{ cupom: CupomNoCaixa }>('/api/admin/consumacao', { query: { token }, retry: 0 })).cupom
  } catch {
    caixa.value = null
  }
}

// relógio ao vivo: o segundo correndo é o que separa a tela de verdade de um print
// nasce vazio e liga no aparelho: hora do servidor ≠ hora do celular (hidratação)
const agora = ref<Date | null>(null)
let tique: ReturnType<typeof setInterval> | null = null
let releitura: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  lerComoCaixa()
  agora.value = new Date()
  tique = setInterval(() => { agora.value = new Date() }, 1000)
  // o cliente com a tela aberta vê o "JÁ USADO" aparecer sozinho depois da baixa
  releitura = setInterval(() => { if (!caixa.value) refresh() }, 15_000)
})
onBeforeUnmount(() => { if (tique) clearInterval(tique); if (releitura) clearInterval(releitura) })
const relogio = computed(() => !agora.value ? '--:--:--' : agora.value.toLocaleTimeString('pt-BR', { timeZone: 'America/Bahia', hour: '2-digit', minute: '2-digit', second: '2-digit' }))

function atualizadoNoCaixa(c: CupomNoCaixa) {
  caixa.value = c
  refresh()
}

const verde = computed(() => data.value?.estado === 'valido' || data.value?.estado === 'ativo')
const baixando = ref(false)
const recado = ref('')
async function baixar() {
  if (!data.value || baixando.value) return
  baixando.value = true
  recado.value = ''
  try {
    const r = await salvarCupomComoImagem({ token, codigo: data.value.codigo, consumacaoPct: data.value.consumacaoPct,
      dia: data.value.dia, programa: data.value.programa, evento: data.value.evento, titular: data.value.titular })
    if (r === 'baixado') recado.value = 'Imagem do cupom baixada.'
  } catch {
    recado.value = 'Não consegui gerar a imagem agora — tire um print desta tela ou anote o código.'
  } finally {
    baixando.value = false
  }
}
</script>

<template>
  <main class="min-h-dvh bg-sun-50 px-4 py-6">
    <div class="mx-auto grid w-full max-w-md gap-4">
      <div v-if="falha" class="card text-center" role="alert" data-parte="cupom-inexistente">
        <p class="titulo text-xl font-semibold text-tinta">Cupom não encontrado</p>
        <p class="mt-1 text-sm text-tinta-suave">Confira o link do seu ingresso ou do e-mail.</p>
      </div>

      <template v-else-if="data">
        <article class="overflow-hidden rounded-3xl border-[3px] border-dashed border-sun-400 bg-white" data-parte="cupom-publico" :data-estado="data.estado">
          <header class="bg-grape-700 px-5 py-3 text-center text-white">
            <p class="text-xs font-bold uppercase tracking-[0.14em]">Cliente {{ data.programa }}</p>
          </header>
          <div class="flex flex-col items-center px-6 pb-6 pt-5 text-center">
            <p class="titulo text-6xl font-extrabold leading-none text-tinta">{{ data.consumacaoPct }}%</p>
            <p class="mt-1 text-lg font-semibold text-tinta">de desconto no bar</p>
            <p class="mt-1 text-sm text-tinta-suave">{{ data.evento }} · {{ diaDoCupomBR(data.dia) }}</p>
            <p v-if="data.titular" class="mt-1 text-sm text-tinta-corpo">Titular: <strong>{{ data.titular }}</strong></p>

            <!-- o estado AGORA, com o relógio correndo e um pulso: print parado se denuncia -->
            <div class="mt-4 w-full rounded-2xl px-4 py-3 text-white"
                 :class="verde ? 'bg-success-600' : data.estado === 'antes_do_dia' ? 'bg-warning-600' : 'bg-danger-600'">
              <p class="flex items-center justify-center gap-2 text-2xl font-extrabold" data-parte="estado-publico">
                <span v-if="verde" class="relative flex size-3" aria-hidden="true">
                  <span class="absolute inline-flex size-full animate-ping rounded-full bg-white opacity-75" />
                  <span class="relative inline-flex size-3 rounded-full bg-white" />
                </span>
                {{ data.recado }}
              </p>
              <p class="mt-0.5 font-mono text-lg tabular-nums" data-parte="relogio" aria-live="off">{{ relogio }}</p>
              <p v-if="data.estado === 'usado' && data.usos.length" class="text-sm">usado às {{ data.usos[data.usos.length - 1]!.em }}</p>
              <p v-else-if="data.estado === 'ativo'" class="text-sm">ativado às {{ data.usos[0]?.em }} — vale o dia todo</p>
              <p v-else-if="data.estado === 'antes_do_dia'" class="text-sm">vale em {{ diaDoCupomBR(data.dia) }}</p>
            </div>

            <img :src="`/api/consumo/${token}/qr.png`" :alt="`QR do cupom ${data.codigo}`"
                 class="mt-4 h-52 w-52 rounded-2xl border border-sun-200 bg-white p-2">
            <p class="mt-3 font-mono text-2xl font-bold tracking-[0.3em] text-tinta" data-parte="codigo-publico">{{ data.codigo }}</p>
            <p class="mt-2 text-sm text-tinta-corpo">
              No caixa do bar, mostre esta tela e um documento com foto. O caixa escaneia o QR e dá a baixa.
            </p>
            <button type="button" class="btn-secundario mt-4 w-full justify-center" :disabled="baixando" data-parte="baixar-cupom" @click="baixar">
              {{ baixando ? 'Gerando…' : 'Baixar o cupom (imagem)' }}
            </button>
            <p v-if="recado" class="mt-2 text-xs text-tinta-suave" role="status">{{ recado }}</p>
          </div>
        </article>

        <!-- a atendente logada: a tela do caixa, com o botão de dar baixa -->
        <div v-if="caixa" data-parte="modo-caixa">
          <p class="mb-2 text-center text-xs font-bold uppercase tracking-[0.14em] text-grape-700">Caixa do bar</p>
          <CaixaDoCupom :cupom="caixa" @atualizado="atualizadoNoCaixa" />
        </div>
      </template>
    </div>
  </main>
</template>
