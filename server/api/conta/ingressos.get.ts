/**
 * GET /api/conta/ingressos — os pedidos feitos COM esta conta (034: a conta não herda pedido
 * antigo do mesmo e-mail). Cada um leva pra página do ingresso (`/ingressos/<código>`), que é
 * onde mora o QR.
 *
 * Reagendamento (036): o ingresso trocado de dia vira `cancelado` no pedido antigo e nasce num
 * pedido novo com `rescheduled_from_ticket_id`. Sem contar à parte, o pedido antigo aparecia com
 * "0 ingressos" e o novo como "Grátis". `reagendados` e `reagendamento` dão nome aos dois.
 *
 * Cada pedido diz a situação dos ingressos dele: `validos` (entram), `usados`, `transferidos` (foram
 * pra outra pessoa), `cancelados` (não entram) e `reagendados` (trocados de dia). `ingressos` segue
 * sendo "os que não foram cancelados".
 */
import { q } from '../../utils/db'
import { contaDaSessaoDoCliente } from '../../utils/conta-do-cliente'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const conta = await contaDaSessaoDoCliente(event)
  if (!conta) throw createError({ statusCode: 401, statusMessage: 'Entre na sua conta.', data: { tipo: 'conta' } })
  const linhas = await q<any>(
    `SELECT o.code, o.status, o.total_cents, o.created_at, o.expires_at,
            e.name AS evento, e.slug, e.starts_at, e.timezone, e.banner_url, e.venue_name,
            (SELECT count(*)::int FROM tickets t WHERE t.order_id = o.id AND t.status <> 'cancelado') AS ingressos,
            (SELECT count(*)::int FROM tickets t WHERE t.order_id = o.id AND t.status = 'valido') AS validos,
            (SELECT count(*)::int FROM tickets t WHERE t.order_id = o.id AND t.status = 'usado') AS usados,
            (SELECT count(*)::int FROM tickets t WHERE t.order_id = o.id AND t.status = 'transferido') AS transferidos,
            (SELECT count(*)::int FROM tickets t WHERE t.order_id = o.id AND t.status = 'cancelado'
                AND EXISTS (SELECT 1 FROM orders o2 WHERE o2.rescheduled_from_ticket_id = t.id)) AS reagendados,
            (SELECT count(*)::int FROM tickets t WHERE t.order_id = o.id AND t.status = 'cancelado'
                AND NOT EXISTS (SELECT 1 FROM orders o2 WHERE o2.rescheduled_from_ticket_id = t.id)) AS cancelados,
            o.rescheduled_from_ticket_id IS NOT NULL AS reagendamento
       FROM orders o JOIN events e ON e.id = o.event_id
      WHERE o.customer_account_id = $1 AND o.status NOT IN ('expirado', 'falhou', 'rascunho')
      ORDER BY o.created_at DESC
      LIMIT 100`, [conta.id])
  return {
    pedidos: linhas.map((l) => ({
      codigo: l.code, status: l.status, totalCents: Number(l.total_cents),
      criadoEm: l.created_at, expiraEm: l.expires_at,
      evento: { nome: l.evento, slug: l.slug, inicio: l.starts_at, fuso: l.timezone, banner: l.banner_url, local: l.venue_name },
      ingressos: Number(l.ingressos), usados: Number(l.usados),
      // a situação de cada ingresso do pedido (05/10: "gestão dos ingressos, válidos e inválidos")
      validos: Number(l.validos), transferidos: Number(l.transferidos), cancelados: Number(l.cancelados),
      reagendados: Number(l.reagendados), reagendamento: l.reagendamento === true,
    })),
  }
})
