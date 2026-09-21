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
 * responsabilidade da página, que sabe o que fazer com ela). Fonte do Google e
 * qualquer outra origem passam direto: offline elas falham, o navegador usa a
 * fonte de sistema e a tela continua legível.
 *
 * ## O relógio de 4 segundos
 *
 * Rede ruim não é rede ausente: o 4G do parque responde em 40 segundos em vez
 * de não responder. `fetch` fica pendurado, a página não pinta, e o operador
 * conclui que travou. Passados 4 segundos sem resposta, serve-se o cache e a
 * página abre — a requisição de rede continua correndo e atualiza o cache pra
 * próxima.
 */

const VERSAO = 'portaria-v1'
const CACHE = `dt-${VERSAO}`
const ESPERA_MS = 4000

self.addEventListener('install', (evento) => {
  // Sem precache de lista fixa: os nomes dos bundles do Nuxt mudam a cada
  // build, e uma lista escrita à mão aqui nasceria errada no primeiro deploy.
  // O que o tablet usou uma vez com rede fica no cache e é o que ele usa sem.
  evento.waitUntil(caches.open(CACHE))
  // Assume o lugar do worker antigo na hora. Um tablet de portaria fica aberto
  // dias; esperar todas as abas fecharem é esperar o evento acabar.
  self.skipWaiting()
})

self.addEventListener('activate', (evento) => {
  evento.waitUntil((async () => {
    for (const nome of await caches.keys()) {
      if (nome.startsWith('dt-') && nome !== CACHE) await caches.delete(nome)
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
  // A tela da portaria e o que ela precisa pra abrir.
  if (requisicao.mode === 'navigate') return url.pathname.includes('/validacao')
  return url.pathname.startsWith('/_nuxt/')
    || url.pathname.endsWith('.css')
    || url.pathname.endsWith('.js')
}

self.addEventListener('fetch', (evento) => {
  if (!meInteressa(evento.request)) return // passa direto, como se eu não existisse
  evento.respondWith(redePrimeiro(evento.request))
})

async function redePrimeiro(requisicao) {
  const cache = await caches.open(CACHE)

  const daRede = fetch(requisicao).then(async (resposta) => {
    // `resposta.ok` só: guardar um 404 ou um 500 no cache é transformar um
    // erro de um minuto em erro permanente do tablet.
    if (resposta && resposta.ok) {
      try { await cache.put(requisicao, resposta.clone()) } catch { /* cota cheia */ }
    }
    return resposta
  })

  // A corrida: ou a rede responde em 4s, ou entra o cache. A promessa da rede
  // continua viva de qualquer jeito — é ela que renova a cópia guardada.
  const guardada = await cache.match(requisicao)
  if (!guardada) {
    try {
      return await daRede
    } catch {
      // Sem rede e sem cópia: se era uma navegação, entrega a última tela de
      // validação que este tablet abriu, seja de qual evento for. Melhor a
      // tela do evento errado (com o aviso de offline em cima) do que a tela
      // de dinossauro.
      if (requisicao.mode === 'navigate') {
        const qualquer = (await cache.keys())
          .find((r) => new URL(r.url).pathname.includes('/validacao'))
        if (qualquer) return (await cache.match(qualquer))
      }
      throw new Error('sem rede e sem cópia guardada')
    }
  }

  const relogio = new Promise((resolve) => setTimeout(() => resolve(null), ESPERA_MS))
  try {
    const resposta = await Promise.race([daRede.catch(() => null), relogio])
    return resposta || guardada
  } catch {
    return guardada
  }
}
