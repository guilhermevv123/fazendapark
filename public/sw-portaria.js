/**
 * sw-portaria.js — o service worker que mantém a portaria de pé quando o 4G cai.
 *
 * O parque fica na Bahia. A rede some, volta, some de novo, e o portão não
 * pode parar. Sem isto, o tablet que a operadora deixa aberto a noite inteira
 * mostra a tela de dinossauro no primeiro F5 — e aí não tem lista, não tem
 * fila, não tem nada: a fila para até alguém achar sinal.
 *
 * ## O que ele faz, e o que ele recusa fazer
 *
 * **Network-first, cache como reserva.** Com rede, TUDO vem do servidor, igual
 * a hoje — nenhuma tela velha, nenhum bundle velho. Sem rede, a última cópia
 * boa da página e dos scripts sai do cache e o leitor abre. É o contrário do
 * cache-first que todo tutorial ensina, e é de propósito: num tablet que fica
 * semanas ligado, cache-first significa operar com o código da semana passada
 * sem ninguém perceber.
 *
 * **`/api/` nunca é cacheado. Nunca.** Uma resposta de check-in guardada e
 * servida de novo é a pior mentira que este sistema pode contar: a tela diria
 * "pode entrar" sem nada ter acontecido no servidor. Quem valida sem rede é a
 * página, contra a lista que ela baixou — e ela sabe que está offline e grava
 * a passagem na fila. O service worker não finge resposta de servidor.
 *
 * **Só GET, só mesma origem.** POST não passa por aqui (a fila é
 * responsabilidade da página, que sabe o que fazer com ela). Qualquer outra
 * origem passa direto: offline ela falha e a tela continua legível. A fonte
 * (Geist) e a logo são NOSSAS — a fonte sai de /_nuxt/, a logo de /brand/ —,
 * então entram no cache junto com o resto e o leitor abre com a cara do parque
 * mesmo sem sinal.
 *
 * ## O relógio de 4 segundos
 *
 * Rede ruim não é rede ausente: o 4G do parque responde em 40 segundos em vez
 * de não responder. `fetch` fica pendurado, a página não pinta, e o operador
 * conclui que travou. Passados 4 segundos sem resposta, serve-se o cache e a
 * página abre — a requisição de rede continua correndo e atualiza o cache pra
 * próxima.
 */

/*
 * ## Versão nova do app (05/10)
 *
 * A página registra `/sw-portaria.js?v=<buildId>`: cada deploy é um worker NOVO, com cache novo.
 * O perigo de trocar o cache é o tablet ficar sem cópia nenhuma: ele atualiza com rede, apaga o
 * cache velho, e meia hora depois cai a internet antes de ter reaberto as telas. Por isso:
 *   1. a instalação já guarda `/portaria` e REBAIXA cada tela da portaria que o cache velho
 *      tinha (com os scripts que a tela pede) — o cache novo nasce completo;
 *   2. o cache velho só é apagado se essa cópia deu certo; se não deu (instalou sem rede),
 *      ele fica, e a busca sem rede procura em TODOS os caches.
 */
const VERSAO = new URL(self.location.href).searchParams.get('v') || 'portaria-v2'
const CACHE = `dt-${VERSAO}`
const ESPERA_MS = 4000
const CHAVE_COMPLETO = '/__sw-portaria-completo'

/** é tela da portaria (endereço curto ou o leitor do painel) */
const ehTelaDaPortaria = (caminho) =>
  caminho === '/portaria' || caminho.startsWith('/portaria/') || /^\/admin\/evento\/[^/]+\/validacao\/?$/.test(caminho)

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
      const telas = new Set([new URL('/portaria', self.location.origin).href])
      for (const nome of await caches.keys()) {
        if (!nome.startsWith('dt-') || nome === CACHE) continue
        for (const req of await (await caches.open(nome)).keys()) {
          const u = new URL(req.url)
          if (ehTelaDaPortaria(u.pathname)) telas.add(u.origin + u.pathname)
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
        if (nome.startsWith('dt-') && nome !== CACHE) await caches.delete(nome)
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
  // Navegação: SÓ as telas da portaria. O resto do painel nunca fica guardado no aparelho.
  if (requisicao.mode === 'navigate') return ehTelaDaPortaria(url.pathname)
  return url.pathname.startsWith('/_nuxt/')
    || url.pathname.startsWith('/brand/')
    || url.pathname === '/portaria.webmanifest'
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
  const lista = await caches.match(new URL('/portaria', self.location.origin).href, { ignoreSearch: true })
  if (lista) return lista
  for (const nome of await caches.keys()) {
    if (!nome.startsWith('dt-')) continue
    const c = await caches.open(nome)
    const qualquer = (await c.keys()).find((r) => ehTelaDaPortaria(new URL(r.url).pathname))
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
