<script setup lang="ts">
/**
 * A imagem do produto nas comandas (057): a FOTO quando tem (a enviada pelo dono ou a pronta
 * pelo nome, `composables/comandaFotos.ts`), senão o ícone de sempre (`Icone.vue`).
 * Preenche o quadro de quem usa (\`class="h-28 w-full"\`); \`tamanho\` é o do ícone reserva.
 */
import { fotoDoItem } from '~/composables/comandaFotos'
import { iconeDoItem } from '~/composables/comandaIcones'
import ComandaIcone from '~/components/comanda/Icone.vue'

const props = withDefaults(defineProps<{
  item: { nome: string; icone?: string | null; foto?: string | null }
  categoria?: { nome: string; icone?: string | null } | null
  tamanho?: number
}>(), { tamanho: 48, categoria: null })
const src = computed(() => fotoDoItem(props.item))
const falhou = ref(false)
watch(src, () => { falhou.value = false })
</script>

<template>
  <span class="flex items-center justify-center overflow-hidden">
    <img v-if="src && !falhou" :src="src" :alt="item.nome" draggable="false" decoding="async" loading="lazy"
         class="h-full w-full select-none object-cover" @error="falhou = true">
    <ComandaIcone v-else :icone="iconeDoItem(item, categoria)" :tamanho="tamanho" />
  </span>
</template>
