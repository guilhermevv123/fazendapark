<script setup lang="ts">
const { data } = await useFetch<any>('/api/eventos-publicos')
const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
useHead({ title: 'Ingressos' })
</script>
<template>
  <div class="mx-auto max-w-3xl px-4 py-12">
    <p class="serial text-xs uppercase text-tinta-fraca">Bilheteria</p>
    <h1 class="titulo mt-1 text-4xl font-extrabold uppercase">Eventos abertos</h1>
    <ul class="mt-8 space-y-3">
      <li v-for="e in data?.eventos ?? []" :key="e.slug">
        <NuxtLink :to="`/e/${e.slug}`"
          class="flex items-center justify-between gap-4 rounded-bilhete border-2 border-tinta bg-papel p-5
                 transition-colors hover:bg-papel-fundo">
          <span>
            <span class="titulo block text-lg font-bold uppercase">{{ e.nome }}</span>
            <span class="text-sm text-tinta-suave">{{ e.cidade }} · {{ new Date(e.inicio).toLocaleDateString('pt-BR') }}</span>
          </span>
          <span class="serial shrink-0 tabular-nums">{{ e.aPartirDeCents != null ? reais(e.aPartirDeCents) : '' }}</span>
        </NuxtLink>
      </li>
    </ul>
    <p v-if="!data?.eventos?.length" class="mt-8 text-tinta-suave">Nenhum evento com vendas abertas.</p>
  </div>
</template>
