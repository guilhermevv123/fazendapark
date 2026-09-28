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
 *
 * `o: 'tudo'` leva os setores E os lotes de cada setor numa chamada só (ADM-41): a tela
 * mandava um PATCH pros setores e mais um por setor, e a rede caindo no meio deixava
 * setores gravados e lotes não — com a tela dizendo "Não foi possível salvar a ordem".
 * Agora ou grava a ordem inteira, ou nada. As formas 'setor' e 'lote' continuam valendo.
 */
import { z } from 'zod'
import { tx } from '../../../../utils/db'
import { explicarErro } from '../index.post'

/** os campos com o nome da tela: a recusa diz O QUE corrigir (ADM-36), não "Dados inválidos" */
const ROTULOS: Record<string, string> = { o: 'O que ordenar', setorId: 'Setor', ids: 'Ordem' }

const Lista = z.array(z.string().uuid()).min(1).max(500)

/** a ordem inteira da tela numa chamada: setores e, pra cada setor, os lotes */
const EntradaTudo = z.object({
  o: z.literal('tudo'),
  setores: Lista,
  lotes: z.array(z.object({ setorId: z.string().uuid(), ids: Lista })).max(500).default([]),
})

const ROTULOS_TUDO: Record<string, string> = { ...ROTULOS, setores: 'Ordem dos setores', lotes: 'Ordem dos lotes' }

const Entrada = z.object({
  /** 'setor' reordena os setores do evento; 'lote', os lotes de UM setor. */
  o: z.enum(['setor', 'lote']),
  /** O pai, quando o alvo é lote. Ignorado para setor. */
  setorId: z.string().uuid().nullish(),
  /** Os ids NA ORDEM desejada. A posição no array vira o sort_order. */
  ids: z.array(z.string().uuid()).min(1).max(500),
})

const repetido = (ids: string[]) => new Set(ids).size !== ids.length

/** O UPDATE da ordem: um só, com a ordem vinda de um unnest (ver abaixo). */
async function gravarOrdem(c: any, tabela: 'sectors' | 'lots', ids: string[]) {
  await c.query(
    `UPDATE ${tabela} AS t SET sort_order = n.ord
       FROM (SELECT id, ord FROM unnest($1::uuid[]) WITH ORDINALITY AS u(id, ord)) AS n
      WHERE t.id = n.id`, [ids])
}

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const corpo = await readBody(event)

  if (corpo?.o === 'tudo') {
    const t = EntradaTudo.safeParse(corpo)
    if (!t.success) {
      throw createError({ statusCode: 400, statusMessage: explicarErro(t.error, ROTULOS_TUDO), data: t.error.flatten() })
    }
    const { setores, lotes } = t.data
    if (repetido(setores) || lotes.some((l) => repetido(l.ids)) || repetido(lotes.map((l) => l.setorId))) {
      throw createError({ statusCode: 422, statusMessage: 'A lista tem id repetido' })
    }
    return await tx(async (c) => {
      // Tudo conferido ANTES de gravar qualquer coisa — e, mesmo que algo escape, a transação
      // desfaz os setores se os lotes falharem.
      const { rows: sets } = await c.query(
        `SELECT id FROM sectors WHERE id = ANY($1::uuid[]) AND event_id = $2`, [setores, eventoId])
      if (sets.length !== setores.length) {
        throw createError({ statusCode: 422, statusMessage: 'A lista tem setor que não é deste evento' })
      }
      for (const l of lotes) {
        const { rows } = await c.query(
          `SELECT l.id FROM lots l JOIN sectors s ON s.id = l.sector_id
            WHERE l.id = ANY($1::uuid[]) AND s.event_id = $2 AND l.sector_id = $3::uuid`,
          [l.ids, eventoId, l.setorId])
        if (rows.length !== l.ids.length) {
          throw createError({
            statusCode: 422,
            statusMessage: 'A lista tem lote que não é deste evento (ou não é deste setor)',
          })
        }
      }
      await gravarOrdem(c, 'sectors', setores)
      for (const l of lotes) await gravarOrdem(c, 'lots', l.ids)
      return { ok: true, ordenados: setores.length + lotes.reduce((n, l) => n + l.ids.length, 0) }
    })
  }

  const p = Entrada.safeParse(corpo)
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: explicarErro(p.error, ROTULOS), data: p.error.flatten() })
  }
  const { o, setorId, ids } = p.data

  if (repetido(ids)) {
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
    await gravarOrdem(c, o === 'setor' ? 'sectors' : 'lots', ids)

    return { ok: true, ordenados: ids.length }
  })
})
