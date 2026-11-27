<script setup lang="ts">
/** Comandas → Atender (055), dentro do painel. A tela é `components/comanda/Atender.vue`. */
import ComandaSituacao from '~/components/comanda/Situacao.vue'
import ComandaAtender from '~/components/comanda/Atender.vue'

definePageMeta({ layout: 'admin' })
useHead({ title: 'Comandas — Atender' })
</script>

<template>
  <div>
    <ClientOnly>
    <ComandaSituacao><ComandaAtender /></ComandaSituacao>
    </ClientOnly>
  </div>
</template>
