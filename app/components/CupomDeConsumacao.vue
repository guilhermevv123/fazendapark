<script setup lang="ts">
/**
 * O cupom de consumação do Volte Mais (042) — o "ticketzinho" do bar, no pé do ingresso do retorno.
 * Cara de cupom (borda tracejada, sol) pra não confundir com o ingresso da portaria: a portaria lê
 * o QR do ingresso; o caixa do bar escaneia ESTE. "Abrir" leva à página ao vivo (relógio + estado
 * que o servidor responde); "Baixar" salva a imagem na galeria.
 */
import { diaDoCupomBR, salvarCupomComoImagem } from '~/composables/cupomImagem'

const props = defineProps<{
  token: string
  codigo: string
  consumacaoPct: number
  dia: string
  programa: string
  evento?: string | null
  titular?: string | null
}>()

const baixando = ref(false)
const recado = ref('')
async function baixar() {
  if (baixando.value) return
  baixando.value = true
  recado.value = ''
  try {
    const r = await salvarCupomComoImagem({ ...props })
    if (r === 'baixado') recado.value = 'Imagem do cupom baixada.'
  } catch {
    recado.value = 'Não consegui gerar a imagem agora. Abra o cupom e tire um print, ou use o código.'
  } finally {
    baixando.value = false
  }
}
</script>

<template>
  <article data-parte="cupom-consumacao"
           class="mx-auto w-full max-w-md overflow-hidden rounded-3xl border-[3px] border-dashed border-sun-400 bg-sun-50 print:break-inside-avoid">
    <header class="bg-grape-700 px-5 py-3 text-center text-white">
      <p class="text-xs font-bold uppercase tracking-[0.14em]">Cliente {{ programa }}</p>
    </header>
    <div class="flex flex-col items-center px-6 pb-6 pt-4 text-center">
      <p class="titulo text-5xl font-extrabold leading-none text-tinta">{{ consumacaoPct }}%</p>
      <p class="mt-1 text-lg font-semibold text-tinta">de desconto no bar</p>
      <p class="mt-1 text-sm text-tinta-suave">Vale em {{ diaDoCupomBR(dia) }}, depois da entrada na portaria</p>
      <img :src="`/api/consumo/${token}/qr.png`" :alt="`QR do cupom de consumação ${codigo}`"
           class="mt-4 h-44 w-44 rounded-2xl border border-sun-200 bg-white p-2" loading="lazy" decoding="async">
      <p class="mt-3 font-mono text-xl font-bold tracking-[0.3em] text-tinta" data-parte="codigo-do-cupom">{{ codigo }}</p>
      <p class="mt-2 text-sm text-tinta-corpo">
        No caixa do bar, mostre este cupom e um documento com foto. O caixa escaneia e dá a baixa.
      </p>
      <div class="mt-4 grid w-full grid-cols-2 gap-2 print:hidden">
        <NuxtLink :to="`/consumo/${token}`" class="btn-primario justify-center text-sm" data-parte="abrir-cupom">
          Abrir cupom
        </NuxtLink>
        <button type="button" class="btn-secundario justify-center text-sm" :disabled="baixando" data-parte="baixar-cupom" @click="baixar">
          {{ baixando ? 'Gerando…' : 'Baixar imagem' }}
        </button>
      </div>
      <p v-if="recado" class="mt-2 text-xs text-tinta-suave" role="status">{{ recado }}</p>
    </div>
  </article>
</template>
