/**
 * Troca com diferença paga (053, dono 24/10/2026). Fica fora de `reagendamento.ts` porque a
 * emissão chama isto, e `reagendamento.ts` puxa a rota da vitrine (`api/e/[slug].get`) — rota
 * importada fora do Nitro quebra (`defineEventHandler is not defined`).
 */
import type { PoolClient } from 'pg'

/**
 * A diferença foi paga, mas o ingresso ANTIGO ainda vale? Devolve o motivo quando NÃO vale.
 *
 * Antes, com o antigo já usado na catraca (ou cancelado pela equipe), o novo saía assim mesmo:
 * uma pessoa entrava com o antigo e ganhava um segundo ingresso inteiro, e o rastro
 * `troca_paga_sem_ingresso_antigo` era a única marca — numa trilha que ninguém abre sem motivo.
 * Agora o novo NÃO sai: quem chama (`emitirNaTransacao`) pendura a entrega como o pagamento sem
 * lugar, com este motivo escrito, e a equipe decide — devolver a diferença ou emitir à mão.
 *
 * Trava o antigo (`FOR UPDATE`): a catraca e o cancelamento da equipe esperam esta transação,
 * e a decisão vale até o COMMIT. Uma linha de rastro por pedido: a entrega é retentada.
 */
export async function trocaSemIngressoAntigo(
  c: PoolClient, pedido: { id: string; org_id: string; code: string; swap_from_ticket_id: string },
): Promise<string | null> {
  const { rows: [velho] } = await c.query(
    `SELECT id, code, status, checked_in_at FROM tickets WHERE id = $1 FOR UPDATE`,
    [pedido.swap_from_ticket_id])
  if (velho && velho.status === 'valido' && !velho.checked_in_at) return null
  const situacao = !velho ? 'não existe mais' : velho.checked_in_at ? 'já entrou no parque' : `está ${velho.status}`
  await c.query(
    `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
     SELECT $1::uuid, 'order', $2::text, 'troca_paga_sem_ingresso_antigo', $3::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM audit_log
                         WHERE entity = 'order' AND entity_id = $2::text
                           AND action = 'troca_paga_sem_ingresso_antigo')`,
    [pedido.org_id, pedido.id, JSON.stringify({
      pedidoNovo: pedido.code, ingressoAnterior: velho?.code ?? null, statusAnterior: velho?.status ?? null,
    })])
  return `troca de dia paga, mas o ingresso anterior${velho ? ` ${velho.code}` : ''} ${situacao}: `
    + 'o novo não foi emitido. Devolver a diferença ou emitir à mão.'
}

/**
 * A diferença foi paga: o ingresso antigo morre, na MESMA transação que emite o novo
 * (`emitirNaTransacao`). O novo herda o titular do antigo, e o pedido passa a contar como troca
 * (`rescheduled_from_ticket_id`, 036) pra conta do cliente e o bilhete mostrarem "trocado".
 *
 * O antigo já não válido (usado, cancelado pela equipe) nem chega aqui: `trocaSemIngressoAntigo`
 * barra a emissão antes. A conferência de baixo fica como rede, na mesma transação.
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
