<script setup lang="ts">
/**
 * A pergunta de "tem certeza?" DENTRO do sistema, no lugar do `confirm()` do navegador.
 *
 * O `confirm()` nativo abre a caixa cinza "www.conquistapark.com.br diz", fora do visual do painel,
 * some em aba de fundo e não dá pra testar olhando a tela (05/10: o dono pediu "tudo dentro do
 * sistema"). Esta janela segue a camada dos outros modais (z-[60], véu escuro), Esc e clique fora
 * cancelam, e o foco entra no botão de cancelar (o lado seguro).
 *
 * Uso: `<JanelaConfirmar v-if="pergunta" v-bind="pergunta" @responder="..." />`, ou pelo composable
 * `usarConfirmacao()` (`app/composables/confirmacao.ts`), que devolve uma Promise<boolean>.
 */
import { prenderTab, soltarRolagem, travarRolagem } from '~/composables/painelFoco'

const props = defineProps<{
  titulo: string
  texto?: string
  /** frases extras, cada uma no seu parágrafo */
  detalhes?: string[]
  confirmar?: string
  cancelar?: string
  /** o botão de confirmar em vermelho (dinheiro saindo, algo que não volta) */
  perigo?: boolean
}>()
const emit = defineEmits<{ responder: [sim: boolean] }>()

const caixa = ref<HTMLElement | null>(null)
const botaoCancelar = ref<HTMLButtonElement | null>(null)
let quemAbriu: HTMLElement | null = null

function tecla(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); emit('responder', false) } else prenderTab(caixa.value, e)
}
onMounted(() => {
  quemAbriu = document.activeElement as HTMLElement | null
  document.addEventListener('keydown', tecla)
  travarRolagem()
  nextTick(() => botaoCancelar.value?.focus())
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', tecla)
  soltarRolagem()
  if (quemAbriu?.isConnected) quemAbriu.focus()
})
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[60] flex items-end justify-center bg-ink-950/60 p-0 sm:items-center sm:p-4"
         data-parte="janela-confirmar" @click.self="emit('responder', false)">
      <div ref="caixa" role="alertdialog" aria-modal="true" aria-labelledby="janela-confirmar-titulo"
           class="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-pop sm:rounded-2xl">
        <h2 id="janela-confirmar-titulo" class="titulo text-lg font-semibold text-ink-900">{{ props.titulo }}</h2>
        <p v-if="props.texto" class="mt-2 text-[15px] text-ink-700">{{ props.texto }}</p>
        <p v-for="(d, i) in props.detalhes ?? []" :key="i" class="mt-2 text-sm text-ink-700">{{ d }}</p>
        <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button ref="botaoCancelar" type="button" class="btn-secundario min-h-[44px] justify-center"
                  data-acao="cancelar" @click="emit('responder', false)">
            {{ props.cancelar ?? 'Cancelar' }}
          </button>
          <button type="button" class="min-h-[44px] justify-center" :class="props.perigo ? 'btn-erro' : 'btn-primario'"
                  data-acao="confirmar" @click="emit('responder', true)">
            {{ props.confirmar ?? 'Confirmar' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
