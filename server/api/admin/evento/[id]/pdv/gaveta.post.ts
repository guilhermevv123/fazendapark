/**
 * POST /api/admin/evento/:id/pdv/gaveta — sangria e suprimento.
 *
 * Sangria é o gerente recolhendo dinheiro do guichê no meio da noite; sem
 * registrar, o caixa fecha com uma falta do tamanho do que foi recolhido e a
 * conversa vira acusação. Suprimento é o contrário: mais troco entrou.
 *
 * Só entra em caixa ABERTO — mexer na gaveta de um turno já conferido muda um
 * fechamento que já foi assinado. Por isso usa a mesma trava da venda.
 */
import { z } from 'zod'
import { q1, tx } from '../../../../../utils/db'
import { SQL_TRAVA_TURNO_ABERTO } from '../../../../../utils/caixa'

const Entrada = z.object({
  turnoId: z.string().uuid(),
  tipo: z.enum(['sangria', 'suprimento']),
  valorCents: z.number().int().positive().max(100_000_00),
  motivo: z.string().max(200).nullish(),
})

export default defineEventHandler(async (event) => {
  const eventId = getRouterParam(event, 'id')!
  const sessao = (event.context as any).sessao
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data

  // turno vem no corpo → cerca própria
  const dono = await q1<any>(
    `SELECT id, org_id FROM pos_shifts WHERE id = $1 AND event_id = $2`, [d.turnoId, eventId])
  if (!dono) throw createError({ statusCode: 404, statusMessage: 'Caixa não encontrado' })

  return await tx(async (c) => {
    const trava = await c.query(SQL_TRAVA_TURNO_ABERTO, [d.turnoId])
    if (trava.rowCount !== 1) {
      throw createError({ statusCode: 409, statusMessage: 'Este caixa está fechado.' })
    }

    await c.query(
      `INSERT INTO pos_cash_movements (org_id, shift_id, kind, amount_cents, reason, by_user)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [dono.org_id, d.turnoId, d.tipo, d.valorCents, d.motivo?.trim() || null,
       sessao?.usuarioId ?? null])

    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'turno',$2,$3,$4::jsonb)`,
      [dono.org_id, d.turnoId, d.tipo,
       JSON.stringify({ valorCents: d.valorCents, motivo: d.motivo ?? null, por: sessao?.nome })])

    return { ok: true }
  })
})
