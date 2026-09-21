/**
 * GET /api/admin/eventos — lista de eventos com o resumo que a listagem mostra.
 *
 * As somas vêm de subconsulta lateral por evento, não de um JOIN com GROUP BY
 * na tabela toda: com 3 eventos dá no mesmo, com 300 a diferença é a tela
 * abrir ou não.
 *
 * O `WHERE e.org_id` não é detalhe: sem ele esta rota listava o evento de
 * TODO cliente da instalação — nome, local, data e faturamento — pra
 * qualquer login. O recorte vem da sessão, nunca de parâmetro.
 *
 * O `cobrado` da linha recortava por `status = 'pago'` e por isso o evento com
 * estorno parcial aparecia aqui menor do que no próprio painel dele: o pedido
 * inteiro sumia por causa da devolução de uma parte. A régua agora é
 * `PEDIDO_VIVO()`, de `utils/liquido.ts`, e o líquido — o que sobra pro
 * produtor — vem junto pela mesma `SQL_LIQUIDO()` do borderô e dos
 * financeiros. Lista e detalhe têm que dizer o mesmo número.
 */
import { q } from '../../utils/db'
import { PEDIDO_VIVO, SQL_LIQUIDO } from '../../utils/liquido'

export default defineEventHandler(async (event) => {
  const orgId = (event.context as any).sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })

  const linhas = await q<any>(
    `SELECT e.id, e.name, e.slug, e.status, e.starts_at, e.ends_at,
            e.venue_name, e.city, e.state, e.thumb_url, o.name AS organizacao,
            v.cobrado, v.liquido, v.pedidos, v.ingressos,
            est.quantidade, est.vendidos
       FROM events e
       JOIN organizations o ON o.id = e.org_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(ord.total_cents),0)::bigint AS cobrado,
                ${SQL_LIQUIDO('ord.')} AS liquido,
                COUNT(*)::int AS pedidos,
                COALESCE(SUM((SELECT SUM(quantity) FROM order_items WHERE order_id = ord.id)),0)::int AS ingressos
           FROM orders ord WHERE ord.event_id = e.id AND ${PEDIDO_VIVO('ord.')}
       ) v ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(l.quantity),0)::int AS quantidade,
                COALESCE(SUM(l.sold),0)::int AS vendidos
           FROM lots l JOIN sectors s ON s.id = l.sector_id WHERE s.event_id = e.id
       ) est ON true
      WHERE e.org_id = $1
      ORDER BY e.starts_at DESC NULLS LAST, e.created_at DESC`, [orgId])

  return linhas.map((e) => ({
    id: e.id, nome: e.name, slug: e.slug, status: e.status,
    inicio: e.starts_at, fim: e.ends_at,
    local: e.venue_name, cidade: e.city, estado: e.state, thumb: e.thumb_url,
    organizacao: e.organizacao,
    cobradoCents: Number(e.cobrado ?? 0),
    // o mesmo líquido do borderô e dos dois financeiros deste evento
    liquidoCents: Number(e.liquido ?? 0),
    pedidos: Number(e.pedidos ?? 0),
    ingressos: Number(e.ingressos ?? 0),
    estoque: { total: Number(e.quantidade ?? 0), vendidos: Number(e.vendidos ?? 0) },
  }))
})
