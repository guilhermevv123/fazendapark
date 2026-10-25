/**
 * Troca com diferença paga (053, dono 24/10/2026). Fica fora de `reagendamento.ts` porque a
 * emissão chama isto, e `reagendamento.ts` puxa a rota da vitrine (`api/e/[slug].get`) — rota
 * importada fora do Nitro quebra (`defineEventHandler is not defined`).
 */
import type { PoolClient } from 'pg'

/**
 * A diferença foi paga: o ingresso antigo morre, na MESMA transação que emite o novo
 * (`emitirNaTransacao`). O novo herda o titular do antigo, e o pedido passa a contar como troca
 * (`rescheduled_from_ticket_id`, 036) pra conta do cliente e o bilhete mostrarem "trocado".
 *
 * Se o antigo já não está válido (usado, cancelado pela equipe) a pessoa pagou e fica com o novo
 * — a emissão não volta atrás com dinheiro na mão; o rastro avisa a equipe pra conferir.
 */
export async function encerrarIngressoTrocado(
  c: PoolClient, pedido: { id: string; org_id: string; code: string; swap_from_ticket_id: string },
): Promise<void> {
  const { rows: [velho] } = await c.query(
    `SELECT id, code, status, checked_in_at, lot_id, ticket_type_id, holder_name, holder_email, holder_document
       FROM tickets WHERE id = $1 FOR UPDATE`, [pedido.swap_from_ticket_id])
  const rastro = { pedidoNovo: pedido.code, ingressoAnterior: velho?.code ?? null }
  if (!velho || velho.status !== 'valido' || velho.checked_in_at) {
    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'order',$2,'troca_paga_sem_ingresso_antigo',$3::jsonb)`,
      [pedido.org_id, pedido.id, JSON.stringify({ ...rastro, statusAnterior: velho?.status ?? null })])
    return
  }
  await c.query(`UPDATE tickets SET status = 'cancelado', canceled_at = now() WHERE id = $1`, [velho.id])
  await c.query(`UPDATE lots SET sold = sold - 1 WHERE id = $1 AND sold >= 1`, [velho.lot_id])
  if (velho.ticket_type_id) {
    await c.query(`UPDATE ticket_types SET sold = sold - 1 WHERE id = $1 AND sold >= 1`, [velho.ticket_type_id])
  }
  await c.query(
    `UPDATE orders SET rescheduled_from_ticket_id = $2
      WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM orders o2 WHERE o2.rescheduled_from_ticket_id = $2)`,
    [pedido.id, velho.id])
  if (velho.holder_name || velho.holder_email || velho.holder_document) {
    await c.query(
      `UPDATE tickets SET holder_name = $2, holder_email = $3, holder_document = $4 WHERE order_id = $1`,
      [pedido.id, velho.holder_name, velho.holder_email, velho.holder_document])
  }
  await c.query(
    `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
     VALUES ($1,'ingresso',$2,'reagendado_com_diferenca',$3::jsonb)`,
    [pedido.org_id, velho.id, JSON.stringify(rastro)])
}
