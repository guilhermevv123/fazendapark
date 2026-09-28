<script setup lang="ts">
/**
 * O "i" ao lado de um título, que abre uma explicação curta — o mesmo recurso
 * do assistente da Zig que o dono pediu (22/09). Abre ao passar o mouse, ao
 * focar pelo teclado e ao TOCAR (no celular não existe hover), e fecha ao
 * tocar fora (o botão perde o foco).
 *
 * O balão cabe na tela (#69, 28/09). Centrado no "i" com `-translate-x-1/2`,
 * no celular ele começava em −41 px e cortava o começo de toda linha — e a
 * animação de entrada (`animate-rise-in`) anima o `transform` até `none`, o que
 * apagava o centramento no aberto pelo toque. Agora a posição é conta, feita na
 * hora de abrir (mouse, foco ou toque): centrado no "i" quando cabe, encostado a
 * 8 px da borda quando não cabe, e sem `transform` nenhum pra centrar.
 */
defineProps<{ rotulo?: string }>()
const aberto = ref(false)
const raiz = ref<HTMLElement | null>(null)

const MARGEM = 8
const LARGURA = 288 // 18rem
/** onde o balão começa, em px a partir da esquerda do "i" (null: ainda não abriu) */
const esquerda = ref<number | null>(null)

function posicionar() {
  const r = raiz.value
  if (!r || typeof window === 'undefined') return
  const tela = document.documentElement.clientWidth || window.innerWidth
  const largura = Math.min(LARGURA, tela - 2 * MARGEM)
  const caixa = r.getBoundingClientRect()
  const ideal = caixa.left + caixa.width / 2 - largura / 2
  const cabe = Math.min(Math.max(MARGEM, ideal), tela - largura - MARGEM)
  esquerda.value = Math.round(cabe - caixa.left)
}
function abrir() {
  posicionar()
  aberto.value = true
}
</script>

<template>
  <span ref="raiz" class="group relative inline-flex align-middle"
        @mouseenter="posicionar" @focusin="posicionar" @touchstart.passive="posicionar"
        @mouseleave="aberto = false">
    <button type="button"
            class="grid size-6 place-items-center rounded-full text-pool-600 transition-colors hover:bg-pool-50 hover:text-pool-800"
            :aria-label="rotulo ?? 'O que é isso?'" :aria-expanded="aberto"
            @click="abrir" @blur="aberto = false">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" /><path d="M12 11v6" /><path d="M12 7.5h.01" />
      </svg>
    </button>
    <span role="tooltip"
          class="pointer-events-none absolute bottom-full z-30 mb-2 rounded-xl bg-ink-900 p-3 text-left text-[12.5px] font-normal normal-case leading-relaxed tracking-normal text-white shadow-pop"
          :class="aberto ? 'block animate-rise-in' : 'hidden group-hover:block group-focus-within:block'"
          :style="{
            width: `min(${LARGURA}px, calc(100vw - ${2 * MARGEM}px))`,
            left: esquerda === null ? `calc(50% - min(${LARGURA / 2}px, calc(50vw - ${MARGEM}px)))` : `${esquerda}px`,
          }">
      <slot />
    </span>
  </span>
</template>
