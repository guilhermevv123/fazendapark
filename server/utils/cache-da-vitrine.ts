/**
 * Cache curto das rotas PÚBLICAS da vitrine (`/api/eventos-publicos`, `/api/e/:slug`).
 *
 * Por quê (dono, 06/10: "está demorando muito"): o servidor roda em Boston e o banco em São Paulo —
 * cada consulta atravessa o continente (~120 ms ida e volta) e a vitrine faz várias em fila. A home
 * ainda pede as duas rotas, uma depois da outra. Com o cache, só a primeira visita em cada janela
 * paga a viagem; as outras saem da memória.
 *
 * O que NÃO muda: o checkout confere estoque, preço e porta de venda no banco, na hora — a vitrine
 * alguns segundos atrasada nunca vende o que não tem nem cobra preço velho. Nada aqui depende de
 * quem pede (as duas rotas não leem sessão nem cookie). Erro não entra no cache. Pedidos iguais que
 * chegam juntos esperam a MESMA consulta (não dispara uma por visitante).
 *
 * Só em produção: em dev e nos testes (que compram e leem a vitrine em seguida) o cache fica
 * desligado. `VITRINE_CACHE_MS` ajusta (0 desliga).
 */
const guardado = new Map<string, { ate: number; valor: Promise<unknown> }>()

export function prazoDoCacheDaVitrine(): number {
  const n = Number(process.env.VITRINE_CACHE_MS)
  if (Number.isFinite(n) && process.env.VITRINE_CACHE_MS !== undefined && process.env.VITRINE_CACHE_MS !== '') return Math.max(0, n)
  return process.env.NODE_ENV === 'production' ? 10_000 : 0
}

export function comCacheDaVitrine<T>(chave: string, montar: () => Promise<T>): Promise<T> {
  const ms = prazoDoCacheDaVitrine()
  if (ms <= 0) return montar()
  const agora = Date.now()
  const hit = guardado.get(chave)
  if (hit && hit.ate > agora) return hit.valor as Promise<T>
  const valor = montar()
  guardado.set(chave, { ate: agora + ms, valor })
  valor.catch(() => { if (guardado.get(chave)?.valor === valor) guardado.delete(chave) })
  if (guardado.size > 500) for (const [k, v] of guardado) if (v.ate <= agora) guardado.delete(k)
  return valor
}

/** Para os testes. */
export function esquecerCacheDaVitrine() { guardado.clear() }
