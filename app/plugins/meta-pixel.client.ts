/**
 * Meta Pixel — código-base e `PageView` em toda página pública (ver `composables/metaPixel.ts`).
 *
 * O ID vem de `runtimeConfig.public.metaPixelId` (`NUXT_PUBLIC_META_PIXEL_ID`); vazio desliga.
 * O script do Facebook só é injetado quando a pessoa abre uma página de quem compra: as telas da
 * equipe (`ROTA_SEM_PIXEL`) nunca carregam nada de fora. Falha aqui (bloqueador de anúncio, rede)
 * não pode atrasar nem quebrar a vitrine.
 */
import { ROTA_SEM_PIXEL } from '~/composables/metaPixel'

export default defineNuxtPlugin(() => {
  const id = String(useRuntimeConfig().public.metaPixelId ?? '').trim()
  if (!/^\d+$/.test(id)) return
  const router = useRouter()
  let iniciado = false

  /** O código-base oficial do pixel (fila `fbq` + `fbevents.js` assíncrono), uma vez só. */
  function iniciar(): boolean {
    if (iniciado) return true
    try {
      const w = window as any
      if (!w.fbq) {
        const n: any = (w.fbq = function (...args: unknown[]) {
          n.callMethod ? n.callMethod.apply(n, args) : n.queue.push(args)
        })
        if (!w._fbq) w._fbq = n
        n.push = n
        n.loaded = true
        n.version = '2.0'
        n.queue = []
        const s = document.createElement('script')
        s.async = true
        s.src = 'https://connect.facebook.net/en_US/fbevents.js'
        s.onerror = () => { /* bloqueado: a fila só não sai */ }
        document.head.appendChild(s)
      }
      w.fbq('init', id)
      iniciado = true
    } catch { /* nunca quebra a página */ }
    return iniciado
  }

  function visita(caminho: string) {
    try {
      if (ROTA_SEM_PIXEL.test(caminho)) return
      if (iniciar()) window.fbq?.('track', 'PageView')
    } catch { /* nunca quebra a página */ }
  }

  // A primeira página já aqui, antes de montar: o `ViewContent` da vitrine sai no `onMounted`
  // dela e precisa achar o `fbq` pronto.
  visita(window.location.pathname)
  router.afterEach((to, from) => {
    if (!from.matched.length) return // a primeira já foi acima
    if (to.path === from.path) return
    visita(to.path)
  })
})
