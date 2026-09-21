/**
 * DELETE /api/admin/evento/:id/cupons — apaga cupom que nunca foi usado.
 *
 * Usado, não apaga: o pedido pago aponta pra ele e o relatório de desconto
 * perderia a origem do abatimento. Nesse caso o caminho é desativar (PATCH
 * ativo=false), que tira de circulação sem apagar a história.
 */
import { z } from 'zod'
import { q1 } from '../../../../utils/db'

const Entrada = z.object({ id: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) throw createError({ statusCode: 400, statusMessage: 'Dados inválidos' })

  const cupom = await q1<any>(
    `SELECT id, code, uses FROM promo_codes WHERE id = $1 AND event_id = $2`,
    [p.data.id, eventoId])
  if (!cupom) throw createError({ statusCode: 404, statusMessage: 'Cupom não encontrado' })

  if (Number(cupom.uses) > 0) {
    throw createError({
      statusCode: 409,
      statusMessage: `"${cupom.code}" já foi usado ${cupom.uses} vez(es). Desative em vez de apagar.`,
    })
  }

  await q1(`DELETE FROM promo_codes WHERE id = $1 RETURNING id`, [p.data.id])
  return { ok: true }
})
