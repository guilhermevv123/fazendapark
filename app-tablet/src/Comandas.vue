<script setup lang="ts">
/**
 * O app do tablet das Comandas (055): login do funcionário e as telas dele (Atender, Pagar e
 * as contas de hoje). Substitui a página `/comanda/<link>` do navegador, que saiu.
 *
 * O login tem dois passos:
 *  1. o CÓDIGO do funcionário: lido do QR do crachá (câmera) ou colado (o gerente cria na
 *     Gestão → Funcionários do app). Fica guardado no tablet até alguém tocar em "Trocar
 *     funcionário";
 *  2. o PIN de 4 números, que só ele sabe. Vale 12 h (um turno); "Sair" apaga na hora.
 *
 * O servidor confere os dois em CADA chamada (`x-comanda-link`, `x-comanda-pin`) e só deixa
 * Atender, Pagar e as contas de hoje (`server/middleware/04.comandas.ts`). As telas são as
 * mesmas do site (`~/components/comanda/*`).
 */
import { chamar, faixaLarga, linkDoFuncionario, mensagemDoErro, pinDoFuncionario } from '~/composables/comandaOffline'
import LeitorCamera from '~/components/LeitorCamera.vue'
import ComandaSituacao from '~/components/comanda/Situacao.vue'
import ComandaAtender from '~/components/comanda/Atender.vue'
import ComandaPagar from '~/components/comanda/Pagar.vue'
import ComandaHoje from '~/components/comanda/Hoje.vue'
import Leitor from './Leitor.vue'
import { nfc } from './nfc'

const route = useRoute()

/* ------------------------------------------------------------------ guardado no tablet */
const CHAVE_CODIGO = 'cp_comanda_codigo'
const CHAVE_PIN = 'cp_comanda_pin'
const DOZE_HORAS = 12 * 60 * 60_000

function ler<T>(chave: string): T | null {
  try { return JSON.parse(localStorage.getItem(chave) ?? 'null') } catch { return null }
}
function gravar(chave: string, valor: unknown) {
  try { localStorage.setItem(chave, JSON.stringify(valor)) } catch { /* sem storage */ }
}
function apagar(chave: string) {
  try { localStorage.removeItem(chave) } catch { /* sem storage */ }
}

/**
 * Tira o código do que veio: o QR do crachá, o código colado ou o link antigo inteiro
 * (`https://…/comanda/<código>`). O código é o segredo de 32 letras do link (base64url).
 */
function codigoDe(texto: string): string | null {
  const t = texto.trim()
  const doLink = t.match(/\/comanda\/([A-Za-z0-9_-]{20,64})(?:[/?#]|$)/)
  if (doLink) return doLink[1]
  return /^[A-Za-z0-9_-]{20,64}$/.test(t) ? t : null
}

/* ------------------------------------------------------------------ passo 1: código */
const guardado = ler<{ codigo: string; nome?: string }>(CHAVE_CODIGO)
const codigo = ref(guardado?.codigo ?? '')
const nomeGuardado = ref(guardado?.nome ?? '')
const colado = ref('')
const lendoQr = ref(false)
const erroCodigo = ref('')

function usarCodigo(texto: string) {
  const c = codigoDe(texto)
  if (!c) {
    erroCodigo.value = 'Esse código não é de funcionário. Use o QR do crachá ou o código que o gerente mandou.'
    return
  }
  lendoQr.value = false
  erroCodigo.value = ''
  colado.value = ''
  codigo.value = c
  nomeGuardado.value = ''
  gravar(CHAVE_CODIGO, { codigo: c })
}
function trocarFuncionario() {
  sair()
  apagar(CHAVE_CODIGO)
  codigo.value = ''
  nomeGuardado.value = ''
  erroPin.value = ''
  travado.value = false
}

/* ------------------------------------------------------------------ passo 2: PIN */
const entrou = ref(false)
const quem = ref('')
const digitado = ref('')
const erroPin = ref('')
const conferindo = ref(false)
const travado = ref(false)

async function entrar(pin: string, silencioso = false) {
  conferindo.value = true
  linkDoFuncionario.value = codigo.value
  pinDoFuncionario.value = pin
  try {
    const e = await chamar<any>('/api/comandas/estado')
    quem.value = e.eu?.nome ?? ''
    nomeGuardado.value = quem.value
    gravar(CHAVE_CODIGO, { codigo: codigo.value, nome: quem.value })
    gravar(CHAVE_PIN, { pin, em: Date.now() })
    entrou.value = true
    erroPin.value = ''
  } catch (e: any) {
    pinDoFuncionario.value = null
    apagar(CHAVE_PIN)
    const motivo = e?.data?.data?.codigo
    if (motivo === 'link' || motivo === 'link_sem_pin') {
      // o código foi desligado ou trocado pelo gerente: volta pro passo 1
      const msg = mensagemDoErro(e)
      trocarFuncionario()
      erroCodigo.value = msg
      return
    }
    travado.value = motivo === 'pin_travado'
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
// teclado físico também digita o PIN
function porTeclado(ev: KeyboardEvent) {
  if (entrou.value || !codigo.value) return
  if (/^\d$/.test(ev.key)) tecla(ev.key)
  else if (ev.key === 'Backspace') tecla('apagar')
}
function sair() {
  apagar(CHAVE_PIN)
  pinDoFuncionario.value = null
  entrou.value = false
  quem.value = ''
}
// o servidor recusou no meio do turno (PIN trocado, código desligado): volta pro login
function recusado() {
  sair()
  erroPin.value = 'Sua entrada caiu. Digite o PIN de novo.'
}

onMounted(() => {
  window.addEventListener('keydown', porTeclado)
  window.addEventListener('comanda:sair', recusado)
  const g = ler<{ pin: string; em: number }>(CHAVE_PIN)
  if (codigo.value && g && Date.now() - g.em < DOZE_HORAS) entrar(g.pin, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', porTeclado)
  window.removeEventListener('comanda:sair', recusado)
})

/* ------------------------------------------------------------------ abas */
const ABAS = [{ id: 'atender', nome: 'Atender' }, { id: 'pagar', nome: 'Pagar' }, { id: 'hoje', nome: 'Contas de hoje', curto: 'Hoje' }]
const aba = computed(() => ABAS.find((a) => a.id === route.query.aba)?.id ?? 'atender')
const coluna = computed(() => aba.value === 'atender' && faixaLarga.value ? 'max-w-6xl' : 'max-w-4xl')
/** tela "Leitor" (testar pulseira / acertar o NFC do tablet), no lugar do atendimento */
const vendoLeitor = ref(false)
const TECLAS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'apagar']
</script>

<template>
  <div class="min-h-screen bg-fundo-cinza" style="padding-top: env(safe-area-inset-top)">
    <!-- LOGIN, passo 1: quem é o funcionário -->
    <div v-if="!codigo" class="flex min-h-screen items-center justify-center p-4">
      <div class="card w-full max-w-md p-6 text-center sm:p-8" data-tela="login-codigo">
        <span class="mx-auto flex h-12 w-12 items-center justify-center rounded-card bg-acao text-base font-bold text-white">CP</span>
        <p class="titulo mt-4 text-xl font-bold">Comandas · Conquista Park</p>
        <p class="mt-1 text-sm text-ink-600">Entre com o QR do seu crachá de funcionário.</p>

        <div v-if="lendoQr" class="mt-5 overflow-hidden rounded-card">
          <LeitorCamera @ler="usarCodigo" />
          <button type="button" class="btn-secundario mt-3 w-full min-h-[52px]" @click="lendoQr = false">Cancelar</button>
        </div>
        <button v-else type="button" class="btn-primario mt-6 w-full min-h-[64px] text-lg" data-acao="ler-qr" @click="lendoQr = true; erroCodigo = ''">
          Ler QR do crachá
        </button>

        <form v-if="!lendoQr" class="mt-6 space-y-2 text-left" @submit.prevent="usarCodigo(colado)">
          <label class="text-sm font-semibold text-ink-700" for="codigo">Ou cole o seu código de acesso</label>
          <div class="flex gap-2">
            <input id="codigo" v-model="colado" class="campo min-w-0 flex-1 font-mono text-sm" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Código que o gerente mandou">
            <button type="submit" class="btn-secundario px-4" :disabled="!colado.trim()">Continuar</button>
          </div>
        </form>
        <p v-if="erroCodigo" class="mt-4 text-sm font-semibold text-danger-600" role="alert">{{ erroCodigo }}</p>
        <p class="mt-5 text-xs text-ink-600">Não tem crachá? Peça ao gerente: Comandas → Gestão → Funcionários do app.</p>
      </div>
    </div>

    <!-- LOGIN, passo 2: PIN -->
    <div v-else-if="!entrou" class="flex min-h-screen items-center justify-center p-4">
      <div class="card w-full max-w-sm p-6 text-center sm:p-8" data-tela="login-pin">
        <span class="mx-auto flex h-12 w-12 items-center justify-center rounded-card bg-acao text-base font-bold text-white">CP</span>
        <p class="titulo mt-4 text-xl font-bold">{{ nomeGuardado ? `Olá, ${nomeGuardado}` : 'Comandas · Conquista Park' }}</p>
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
        <button type="button" class="mt-5 text-sm font-semibold text-acao" data-acao="trocar-funcionario" @click="trocarFuncionario">
          {{ nomeGuardado ? `Não é ${nomeGuardado}? Trocar funcionário` : 'Trocar funcionário' }}
        </button>
        <p class="mt-2 text-xs text-ink-600">Esqueceu o PIN? Peça ao gerente um código novo.</p>
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
              <RouterLink v-for="a in ABAS" :key="a.id" :to="{ query: a.id === 'atender' ? {} : { aba: a.id } }" @click="vendoLeitor = false"
                          class="flex min-h-[48px] items-center whitespace-nowrap rounded-card px-6 text-base font-semibold transition"
                          :class="aba === a.id ? 'bg-white text-acao shadow-sm' : 'text-ink-600 hover:text-ink-900'">{{ a.nome }}</RouterLink>
            </nav>
            <div class="flex shrink-0 items-center gap-2">
              <span class="hidden text-right leading-tight sm:block">
                <span class="block text-sm font-semibold text-ink-900">{{ quem }}</span>
                <span class="block text-xs text-ink-600">Atendente</span>
              </span>
              <button type="button" class="btn-secundario min-h-[44px] px-3 text-sm" data-acao="leitor"
                      :class="nfc.existe.value && !nfc.ligado.value ? 'ring-danger-600 text-danger-600' : ''"
                      @click="vendoLeitor = !vendoLeitor">{{ nfc.existe.value && !nfc.ligado.value ? 'NFC desligado' : 'Leitor' }}</button>
              <button type="button" class="btn-secundario min-h-[44px] px-3 text-sm" @click="sair">Sair</button>
            </div>
          </div>
          <!-- celular: as abas ganham uma linha só delas -->
          <nav class="mb-3 grid grid-cols-3 gap-1 rounded-card bg-ink-50 p-1 md:hidden" aria-label="Comandas">
            <RouterLink v-for="a in ABAS" :key="a.id" :to="{ query: a.id === 'atender' ? {} : { aba: a.id } }" @click="vendoLeitor = false"
                        class="flex min-h-[44px] items-center justify-center rounded-card text-[15px] font-semibold transition"
                        :class="aba === a.id ? 'bg-white text-acao shadow-sm' : 'text-ink-600'">{{ a.curto ?? a.nome }}</RouterLink>
          </nav>
        </div>
      </header>

      <main class="mx-auto px-3 py-4 sm:px-4 sm:py-5" :class="coluna">
        <Leitor v-if="vendoLeitor" @fechar="vendoLeitor = false" />
        <ComandaSituacao v-else>
          <ComandaAtender v-if="aba === 'atender'" />
          <ComandaPagar v-else-if="aba === 'pagar'" />
          <ComandaHoje v-else />
        </ComandaSituacao>
      </main>
    </template>
  </div>
</template>
