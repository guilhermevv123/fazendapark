<script setup lang="ts">
/**
 * Reagendar um ingresso (dono, 30/09): a pessoa escolhe outro dia/ingresso que o parque tem à
 * venda e troca o dela. Chega aqui pelo botão "Reagendar" do bilhete (`/ingressos/<pedido>`).
 *
 * Só com a conta logada, e só ingresso DESTA conta — a rota recusa o resto. As regras (mesmo
 * tipo, não custar mais do que foi pago, antes de o dia começar…) moram em
 * `server/utils/reagendamento.ts`; a tela só mostra o que a rota devolveu.
 */
import { dataNoFuso } from '~/composables/carrinhoDaVitrine'
import { useContaDoCliente } from '~/composables/contaDoCliente'
import { diaDaSemana } from '~/composables/formato'

const route = useRoute()
const ingressoId = String(route.params.ingresso ?? '')
const { estado, abrir, garantir } = useContaDoCliente()
const conta = computed(() => estado.value.conta)

const dados = ref<any | null>(null)
const carregando = ref(true)
const falha = ref<string | null>(null)
/** a rota respondeu "em manutenção" (503, dono 05/10): a tela diz isso e mais nada */
const manutencao = ref<string | null>(null)

async function carregar() {
  carregando.value = true
  falha.value = null
  try {
    dados.value = await $fetch(`/api/reagendamento/${encodeURIComponent(ingressoId)}`)
  } catch (e: any) {
    if (e?.statusCode === 503 && e?.data?.data?.tipo === 'manutencao') {
      manutencao.value = e?.data?.statusMessage || 'O reagendamento pelo site está em manutenção.'
    } else if (e?.statusCode === 401) {
      dados.value = null
      abrir('entrar', 'Entre na sua conta para reagendar o ingresso.')
    } else {
      falha.value = e?.data?.statusMessage || 'Não deu pra carregar agora. Tente de novo em instantes.'
    }
  } finally {
    carregando.value = false
  }
}

onMounted(async () => {
  const s = await garantir()
  if (!s.conta) {
    // em manutenção a rota responde antes de olhar o login: não pede pra entrar à toa
    await carregar()
    if (manutencao.value) return
    carregando.value = false
    abrir('entrar', 'Entre na sua conta para reagendar o ingresso.')
    return
  }
  await carregar()
})
// entrou pela janela da conta: carrega na hora (sem repetir a carga do onMounted)
watch(conta, (c, antes) => { if (c && !antes && !dados.value && !carregando.value) carregar() })

/** As opções agrupadas por DIA (cada dia é um evento). */
const dias = computed(() => {
  const grupos = new Map<string, { eventoId: string; evento: string; inicio: string; fuso: string | null; opcoes: any[] }>()
  for (const o of dados.value?.opcoes ?? []) {
    if (!grupos.has(o.eventoId)) {
      grupos.set(o.eventoId, { eventoId: o.eventoId, evento: o.evento, inicio: o.inicio, fuso: o.fuso, opcoes: [] })
    }
    grupos.get(o.eventoId)!.opcoes.push(o)
  }
  return [...grupos.values()]
})

const escolha = ref<{ loteId: string; tipoId: string } | null>(null)
const escolhida = computed(() => (dados.value?.opcoes ?? [])
  .find((o: any) => o.loteId === escolha.value?.loteId && o.tipoId === escolha.value?.tipoId) ?? null)
const chave = (o: any) => `${o.loteId}|${o.tipoId}`

const confirmando = ref(false)
const enviando = ref(false)
const erroTroca = ref<string | null>(null)

async function trocar() {
  if (!escolha.value || enviando.value) return
  enviando.value = true
  erroTroca.value = null
  try {
    const r: any = await $fetch(`/api/reagendamento/${encodeURIComponent(ingressoId)}`, {
      method: 'POST', body: escolha.value,
    })
    await navigateTo(`/ingressos/${encodeURIComponent(r.pedido)}`)
  } catch (e: any) {
    if (e?.statusCode === 401) return void abrir('entrar', 'Sua sessão terminou. Entre de novo para reagendar.')
    erroTroca.value = e?.data?.statusMessage || 'Não deu pra trocar agora. Tente de novo.'
    confirmando.value = false
    await carregar() // a opção pode ter esgotado: a lista volta atualizada
  } finally {
    enviando.value = false
  }
}

/** "Sábado" — o dia da semana pela régua da casa (`formato.ts`). */
const semana = (v: string, _fuso?: string | null) => {
  const s = diaDaSemana(v, '')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

useHead({ title: 'Reagendar ingresso' })
</script>

<template>
  <div class="min-h-screen">
    <CabecalhoPublico largura="max-w-3xl" />

    <div class="mx-auto max-w-3xl px-4 py-6">
      <NuxtLink v-if="dados?.ingresso" :to="`/ingressos/${dados.ingresso.pedido}`"
                class="text-sm font-semibold text-pool-700 hover:underline">
        ← Voltar para o ingresso
      </NuxtLink>
      <h1 class="titulo mt-2 text-2xl font-semibold text-tinta sm:text-3xl">Reagendar ingresso</h1>
      <p v-if="!manutencao" class="mt-1 text-tinta-suave">Escolha outro dia. O ingresso atual é trocado pelo novo, sem custo.</p>

      <p v-if="carregando" class="mt-8 text-tinta-suave" role="status">Carregando os dias disponíveis…</p>

      <section v-else-if="manutencao" class="card mt-6 text-center" data-parte="reagendar-manutencao">
        <span class="mx-auto grid size-14 place-items-center rounded-2xl bg-sun-100 text-sun-800" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
        </span>
        <h2 class="titulo mt-4 text-xl font-semibold text-tinta">Reagendamento em manutenção</h2>
        <p class="mt-2 text-tinta-corpo">{{ manutencao }}</p>
        <button type="button" class="btn-secundario mt-6 justify-center py-3" @click="$router.back()">Voltar</button>
      </section>

      <div v-else-if="!conta" class="card mt-6 text-center">
        <p class="font-semibold text-tinta">Entre na sua conta para reagendar.</p>
        <button type="button" class="btn-cta mt-4 py-3" @click="abrir('entrar', null)">Entrar</button>
      </div>

      <div v-else-if="falha" class="faixa-erro mt-6" role="alert">
        {{ falha }}
        <button type="button" class="btn-secundario ml-2 py-1.5 text-sm" @click="carregar()">Tentar de novo</button>
      </div>

      <template v-else-if="dados">
        <!-- o ingresso de hoje -->
        <section class="card mt-6" data-parte="ingresso-atual">
          <p class="rotulo">Seu ingresso</p>
          <p class="titulo mt-1 text-lg font-semibold text-tinta">{{ dados.ingresso.evento }}</p>
          <p class="text-sm text-tinta-suave">
            {{ semana(dados.ingresso.inicio, dados.ingresso.fuso) }}, {{ dataNoFuso(dados.ingresso.inicio, dados.ingresso.fuso) }}
          </p>
          <p class="mt-1 text-sm text-tinta-corpo">
            {{ dados.ingresso.tipo ?? 'Ingresso' }} · {{ dados.ingresso.setor }}
            <span class="font-mono text-tinta-suave"> · {{ dados.ingresso.codigo }}</span>
          </p>
        </section>

        <p v-if="dados.motivo" class="faixa-aviso mt-4" role="alert">{{ dados.motivo }}</p>

        <template v-else>
          <p v-if="erroTroca" class="faixa-erro mt-4" role="alert">{{ erroTroca }}</p>

          <div v-if="!dias.length" class="card mt-4 text-center">
            <p class="font-semibold text-tinta">Nenhum outro dia disponível para troca agora.</p>
            <p class="mt-1 text-sm text-tinta-suave">
              Assim que o parque abrir novas datas, elas aparecem aqui. Seu ingresso atual continua valendo.
            </p>
          </div>

          <!-- os dias -->
          <section v-for="d in dias" :key="d.eventoId" class="mt-5" data-parte="dia-de-troca">
            <h2 class="titulo text-lg font-semibold text-tinta">
              {{ semana(d.inicio, d.fuso) }} · {{ dataNoFuso(d.inicio, d.fuso) }}
            </h2>
            <p class="text-sm text-tinta-suave">{{ d.evento }}</p>
            <div class="mt-2 grid gap-2 sm:grid-cols-2">
              <label v-for="o in d.opcoes" :key="chave(o)"
                     class="flex cursor-pointer items-center gap-3 rounded-xl bg-white p-4 ring-1 ring-inset transition-colors"
                     :class="escolha && chave(escolha) === chave(o) ? 'ring-2 ring-pool-600 bg-pool-50' : 'ring-ink-200 hover:ring-pool-300'">
                <input v-model="escolha" type="radio" name="opcao" class="size-4 accent-pool-600"
                       :value="{ loteId: o.loteId, tipoId: o.tipoId }">
                <span class="min-w-0 flex-1">
                  <span class="block font-semibold text-tinta">{{ o.tipo }}</span>
                  <span class="block text-sm text-tinta-suave">{{ o.setor }} · {{ o.lote }}</span>
                </span>
                <span class="selo-ok shrink-0">Sem custo</span>
              </label>
            </div>
          </section>

          <!-- confirmar -->
          <div v-if="dias.length" class="sticky bottom-0 mt-6 bg-fundo/95 py-4 backdrop-blur">
            <div v-if="confirmando && escolhida" class="card" role="alertdialog" aria-labelledby="confirma-troca">
              <p id="confirma-troca" class="font-semibold text-tinta">Confirmar a troca?</p>
              <p class="mt-1 text-sm text-tinta-corpo">
                O ingresso de <strong>{{ dataNoFuso(dados.ingresso.inicio, dados.ingresso.fuso) }}</strong> será cancelado
                e você recebe um novo para <strong>{{ semana(escolhida.inicio, escolhida.fuso) }}, {{ dataNoFuso(escolhida.inicio, escolhida.fuso) }}</strong>
                ({{ escolhida.tipo }}). O QR antigo deixa de valer. A troca não pode ser desfeita.
              </p>
              <div class="mt-3 grid grid-cols-2 gap-2">
                <button type="button" class="btn-secundario justify-center" :disabled="enviando" @click="confirmando = false">
                  Voltar
                </button>
                <button type="button" class="btn-primario justify-center" :disabled="enviando" @click="trocar()">
                  {{ enviando ? 'Trocando…' : 'Confirmar troca' }}
                </button>
              </div>
            </div>
            <button v-else type="button" class="btn-cta w-full justify-center py-3.5"
                    :disabled="!escolha" @click="confirmando = true">
              {{ escolha ? 'Reagendar para este dia' : 'Escolha um dia acima' }}
            </button>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>
