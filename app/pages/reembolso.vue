<script setup lang="ts">
/**
 * Reembolso (dono, 05/10): o parque não faz reembolso pelo site e o botão "Pedir reembolso" saiu do
 * bilhete. A página fica só pra quem chegar por um link antigo: diz isso e leva de volta.
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
        <h1 class="titulo mt-4 text-2xl font-semibold text-tinta">Reembolso pelo site indisponível</h1>
        <p class="mt-2 text-tinta-corpo">
          O pedido de reembolso não é feito pelo site. Em caso de dúvida sobre o seu ingresso, fale com o parque.
        </p>

        <div class="mt-6 grid gap-2 sm:grid-cols-2">
          <NuxtLink :to="pedido ? `/ingressos/${pedido}` : '/conta'" class="btn-primario justify-center py-3">
            {{ pedido ? 'Voltar para o ingresso' : 'Ver meus ingressos' }}
          </NuxtLink>
          <NuxtLink to="/" class="btn-secundario justify-center py-3">Página inicial</NuxtLink>
        </div>
      </section>
    </div>
  </div>
</template>
