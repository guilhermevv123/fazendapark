/**
 * GET /api/admin/evento/:id/cortesias — ingressos dados, e por quem.
 *
 * Cortesia é a categoria que some do relatório e reaparece na portaria. O
 * número de cortesia emitida precisa ficar no mesmo lugar em que se emite,
 * senão o produtor descobre que deu 400 entradas de graça olhando a fila.
 */
import { q, q1 } from '../../../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const ev = await q1<any>(`SELECT id, name FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const ingressos = await q<any>(
    `SELECT t.id, t.code, t.status, t.holder_name, t.holder_email, t.holder_document,
            t.issued_at, t.checked_in_at,
            s.name AS setor, l.name AS lote, tt.name AS tipo,
            o.code AS pedido, o.id AS pedido_id
       FROM tickets t
       JOIN sectors s ON s.id = t.sector_id
       JOIN lots    l ON l.id = t.lot_id
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN orders o ON o.id = t.order_id
      WHERE t.event_id = $1 AND t.is_courtesy = true
      ORDER BY t.issued_at DESC
      LIMIT 500`, [id])

  // O resumo é contado no banco, não somando a lista: a lista tem LIMIT e um
  // total tirado dela mentiria assim que passasse de 500 cortesias.
  const resumo = await q1<any>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'usado')::int     AS usados,
            count(*) FILTER (WHERE status = 'cancelado')::int AS cancelados,
            -- o que essas cortesias teriam faturado se fossem vendidas
            COALESCE(SUM(l.price_cents) FILTER (WHERE t.status <> 'cancelado'), 0)::bigint AS valor_dado
       FROM tickets t JOIN lots l ON l.id = t.lot_id
      WHERE t.event_id = $1 AND t.is_courtesy = true`, [id])

  // Só lote com estoque pode receber cortesia — e a tela precisa saber quanto
  // sobrou pra não oferecer o que não existe.
  const lotes = await q<any>(
    `SELECT l.id, l.name, l.price_cents, l.quantity, l.sold, l.reserved,
            s.name AS setor, s.id AS setor_id
       FROM lots l JOIN sectors s ON s.id = l.sector_id
      WHERE s.event_id = $1
      ORDER BY s.sort_order, l.sort_order`, [id])

  return {
    evento: { id: ev.id, nome: ev.name },
    resumo: {
      total: resumo.total, usados: resumo.usados, cancelados: resumo.cancelados,
      valorDadoCents: Number(resumo.valor_dado),
    },
    lotes: lotes.map((l) => ({
      id: l.id, nome: l.name, setor: l.setor, setorId: l.setor_id,
      faceCents: Number(l.price_cents),
      disponivel: l.quantity - l.sold - l.reserved,
    })),
    ingressos: ingressos.map((t) => ({
      id: t.id, codigo: t.code, status: t.status,
      nome: t.holder_name, email: t.holder_email, documento: t.holder_document,
      emitidoEm: t.issued_at, entrouEm: t.checked_in_at,
      setor: t.setor, lote: t.lote, tipo: t.tipo,
      pedido: t.pedido, pedidoId: t.pedido_id,
    })),
  }
})
