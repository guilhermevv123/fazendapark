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
    // De minuto em minuto: é o intervalo que faz a prateleira voltar antes de
    // a próxima pessoa desistir. Mais espaçado que isso e o lugar fica preso
    // tempo suficiente pra virar venda perdida numa noite de pico.
    scheduledTasks: { '* * * * *': ['liberar-expirados'] },
  },
})
