/**
 * GET /api/admin/evento/:id/resumo — o mínimo que o shell precisa (nome e
 * status pra trilha e selo do topo). Separado do dashboard de propósito: o
 * menu é renderizado em toda tela do evento e não pode pagar o preço das
 * agregações pesadas a cada navegação.
 */
import { q1 } from '../../../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const ev = await q1<any>(
    `SELECT e.id, e.name, e.slug, e.status, e.starts_at, o.name AS organizacao
       FROM events e JOIN organizations o ON o.id = e.org_id
      WHERE e.id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  return {
    id: ev.id, nome: ev.name, slug: ev.slug, status: ev.status,
    inicio: ev.starts_at, organizacao: ev.organizacao,
    usuario: 'time',
  }
})
