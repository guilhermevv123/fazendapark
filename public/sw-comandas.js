/**
 * sw-comandas.js — mantém o tablet da comanda (055) de pé quando a internet cai.
 *
 * É o MESMO desenho do `sw-portaria.js` (leia o cabeçalho de lá): rede primeiro, cópia
 * guardada como reserva depois de 4 s, `/api/` NUNCA vai pro cache, só GET da mesma origem.
 * O que muda: as telas guardadas são as de `/admin/comandas`, o cache se chama `dc-*` (não
 * encosta no `dt-*` da portaria) e o escopo do registro é `/admin/comandas` — este worker não
 * controla nenhuma outra tela do sistema.
 *
 * Os PEDIDOS feitos sem internet não passam por aqui: quem guarda a fila é a página
 * (`app/composables/comandaOffline.ts`). Este arquivo só garante que a TELA abre sem rede.
 */
const VERSAO = new URL(self.location.href).searchParams.get('v') || 'comandas-v1'
const CACHE = `dc-${VERSAO}`
const ESPERA_MS = 4000
const CHAVE_COMPLETO = '/__sw-comandas-completo'

/** é tela do tablet da comanda */
const ehTelaDaComanda = (caminho) => caminho === '/admin/comandas' || caminho.startsWith('/admin/comandas/')

/** Baixa uma tela e os /_nuxt/ que ela cita (entrada, CSS, pedaços pré-carregados). */
async function guardarTela(cache, url) {
  const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
  if (!r.ok || r.redirected) return false
  await cache.put(url, r.clone())
  const html = await r.text()
  const pedacos = [...new Set(html.match(/\/_nuxt\/[^"'\s)<>]+/g) ?? [])]
    .filter((p) => !p.startsWith('/_nuxt/builds/'))
  await Promise.all(pedacos.map(async (p) => {
    try {
      const a = await fetch(p)
      if (a.ok) await cache.put(p, a)
    } catch { /* um pedaço que falhou vem da rede na próxima vez */ }
  }))
  return true
}

self.addEventListener('install', (evento) => {
  evento.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    try {
      const telas = new Set([new URL('/admin/comandas/atender', self.location.origin).href])
      for (const nome of await caches.keys()) {
        if (!nome.startsWith('dc-') || nome === CACHE) continue
        for (const req of await (await caches.open(nome)).keys()) {
          const u = new URL(req.url)
          if (ehTelaDaComanda(u.pathname)) telas.add(u.origin + u.pathname)
        }
      }
      const feitas = await Promise.all([...telas].slice(0, 12).map((u) => guardarTela(cache, u).catch(() => false)))
      if (feitas.some(Boolean)) await cache.put(CHAVE_COMPLETO, new Response('1'))
    } catch { /* sem rede: o cache velho segura até a próxima vez */ }
  })())
  // Assume o lugar do worker antigo na hora. Um tablet de portaria fica aberto
  // dias; esperar todas as abas fecharem é esperar o evento acabar.
  self.skipWaiting()
})

self.addEventListener('activate', (evento) => {
  evento.waitUntil((async () => {
    const meu = await caches.open(CACHE)
    // só apaga o velho se o novo já tem com que abrir sem rede
    if (await meu.match(CHAVE_COMPLETO)) {
      for (const nome of await caches.keys()) {
        if (nome.startsWith('dc-') && nome !== CACHE) await caches.delete(nome)
      }
    }
    await self.clients.claim()
  })())
})

/** A página pede pra trocar de worker sem esperar (botão "atualizar"). */
self.addEventListener('message', (evento) => {
  if (evento.data === 'assumir-agora') self.skipWaiting()
})

function meInteressa(requisicao) {
  if (requisicao.method !== 'GET') return false
  const url = new URL(requisicao.url)
  if (url.origin !== self.location.origin) return false
  // A regra que não pode ser afrouxada: resposta de API não vira cache.
  if (url.pathname.startsWith('/api/')) return false
  // O número da versão tem que vir do servidor, sempre (é ele que avisa "versão nova").
  if (url.pathname.startsWith('/_nuxt/builds/')) return false
  // Navegação: SÓ as telas da comanda. O resto do painel nunca fica guardado no aparelho.
  if (requisicao.mode === 'navigate') return ehTelaDaComanda(url.pathname)
  return url.pathname.startsWith('/_nuxt/')
    || url.pathname.startsWith('/brand/')
    || url.pathname.startsWith('/comandas/icones/')
    || url.pathname === '/comandas.webmanifest'
}

self.addEventListener('fetch', (evento) => {
  if (!meInteressa(evento.request)) return // passa direto, como se eu não existisse
  evento.respondWith(redePrimeiro(evento.request))
})

/** a cópia guardada — no cache desta versão ou, se ele ainda não tem, em qualquer outro */
async function copiaGuardada(cache, requisicao) {
  const opcoes = requisicao.mode === 'navigate' ? { ignoreSearch: true } : undefined
  return (await cache.match(requisicao, opcoes)) || (await caches.match(requisicao, opcoes))
}

/** Sem cópia desta tela: a lista de eventos (de onde se chega a qualquer leitor) e, sem ela, qualquer leitor. */
async function telaReserva() {
  const lista = await caches.match(new URL('/admin/comandas/atender', self.location.origin).href, { ignoreSearch: true })
  if (lista) return lista
  for (const nome of await caches.keys()) {
    if (!nome.startsWith('dc-')) continue
    const c = await caches.open(nome)
    const qualquer = (await c.keys()).find((r) => ehTelaDaComanda(new URL(r.url).pathname))
    if (qualquer) return c.match(qualquer)
  }
  return null
}

async function redePrimeiro(requisicao) {
  const cache = await caches.open(CACHE)

  const daRede = fetch(requisicao).then(async (resposta) => {
    // `resposta.ok` só: guardar um 404 ou um 500 no cache é transformar um
    // erro de um minuto em erro permanente do tablet. Redirecionada (sessão caiu e o servidor
    // mandou pro login) também não: a cópia boa da tela continua sendo a de antes.
    if (resposta && resposta.ok && !resposta.redirected) {
      try { await cache.put(requisicao, resposta.clone()) } catch { /* cota cheia */ }
    }
    return resposta
  })

  // A corrida: ou a rede responde em 4s, ou entra o cache. A promessa da rede
  // continua viva de qualquer jeito — é ela que renova a cópia guardada.
  const guardada = await copiaGuardada(cache, requisicao)
  if (!guardada) {
    try {
      const r = await daRede
      // servidor fora (502/503/504 do proxy) numa navegação: a tela reserva vale mais que a página de erro
      if (r.status >= 500 && requisicao.mode === 'navigate') return (await telaReserva()) || r
      return r
    } catch {
      if (requisicao.mode === 'navigate') {
        const reserva = await telaReserva()
        if (reserva) return reserva
      }
      throw new Error('sem rede e sem cópia guardada')
    }
  }

  const relogio = new Promise((resolve) => setTimeout(() => resolve(null), ESPERA_MS))
  try {
    const resposta = await Promise.race([daRede.catch(() => null), relogio])
    // 5xx = o servidor está fora (deploy, queda): a cópia boa de antes vale mais que a página de erro
    if (resposta && resposta.status >= 500) return guardada
    return resposta || guardada
  } catch {
    return guardada
  }
}
