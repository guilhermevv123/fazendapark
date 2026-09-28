/**
 * DELETE /api/admin/evento/:id/cupons — apaga cupom que nunca foi usado.
 *
 * Usado, não apaga: o pedido pago aponta pra ele e o relatório de desconto
 * perderia a origem do abatimento. Nesse caso o caminho é desativar (PATCH
 * ativo=false), que tira de circulação sem apagar a história.
 *
 * ## "Usado" é o que os PEDIDOS dizem, e a pergunta é feita com o cupom travado (ADM-37)
 *
 * A conferência lia `promo_codes.uses` e apagava numa consulta separada. Dois furos:
 *
 *  - `uses` é um placar que alguém soma e alguém subtrai (ver `utils/cupom.ts`): o cancelamento
 *    desconta, e com ele em 0 o cupom de um pedido pago era apagado;
 *  - entre a conferência e o DELETE, um checkout podia resgatar o cupom.
 *
 * E o banco não segura: `orders.promo_code_id` é `ON DELETE SET NULL` — o pedido pago perde a
 * origem do desconto EM SILÊNCIO, sem erro nenhum (a auditoria esperava um 500 de chave
 * estrangeira; o que acontece é pior, porque não aparece). Agora: transação, cupom travado
 * (`FOR UPDATE`, a mesma trava do `resgatarCupom` do checkout — os dois fazem fila) e a contagem
 * sai de `orders`.
 */
import { z } from 'zod'
import { tx } from '../../../../utils/db'

const Entrada = z.object({ id: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) throw createError({ statusCode: 400, statusMessage: 'Dados inválidos: o id do cupom' })

  return tx(async (c) => {
    const { rows: [cupom] } = await c.query(
      `SELECT id, code FROM promo_codes WHERE id = $1 AND event_id = $2 FOR UPDATE`,
      [p.data.id, eventoId])
    if (!cupom) throw createError({ statusCode: 404, statusMessage: 'Cupom não encontrado' })

    const { rows: [uso] } = await c.query(
      `SELECT count(*)::int AS pedidos FROM orders WHERE promo_code_id = $1`, [cupom.id])
    if (Number(uso.pedidos) > 0) {
      throw createError({
        statusCode: 409,
        statusMessage: `"${cupom.code}" está em ${uso.pedidos} pedido(s). Desative em vez de apagar.`,
      })
    }

    await c.query(`DELETE FROM promo_codes WHERE id = $1`, [cupom.id])
    return { ok: true }
  })
})
