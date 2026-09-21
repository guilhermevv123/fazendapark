/**
 * POST /api/admin/evento/:id/transferencias — manda um ingresso pra outra pessoa.
 *
 * A transferência sai como PENDENTE e não mexe no ingresso. Trocar o titular
 * na hora do envio pareceria mais simples e criaria o pior caso possível: a
 * pessoa que comprou perde o ingresso na mesma hora, o destinatário nunca
 * abre o link, e na porta não entra ninguém.
 *
 * Quem entra enquanto está pendente é o titular de agora — a catraca lê
 * `tickets`, e `tickets` só muda no aceite.
 */
import { z } from 'zod'
import { q1, tx } from '../../../../utils/db'
import {
  gerarToken, mesmoEmail, RECUSA, venceEm,
} from '../../../../utils/transferencia'

const Entrada = z.object({
  ingressoId: z.string().uuid().optional(),
  /** o operador quase sempre tem o código na mão, não o uuid */
  codigo: z.string().min(4).max(40).optional(),
  paraNome: z.string().min(2).max(120),
  paraEmail: z.string().email().max(160),
  paraDocumento: z.string().max(20).nullish(),
  paraTelefone: z.string().max(25).nullish(),
}).refine((d) => d.ingressoId || d.codigo, {
  message: 'Informe o ingresso pelo id ou pelo código',
})

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data
  const sessao = (event.context as any).sessao

  const ev = await q1<any>(
    `SELECT id, org_id, allow_transfer FROM events WHERE id = $1`, [eventoId])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  if (!ev.allow_transfer) throw createError({ statusCode: 409, statusMessage: RECUSA.desligada })

  const ingresso = await q1<any>(
    `SELECT t.id, t.code, t.status, t.holder_name, t.holder_email, t.holder_document,
            (SELECT count(*)::int FROM ticket_transfers
              WHERE ticket_id = t.id AND status = 'aguardando') AS pendentes
       FROM tickets t
      WHERE t.event_id = $1 AND ($2::uuid IS NULL OR t.id = $2)
        AND ($3::text IS NULL OR upper(t.code) = upper($3))
      LIMIT 1`,
    [eventoId, d.ingressoId ?? null, d.codigo ?? null])

  if (!ingresso) throw createError({ statusCode: 404, statusMessage: RECUSA.inexistente })
  if (ingresso.status === 'usado') throw createError({ statusCode: 409, statusMessage: RECUSA.usado })
  if (ingresso.status === 'cancelado') throw createError({ statusCode: 409, statusMessage: RECUSA.cancelado })
  if (ingresso.pendentes > 0) throw createError({ statusCode: 409, statusMessage: RECUSA.pendente })
  if (mesmoEmail(ingresso.holder_email, d.paraEmail)) {
    throw createError({ statusCode: 422, statusMessage: RECUSA.mesma_pessoa })
  }

  return await tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO ticket_transfers
         (org_id, event_id, ticket_id, de_nome, de_email, de_documento,
          para_nome, para_email, para_documento, para_telefone,
          code, criado_por, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, code, expires_at`,
      [ev.org_id, eventoId, ingresso.id,
       ingresso.holder_name, ingresso.holder_email, ingresso.holder_document,
       d.paraNome.trim(), d.paraEmail.trim().toLowerCase(),
       d.paraDocumento ?? null, d.paraTelefone ?? null,
       gerarToken(), sessao?.usuarioId ?? null, venceEm()])

    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'ingresso',$2,'transferencia_enviada',$3::jsonb)`,
      [ev.org_id, ingresso.id, JSON.stringify({
        de: ingresso.holder_email, para: d.paraEmail, codigo: ingresso.code,
      })])

    return {
      ok: true,
      transferencia: {
        id: rows[0].id,
        venceEm: rows[0].expires_at,
        // o link que a pessoa abre; o e-mail sai daqui quando o envio existir
        link: `/transferencia/${rows[0].code}`,
      },
    }
  })
})
