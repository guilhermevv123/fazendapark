import { getRequestHeader, getRequestURL, type H3Event } from 'h3'

/**
 * O caminho que o ROTEADOR usa pra escolher a rota — decodificado (`%61` → `a`)
 * pelo h3 antes de rotear e guardado em `event.path`.
 *
 * `getRequestURL(event).pathname` é o `originalUrl` CRU: um portão que decide
 * por ele vê `/api/%61dmin/...` como "não é painel" e sai cedo, enquanto o
 * roteador decodifica e entrega o handler do painel sem sessão. Medido em
 * 22/09: participantes, borderô e criação de cupom respondiam 200 sem login.
 *
 * Barras repetidas e a barra final também são tiradas: aqui é o lado que
 * TRANCA, e trancar a mais só custa um 404 que já aconteceria.
 */
export function caminhoDaRota(event: H3Event): string {
  const semQuery = event.path.split('?')[0] || '/'
  return semQuery.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')
}

/**
 * A origem que uma requisição que altera dado tem que trazer.
 *
 * Em produção vem de `PUBLIC_BASE_URL`, não da requisição: `getRequestURL`
 * monta host e protocolo de `x-forwarded-host`/`x-forwarded-proto`, que o
 * próprio cliente manda — comparar `Origin` com eles é comparar o atacante
 * com ele mesmo. Fora de produção (3100 e 3101 na mesma máquina) segue a
 * requisição, que é o que os testes e o `nuxt dev` precisam.
 */
export function origemEsperada(event: H3Event): string {
  const fixa = process.env.PUBLIC_BASE_URL
  if (process.env.NODE_ENV === 'production' && fixa) {
    try { return new URL(fixa).origin } catch { /* cai na da requisição */ }
  }
  return getRequestURL(event).origin
}

/**
 * Recusa mutação vinda de outro site: `Origin` diferente, ou `Sec-Fetch-Site:
 * cross-site` quando o navegador não mandou `Origin`. Sem nenhum dos dois é
 * cliente fora de navegador (curl, teste) — que não carrega o cookie de
 * ninguém, e por isso não é CSRF.
 */
export function mutacaoDeOutroSite(event: H3Event): boolean {
  const origem = getRequestHeader(event, 'origin')
  if (origem) return origem !== origemEsperada(event)
  return getRequestHeader(event, 'sec-fetch-site') === 'cross-site'
}
