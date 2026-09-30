<script setup lang="ts">
/**
 * "Pedir reembolso" (dono, 30/09): por enquanto a página diz que o reembolso pelo site está em
 * manutenção e oferece o que funciona — reagendar pra outro dia. Chega aqui pelo botão do
 * bilhete (`/ingressos/<pedido>`), com `?pedido=` pra voltar pro mesmo lugar.
 */
const route = useRoute()
const pedido = computed(() => {
  const p = String(route.query.pedido ?? '')
  return /^[A-Za-z0-9-]{4,40}$/.test(p) ? p : null
})
useHead({ title: 'Reembolso' })
</script>

<template>
  <div class="min-h-screen">
    <CabecalhoPublico largura="max-w-3xl" />

    <div class="mx-auto max-w-xl px-4 py-10">
      <section class="card text-center" data-parte="reembolso-manutencao">
        <span class="mx-auto grid size-14 place-items-center rounded-2xl bg-sun-100 text-sun-800" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
        </span>
        <h1 class="titulo mt-4 text-2xl font-semibold text-tinta">Reembolso em manutenção</h1>
        <p class="mt-2 text-tinta-corpo">
          O pedido de reembolso pelo site está passando por manutenção e volta em breve.
        </p>
        <p class="mt-1 text-tinta-suave">
          Enquanto isso, você pode <strong class="text-tinta">reagendar</strong> o seu ingresso para outro dia, sem custo.
        </p>

        <div class="mt-6 grid gap-2 sm:grid-cols-2">
          <NuxtLink v-if="pedido" :to="`/ingressos/${pedido}`" class="btn-primario justify-center py-3">
            Reagendar meu ingresso
          </NuxtLink>
          <NuxtLink v-else to="/conta" class="btn-primario justify-center py-3">
            Ver meus ingressos
          </NuxtLink>
          <NuxtLink :to="pedido ? `/ingressos/${pedido}` : '/'" class="btn-secundario justify-center py-3">
            Voltar
          </NuxtLink>
        </div>
      </section>
    </div>
  </div>
</template>
