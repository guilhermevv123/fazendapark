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
import {
  SQL_CONTA_NO_TURNO, SQL_NA_GAVETA_DO_TURNO, anulaQual, contarTurno, motivoLegivel,
} from '../../../../../utils/caixa'

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

  /**
   * AS LINHAS PRECISAM SOMAR O TOTAL IMPRESSO ACIMA DELAS.
   *
   * `contarTurno` conta o turno por pedido VIVO — `SUM(total − refunded)` em
   * `'pago'` E `'estornado_parcial'` — e esta lista recortava por
   * `status = 'pago'`. O pedido do qual o operador devolveu R$ 20 sumia da
   * lista inteiro e continuava dentro do total: medido na fixture, contagem
   * de R$ 1.415,00 em 2 pedidos com UMA linha de R$ 500,00 na tela. O
   * operador confere a gaveta somando linhas que não fecham com o número
   * impresso logo acima, e não tem como descobrir qual venda falta.
   *
   * Duas coisas vêm junto com a linha de volta, porque só trazê-la de volta
   * trocaria um buraco de R$ 935 por um de R$ 20:
   *
   * - `estornadoCents`, o que voltou pra mão do cliente naquela venda;
   * - `naGavetaCents` = `total − estornado`, que é EXATAMENTE a parcela com
   *   que aquela linha entra em `contarTurno`. É esta coluna que soma o
   *   total, e é por isso que ela existe em vez de deixar quem lê refazer a
   *   subtração.
   *
   * `status` vai junto pra a tela poder dizer POR QUE aquela linha vale menos
   * do que foi vendido, em vez de mostrar dois números sem explicação.
   */
  //
  // Com o caixa FECHADO entram também as vendas canceladas depois do
  // fechamento, pelo valor cheio — a mesma régua de `contarTurno` (ver
  // `SQL_CONTA_NO_TURNO`). A soma da coluna continua sendo o total de cima.
  const vendas = await q<any>(
    `SELECT o.id, o.code, o.status, o.total_cents, o.refunded_cents,
            ${SQL_NA_GAVETA_DO_TURNO} AS na_gaveta,
            o.payment_method, o.paid_at,
            o.cash_received_cents, o.change_cents,
            COALESCE(c.name, '—') AS comprador,
            (SELECT count(*)::int FROM tickets t WHERE t.order_id = o.id) AS ingressos
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.pos_shift_id = $1 AND ${SQL_CONTA_NO_TURNO}
      ORDER BY o.paid_at DESC LIMIT 100`, [turnoId, turno.closed_at])

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
    // `anula` = este lançamento desfaz aquele; `anuladoPor` = aquele foi
    // desfeito por este. A tela risca o par e esconde o botão de anular.
    movimentos: movimentos.map((m) => ({
      id: m.id, tipo: m.kind, valorCents: Number(m.amount_cents),
      motivo: motivoLegivel(m.reason), em: m.at, por: m.por,
      anula: anulaQual(m.reason),
      anuladoPor: movimentos.find((x) => anulaQual(x.reason) === m.id)?.id ?? null,
    })),
    vendas: vendas.map((v) => ({
      id: v.id, codigo: v.code, situacao: v.status, totalCents: Number(v.total_cents),
      // o que voltou pra mão do cliente nesta venda
      estornadoCents: Number(v.refunded_cents),
      // a parcela com que esta linha entra na contagem do turno — a soma desta
      // coluna é o total impresso no alto da tela
      naGavetaCents: Number(v.na_gaveta),
      forma: v.payment_method, em: v.paid_at, comprador: v.comprador, ingressos: v.ingressos,
      recebidoCents: v.cash_received_cents === null ? null : Number(v.cash_received_cents),
      trocoCents: v.change_cents === null ? null : Number(v.change_cents),
    })),
  }
})
