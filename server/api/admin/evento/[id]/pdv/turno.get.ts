/**
 * GET /api/admin/evento/:id/pdv/turno?turno=<uuid> — o extrato do caixa.
 *
 * Serve a dois momentos diferentes com o mesmo número: durante o turno, é o
 * operador conferindo se o que ele lembra bate; no fechamento, é o gerente
 * lendo por que faltou.
 *
 * O `esperado` sai daqui mas a tela de fechamento não mostra antes da
 * contagem — ver o alvo antes de contar transforma a conferência em cópia.
 */
import { q, q1, tx } from '../../../../../utils/db'
import { contarTurno } from '../../../../../utils/caixa'

export default defineEventHandler(async (event) => {
  const eventId = getRouterParam(event, 'id')!
  const turnoId = String(getQuery(event).turno ?? '')
  if (!turnoId) throw createError({ statusCode: 400, statusMessage: 'Informe o caixa' })

  const turno = await q1<any>(
    `SELECT t.id, t.status, t.opened_at, t.closed_at, t.opening_float_cents,
            t.closing_counted_cents, t.closing_expected_cents, t.note,
            p.name AS ponto, p.location, p.payment_methods,
            u.name AS operador
       FROM pos_shifts t
       JOIN pos_terminals p ON p.id = t.terminal_id
       JOIN users u ON u.id = t.operator_id
      WHERE t.id = $1 AND t.event_id = $2`, [turnoId, eventId])
  if (!turno) throw createError({ statusCode: 404, statusMessage: 'Caixa não encontrado' })

  // Leitura de acompanhamento: sem lock e sem congelar nada. Uma venda que
  // entre no meio das consultas muda o número da próxima atualização da tela,
  // e tudo bem — o número que vale pra conferência é o que o FECHAMENTO
  // congela, e lá a linha do turno está travada.
  const contagem = await tx((c) => contarTurno(c, turnoId))

  const movimentos = await q<any>(
    `SELECT m.id, m.kind, m.amount_cents, m.reason, m.at, u.name AS por
       FROM pos_cash_movements m
       LEFT JOIN users u ON u.id = m.by_user
      WHERE m.shift_id = $1 ORDER BY m.at DESC`, [turnoId])

  const vendas = await q<any>(
    `SELECT o.id, o.code, o.total_cents, o.payment_method, o.paid_at,
            o.cash_received_cents, o.change_cents,
            COALESCE(c.name, '—') AS comprador,
            (SELECT count(*)::int FROM tickets t WHERE t.order_id = o.id) AS ingressos
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.pos_shift_id = $1 AND o.status = 'pago'
      ORDER BY o.paid_at DESC LIMIT 100`, [turnoId])

  return {
    turno: {
      id: turno.id,
      status: turno.status,
      ponto: turno.ponto,
      local: turno.location,
      formas: turno.payment_methods,
      operador: turno.operador,
      abriuEm: turno.opened_at,
      fechouEm: turno.closed_at,
      fundoCents: Number(turno.opening_float_cents),
      contadoCents: turno.closing_counted_cents === null ? null : Number(turno.closing_counted_cents),
      esperadoNoFechamentoCents: turno.closing_expected_cents === null
        ? null : Number(turno.closing_expected_cents),
      observacao: turno.note,
    },
    contagem,
    movimentos: movimentos.map((m) => ({
      id: m.id, tipo: m.kind, valorCents: Number(m.amount_cents),
      motivo: m.reason, em: m.at, por: m.por,
    })),
    vendas: vendas.map((v) => ({
      id: v.id, codigo: v.code, totalCents: Number(v.total_cents),
      forma: v.payment_method, em: v.paid_at, comprador: v.comprador, ingressos: v.ingressos,
      recebidoCents: v.cash_received_cents === null ? null : Number(v.cash_received_cents),
      trocoCents: v.change_cents === null ? null : Number(v.change_cents),
    })),
  }
})
