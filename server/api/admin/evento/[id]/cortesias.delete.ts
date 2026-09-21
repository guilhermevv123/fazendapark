/**
 * DELETE /api/admin/evento/:id/cortesias — cancela uma cortesia.
 *
 * Cancela, não apaga: o ingresso vira 'cancelado' e o estoque volta pra
 * prateleira. Apagar a linha destruiria a prova de que aquele código existiu —
 * e é exatamente esse código que alguém vai apresentar na portaria dizendo que
 * recebeu.
 *
 * Cortesia que JÁ ENTROU não cancela. O estoque dela já virou pessoa dentro do
 * parque; devolver a vaga venderia um lugar que está ocupado.
 */
import { z } from 'zod'
import { tx } from '../../../../utils/db'

const Entrada = z.object({ id: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) throw createError({ statusCode: 400, statusMessage: 'Dados inválidos' })

  return await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT t.id, t.code, t.status, t.lot_id, t.ticket_type_id, t.is_courtesy, t.org_id
         FROM tickets t
        WHERE t.id = $1 AND t.event_id = $2
        FOR UPDATE OF t`, [p.data.id, eventoId])
    const ing = rows[0]
    if (!ing) throw createError({ statusCode: 404, statusMessage: 'Ingresso não encontrado' })
    if (!ing.is_courtesy) {
      throw createError({ statusCode: 422, statusMessage: 'Este ingresso não é cortesia. Cancele pelo pedido.' })
    }
    if (ing.status === 'usado') {
      throw createError({ statusCode: 409, statusMessage: `"${ing.code}" já entrou no evento e não pode ser cancelado.` })
    }
    if (ing.status === 'cancelado') return { ok: true, jaEstava: true }

    await c.query(
      `UPDATE tickets SET status = 'cancelado', canceled_at = now() WHERE id = $1`, [ing.id])
    // GREATEST evita que uma dupla chamada empurre o contador pra negativo —
    // o FOR UPDATE acima já serializa, isto é a rede embaixo.
    await c.query(
      `UPDATE lots SET sold = GREATEST(sold - 1, 0) WHERE id = $1`, [ing.lot_id])
    if (ing.ticket_type_id) {
      await c.query(
        `UPDATE ticket_types SET sold = GREATEST(sold - 1, 0) WHERE id = $1`, [ing.ticket_type_id])
    }
    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'ticket',$2,'cortesia_cancelada',$3::jsonb)`,
      [ing.org_id, ing.id, JSON.stringify({ codigo: ing.code })])

    return { ok: true, codigo: ing.code }
  })
})
