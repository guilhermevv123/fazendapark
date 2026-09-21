<script setup lang="ts">
/**
 * Cabeçalho das telas de quem COMPRA (vitrine do evento, pagamento, ingressos,
 * lista de eventos): faixa branca fosca colada no alto, logo do parque à
 * esquerda, o que a tela quiser à direita (slot). É o `SiteHeader` do sistema
 * do parque, sem o menu — aqui a pessoa está no meio de uma compra, e link pra
 * fora dela é rota de fuga.
 *
 * A faixa some na impressão: a página de ingressos é impressa, e cabeçalho de
 * site no meio do papel é tinta gasta.
 *
 * `largura` casa com a coluna da página (`max-w-5xl` na vitrine, `max-w-2xl`
 * no pagamento), pra logo ficar alinhada com o conteúdo e não com a janela.
 */
withDefaults(defineProps<{ para?: string; largura?: string }>(), {
  para: '/',
  largura: 'max-w-5xl',
})
</script>

<template>
  <header class="sticky top-0 z-40 border-b border-ink-200/60 bg-white/90 backdrop-blur print:hidden">
    <div class="mx-auto flex h-16 items-center justify-between gap-3 px-4 sm:px-6" :class="largura">
      <NuxtLink :to="para" class="shrink-0" aria-label="Conquista Park, página inicial">
        <LogoMarca class="h-9 sm:h-10" />
      </NuxtLink>
      <div class="flex min-w-0 items-center gap-3 text-sm text-ink-600">
        <slot />
      </div>
    </div>
  </header>
</template>
