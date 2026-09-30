<script setup lang="ts">
/**
 * O layout de `/portaria` — o endereço curto do porteiro (30/09). Sem a lateral do painel: logo,
 * "Portaria", o caminho de volta pra lista de eventos e o botão de sair. A tela do leitor é a MESMA
 * de `/admin/evento/<id>/validacao` (ela tem o apelido `/portaria/<id>`); só a moldura muda.
 */
const route = useRoute()
const noLeitor = computed(() => route.path !== '/portaria' && route.path.startsWith('/portaria/'))
const { data: eu } = useFetch<any>('/api/auth/eu', { key: 'auth-eu' })
const saindo = ref(false)
const erroAoSair = ref('')

/** Igual ao "Sair" do painel (NAV-04): sem rede avisa que a sessão segue aberta; 401 é já ter saído. */
async function sair() {
  if (saindo.value) return
  erroAoSair.value = ''
  saindo.value = true
  try {
    await $fetch('/api/auth/sair', { method: 'POST' })
  } catch (e: any) {
    const status = Number(e?.statusCode ?? e?.status ?? e?.response?.status ?? 0)
    if (status !== 401) {
      erroAoSair.value = 'Não consegui sair agora — confira a internet. A sessão continua aberta neste aparelho.'
      saindo.value = false
      return
    }
  }
  // recarrega de verdade: o cache do useFetch ficaria com o usuário antigo
  window.location.href = '/portaria'
}
</script>

<template>
  <div class="min-h-dvh bg-fundo-cinza">
    <header class="sticky top-0 z-30 border-b border-ink-200/70 bg-white/95 backdrop-blur">
      <div class="mx-auto flex h-14 max-w-3xl items-center justify-between gap-3 px-4">
        <NuxtLink v-if="noLeitor" to="/portaria" data-parte="voltar-eventos"
                  class="flex min-h-[44px] items-center gap-1.5 font-semibold text-acao">
          <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          Eventos
        </NuxtLink>
        <NuxtLink v-else to="/portaria" class="flex items-center gap-2" aria-label="Portaria, início">
          <LogoMarca class="h-8" />
          <span class="titulo text-sm font-semibold uppercase tracking-wider text-ink-600">Portaria</span>
        </NuxtLink>
        <button v-if="eu?.usuario" type="button" data-parte="sair"
                class="min-h-[44px] rounded-md px-3 text-sm font-semibold text-ink-700 hover:bg-ink-100"
                :disabled="saindo" @click="sair">
          {{ saindo ? 'Saindo…' : 'Sair' }}
        </button>
      </div>
    </header>
    <p v-if="erroAoSair" class="faixa-erro mx-auto mt-3 max-w-3xl" role="alert">{{ erroAoSair }}</p>
    <main class="mx-auto max-w-3xl px-4 pb-10">
      <slot />
    </main>
  </div>
</template>
