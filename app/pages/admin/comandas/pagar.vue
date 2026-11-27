<script setup lang="ts">
/** Comandas → Pagar (055), dentro do painel: o atalho de fechar conta. A tela é `components/comanda/Pagar.vue`. */
import ComandaSituacao from '~/components/comanda/Situacao.vue'
import ComandaPagar from '~/components/comanda/Pagar.vue'

definePageMeta({ layout: 'admin' })
useHead({ title: 'Comandas — Pagar' })
</script>

<template>
  <div>
    <ClientOnly>
      <ComandaSituacao><ComandaPagar /></ComandaSituacao>
    </ClientOnly>
  </div>
</template>
