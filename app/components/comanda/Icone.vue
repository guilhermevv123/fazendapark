<script setup lang="ts">
/**
 * Ícone de produto/categoria das comandas (055): a ilustração 3D quando existe
 * (`public/comandas/icones`), senão o próprio emoji. Ver `composables/comandaIcones.ts`.
 * `tamanho` é o lado do quadrado em px; o emoji usa ~80% dele para ficar do mesmo porte.
 */
import { imagemDoIcone } from '~/composables/comandaIcones'

const props = withDefaults(defineProps<{ icone: string; tamanho?: number }>(), { tamanho: 32 })
const src = computed(() => imagemDoIcone(props.icone))
const falhou = ref(false)
watch(() => props.icone, () => { falhou.value = false })
</script>

<template>
  <img v-if="src && !falhou" :src="src" alt="" aria-hidden="true" draggable="false" decoding="async"
       class="inline-block shrink-0 select-none object-contain" :style="{ width: `${tamanho}px`, height: `${tamanho}px` }"
       @error="falhou = true">
  <span v-else aria-hidden="true" class="inline-flex shrink-0 select-none items-center justify-center leading-none"
        :style="{ width: `${tamanho}px`, height: `${tamanho}px`, fontSize: `${Math.round(tamanho * 0.8)}px` }">{{ icone }}</span>
</template>
