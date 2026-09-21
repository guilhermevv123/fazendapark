<script setup lang="ts">
/**
 * Linhas de água — o motivo visual da marca nos fundos (mesmas três curvas do
 * `Waves` do sistema do parque). Decorativo: `aria-hidden`, cor por
 * `currentColor` (quem usa dá `text-white/[0.08]`) e sem tamanho próprio —
 * quem usa escreve `h-64 w-full`.
 */
</script>

<template>
  <svg aria-hidden="true" viewBox="0 0 800 220" preserveAspectRatio="none" fill="none"
       class="pointer-events-none">
    <path d="M0 132C120 104 222 160 344 132S566 104 688 132 800 146 800 146" stroke="currentColor" stroke-width="2" />
    <path d="M0 164C138 136 244 192 382 164S602 136 724 164 800 176 800 176" stroke="currentColor" stroke-width="2" />
    <path d="M0 196C128 172 252 220 392 196S612 172 742 196 800 206 800 206" stroke="currentColor" stroke-width="2" />
  </svg>
</template>
