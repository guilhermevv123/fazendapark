<script setup lang="ts">
/**
 * /portaria — o endereço do porteiro (pedido do dono, 30/09: "uma URL específica pra isso").
 *
 * Sem sessão: o próprio login, aqui mesmo (o mesmo `POST /api/auth/entrar` de /entrar). Com sessão:
 * os eventos abertos da organização, cada um com VALIDADOS e FALTAM (o mesmo retrato do leitor,
 * vindo de `/api/portaria/destino`), e um toque abre o leitor em `/portaria/<id>`. Os números se
 * renovam sozinhos enquanto a tela está aberta.
 */
definePageMeta({ layout: 'portaria' })
useHead({
  title: 'Portaria',
  link: [
    { rel: 'manifest', href: '/portaria.webmanifest' },
    { rel: 'apple-touch-icon', href: '/brand/apple-touch-icon-portaria.png' },
  ],
  meta: [
    { name: 'apple-mobile-web-app-capable', content: 'yes' },
    { name: 'mobile-web-app-capable', content: 'yes' },
    { name: 'apple-mobile-web-app-title', content: 'Portaria' },
  ],
})

import InstalarPortaria from '~/components/InstalarPortaria.vue'
import {
  aparelhoDaPortaria, esquecerLoginDaPortaria, eventosGuardadosDaPortaria, filasPendentesDaPortaria,
  guardarEventosDaPortaria, lembrarLoginDaPortaria, loginLembradoDaPortaria, situacaoOfflineDoEvento,
  sincronizarFilasDaPortaria, type ResultadoDaSincronia, type SituacaoOffline,
} from '~/composables/portariaOffline'

type EventoDaPortaria = {
  id: string; nome: string; inicio: string; fim: string | null
  validados: number; faltam: number; aptos: number; comparecimentoPct: number
}

const falhaDeRede = (e: any) => {
  const s = Number(e?.statusCode ?? e?.status ?? e?.response?.status ?? 0)
  return !s || s === 502 || s === 503 || s === 504
}

const { data: eu, error: erroEu, refresh: refreshEu } = useFetch<any>('/api/auth/eu', { key: 'auth-eu' })
/**
 * Logado = o servidor disse que sim; OU o servidor não respondeu (sem internet) e este aparelho
 * lembra de um login. Sem isto, abrir o app no portão sem sinal mostrava o formulário de login —
 * que sem rede não entra — e o porteiro ficava sem o leitor que FUNCIONA offline.
 */
const lembrado = ref<{ nome: string } | null>(null)
const semRedeAgora = ref(false)
const logado = computed(() => !!eu.value?.usuario || (semRedeAgora.value && !!lembrado.value))

watch([eu, erroEu], () => {
  if (eu.value?.usuario) {
    lembrarLoginDaPortaria(eu.value.usuario.nome ?? '')
    lembrado.value = { nome: eu.value.usuario.nome ?? '' }
    semRedeAgora.value = false
  } else if (eu.value && !eu.value.usuario) {
    // quem disse "sem sessão" foi o SERVIDOR: aí sim esquece
    esquecerLoginDaPortaria()
    lembrado.value = null
  } else if (erroEu.value && falhaDeRede(erroEu.value)) {
    semRedeAgora.value = true
  }
}, { immediate: true })

const { data: destino, error: erroDestino, refresh: refreshDestino, pending } = useFetch<{ eventos: EventoDaPortaria[] }>(
  '/api/portaria/destino', { key: 'portaria-destino-lista', immediate: false, server: false })

watch(logado, (sim) => { if (sim) { refreshDestino(); void enviarFilasDepois() } }, { immediate: true })
// declarada lá embaixo; o watch imediato roda antes dela existir
function enviarFilasDepois() { if (import.meta.client) setTimeout(() => { void enviarFilas() }, 0) }

/** Os eventos da última vez que teve rede — o que a tela mostra quando o servidor não responde. */
const guardados = ref<{ em: string; eventos: EventoDaPortaria[] } | null>(null)
watch(erroDestino, (e) => { if (e && falhaDeRede(e)) semRedeAgora.value = true }, { immediate: true })

const mostrandoGuardados = computed(() => !destino.value?.eventos && !!erroDestino.value && !!guardados.value)
const eventos = computed<EventoDaPortaria[]>(() => destino.value?.eventos ?? (erroDestino.value ? guardados.value?.eventos ?? [] : []))

/* ---------------------------------------------- situação offline e fila */

const situacao = ref<Record<string, SituacaoOffline>>({})
const pendentesTotal = ref(0)
function lerSituacao() {
  const s: Record<string, SituacaoOffline> = {}
  for (const e of eventos.value) s[e.id] = situacaoOfflineDoEvento(e.id)
  situacao.value = s
  pendentesTotal.value = filasPendentesDaPortaria().reduce((t, f) => t + f.pendentes, 0)
}
watch(eventos, lerSituacao)

const enviandoFila = ref(false)
const ultimoEnvioFila = ref<ResultadoDaSincronia | null>(null)
/** Sobe a fila de TODOS os eventos deste aparelho — sem precisar abrir cada leitor. */
async function enviarFilas() {
  if (enviandoFila.value || !filasPendentesDaPortaria().length) return
  enviandoFila.value = true
  try {
    ultimoEnvioFila.value = await sincronizarFilasDaPortaria(aparelhoDaPortaria())
    if (ultimoEnvioFila.value.semRede) semRedeAgora.value = true
    if (ultimoEnvioFila.value.enviadas) void refreshDestino()
  } finally {
    enviandoFila.value = false
    lerSituacao()
  }
}

/**
 * Pronto pra ficar sem internet: com rede, baixa a lista de ingressos dos eventos que este
 * aparelho ainda não tem (ou tem velha) e deixa a tela do leitor guardada no service worker.
 * Só baixa onde NÃO há fila pendente — com fila, quem junta as marcas na lista nova é o leitor.
 */
const LISTA_VELHA_MS = 15 * 60_000
async function deixarProntoOffline(lista: EventoDaPortaria[]) {
  for (const e of lista.slice(0, 6)) {
    const s = situacaoOfflineDoEvento(e.id)
    const velha = !s.listaEm || Date.now() - new Date(s.listaEm).getTime() > LISTA_VELHA_MS
    if (velha && !s.pendentes) {
      try {
        const r = await $fetch<any>('/api/portaria/sincronizar', {
          method: 'POST', body: { eventId: e.id, deviceId: aparelhoDaPortaria(), fila: [], comLista: true },
        })
        if (r?.lista) {
          // o MESMO formato que o leitor guarda (guardarLista em validacao/index.vue)
          localStorage.setItem(`dt_portaria_lista_${e.id}`, JSON.stringify({
            em: r.lista.geradaEm, truncada: Boolean(r.lista.truncada), sal: r.lista.sal ?? null, ingressos: r.lista.ingressos,
          }))
        }
      } catch { /* sem rede ou memória cheia: o leitor tenta quando abrir */ }
    }
    // a tela do leitor deste evento fica guardada pra abrir sem rede (o service worker guarda)
    try { await fetch(`/portaria/${e.id}`, { credentials: 'same-origin' }) } catch { /* sem rede */ }
    try { if (typeof preloadRouteComponents === 'function') await preloadRouteComponents(`/portaria/${e.id}`) } catch { /* nada */ }
  }
  lerSituacao()
}

const prontoOffline = (id: string) => (situacao.value[id]?.ingressos ?? 0) > 0
const pendentesDe = (id: string) => situacao.value[id]?.pendentes ?? 0

// depois de tudo que ele usa (immediate roda já no setup)
watch(destino, (d) => {
  if (!d?.eventos) return
  guardarEventosDaPortaria(d.eventos)
  guardados.value = { em: new Date().toISOString(), eventos: d.eventos }
  semRedeAgora.value = false
  void deixarProntoOffline(d.eventos)
}, { immediate: true })

let relogio: ReturnType<typeof setInterval> | undefined
const aoVoltarRede = () => { void refreshEu(); void enviarFilas() }
const aoPerderRede = () => { semRedeAgora.value = true }
onMounted(() => {
  lembrado.value = loginLembradoDaPortaria()
  guardados.value = eventosGuardadosDaPortaria()
  if (navigator.onLine === false) semRedeAgora.value = true
  // a tela pode ter vindo da cópia guardada pelo service worker: confere a sessão de verdade
  else if (!eu.value?.usuario && lembrado.value) void refreshEu()
  lerSituacao()
  void enviarFilas()
  relogio = setInterval(() => {
    if (document.hidden) return
    if (logado.value) refreshDestino()
    void enviarFilas()
    lerSituacao()
  }, 20_000)
  window.addEventListener('online', aoVoltarRede)
  window.addEventListener('offline', aoPerderRede)
  // o mesmo service worker do leitor, com a versão do build (troca o cache a cada deploy)
  const versao = useRuntimeConfig().app?.buildId ?? ''
  if ('serviceWorker' in navigator) navigator.serviceWorker.register(`/sw-portaria.js?v=${versao}`).catch(() => {})
})
onBeforeUnmount(() => {
  clearInterval(relogio)
  window.removeEventListener('online', aoVoltarRede)
  window.removeEventListener('offline', aoPerderRede)
})

/* ------------------------------------------------------------------ login */
const email = ref('')
const senha = ref('')
const erro = ref('')
const enviando = ref(false)
// digitou antes da hidratação (celular lento): lê o que já está no campo — ver /entrar
onBeforeMount(() => {
  const campo = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? ''
  if (!email.value) email.value = campo('email')
  if (!senha.value) senha.value = campo('senha')
})
async function entrar() {
  erro.value = ''
  enviando.value = true
  try {
    await $fetch('/api/auth/entrar', { method: 'POST', body: { email: email.value.trim(), senha: senha.value } })
    senha.value = ''
    await refreshEu()
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível entrar.'
  } finally {
    enviando.value = false
  }
}

/* -------------------------------------------------------------- formato */
const quando = (e: EventoDaPortaria) => new Date(e.inicio).toLocaleString('pt-BR', {
  weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia',
})
const largura = (e: EventoDaPortaria) => `${e.aptos ? Math.min(100, (e.validados / e.aptos) * 100) : 0}%`
const semAcesso = computed(() => erroDestino.value?.statusCode === 403)
const hora = (iso?: string | null) => iso
  ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  : ''
const leituras = (n: number) => `${n} ${n === 1 ? 'leitura' : 'leituras'}`
</script>

<template>
  <!-- ============================================================ login -->
  <div v-if="!logado" class="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-[400px] flex-col justify-center py-8">
    <p v-if="pendentesTotal" class="faixa-aviso mb-4" role="status" data-parte="fila-sem-sessao">
      Há {{ leituras(pendentesTotal) }} guardadas neste aparelho. Entre para enviá-las — nada se perde.
    </p>
    <form class="card grid gap-5 p-6" data-parte="login-portaria" @submit.prevent="entrar">
      <div>
        <h1 class="titulo text-[28px] font-semibold tracking-[-0.02em] text-ink-900">Portaria</h1>
        <p class="mt-1 text-[15px] text-ink-500">Entre com o e-mail e a senha do seu acesso.</p>
      </div>
      <p v-if="erro" class="faixa-erro" role="alert">{{ erro }}</p>
      <div>
        <label for="email" class="rotulo">E-mail</label>
        <input id="email" v-model="email" type="email" autocomplete="username" required
               inputmode="email" autocapitalize="none" spellcheck="false" class="campo">
      </div>
      <div>
        <label for="senha" class="rotulo">Senha</label>
        <input id="senha" v-model="senha" type="password" autocomplete="current-password" required class="campo">
      </div>
      <button type="submit" class="btn-primario w-full py-3 text-base" :disabled="enviando">
        {{ enviando ? 'Entrando…' : 'Entrar' }}
      </button>
      <p class="text-center text-[13px] leading-5 text-ink-500">
        Esqueceu a senha? Peça a um master da equipe para gerar uma nova em Equipe.
      </p>
    </form>
    <InstalarPortaria />
  </div>

  <!-- ========================================================== eventos -->
  <div v-else class="py-5">
    <h1 class="titulo text-2xl font-semibold text-tinta">Eventos abertos</h1>
    <p class="mt-1 text-tinta-suave">Toque no evento para abrir o leitor.</p>

    <!-- sem internet: o leitor segue funcionando, a tela diz isso em vez de dar erro -->
    <div v-if="semRedeAgora || mostrandoGuardados" class="mt-5 rounded-lg border-2 border-warning-600 bg-warning-50 p-4"
         role="status" data-parte="sem-internet">
      <p class="font-semibold text-warning-800">Sem internet agora</p>
      <p class="mt-0.5 text-sm text-warning-800">
        O leitor continua validando nos eventos marcados <strong>Pronto sem internet</strong>.
        As leituras ficam guardadas e sobem sozinhas quando a rede voltar.
        <template v-if="mostrandoGuardados && guardados"> Eventos de {{ hora(guardados.em) }}.</template>
      </p>
    </div>

    <!-- fila parada: quantas leituras esperam a rede, e o botão pra quem quer forçar -->
    <div v-if="pendentesTotal" class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-pool-50 p-4"
         role="status" data-parte="fila-pendente">
      <p class="text-sm font-semibold text-tinta">
        {{ leituras(pendentesTotal) }} esperando internet
        <span class="block text-xs font-normal text-tinta-suave">Sobem sozinhas quando a rede voltar.</span>
      </p>
      <button type="button" class="btn-primario px-4 py-2.5 text-sm" :disabled="enviandoFila"
              data-parte="enviar-fila" @click="enviarFilas">
        {{ enviandoFila ? 'Enviando…' : 'Enviar agora' }}
      </button>
    </div>
    <p v-if="ultimoEnvioFila?.conflitos" class="faixa-erro mt-3" role="alert" data-parte="fila-conflitos">
      {{ ultimoEnvioFila.conflitos }} ingresso(s) já tinham passado por outro aparelho. Abra o leitor do evento para ver quais.
    </p>

    <p v-if="semAcesso" class="faixa-erro mt-5" role="alert">
      {{ erroDestino?.data?.statusMessage || 'Seu acesso não inclui o leitor de entrada.' }}
    </p>
    <p v-else-if="erroDestino && !mostrandoGuardados && !semRedeAgora" class="faixa-aviso mt-5" role="alert">
      Não deu pra atualizar os eventos agora. Confira a internet —
      <button type="button" class="font-semibold underline" @click="refreshDestino()">tentar de novo</button>.
    </p>

    <p v-else-if="!eventos.length && pending" class="mt-6 text-tinta-suave">Carregando os eventos…</p>

    <p v-else-if="destino && !destino.eventos.length" class="card mt-5 text-center text-tinta-suave"
       data-parte="sem-eventos">
      Nenhum evento aberto agora.
    </p>

    <ul v-if="eventos.length" class="mt-5 grid gap-3" data-parte="eventos-da-portaria">
      <li v-for="e in eventos" :key="e.id">
        <NuxtLink :to="`/portaria/${e.id}`" :data-evento="e.id"
                  class="card block p-5 transition hover:ring-pool-300 active:scale-[0.99]">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="titulo truncate text-lg font-semibold text-ink-900">{{ e.nome }}</h2>
              <p class="text-sm capitalize text-tinta-suave">{{ quando(e) }}</p>
            </div>
            <span class="shrink-0 rounded-md bg-acao px-3 py-2 text-sm font-semibold text-white">Abrir leitor</span>
          </div>
          <div class="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
            <span v-if="prontoOffline(e.id)" class="rounded-md bg-success-50 px-2 py-1 text-success-700"
                  data-parte="pronto-offline" :title="`Lista de ${hora(situacao[e.id]?.listaEm)}`">
              ✓ Pronto sem internet
            </span>
            <span v-else class="rounded-md bg-warning-50 px-2 py-1 text-warning-800" data-parte="nao-pronto-offline">
              Abra o leitor uma vez com internet
            </span>
            <span v-if="pendentesDe(e.id)" class="rounded-md bg-pool-50 px-2 py-1 text-pool-700" data-parte="pendentes-evento">
              {{ leituras(pendentesDe(e.id)) }} esperando internet
            </span>
          </div>
          <div class="mt-4 flex items-baseline justify-between gap-3">
            <p class="text-sm font-semibold text-tinta-suave">
              Validados
              <span class="titulo ml-1 text-2xl font-semibold tabular-nums text-ok" data-parte="validados">{{ e.validados }}</span>
            </p>
            <p class="text-sm font-semibold text-tinta-suave">
              Faltam
              <span class="titulo ml-1 text-2xl font-semibold tabular-nums text-tinta" data-parte="faltam">{{ e.faltam }}</span>
            </p>
          </div>
          <div class="mt-2 h-2 overflow-hidden rounded-full bg-ink-100" role="progressbar"
               :aria-label="`Validados em ${e.nome}`" :aria-valuenow="e.validados" aria-valuemin="0" :aria-valuemax="e.aptos">
            <div class="h-full rounded-full bg-success-600 transition-[width] duration-300" :style="{ width: largura(e) }" />
          </div>
          <p class="mt-1.5 text-xs text-tinta-suave">
            de {{ e.aptos }} ingressos · {{ e.comparecimentoPct.toLocaleString('pt-BR') }}%
            <template v-if="mostrandoGuardados"> · números de {{ hora(guardados?.em) }}</template>
          </p>
        </NuxtLink>
      </li>
    </ul>

    <InstalarPortaria />
  </div>
</template>
