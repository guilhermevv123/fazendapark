/**
 * PATCH /api/admin/evento/:id/ordenar — ordem dos setores e dos lotes.
 *
 * A ordem aqui é a ordem da PÁGINA DE VENDA. Não é enfeite de painel: o que
 * está em cima é o que a maioria compra. Um setor de camarote listado primeiro
 * muda o mix de venda do evento inteiro.
 *
 * Grava a lista toda numa transação, e não item a item. Reordenar mandando
 * cinco PATCHes deixa a página com duas ordens válidas ao mesmo tempo se um
 * deles falhar no meio — e nenhuma delas é a que a pessoa arrastou.
 */
import { z } from 'zod'
import { tx } from '../../../../utils/db'

const Entrada = z.object({
  /** 'setor' reordena os setores do evento; 'lote', os lotes de UM setor. */
  o: z.enum(['setor', 'lote']),
  /** O pai, quando o alvo é lote. Ignorado para setor. */
  setorId: z.string().uuid().nullish(),
  /** Os ids NA ORDEM desejada. A posição no array vira o sort_order. */
  ids: z.array(z.string().uuid()).min(1).max(500),
})

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const { o, setorId, ids } = p.data

  if (new Set(ids).size !== ids.length) {
    throw createError({ statusCode: 422, statusMessage: 'A lista tem id repetido' })
  }

  return await tx(async (c) => {
    // Confere que TODOS os ids são deste evento antes de gravar qualquer um.
    // Sem isto, uma lista com um id de fora ordenaria o que é dos outros — e a
    // parte válida já teria sido gravada quando o erro aparecesse.
    const dono = o === 'setor'
      ? `SELECT id FROM sectors WHERE id = ANY($1::uuid[]) AND event_id = $2`
      : `SELECT l.id FROM lots l JOIN sectors s ON s.id = l.sector_id
          WHERE l.id = ANY($1::uuid[]) AND s.event_id = $2
            AND ($3::uuid IS NULL OR l.sector_id = $3::uuid)`
    const { rows } = await c.query(dono,
      o === 'setor' ? [ids, eventoId] : [ids, eventoId, setorId ?? null])
    if (rows.length !== ids.length) {
      throw createError({
        statusCode: 422,
        statusMessage: 'A lista tem item que não é deste evento (ou não é deste setor)',
      })
    }

    // Um UPDATE só, com a ordem vinda de um unnest: N updates numa transação
    // longa seguram lock em todas as linhas até o fim, e a página de venda
    // fica esperando por isso.
    const tabela = o === 'setor' ? 'sectors' : 'lots'
    await c.query(
      `UPDATE ${tabela} AS t SET sort_order = n.ord
         FROM (SELECT id, ord FROM unnest($1::uuid[]) WITH ORDINALITY AS u(id, ord)) AS n
        WHERE t.id = n.id`, [ids])

    return { ok: true, ordenados: ids.length }
  })
})
