<script setup lang="ts">
/**
 * Comandas pelo LINK do funcionário (055). Fora do painel e sem login do sistema: o segredo
 * da URL e o PIN do funcionário vão em cada chamada (`x-comanda-link`, `x-comanda-pin`), e o
 * servidor só deixa Atender, Pagar e as contas de hoje (`server/middleware/04.comandas.ts`).
 * O link sozinho não abre: sem o PIN, só aparece o teclado. O gerente desliga o link na Gestão.
 *
 * Feita para TABLET (uso principal) e celular: abas grandes de tocar; no tablet, cabeçalho numa
 * linha só; no celular, as abas descem para uma linha própria, de ponta a ponta.
 */
import { chamar, faixaLarga, linkDoFuncionario, mensagemDoErro, pinDoFuncionario } from '~/composables/comandaOffline'
import ComandaSituacao from '~/components/comanda/Situacao.vue'
import ComandaAtender from '~/components/comanda/Atender.vue'
import ComandaPagar from '~/components/comanda/Pagar.vue'
import ComandaHoje from '~/components/comanda/Hoje.vue'

definePageMeta({ layout: false })
useHead({
  title: 'Comandas — Atendimento',
  meta: [
    { name: 'robots', content: 'noindex' },
    { name: 'referrer', content: 'no-referrer' },
    { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
  ],
})

const route = useRoute()
const segredo = String(route.params.segredo ?? '')
linkDoFuncionario.value = segredo

/* ------------------------------------------------------------------ PIN */
// o PIN fica só nesta aba do navegador e vale 12 h (um turno); "Sair" apaga na hora
const CHAVE = `dt_comanda_pin_${segredo.slice(0, 10)}`
const DOZE_HORAS = 12 * 60 * 60_000
const entrou = ref(false)
const quem = ref('')
const digitado = ref('')
const erroPin = ref('')
const conferindo = ref(false)
const travado = ref(false)

function lembrado(): string | null {
  try {
    const g = JSON.parse(sessionStorage.getItem(CHAVE) ?? 'null')
    return g && Date.now() - g.em < DOZE_HORAS ? g.pin : null
  } catch { return null }
}
async function entrar(pin: string, silencioso = false) {
  conferindo.value = true
  pinDoFuncionario.value = pin
  try {
    const e = await chamar<any>('/api/comandas/estado')
    quem.value = e.eu?.nome ?? ''
    try { sessionStorage.setItem(CHAVE, JSON.stringify({ pin, em: Date.now() })) } catch { /* sem storage */ }
    entrou.value = true
    erroPin.value = ''
  } catch (e: any) {
    pinDoFuncionario.value = null
    try { sessionStorage.removeItem(CHAVE) } catch { /* sem storage */ }
    const codigo = e?.data?.data?.codigo
    travado.value = codigo === 'pin_travado' || codigo === 'link' || codigo === 'link_sem_pin'
    if (!silencioso || travado.value) erroPin.value = mensagemDoErro(e, 'Não consegui conferir agora. Veja a internet e tente de novo.')
  } finally {
    digitado.value = ''
    conferindo.value = false
  }
}
function tecla(t: string) {
  if (conferindo.value) return
  erroPin.value = ''
  if (t === 'apagar') { digitado.value = digitado.value.slice(0, -1); return }
  if (digitado.value.length >= 4) return
  digitado.value += t
  if (digitado.value.length === 4) entrar(digitado.value)
}
// teclado físico (ou o do celular) também digita o PIN
function porTeclado(ev: KeyboardEvent) {
  if (entrou.value) return
  if (/^\d$/.test(ev.key)) tecla(ev.key)
  else if (ev.key === 'Backspace') tecla('apagar')
}
function sair() {
  try { sessionStorage.removeItem(CHAVE) } catch { /* sem storage */ }
  pinDoFuncionario.value = null
  entrou.value = false
  quem.value = ''
}
onMounted(() => {
  window.addEventListener('keydown', porTeclado)
  const pin = lembrado()
  if (pin) entrar(pin, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', porTeclado)
  linkDoFuncionario.value = null
  pinDoFuncionario.value = null
})

/* ------------------------------------------------------------------ abas */
const ABAS = [{ id: 'atender', nome: 'Atender' }, { id: 'pagar', nome: 'Pagar' }, { id: 'hoje', nome: 'Contas de hoje', curto: 'Hoje' }]
const aba = computed(() => ABAS.find((a) => a.id === route.query.aba)?.id ?? 'atender')
// uma largura só para o cabeçalho e o conteúdo: tudo alinhado nas duas bordas
const coluna = computed(() => aba.value === 'atender' && faixaLarga.value ? 'max-w-6xl' : 'max-w-4xl')
const TECLAS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'apagar']
</script>

<template>
  <div class="min-h-screen bg-fundo-cinza">
    <ClientOnly>
      <!-- PIN -->
      <div v-if="!entrou" class="flex min-h-screen items-center justify-center p-4">
        <div class="card w-full max-w-sm p-6 text-center sm:p-8">
          <span class="mx-auto flex h-12 w-12 items-center justify-center rounded-card bg-acao text-base font-bold text-white">CP</span>
          <p class="titulo mt-4 text-xl font-bold">Comandas · Conquista Park</p>
          <p class="mt-1 text-sm text-ink-600">Digite o seu PIN de 4 números para começar.</p>

          <div class="mt-6 flex justify-center gap-3" aria-live="polite" :aria-label="`${digitado.length} de 4 números`">
            <span v-for="i in 4" :key="i" class="h-4 w-4 rounded-full border-2 transition"
                  :class="i <= digitado.length ? 'border-acao bg-acao' : 'border-linha-forte bg-white'" />
          </div>
          <p class="mt-4 min-h-[40px] text-sm" :class="erroPin ? 'font-semibold text-danger-600' : 'text-ink-600'">
            {{ conferindo ? 'Conferindo…' : erroPin }}
          </p>

          <div class="mt-2 grid grid-cols-3 gap-3">
            <template v-for="t in TECLAS" :key="t || 'vazio'">
              <span v-if="!t" />
              <button v-else type="button" :disabled="conferindo || travado"
                      class="flex h-16 items-center justify-center rounded-card border border-linha bg-white text-2xl font-semibold text-ink-900 transition active:scale-95 active:bg-acao-claro disabled:opacity-40"
                      :aria-label="t === 'apagar' ? 'Apagar' : t" @click="tecla(t)">
                <svg v-if="t === 'apagar'" viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 5H9l-6 7 6 7h12a1 1 0 001-1V6a1 1 0 00-1-1zM17 9l-6 6M11 9l6 6" /></svg>
                <template v-else>{{ t }}</template>
              </button>
            </template>
          </div>
          <p class="mt-5 text-xs text-ink-600">Esqueceu o PIN? Peça ao gerente um link novo.</p>
        </div>
      </div>

      <!-- COMANDAS -->
      <template v-else>
        <header class="sticky top-0 z-30 border-b border-linha bg-white/95 backdrop-blur">
          <div class="mx-auto px-4" :class="coluna">
            <div class="flex items-center justify-between gap-3 py-3">
              <div class="flex min-w-0 items-center gap-2.5">
                <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-acao text-sm font-bold text-white">CP</span>
                <span class="min-w-0 leading-tight">
                  <span class="block truncate text-sm font-bold text-ink-900">Comandas</span>
                  <span class="block truncate text-xs text-ink-600">Conquista Park</span>
                </span>
              </div>
              <!-- tablet: as abas ficam no meio do cabeçalho -->
              <nav class="hidden rounded-card bg-ink-50 p-1 md:flex" aria-label="Comandas">
                <NuxtLink v-for="a in ABAS" :key="a.id" :to="{ query: a.id === 'atender' ? {} : { aba: a.id } }"
                          class="flex min-h-[48px] items-center whitespace-nowrap rounded-card px-6 text-base font-semibold transition"
                          :class="aba === a.id ? 'bg-white text-acao shadow-sm' : 'text-ink-600 hover:text-ink-900'">{{ a.nome }}</NuxtLink>
              </nav>
              <div class="flex shrink-0 items-center gap-2">
                <span class="hidden text-right leading-tight sm:block">
                  <span class="block text-sm font-semibold text-ink-900">{{ quem }}</span>
                  <span class="block text-xs text-ink-600">Atendente</span>
                </span>
                <button type="button" class="btn-secundario min-h-[44px] px-3 text-sm" @click="sair">Sair</button>
              </div>
            </div>
            <!-- celular: as abas ganham uma linha só delas -->
            <nav class="grid grid-cols-3 gap-1 rounded-card bg-ink-50 p-1 mb-3 md:hidden" aria-label="Comandas">
              <NuxtLink v-for="a in ABAS" :key="a.id" :to="{ query: a.id === 'atender' ? {} : { aba: a.id } }"
                        class="flex min-h-[44px] items-center justify-center rounded-card text-[15px] font-semibold transition"
                        :class="aba === a.id ? 'bg-white text-acao shadow-sm' : 'text-ink-600'">{{ a.curto ?? a.nome }}</NuxtLink>
            </nav>
          </div>
        </header>

        <main class="mx-auto px-3 py-4 sm:px-4 sm:py-5" :class="coluna">
          <ComandaSituacao>
            <ComandaAtender v-if="aba === 'atender'" />
            <ComandaPagar v-else-if="aba === 'pagar'" />
            <ComandaHoje v-else />
          </ComandaSituacao>
        </main>
      </template>
    </ClientOnly>
  </div>
</template>
