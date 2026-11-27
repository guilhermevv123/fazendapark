/**
 * O pouco do Nuxt que as telas da comanda usam, para rodarem fora dele (neste app):
 * `$fetch` (global), `useRuntimeConfig` (auto-import, ver vite.config.ts), `<NuxtLink>` e
 * `<ClientOnly>` (componentes globais, registrados em main.ts).
 */
import { Capacitor } from '@capacitor/core'
import { ofetch } from 'ofetch'
import { defineComponent, h } from 'vue'
import { RouterLink } from 'vue-router'

/**
 * Para onde vão as chamadas `/api/...`.
 * - no navegador do PC (`npm run dev`): mesmo endereço, e o Vite repassa pro site local (3100);
 * - no tablet (APK): o site de verdade, ou o de `VITE_API_URL` na hora do build.
 */
export const ENDERECO_DO_SISTEMA: string = import.meta.env.VITE_API_URL
  || (Capacitor.isNativePlatform() ? 'https://www.conquistapark.com.br' : '')

;(globalThis as any).$fetch = ofetch.create({ baseURL: ENDERECO_DO_SISTEMA })
// as fotos enviadas pelo painel (`/api/cardapio-foto/...`) vêm do sistema, não de dentro do app
;(globalThis as any).__ENDERECO_DO_SISTEMA__ = ENDERECO_DO_SISTEMA

export function useRuntimeConfig() {
  return { app: { buildId: import.meta.env.VITE_VERSAO ?? 'app' }, public: {} }
}

export const NuxtLink = defineComponent({
  name: 'NuxtLink',
  props: { to: { type: [String, Object], required: true } },
  setup(props, { slots, attrs }) {
    return () => h(RouterLink, { ...attrs, to: props.to as any }, slots)
  },
})

export const ClientOnly = defineComponent({
  name: 'ClientOnly',
  setup(_, { slots }) { return () => slots.default?.() },
})
