<script setup lang="ts">
/**
 * "Saiu versão nova" (dono, 05/10): o app da portaria instalado na tela inicial fica aberto o dia
 * inteiro; sem isto ele roda o código do dia em que foi aberto até alguém fechar e abrir.
 *
 * O Nuxt publica o número da versão em `/_nuxt/builds/latest.json` a cada deploy. Com rede, a
 * cada 5 min (e quando o app volta pra frente) conferimos contra a versão que está rodando
 * (`app.buildId`). Mudou: faixa "Versão nova — Atualizar". Recarregar não perde nada — a lista e a
 * fila moram no localStorage e voltam no F5.
 *
 * Se o aparelho está parado (sem toque há 1 min) e com a tela visível, atualiza sozinho: o
 * porteiro não precisa entender de versão. Nunca no meio de uma leitura.
 */
const props = defineProps<{ ocupado?: boolean }>()

const CONFERIR_A_CADA_MS = 5 * 60_000
const PARADO_MS = 60_000

const versaoAtual = useRuntimeConfig().app?.buildId as string | undefined
const temNova = ref(false)
let ultimoToque = Date.now()
let relogio: ReturnType<typeof setInterval> | undefined
let relogioParado: ReturnType<typeof setInterval> | undefined

async function conferir() {
  if (!versaoAtual || temNova.value || (typeof navigator !== 'undefined' && navigator.onLine === false)) return
  try {
    const r = await fetch(`/_nuxt/builds/latest.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!r.ok) return
    const j = await r.json()
    if (j?.id && j.id !== versaoAtual) temNova.value = true
  } catch { /* sem rede: confere na próxima */ }
}

function atualizar() {
  window.location.reload()
}

const tocou = () => { ultimoToque = Date.now() }
const voltou = () => { if (!document.hidden) void conferir() }

onMounted(() => {
  void conferir()
  relogio = setInterval(() => { void conferir() }, CONFERIR_A_CADA_MS)
  relogioParado = setInterval(() => {
    if (temNova.value && !props.ocupado && !document.hidden && navigator.onLine !== false
        && Date.now() - ultimoToque > PARADO_MS) atualizar()
  }, 10_000)
  window.addEventListener('pointerdown', tocou, { passive: true })
  window.addEventListener('keydown', tocou)
  document.addEventListener('visibilitychange', voltou)
})
onBeforeUnmount(() => {
  clearInterval(relogio)
  clearInterval(relogioParado)
  window.removeEventListener('pointerdown', tocou)
  window.removeEventListener('keydown', tocou)
  document.removeEventListener('visibilitychange', voltou)
})
</script>

<template>
  <div v-if="temNova" role="status" data-parte="versao-nova"
       class="flex items-center justify-between gap-3 bg-acao px-4 py-2.5 text-sm font-semibold text-white">
    <span>Versão nova do app disponível.</span>
    <button type="button" class="rounded-md bg-white px-3 py-1.5 text-acao" data-parte="atualizar-app" @click="atualizar">
      Atualizar
    </button>
  </div>
</template>
