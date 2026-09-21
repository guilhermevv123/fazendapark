import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/base.css'],
  runtimeConfig: {
    databaseUrl: process.env.DATABASE_URL,
    asaasWebhookToken: process.env.ASAAS_WEBHOOK_TOKEN,
    public: { baseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:3000' },
  },
  app: {
    head: {
      htmlAttrs: { lang: 'pt-BR' },
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&family=Roboto:wght@400;500;700&display=swap' },
      ],
    },
  },
  nitro: {
    experimental: { asyncContext: true, tasks: true },

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
    scheduledTasks: { '* * * * *': ['liberar-expirados'] },
  },
})
