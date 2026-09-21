/**
 * vitest.config.ts — a suíte roda em dois ambientes, de propósito.
 *
 * O padrão continua `node`: teste de dinheiro vai ao banco e não quer DOM
 * nenhum no caminho. Quem precisa de tela pede na primeira linha do arquivo
 * com `// @vitest-environment happy-dom` — e aí existe `document`,
 * `@vue/test-utils` monta o componente e dá pra PERGUNTAR o que a tela
 * mostrou, em vez de acreditar que mostrou.
 *
 * Antes desta linha o repositório tinha 46 arquivos `.vue` e zero teste de
 * componente: `npx vitest run` num `import` de `.vue` respondia
 * "Failed to parse source for import analysis … Install @vitejs/plugin-vue".
 * Trinta e cinco telas sem rede num projeto cuja classe de bug mais comum é a
 * que "só aparece olhando".
 */
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const raiz = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [vue()],
  resolve: {
    // os mesmos apelidos que o Nuxt resolve em produção: `~~` é a raiz,
    // `~` é a pasta `app`. Sem isto, `~~/server/utils/papeis` (a régua de
    // papéis que o layout do painel importa DE VERDADE) não resolve, e o
    // teste de papel acabaria testando uma cópia da régua.
    alias: {
      '~~': raiz,
      '@@': raiz,
      '~': raiz + 'app',
      '@': raiz + 'app',
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./scripts/test-setup.ts', './app/composables/.vitest-setup-dom.ts'],
    fileParallelism: false,
  },
})
