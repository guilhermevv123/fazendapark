<script setup lang="ts">
/**
 * Painel que entra pela direita. Formulário longo dentro de uma linha de
 * tabela empurra a tabela inteira pra baixo e faz a pessoa perder o lugar onde
 * estava; aqui a tabela fica parada atrás e o formulário tem espaço pra
 * respirar.
 *
 * Sem <Transition>: o Vue deixa a entrada em opacidade 0 quando a aba está
 * escondida (o rAF congela), e o painel "não abre" sem erro nenhum. A animação
 * é CSS de montagem, que roda independente do rAF.
 */
defineProps<{ titulo: string; largura?: string }>()
const emit = defineEmits<{ fechar: [] }>()

// Esc fecha. Um painel que só fecha no X é o que faz a pessoa recarregar a
// página inteira pra sair de um formulário aberto por engano.
function tecla(e: KeyboardEvent) { if (e.key === 'Escape') emit('fechar') }
onMounted(() => document.addEventListener('keydown', tecla))
onBeforeUnmount(() => document.removeEventListener('keydown', tecla))
</script>

<template>
  <div class="fixed inset-0 z-40 flex justify-end">
    <div class="entra-fundo absolute inset-0 bg-black/40" @click="emit('fechar')" />

    <aside class="entra-painel relative flex h-full w-full flex-col bg-white shadow-2xl"
           :class="largura ?? 'max-w-lg'" role="dialog" aria-modal="true">
      <header class="flex items-center gap-3 border-b border-linha px-5 py-4">
        <h2 class="titulo text-lg font-bold text-tinta">{{ titulo }}</h2>
        <button type="button" class="ml-auto p-1 text-tinta-fraca hover:text-tinta"
                aria-label="Fechar" @click="emit('fechar')">
          <IconeMenu nome="fechar" :tamanho="20" />
        </button>
      </header>

      <div class="flex-1 overflow-y-auto px-5 py-4">
        <slot />
      </div>

      <footer class="flex justify-end gap-2 border-t border-linha px-5 py-4">
        <slot name="acoes" />
      </footer>
    </aside>
  </div>
</template>

<style scoped>
@keyframes entra-fundo-kf { from { opacity: 0 } to { opacity: 1 } }
@keyframes entra-painel-kf { from { transform: translateX(24px); opacity: 0 } to { transform: none; opacity: 1 } }
.entra-fundo  { animation: entra-fundo-kf .15s ease-out both }
.entra-painel { animation: entra-painel-kf .18s ease-out both }
@media (prefers-reduced-motion: reduce) { .entra-fundo, .entra-painel { animation: none } }
</style>
