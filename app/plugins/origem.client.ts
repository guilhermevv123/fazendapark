/**
 * Guarda a origem de cada chegada ao site e conta a visita (052) — ver `composables/origemDaVisita.ts`.
 *
 * A visita sobe UMA vez por aba (a primeira página pública aberta nela), em segundo plano: falhar
 * aqui não pode atrasar nem quebrar nada da vitrine.
 */
import { idsDaVisita, PAGINA_DA_EQUIPE, registrarChegada } from '~/composables/origemDaVisita'

export default defineNuxtPlugin((nuxtApp) => {
  const router = useRouter()
  let primeira = true

  const chegou = (to: { path: string; query: Record<string, unknown> }) => {
    try {
      const referencia = primeira ? (document.referrer || null) : null
      primeira = false
      const origem = registrarChegada(to.query, referencia, to.path)
      if (PAGINA_DA_EQUIPE.test(to.path)) return
      const { visitante, aba, novaAba } = idsDaVisita()
      // a aba já contou; mas se ESTA chegada trouxe origem nova (clicou noutro anúncio), conta de novo
      if (!novaAba && !origem) return
      const corpo = JSON.stringify({ visitante, aba: novaAba ? aba : `${aba}-${Date.now().toString(36)}`, caminho: to.path, origem })
      void fetch('/api/origem/visita', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: corpo, keepalive: true,
      }).catch(() => {})
    } catch { /* nunca quebra a página */ }
  }

  nuxtApp.hook('app:mounted', () => chegou(router.currentRoute.value as any))
  router.afterEach((to, from) => {
    if (!from.matched.length) return // a primeira já foi pelo app:mounted
    if (to.fullPath === from.fullPath) return
    // só conta navegação interna quando a URL trouxe origem (ex.: link com UTM aberto por dentro)
    if (Object.keys(to.query).some((k) => /^(utm_|fbclid|gclid|ttclid)/.test(k))) chegou(to as any)
  })
})
