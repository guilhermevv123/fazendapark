/**
 * PATCH /api/admin/evento/:id/participantes — nomeia um ingresso.
 *
 * Quem compra 6 ingressos recebe 5 em branco (ver emissao.ts). Nomear é o que
 * transforma a compra numa lista de portaria — e é o que permite exigir
 * documento na entrada.
 *
 * Ingresso JÁ USADO não muda de nome. A pessoa que entrou entrou; trocar o
 * portador depois reescreve quem esteve lá dentro, que é justamente o registro
 * que alguém vai querer consultar se algo acontecer no evento.
 */
import { z } from 'zod'
import { q1 } from '../../../../utils/db'

const Entrada = z.object({
  id: z.string().uuid(),
  nome: z.string().max(120).nullish(),
  email: z.string().email().max(160).nullish().or(z.literal('')),
  documento: z.string().max(20).nullish(),
})

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data

  const ing = await q1<any>(
    `SELECT id, code, status FROM tickets WHERE id = $1 AND event_id = $2`,
    [d.id, eventoId])
  if (!ing) throw createError({ statusCode: 404, statusMessage: 'Ingresso não encontrado' })
  if (ing.status === 'usado') {
    throw createError({
      statusCode: 409,
      statusMessage: `"${ing.code}" já entrou no evento. O portador não pode mais ser trocado.`,
    })
  }
  if (ing.status === 'cancelado') {
    throw createError({ statusCode: 409, statusMessage: 'Ingresso cancelado.' })
  }

  await q1(
    `UPDATE tickets SET holder_name = $2, holder_email = $3, holder_document = $4
      WHERE id = $1 RETURNING id`,
    [d.id, d.nome?.trim() || null, d.email || null,
     d.documento?.trim() || null])

  return { ok: true }
})
