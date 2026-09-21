/**
 * PATCH /api/admin/evento/:id/assentos — bloqueia ou libera lugares.
 *
 * Bloquear é o que se faz com a poltrona quebrada, com a fila reservada pra
 * produção e com o lugar atrás da coluna. É diferente de vendido: ninguém
 * comprou, mas ninguém pode comprar.
 *
 * **Assento com ingresso não muda por aqui.** Liberar um lugar vendido pela
 * tela do mapa desfaria a ligação com a pessoa sem cancelar o ingresso dela —
 * ela continuaria com o QR válido e sem lugar. Quem cancela venda é a tela de
 * vendas, e o assento volta junto.
 */
import { z } from 'zod'
import { q, tx } from '../../../../utils/db'

const Entrada = z.object({
  ids: z.array(z.string().uuid()).min(1).max(2000),
  status: z.enum(['livre', 'bloqueado']),
  nota: z.string().max(160).nullish(),
})

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data

  // Confere que TODOS os ids são deste evento antes de mexer em qualquer um:
  // meia alteração é pior que nenhuma, porque ninguém sabe onde parou.
  const achados = await q<any>(
    `SELECT id, label, status, ticket_id FROM seats
      WHERE id = ANY($1::uuid[]) AND event_id = $2`, [d.ids, eventoId])

  if (achados.length !== d.ids.length) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Um ou mais lugares não são deste evento.',
    })
  }

  const ocupados = achados.filter((a) => a.ticket_id || a.status === 'vendido')
  if (ocupados.length) {
    throw createError({
      statusCode: 422,
      statusMessage: `${ocupados.length} lugar(es) estão vendidos `
        + `(${ocupados.slice(0, 5).map((o) => o.label).join(', ')}`
        + `${ocupados.length > 5 ? '…' : ''}). Cancele a venda pela tela de vendas.`,
    })
  }

  return await tx(async (c) => {
    const r = await c.query(
      `UPDATE seats SET status = $2, note = $3
        WHERE id = ANY($1::uuid[]) AND ticket_id IS NULL
        RETURNING id`, [d.ids, d.status, d.status === 'livre' ? null : (d.nota ?? null)])
    return { ok: true, alterados: r.rowCount }
  })
})
