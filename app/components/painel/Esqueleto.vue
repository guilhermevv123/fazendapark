<script setup lang="ts">
/**
 * `<PainelEsqueleto>` — o "carregando" que tem a FORMA da tela: cartões cinza pulsando no lugar
 * dos números. Trocar de filtro mantinha os números velhos na tela sem aviso nenhum até a resposta
 * chegar (auditoria REL-09); agora o recorte novo mostra que está chegando.
 */
withDefaults(defineProps<{ cartoes?: number; grafico?: boolean }>(), { cartoes: 4, grafico: true })
</script>

<template>
  <div class="grid gap-3" aria-busy="true" aria-live="polite" data-parte="esqueleto">
    <span class="sr-only">Carregando…</span>
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div v-for="i in cartoes" :key="i" class="h-32 animate-pulse rounded-2xl bg-ink-100" />
    </div>
    <div v-if="grafico" class="h-64 animate-pulse rounded-2xl bg-ink-100" />
  </div>
</template>
