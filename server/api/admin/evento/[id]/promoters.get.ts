/**
 * GET /api/admin/evento/:id/promoters — divulgadores e o que cada um vendeu.
 *
 * O número que importa não é quantos links o promoter mandou, é quanto entrou
 * por ele. Por isso a contagem vem de `orders.promoter_id` com status pago —
 * clique não é venda, e um painel que mostra clique faz o produtor pagar
 * comissão por tráfego.
 */
import { q, q1 } from '../../../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const ev = await q1<any>(`SELECT id, name, slug FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const linhas = await q<any>(
    `SELECT p.id, p.name, p.email, p.phone, p.code, p.commission_bps, p.active, p.created_at,
            COUNT(o.id) FILTER (WHERE o.status = 'pago')::int           AS pedidos,
            COALESCE(SUM(o.face_cents) FILTER (WHERE o.status = 'pago'), 0)::bigint AS faturado,
            COALESCE(SUM(oi.quantity) FILTER (WHERE o.status = 'pago'), 0)::int     AS ingressos
       FROM promoters p
       LEFT JOIN orders o      ON o.promoter_id = p.id
       LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE p.event_id = $1
      GROUP BY p.id
      ORDER BY faturado DESC, p.name`, [id])

  return {
    evento: { id: ev.id, nome: ev.name, slug: ev.slug },
    promoters: linhas.map((p) => {
      const faturado = Number(p.faturado)
      return {
        id: p.id, nome: p.name, email: p.email, telefone: p.phone, codigo: p.code,
        comissaoBps: Number(p.commission_bps), ativo: p.active,
        pedidos: p.pedidos, ingressos: p.ingressos,
        faturadoCents: faturado,
        // A comissão é calculada sobre a FACE, não sobre o total: a taxa de
        // serviço não é receita do produtor, e comissionar em cima dela é
        // pagar percentual sobre dinheiro que nunca entrou.
        comissaoCents: Math.round((faturado * Number(p.commission_bps)) / 10_000),
        link: `/e/${ev.slug}?promoter=${encodeURIComponent(p.code)}`,
        podeApagar: p.pedidos === 0,
      }
    }),
  }
})
