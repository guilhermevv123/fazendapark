/**
 * App do tablet das Comandas (Android, Capacitor).
 *
 * As telas NÃO são copiadas: vêm de `../app/components/comanda` (as mesmas do site), pelo
 * apelido `~` → `../app`. Mudou lá, muda aqui. O que é do Nuxt e não existe num Vite puro
 * (`$fetch`, `<NuxtLink>`, `<ClientOnly>`, auto-import de `ref`/`computed`…) é suprido em
 * `src/nuxt.ts` e no AutoImport abaixo.
 */
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import { defineConfig } from 'vite'

const site = fileURLToPath(new URL('../app', import.meta.url))

export default defineConfig({
  plugins: [
    vue(),
    AutoImport({
      imports: ['vue', 'vue-router', { '#nuxt-do-app': ['useRuntimeConfig'] }],
      dts: false,
    }),
  ],
  resolve: {
    alias: { '~': site, '#nuxt-do-app': fileURLToPath(new URL('./src/nuxt.ts', import.meta.url)) },
    // um Vue só: as telas de `../app` e o app precisam do MESMO Vue (senão a reatividade quebra)
    dedupe: ['vue', 'vue-router'],
  },
  server: {
    fs: { allow: ['..'] },
    // no navegador do PC, `/api` vai pro servidor local do site (porta 3100), sem CORS
    proxy: { '/api': 'http://localhost:3100' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
