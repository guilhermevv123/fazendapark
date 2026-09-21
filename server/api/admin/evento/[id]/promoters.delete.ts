/**
 * DELETE /api/admin/evento/:id/promoters — apaga divulgador sem venda.
 *
 * Com venda, não apaga. A FK é ON DELETE SET NULL: o banco deixaria apagar e
 * as vendas dele ficariam órfãs em silêncio — o faturamento continuaria certo,
 * mas a atribuição sumiria e ninguém saberia mais quem vendeu o quê.
 */
import { z } from 'zod'
import { q1 } from '../../../../utils/db'

const Entrada = z.object({ id: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) throw createError({ statusCode: 400, statusMessage: 'Dados inválidos' })

  const pr = await q1<any>(
    `SELECT p.id, p.name,
            (SELECT count(*)::int FROM orders o WHERE o.promoter_id = p.id) AS pedidos
       FROM promoters p WHERE p.id = $1 AND p.event_id = $2`,
    [p.data.id, eventoId])
  if (!pr) throw createError({ statusCode: 404, statusMessage: 'Divulgador não encontrado' })

  if (Number(pr.pedidos) > 0) {
    throw createError({
      statusCode: 409,
      statusMessage: `"${pr.name}" tem ${pr.pedidos} pedido(s) atribuído(s). Desative em vez de apagar.`,
    })
  }

  await q1(`DELETE FROM promoters WHERE id = $1 RETURNING id`, [p.data.id])
  return { ok: true }
})
