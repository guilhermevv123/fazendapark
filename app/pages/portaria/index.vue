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

type EventoDaPortaria = {
  id: string; nome: string; inicio: string; fim: string | null
  validados: number; faltam: number; aptos: number; comparecimentoPct: number
}

const { data: eu, refresh: refreshEu } = useFetch<any>('/api/auth/eu', { key: 'auth-eu' })
const logado = computed(() => !!eu.value?.usuario)

const { data: destino, error: erroDestino, refresh: refreshDestino, pending } = useFetch<{ eventos: EventoDaPortaria[] }>(
  '/api/portaria/destino', { key: 'portaria-destino-lista', immediate: false, server: false })

watch(logado, (sim) => { if (sim) refreshDestino() }, { immediate: true })

let relogio: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  relogio = setInterval(() => { if (logado.value && !document.hidden) refreshDestino() }, 20_000)
  // o mesmo service worker do leitor: o celular abre a portaria mesmo com o 4G caindo
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw-portaria.js').catch(() => {})
})
onBeforeUnmount(() => clearInterval(relogio))

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
</script>

<template>
  <!-- ============================================================ login -->
  <div v-if="!logado" class="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-[400px] flex-col justify-center py-8">
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
  </div>

  <!-- ========================================================== eventos -->
  <div v-else class="py-5">
    <h1 class="titulo text-2xl font-semibold text-tinta">Eventos abertos</h1>
    <p class="mt-1 text-tinta-suave">Toque no evento para abrir o leitor.</p>

    <p v-if="semAcesso" class="faixa-erro mt-5" role="alert">
      {{ erroDestino?.data?.statusMessage || 'Seu acesso não inclui o leitor de entrada.' }}
    </p>
    <p v-else-if="erroDestino" class="faixa-aviso mt-5" role="alert">
      Não deu pra atualizar os eventos agora. Confira a internet —
      <button type="button" class="font-semibold underline" @click="refreshDestino()">tentar de novo</button>.
    </p>

    <p v-else-if="!destino && pending" class="mt-6 text-tinta-suave">Carregando os eventos…</p>

    <p v-else-if="destino && !destino.eventos.length" class="card mt-5 text-center text-tinta-suave"
       data-parte="sem-eventos">
      Nenhum evento aberto agora.
    </p>

    <ul v-if="destino?.eventos.length" class="mt-5 grid gap-3" data-parte="eventos-da-portaria">
      <li v-for="e in destino.eventos" :key="e.id">
        <NuxtLink :to="`/portaria/${e.id}`" :data-evento="e.id"
                  class="card block p-5 transition hover:ring-pool-300 active:scale-[0.99]">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="titulo truncate text-lg font-semibold text-ink-900">{{ e.nome }}</h2>
              <p class="text-sm capitalize text-tinta-suave">{{ quando(e) }}</p>
            </div>
            <span class="shrink-0 rounded-md bg-acao px-3 py-2 text-sm font-semibold text-white">Abrir leitor</span>
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
          </p>
        </NuxtLink>
      </li>
    </ul>
  </div>
</template>
