<script setup lang="ts">
/**
 * O "i" ao lado de um título, que abre uma explicação curta — o mesmo recurso
 * do assistente da Zig que o dono pediu (22/09). Abre ao passar o mouse, ao
 * focar pelo teclado e ao TOCAR (no celular não existe hover), e fecha ao
 * tocar fora (o botão perde o foco).
 */
defineProps<{ rotulo?: string }>()
const aberto = ref(false)
</script>

<template>
  <span class="group relative inline-flex align-middle" @mouseleave="aberto = false">
    <button type="button"
            class="grid size-6 place-items-center rounded-full text-pool-600 transition-colors hover:bg-pool-50 hover:text-pool-800"
            :aria-label="rotulo ?? 'O que é isso?'" :aria-expanded="aberto"
            @click="aberto = true" @blur="aberto = false">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" /><path d="M12 11v6" /><path d="M12 7.5h.01" />
      </svg>
    </button>
    <span role="tooltip"
          class="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 w-72 max-w-[80vw] -translate-x-1/2 rounded-xl bg-ink-900 p-3 text-left text-[12.5px] font-normal normal-case leading-relaxed tracking-normal text-white shadow-pop"
          :class="aberto ? 'block animate-rise-in' : 'hidden group-hover:block group-focus-within:block'">
      <slot />
    </span>
  </span>
</template>
