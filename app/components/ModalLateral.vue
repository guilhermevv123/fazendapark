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
import { focaveis, prenderTab, soltarRolagem, travarRolagem } from '~/composables/painelFoco'

defineProps<{ titulo: string; largura?: string }>()
const emit = defineEmits<{ fechar: [] }>()

/**
 * NAV-05: aberto, o painel TRAVA a rolagem do fundo, PRENDE o Tab dentro dele e, ao fechar,
 * devolve o foco a quem abriu. Antes o fundo rolava junto e o Tab andava pelos links de trás — o
 * Enter seguinte navegava pra fora com o formulário aberto.
 *
 * ADM-57: a camada é z-[60], acima da lateral flutuante (z-50). Em z-40 a lateral ficava POR CIMA
 * do véu: dava pra clicar no menu com o formulário aberto, sair da tela e perder o que foi
 * digitado. (É a mesma camada da troca de senha, no layout.)
 */
const painel = ref<HTMLElement | null>(null)
let quemAbriu: HTMLElement | null = null

// Esc fecha. Um painel que só fecha no X é o que faz a pessoa recarregar a
// página inteira pra sair de um formulário aberto por engano.
function tecla(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('fechar')
  else prenderTab(painel.value, e)
}
onMounted(() => {
  quemAbriu = document.activeElement as HTMLElement | null
  document.addEventListener('keydown', tecla)
  travarRolagem()
  // o foco entra no painel: no primeiro campo do formulário, senão no primeiro botão
  nextTick(() => {
    const raiz = painel.value
    if (!raiz) return
    const lista = focaveis(raiz)
    const campo = lista.find((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName))
    ;(campo ?? lista[0])?.focus()
  })
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', tecla)
  soltarRolagem()
  if (quemAbriu?.isConnected) quemAbriu.focus()
})
</script>

<template>
  <div class="fixed inset-0 z-[60] flex justify-end" data-parte="modal-lateral">
    <div class="entra-fundo absolute inset-0 bg-ink-950/40" @click="emit('fechar')" />

    <aside ref="painel" class="entra-painel relative flex h-full w-full flex-col bg-white shadow-pop"
           :class="largura ?? 'max-w-lg'" role="dialog" aria-modal="true" :aria-label="titulo">
      <header class="flex items-center gap-3 border-b border-ink-100 px-5 py-4">
        <h2 class="titulo text-lg font-semibold text-ink-900">{{ titulo }}</h2>
        <button type="button"
                class="ml-auto grid size-9 place-items-center rounded-xl text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-900"
                aria-label="Fechar" @click="emit('fechar')">
          <IconeMenu nome="fechar" :tamanho="20" />
        </button>
      </header>

      <div class="flex-1 overflow-y-auto px-5 py-4">
        <slot />
      </div>

      <footer class="flex justify-end gap-2 border-t border-ink-100 px-5 py-4">
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
