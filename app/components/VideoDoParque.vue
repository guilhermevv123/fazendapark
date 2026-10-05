<script setup lang="ts">
/**
 * "Veja o parque" — o vídeo vertical de destaque da home (dono, 05/10).
 *
 * O vídeo (52 s, drone + atrações) mora em `public/videos/` já convertido pra web: H.264
 * 540×960 com `faststart` (começa a tocar antes de baixar tudo), ~8 MB. Três cuidados:
 *
 * - **Só baixa quando a pessoa chega perto.** `preload="none"` e o `src` entra pelo
 *   IntersectionObserver: quem não rola até aqui não gasta os 8 MB do plano de dados.
 * - **Toca sozinho e mudo, como o Instagram** — navegador só deixa autoplay mudo —, pausa ao
 *   sair da tela e tem botão de som. Quem pede menos movimento (`prefers-reduced-motion`) não
 *   recebe autoplay: vê a capa e um botão de tocar.
 * - Sem JavaScript fica a capa (o vídeo depende do script pra baixar).
 */
defineProps<{ irComprar: string }>()

const VIDEO = '/videos/conquista-park-540.mp4'
const CAPA = '/videos/conquista-park-capa.webp'

const video = ref<HTMLVideoElement | null>(null)
const caixa = ref<HTMLElement | null>(null)
const carregado = ref(false)
const tocando = ref(false)
const comSom = ref(false)
const semMovimento = ref(false)
let observador: IntersectionObserver | null = null

function carregar() {
  if (carregado.value || !video.value) return
  video.value.src = VIDEO
  carregado.value = true
}

async function tocar() {
  carregar()
  try { await video.value?.play() } catch { /* navegador recusou o autoplay: fica a capa e o botão */ }
}

function alternar() {
  if (!video.value) return
  if (video.value.paused) tocar()
  else video.value.pause()
}

function alternarSom() {
  if (!video.value) return
  comSom.value = !comSom.value
  video.value.muted = !comSom.value
  if (comSom.value && video.value.paused) tocar()
}

onMounted(() => {
  semMovimento.value = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!caixa.value || !('IntersectionObserver' in window)) return
  observador = new IntersectionObserver((entradas) => {
    for (const e of entradas) {
      if (e.isIntersecting) {
        carregar()
        if (!semMovimento.value && e.intersectionRatio >= 0.5) tocar()
      } else if (video.value && !video.value.paused) {
        video.value.pause()
      }
    }
  }, { rootMargin: '300px 0px', threshold: [0, 0.5] })
  observador.observe(caixa.value)
})
onBeforeUnmount(() => observador?.disconnect())
</script>

<template>
  <section aria-labelledby="veja-o-parque" class="relative isolate overflow-hidden bg-grape-950 text-white" data-parte="video-do-parque">
    <div aria-hidden="true"
         class="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(40%_45%_at_80%_30%,rgb(34_170_195/0.35),transparent_70%),radial-gradient(35%_40%_at_10%_90%,rgb(253_185_42/0.18),transparent_70%)]" />
    <div class="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-[1fr_auto] lg:gap-16">
      <div data-revelar class="max-w-xl">
        <p class="text-[13px] font-semibold uppercase tracking-[0.22em] text-pool-300">Veja o parque</p>
        <h2 id="veja-o-parque" class="titulo mt-3 text-balance text-3xl font-semibold leading-tight tracking-[-0.02em] sm:text-[44px]">
          Um dia inteiro de <span class="text-sun-300">água, sol e cor</span>.
        </h2>
        <p class="mt-4 text-lg leading-8 text-grape-100">
          Do alto, dá pra ver tudo: os toboáguas coloridos, as piscinas, a área infantil e o deck pra descansar à sombra.
          É assim que o seu dia no Conquista Park começa.
        </p>
        <ul class="mt-6 grid gap-2 text-base text-white/90">
          <li v-for="item in ['Toboáguas para todas as idades', 'Piscinas e área infantil', 'Restaurante e espaço à sombra']" :key="item"
              class="flex items-center gap-3">
            <span class="grid size-6 shrink-0 place-items-center rounded-full bg-sun-400 text-grape-950" aria-hidden="true">
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7" /></svg>
            </span>
            {{ item }}
          </li>
        </ul>
        <NuxtLink :to="irComprar" class="btn-cta brilho mt-8 inline-flex px-7 py-3.5 text-base">Comprar ingressos</NuxtLink>
      </div>

      <!-- o "celular": o vídeo é vertical, então mora numa moldura vertical -->
      <div ref="caixa" data-revelar="120"
           class="relative mx-auto w-full max-w-[300px] sm:max-w-[340px]">
        <div class="relative overflow-hidden rounded-[2.25rem] bg-ink-950 p-2 shadow-2xl ring-1 ring-white/15">
          <div class="relative aspect-[9/16] overflow-hidden rounded-[1.75rem] bg-ink-900">
            <video ref="video" :poster="CAPA" preload="none" muted loop playsinline
                   class="h-full w-full object-cover"
                   aria-label="Vídeo do Conquista Park visto de cima: toboáguas, piscinas e área infantil"
                   @play="tocando = true" @pause="tocando = false" @click="alternar">
            </video>

            <button v-if="!tocando" type="button" data-parte="tocar-video"
                    class="absolute inset-0 grid place-items-center bg-ink-950/25 transition-colors hover:bg-ink-950/10"
                    aria-label="Tocar o vídeo do parque" @click="tocar">
              <span class="grid size-16 place-items-center rounded-full bg-sun-400 text-grape-950 shadow-lg">
                <svg class="ml-1 size-7" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z" /></svg>
              </span>
            </button>

            <button type="button" data-parte="som-video"
                    class="absolute bottom-3 right-3 inline-flex items-center gap-2 rounded-full bg-ink-950/70 px-3.5 py-2 text-sm font-semibold text-white backdrop-blur transition-colors hover:bg-ink-950/85"
                    :aria-pressed="comSom" @click="alternarSom">
              <svg v-if="comSom" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" /></svg>
              <svg v-else class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M22 9l-6 6M16 9l6 6" /></svg>
              {{ comSom ? 'Com som' : 'Ativar som' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
