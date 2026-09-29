<script setup lang="ts">
/**
 * O canto da conta no cabeçalho do site (034): "Entrar" pra quem está fora; o primeiro nome,
 * levando pra "Minha conta", pra quem está dentro.
 *
 * A conta só é lida no navegador, depois de a página montar: o nome de uma pessoa nunca vai
 * dentro do HTML que o servidor renderiza (um cache no caminho entregaria a página de um pra
 * outro). Enquanto lê, ocupa o mesmo lugar vazio — o cabeçalho não pula.
 */
const props = defineProps<{ evento?: string | null }>()
const { estado, abrir, garantir } = useContaDoCliente()

onMounted(() => { garantir(props.evento ?? null) })

const inicial = computed(() => (estado.value.conta?.primeiroNome || '?').slice(0, 1).toUpperCase())
</script>

<template>
  <span v-if="!estado.carregada" class="inline-block h-10 w-20" aria-hidden="true" />
  <NuxtLink v-else-if="estado.conta" to="/conta" data-parte="minha-conta"
            class="flex min-h-[40px] shrink-0 items-center gap-2 rounded-md px-2 py-1 font-semibold text-ink-800 transition-colors hover:bg-ink-100 hover:text-ink-900">
    <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-pool-100 text-sm font-bold text-acao" aria-hidden="true">
      {{ inicial }}
    </span>
    <span class="hidden max-w-[9rem] truncate sm:inline">{{ estado.conta.primeiroNome }}</span>
    <span class="sr-only sm:hidden">Minha conta</span>
  </NuxtLink>
  <button v-else type="button" data-parte="entrar-na-conta"
          class="flex min-h-[40px] min-w-[40px] shrink-0 items-center justify-center gap-2 rounded-md border border-ink-300 bg-white font-semibold text-ink-800 transition-colors hover:border-ink-400 hover:bg-ink-50 hover:text-ink-900 sm:px-3"
          @click="abrir('entrar')">
    <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <circle cx="12" cy="8" r="4" /><path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" stroke-linecap="round" />
    </svg>
    <!-- no celular o cabeçalho já leva "Comprar ingressos": aqui fica o ícone (o nome segue pro leitor) -->
    <span class="sr-only sm:not-sr-only">Entrar</span>
  </button>
</template>
