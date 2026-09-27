/**
 * Bateria E2E (Playwright) — o "teste na mão" escrito, pra rodar de novo a qualquer hora.
 *
 * Cada caso faz o que uma pessoa faria no navegador: clica, preenche a opção A e depois a B,
 * aperta F5 no meio, volta, clica duas vezes. Roda contra a instância de E2E (`npm run dev:e2e`,
 * banco `diamond_tickets_e2e`), NUNCA contra o painel real nem contra a produção — `e2e/apoio.ts`
 * recusa a base nesses endereços antes do primeiro clique.
 *
 * Navegador: o Google Chrome já instalado (`channel: 'chrome'`), sem baixar Chromium.
 *
 *   npm run e2e:banco && npm run dev:e2e    (em outro terminal)
 *   npm run e2e                              (tudo)
 *   npx playwright test e2e/compra.e2e.ts    (um arquivo)
 */
import { defineConfig, devices } from '@playwright/test'

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3120'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  // `nuxt dev` compila no primeiro acesso: com a máquina carregada uma tela passou de 1 min (27/09)
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // uma instância, um banco: os casos criam o que usam, mas somas da organização mudam se dois
  // arquivos compram ao mesmo tempo — em série, o número de uma tela é o que o caso espera
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'e2e-resultados/resultado.json' }],
    ['html', { outputFolder: 'e2e-resultados/html', open: 'never' }],
  ],
  outputDir: 'e2e-resultados/artefatos',
  use: {
    baseURL: BASE,
    channel: 'chrome',
    locale: 'pt-BR',
    timezoneId: 'America/Bahia',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    { name: 'preparo', testMatch: /preparo\.e2e\.ts/ },
    {
      name: 'computador',
      testIgnore: [/preparo\.e2e\.ts/, /celular\.e2e\.ts/],
      use: { viewport: { width: 1366, height: 860 } },
      dependencies: ['preparo'],
    },
    {
      name: 'celular',
      testMatch: /celular\.e2e\.ts/,
      use: { ...devices['Pixel 7'], channel: 'chrome' },
      dependencies: ['preparo'],
    },
  ],
})
