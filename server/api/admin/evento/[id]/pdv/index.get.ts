/**
 * GET /api/admin/evento/:id/pdv — os pontos de venda e o estado de cada caixa.
 *
 * É a tela que o produtor abre às 19h pra saber quem está vendendo, com
 * quanto, e qual guichê ainda não fechou. Por isso cada ponto vem com o turno
 * aberto embutido: a pergunta "o caixa 2 está aberto?" não pode custar uma
 * segunda visita à tela.
 */
import { q } from '../../../../../utils/db'

export default defineEventHandler(async (event) => {
  const eventId = getRouterParam(event, 'id')!

  const pontos = await q<any>(
    `SELECT p.id, p.name, p.location, p.kind, p.payment_methods, p.active, p.created_at,
            t.id                  AS turno_id,
            t.opened_at           AS turno_abriu,
            t.opening_float_cents AS turno_fundo,
            u.name                AS turno_operador,
            COALESCE(v.pedidos, 0)::int     AS turno_pedidos,
            COALESCE(v.total, 0)::bigint    AS turno_total,
            COALESCE(d.pedidos_hoje, 0)::int  AS pedidos_hoje,
            COALESCE(d.total_hoje, 0)::bigint AS total_hoje
       FROM pos_terminals p
       LEFT JOIN pos_shifts t ON t.terminal_id = p.id AND t.status = 'aberto'
       LEFT JOIN users u ON u.id = t.operator_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS pedidos, COALESCE(SUM(o.total_cents),0)::bigint AS total
           FROM orders o WHERE o.pos_shift_id = t.id AND o.status = 'pago') v ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS pedidos_hoje, COALESCE(SUM(o.total_cents),0)::bigint AS total_hoje
           FROM orders o
          WHERE o.pos_terminal_id = p.id AND o.status = 'pago'
            AND o.paid_at >= date_trunc('day', now())) d ON true
      WHERE p.event_id = $1
      ORDER BY p.active DESC, p.name`, [eventId])

  // Turnos fechados recentes: é onde a diferença de caixa aparece, e é o que
  // o gerente confere no dia seguinte.
  const turnos = await q<any>(
    `SELECT t.id, t.status, t.opened_at, t.closed_at,
            t.opening_float_cents, t.closing_counted_cents, t.closing_expected_cents,
            t.note, p.name AS ponto, u.name AS operador, f.name AS fechou_quem,
            COALESCE(v.pedidos, 0)::int  AS pedidos,
            COALESCE(v.total, 0)::bigint AS total
       FROM pos_shifts t
       JOIN pos_terminals p ON p.id = t.terminal_id
       JOIN users u ON u.id = t.operator_id
       LEFT JOIN users f ON f.id = t.closed_by
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS pedidos, COALESCE(SUM(o.total_cents),0)::bigint AS total
           FROM orders o WHERE o.pos_shift_id = t.id AND o.status = 'pago') v ON true
      WHERE t.event_id = $1
      ORDER BY t.opened_at DESC
      LIMIT 40`, [eventId])

  const total = await q<any>(
    `SELECT COALESCE(SUM(o.total_cents),0)::bigint AS bruto,
            count(*)::int AS pedidos,
            COALESCE(SUM(CASE WHEN o.payment_method = 'dinheiro' THEN o.total_cents END),0)::bigint
              AS dinheiro
       FROM orders o
      WHERE o.event_id = $1 AND o.status = 'pago' AND o.pos_terminal_id IS NOT NULL`, [eventId])

  return {
    pontos: pontos.map((p) => ({
      id: p.id,
      nome: p.name,
      local: p.location,
      tipo: p.kind,
      formas: p.payment_methods,
      ativo: p.active,
      turno: p.turno_id
        ? {
            id: p.turno_id,
            abriuEm: p.turno_abriu,
            fundoCents: Number(p.turno_fundo),
            operador: p.turno_operador,
            pedidos: p.turno_pedidos,
            totalCents: Number(p.turno_total),
          }
        : null,
      hoje: { pedidos: p.pedidos_hoje, totalCents: Number(p.total_hoje) },
    })),
    turnos: turnos.map((t) => ({
      id: t.id,
      status: t.status,
      ponto: t.ponto,
      operador: t.operador,
      fechouQuem: t.fechou_quem,
      abriuEm: t.opened_at,
      fechouEm: t.closed_at,
      fundoCents: Number(t.opening_float_cents),
      contadoCents: t.closing_counted_cents === null ? null : Number(t.closing_counted_cents),
      esperadoCents: t.closing_expected_cents === null ? null : Number(t.closing_expected_cents),
      // a diferença é calculada na leitura a partir dos dois números
      // congelados — nunca recalculada do zero, senão o fechamento de ontem
      // muda sozinho quando um pedido de ontem for estornado hoje.
      diferencaCents: t.closing_counted_cents === null || t.closing_expected_cents === null
        ? null
        : Number(t.closing_counted_cents) - Number(t.closing_expected_cents),
      pedidos: t.pedidos,
      totalCents: Number(t.total),
      observacao: t.note,
    })),
    resumo: {
      brutoCents: Number(total[0]?.bruto ?? 0),
      pedidos: Number(total[0]?.pedidos ?? 0),
      dinheiroCents: Number(total[0]?.dinheiro ?? 0),
    },
  }
})
