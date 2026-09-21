/**
 * PATCH /api/admin/evento/:id/transferencias — cancela, ou liga/desliga a regra.
 *
 * Cancelar devolve o ingresso pro ÚLTIMO titular, e "último" aqui é literal:
 * se a transferência já foi aceita, o titular de agora é o destinatário, e
 * cancelar tem que restaurar exatamente quem estava antes — os três campos,
 * inclusive os que estavam vazios. Restaurar só o nome deixaria o e-mail da
 * outra pessoa colado no ingresso, e é pro e-mail que a segunda via vai.
 *
 * **Ingresso que já entrou não volta.** Se a pessoa que recebeu já passou na
 * catraca, desfazer a titularidade deixaria o registro de entrada apontando
 * pra alguém que, no papel, nunca teve o ingresso.
 */
import { z } from 'zod'
import { q1, tx } from '../../../../utils/db'

const Entrada = z.object({
  transferenciaId: z.string().uuid().optional(),
  acao: z.enum(['cancelar']).optional(),
  /** liga/desliga a permissão no evento inteiro */
  permitir: z.boolean().optional(),
}).refine((d) => d.permitir !== undefined || (d.transferenciaId && d.acao), {
  message: 'Informe a transferência e a ação, ou a permissão do evento',
})

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data

  const ev = await q1<any>(`SELECT id, org_id FROM events WHERE id = $1`, [eventoId])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  // ---- só a chave geral -----------------------------------------------
  if (d.permitir !== undefined && !d.transferenciaId) {
    await tx(async (c) => {
      await c.query(`UPDATE events SET allow_transfer = $2, updated_at = now() WHERE id = $1`,
        [eventoId, d.permitir])
      await c.query(
        `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
         VALUES ($1,'evento',$2,'transferencia_permissao',$3::jsonb)`,
        [ev.org_id, eventoId, JSON.stringify({ permitir: d.permitir })])
    })
    return { ok: true, permite: d.permitir }
  }

  // ---- cancelar uma transferência --------------------------------------
  const tr = await q1<any>(
    `SELECT tr.*, t.status AS ingresso_status, t.code AS ingresso_codigo
       FROM ticket_transfers tr JOIN tickets t ON t.id = tr.ticket_id
      WHERE tr.id = $1 AND tr.event_id = $2`, [d.transferenciaId, eventoId])
  if (!tr) throw createError({ statusCode: 404, statusMessage: 'Transferência não encontrada' })

  if (tr.status === 'cancelado') {
    throw createError({ statusCode: 409, statusMessage: 'Esta transferência já foi cancelada.' })
  }
  if (tr.status === 'expirado') {
    throw createError({ statusCode: 409, statusMessage: 'Esta transferência venceu sozinha — não há o que cancelar.' })
  }
  if (tr.status === 'concluido' && tr.ingresso_status === 'usado') {
    throw createError({
      statusCode: 409,
      statusMessage: `O ingresso ${tr.ingresso_codigo} já entrou no evento no nome de `
        + `${tr.para_nome}. Desfazer agora deixaria a entrada registrada sem titular.`,
    })
  }

  return await tx(async (c) => {
    await c.query(
      `UPDATE ticket_transfers SET status = 'cancelado', canceled_at = now() WHERE id = $1`,
      [tr.id])

    // Só mexe no ingresso se a transferência chegou a mudar o titular. Uma
    // pendente cancelada não tem nada pra devolver — o ingresso nunca saiu.
    if (tr.status === 'concluido') {
      await c.query(
        `UPDATE tickets SET holder_name = $2, holder_email = $3, holder_document = $4
          WHERE id = $1`,
        [tr.ticket_id, tr.de_nome, tr.de_email, tr.de_documento])
    }

    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'ingresso',$2,'transferencia_cancelada',$3::jsonb)`,
      [ev.org_id, tr.ticket_id, JSON.stringify({
        transferencia: tr.id, eraStatus: tr.status,
        voltouPara: tr.status === 'concluido' ? tr.de_email : null,
      })])

    return {
      ok: true,
      devolvido: tr.status === 'concluido',
      titular: tr.status === 'concluido' ? tr.de_nome : null,
    }
  })
})
