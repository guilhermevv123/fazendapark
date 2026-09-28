<script setup lang="ts">
/**
 * `<PainelVazio>` — o estado vazio que orienta: ícone, uma frase do que aconteceu, e a AÇÃO que
 * resolve (no slot). "Só a frase cinza no meio de um cartão branco" lia como tela quebrada
 * (dono, 22/09); vazio sem saída é beco.
 */
withDefaults(defineProps<{ icone?: string; titulo: string; texto?: string; tom?: 'pool' | 'grape' | 'sun' }>(), {
  icone: 'relatorio', texto: undefined, tom: 'pool',
})
const FUNDO: Record<string, string> = {
  pool: 'bg-gradient-to-br from-pool-100 to-pool-200 text-pool-800',
  grape: 'bg-gradient-to-br from-grape-100 to-grape-200 text-grape-800',
  sun: 'bg-gradient-to-br from-sun-100 to-sun-200 text-sun-800',
}
</script>

<template>
  <div class="card flex flex-col items-center px-6 py-10 text-center" data-parte="vazio">
    <span class="grid size-16 place-items-center rounded-2xl" :class="FUNDO[tom]">
      <IconeMenu :nome="icone" :tamanho="30" />
    </span>
    <p class="titulo mt-4 text-lg font-semibold text-ink-900">{{ titulo }}</p>
    <p v-if="texto" class="mt-1 max-w-md text-[15px] leading-6 text-ink-700">{{ texto }}</p>
    <div class="mt-5 flex flex-wrap justify-center gap-2 empty:hidden">
      <slot />
    </div>
  </div>
</template>
