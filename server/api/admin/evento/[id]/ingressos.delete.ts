/**
 * DELETE /api/admin/evento/:id/ingressos — apaga setor, lote ou tipo.
 *
 * A regra inteira desta rota é uma só: **nada que já vendeu pode sumir**.
 * Apagar um lote com venda apagaria a referência do ingresso que está no
 * celular de alguém — e o furo só apareceria na portaria, no dia, com fila.
 *
 * Por isso a checagem é por `sold`/`reserved` no banco e não por "o produtor
 * confirmou". Confirmação some; o ingresso vendido não.
 */
import { z } from 'zod'
import { q1, tx } from '../../../../utils/db'
import { autorDaRequisicao, registrarAuditoria, type Autor } from '../../../../utils/auditoria'
import { explicarErro } from '../index.post'

/** os campos com o nome da tela: a recusa diz O QUE corrigir (ADM-36), não "Dados inválidos" */
const ROTULOS: Record<string, string> = { o: 'O que apagar', id: 'Item' }

const Entrada = z.object({
  o: z.enum(['setor', 'lote', 'tipo']),
  id: z.string().uuid(),
})

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) throw createError({ statusCode: 400, statusMessage: explicarErro(p.error, ROTULOS) })
  const { o, id } = p.data

  const autor = autorDaRequisicao(event)
  return await tx(async (c) => {
    if (o === 'tipo') {
      const t = await c.query(
        `SELECT tt.id, tt.name, tt.sold FROM ticket_types tt
           JOIN lots l ON l.id = tt.lot_id JOIN sectors s ON s.id = l.sector_id
          WHERE tt.id = $1 AND s.event_id = $2 FOR UPDATE OF tt`, [id, eventoId])
      if (!t.rowCount) throw createError({ statusCode: 404, statusMessage: 'Tipo não encontrado' })
      if (Number(t.rows[0].sold) > 0) {
        throw createError({
          statusCode: 409,
          statusMessage: `"${t.rows[0].name}" já vendeu ${t.rows[0].sold}. Em vez de apagar, zere a quantidade para parar a venda.`,
        })
      }
      await c.query(`DELETE FROM ticket_types WHERE id = $1`, [id])
      await auditar(c, autor, 'ticket_type', id, t.rows[0])
      return { ok: true }
    }

    if (o === 'lote') {
      const l = await c.query(
        `SELECT l.id, l.name, l.sold, l.reserved FROM lots l
           JOIN sectors s ON s.id = l.sector_id
          WHERE l.id = $1 AND s.event_id = $2 FOR UPDATE OF l`, [id, eventoId])
      if (!l.rowCount) throw createError({ statusCode: 404, statusMessage: 'Lote não encontrado' })
      const { sold, reserved, name } = l.rows[0]
      if (Number(sold) > 0 || Number(reserved) > 0) {
        throw createError({
          statusCode: 409,
          statusMessage: `"${name}" tem ${sold} vendido(s) e ${reserved} em carrinho. Esconda o lote em vez de apagar.`,
        })
      }
      await c.query(`DELETE FROM ticket_types WHERE lot_id = $1`, [id])
      await c.query(`DELETE FROM lots WHERE id = $1`, [id])
      await auditar(c, autor, 'lot', id, l.rows[0])
      return { ok: true }
    }

    const s = await c.query(
      `SELECT s.id, s.name,
              COALESCE((SELECT SUM(sold) FROM lots WHERE sector_id = s.id),0)::int AS vendidos,
              COALESCE((SELECT SUM(reserved) FROM lots WHERE sector_id = s.id),0)::int AS reservados
         FROM sectors s WHERE s.id = $1 AND s.event_id = $2 FOR UPDATE OF s`, [id, eventoId])
    if (!s.rowCount) throw createError({ statusCode: 404, statusMessage: 'Setor não encontrado' })
    if (Number(s.rows[0].vendidos) > 0 || Number(s.rows[0].reservados) > 0) {
      throw createError({
        statusCode: 409,
        statusMessage: `O setor "${s.rows[0].name}" já vendeu ${s.rows[0].vendidos} ingresso(s) e não pode ser apagado.`,
      })
    }
    await c.query(
      `DELETE FROM ticket_types WHERE lot_id IN (SELECT id FROM lots WHERE sector_id = $1)`, [id])
    await c.query(`DELETE FROM lots WHERE sector_id = $1`, [id])
    await c.query(`DELETE FROM sectors WHERE id = $1`, [id])
    await auditar(c, autor, 'sector', id, s.rows[0])
    return { ok: true }
  })
})

/** quem apagou — com usuário e organização carimbados (ADM-26), não um INSERT sem autor */
async function auditar(c: any, autor: Autor, entidade: string, id: string, antes: unknown) {
  await registrarAuditoria({
    autor, entidade, entidadeId: id, acao: 'apagado', antes: antes as Record<string, unknown>,
  }, c)
}
