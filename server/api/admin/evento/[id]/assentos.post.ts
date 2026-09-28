/**
 * POST /api/admin/evento/:id/assentos — gera o mapa de um setor.
 *
 * Gerar é criar fileira por fileira. Duas coisas que o gerador NÃO faz, de
 * propósito:
 *
 * - **Não apaga assento vendido.** Regerar um setor que já tem gente sentada
 *   apagaria a ligação entre pessoa e poltrona, e no dia do evento duas
 *   pessoas apareceriam com direito ao mesmo lugar. Setor com assento
 *   ocupado só regera depois de o operador liberar, e a recusa diz quantos
 *   estão ocupados.
 *
 * - **Não inventa assento onde tem corredor.** `pular` recebe os números que
 *   não existem naquela fileira; eles simplesmente não são criados.
 *
 * As fileiras são nomeadas A, B, C… e depois AA, AB — não Z seguido de
 * "AA" quebrado: `nomeDaFileira` faz a conta em base 26 de verdade.
 */
import { z } from 'zod'
import { q1, tx } from '../../../../utils/db'
import { autorDaRequisicao, registrarAuditoria } from '../../../../utils/auditoria'
import { explicarErro } from '../index.post'

/** os campos com o nome da tela: a recusa diz O QUE corrigir (ADM-36), não "Dados inválidos" */
const ROTULOS: Record<string, string> = { setorId: 'Setor', fileiras: 'Fileiras', porFileira: 'Lugares por fileira', pular: 'Lugares a pular', primeiroNumero: 'Primeiro número', primeiraFileira: 'Primeira fileira', substituir: 'Substituir' }

const Entrada = z.object({
  setorId: z.string().uuid(),
  fileiras: z.number().int().min(1).max(200),
  porFileira: z.number().int().min(1).max(200),
  /** números que não existem (corredor) */
  pular: z.array(z.number().int().min(1)).max(200).default([]),
  /** começa a numerar em 1 por padrão; alguns teatros começam em 101 */
  primeiroNumero: z.number().int().min(0).max(9999).default(1),
  /** rótulo da primeira fileira: 'A' (padrão) ou 'AA', ou número */
  primeiraFileira: z.string().max(4).default('A'),
  substituir: z.boolean().default(false),
})

/** 0 → A, 25 → Z, 26 → AA, 27 → AB … */
export function nomeDaFileira(i: number): string {
  let n = i
  let s = ''
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: explicarErro(p.error, ROTULOS), data: p.error.flatten() })
  }
  const d = p.data

  const setor = await q1<any>(
    `SELECT s.id, s.name, s.event_id, e.org_id,
            (SELECT count(*)::int FROM seats WHERE sector_id = s.id) AS tem,
            (SELECT count(*)::int FROM seats
              WHERE sector_id = s.id AND status IN ('vendido','reservado')) AS ocupados
       FROM sectors s JOIN events e ON e.id = s.event_id
      WHERE s.id = $1 AND s.event_id = $2`, [d.setorId, eventoId])
  if (!setor) throw createError({ statusCode: 404, statusMessage: 'Setor não encontrado' })

  if (setor.tem > 0 && !d.substituir) {
    throw createError({
      statusCode: 409,
      statusMessage: `"${setor.name}" já tem ${setor.tem} lugares. `
        + 'Marque "substituir o mapa atual" para refazer.',
    })
  }
  if (setor.ocupados > 0) {
    throw createError({
      statusCode: 422,
      statusMessage: `"${setor.name}" tem ${setor.ocupados} lugar(es) ocupado(s). `
        + 'Refazer o mapa agora desfaria a ligação entre a pessoa e a poltrona dela.',
    })
  }

  const pular = new Set(d.pular)
  const base = /^\d+$/.test(d.primeiraFileira)
    ? null
    : d.primeiraFileira.toUpperCase().charCodeAt(0) - 65

  const linhas: any[] = []
  for (let f = 0; f < d.fileiras; f++) {
    const nome = base === null
      ? String(Number(d.primeiraFileira) + f)
      : nomeDaFileira(base + f)
    for (let n = 0; n < d.porFileira; n++) {
      const numero = d.primeiroNumero + n
      if (pular.has(numero)) continue
      linhas.push({ nome, numero, x: n, y: f })
    }
  }
  if (!linhas.length) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Essa combinação não gera nenhum lugar — todos caíram na lista de pular.',
    })
  }

  const autor = autorDaRequisicao(event)
  return await tx(async (c) => {
    if (d.substituir) await c.query(`DELETE FROM seats WHERE sector_id = $1`, [d.setorId])

    // Um único INSERT com unnest em vez de N inserts: um setor de 2000
    // lugares vira 2000 idas ao banco no laço, e a tela fica pendurada.
    await c.query(
      `INSERT INTO seats (event_id, sector_id, row_label, number, label, pos_x, pos_y)
       SELECT $1, $2, x.fila, x.num, x.fila || x.num::text, x.px, x.py
         FROM unnest($3::text[], $4::int[], $5::int[], $6::int[])
                AS x(fila, num, px, py)`,
      [eventoId, d.setorId,
       linhas.map((l) => l.nome), linhas.map((l) => l.numero),
       linhas.map((l) => l.x), linhas.map((l) => l.y)])

    await c.query(`UPDATE sectors SET seated = true WHERE id = $1`, [d.setorId])
    await registrarAuditoria({
      autor, entidade: 'setor', entidadeId: d.setorId, acao: 'mapa_gerado',
      depois: { fileiras: d.fileiras, porFileira: d.porFileira, lugares: linhas.length, substituiu: d.substituir },
    }, c)

    return { ok: true, criados: linhas.length, fileiras: d.fileiras }
  })
})
