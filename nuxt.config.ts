import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  modules: ['@nuxtjs/tailwindcss'],
  // Pasta de compilação por instância. Os três `nuxt dev` (3100 real, 3101 vitest, 3120 E2E)
  // rodam no MESMO diretório; dividindo `.nuxt/`, cada edição fazia os três regenerarem os mesmos
  // arquivos ao mesmo tempo — medido em 27/09: `router.options.mjs` levou 83 s e o E2E estourou
  // tempo. `scripts/dev-e2e.mjs` põe o dele em `.nuxt-e2e`. Sem a variável, nada muda.
  buildDir: process.env.NUXT_PASTA_BUILD || '.nuxt',
  // O cache de dependências do Vite também por instância: as cópias de trabalho das frotas de
  // correção dividem o `node_modules` (link pro repositório principal), e um servidor reotimizando
  // dependências reescrevia o cache que os outros estavam servindo — a página recarregava no meio de
  // um teste. Sem a variável, fica no lugar de sempre (`node_modules/.cache/vite`).
  // E, nessas cópias, o `node_modules` real mora fora da pasta do projeto: sem liberar o caminho
  // verdadeiro, o Vite respondia 403 pra fonte Geist (a página caía na fonte reserva e os prints
  // e medidas de tela saíam errados). No repositório principal o caminho é o mesmo de sempre.
  vite: {
    ...(process.env.NUXT_PASTA_BUILD
      ? { cacheDir: `node_modules/.cache/vite${process.env.NUXT_PASTA_BUILD.replace(/^\.nuxt/, '')}` }
      : {}),
    server: { fs: { allow: [realpathSync(fileURLToPath(new URL('./node_modules', import.meta.url)))] } },
  },
  // Cabeçalhos de segurança — a produção (27/09) saía sem NENHUM: sem HSTS, o painel podia ser
  // posto dentro de um iframe de outro site (clickjacking no botão de estornar), e o navegador
  // adivinhava tipo de arquivo. `camera=(self)` porque o leitor da portaria usa a câmera.
  // CSP completa (script com nonce) exige módulo próprio; aqui vão as diretivas que não quebram
  // nada do Nuxt e fecham o que importa: ninguém emoldura a página, nenhum plugin, nenhum <base>.
  routeRules: {
    '/**': {
      headers: {
        'Strict-Transport-Security': 'max-age=31536000',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
        'Content-Security-Policy': "frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
      },
    },
    // o painel e a sessão não ficam em cache de computador compartilhado nem em buscador
    '/admin/**': { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } },
    '/entrar': { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } },
    '/api/admin/**': { headers: { 'Cache-Control': 'no-store' } },
    '/api/auth/**': { headers: { 'Cache-Control': 'no-store' } },
  },
  // Geist, a fonte do site do parque, servida por nós e não pelo Google: vem de
  // /_nuxt/, que o service worker da portaria guarda, então o leitor de entrada
  // mantém a tipografia inclusive sem rede. A ordem importa — o base.css vem por
  // último pra ganhar de qualquer regra das fontes.
  css: [
    '@fontsource-variable/geist/index.css',
    '@fontsource-variable/geist-mono/index.css',
    '~/assets/base.css',
  ],
  // Segredo NÃO entra aqui. O que se põe no runtimeConfig com `process.env.X` no build fica
  // ESCRITO no pacote gerado (.output) se a variável existir na hora de compilar — e o banco e o
  // token do webhook estavam aqui sem ninguém ler (o servidor lê direto de process.env; achado da
  // frota F1, 28/09). Só o que é público fica.
  runtimeConfig: {
    public: { baseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:3000' },
  },
  app: {
    head: {
      htmlAttrs: { lang: 'pt-BR' },
      // O título "<tela> · Conquista Park" mora em app/plugins/titulo.ts: função
      // não sobrevive à serialização do `app.head` daqui (o `titleTemplate` em
      // forma de função chegava no navegador como se não existisse).
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#146f83' },
        { name: 'application-name', content: 'Conquista Park' },
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
  nitro: {
    experimental: { asyncContext: true, tasks: true },

    // Build de conferência em pasta própria (NUXT_PASTA_SAIDA), pelo mesmo motivo do `buildDir`:
    // duas instâncias de teste buildando juntas escreviam no mesmo `.output`. Produção não define
    // a variável e continua em `.output` — é onde o Dockerfile procura.
    output: { dir: process.env.NUXT_PASTA_SAIDA || '.output' },

    // O plugin que liga as filas de fundo, registrado NA MÃO.
    //
    // A pasta `server/plugins/` é varrida automaticamente, e no build ela é —
    // medido: o `.output` sobe as duas filas no boot, sem rota nenhuma. Em
    // `nuxt dev` a varredura passou a não pegar o arquivo depois de um
    // recarregamento, e o efeito é o defeito de volta e mudo: a fila não anda
    // e nada avisa. Uma linha explícita custa menos que descobrir isso de
    // novo. O caminho é absoluto de propósito: `~/` aponta pro `app/` no Nuxt
    // 4, e um alias errado aqui falha do mesmo jeito silencioso.
    plugins: [fileURLToPath(new URL('./server/plugins/00.filas.ts', import.meta.url))],

    // De minuto em minuto: é o intervalo que faz a prateleira voltar antes de
    // a próxima pessoa desistir. Mais espaçado que isso e o lugar fica preso
    // tempo suficiente pra virar venda perdida numa noite de pico.
    //
    // O Pix do Mercado Pago é tarefa PRÓPRIA no mesmo minuto (server/tasks/mercadopago-pix.ts): o
    // cron dispara as duas juntas, e MP lento não segura a devolução do estoque atrás dele.
    scheduledTasks: { '* * * * *': ['liberar-expirados', 'mercadopago-pix'] },
  },
})
