/**
 * POST /api/admin/evento/:id/ingressos/ordem — sobe ou desce um TIPO dentro do lote, ou um SETOR
 * dentro do evento (dono, 06/10: "colocar pra eu mexer na ordem de visualização"). É a ordem do
 * site, do balcão e do painel — todos leem `sort_order`.
 *
 * Lote fica de fora de propósito: a ordem dos lotes é a da virada automática (o 2º lote abre quando
 * o 1º acaba). Mexer nela pelo mesmo botão mudaria qual lote vende, não só onde aparece.
 *
 * Como: trava os irmãos, renumera 1..n na ordem atual (empates e buracos de quem foi apagado somem)
 * e troca o item com o vizinho. Duas pessoas clicando juntas esperam a vez pela trava.
 */
import { z } from 'zod'
import { tx } from '../../../../../utils/db'
import { autorDaRequisicao, registrarAuditoria } from '../../../../../utils/auditoria'

const Entrada = z.object({
  o: z.enum(['tipo', 'setor']),
  id: z.string().uuid(),
  direcao: z.enum(['subir', 'descer']),
})

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) throw createError({ statusCode: 400, statusMessage: 'Pedido de ordem inválido' })
  const { o, id, direcao } = p.data
  const autor = autorDaRequisicao(event)

  return await tx(async (c) => {
    // o item tem que ser DESTE evento; e a lista de irmãos é a do mesmo lote (tipo) ou evento (setor)
    const irmaos = o === 'tipo'
      ? await c.query<{ id: string; name: string }>(
        `SELECT tt.id, tt.name FROM ticket_types tt
          WHERE tt.lot_id = (SELECT t2.lot_id FROM ticket_types t2 JOIN lots l ON l.id = t2.lot_id
                               JOIN sectors s ON s.id = l.sector_id
                              WHERE t2.id = $1 AND s.event_id = $2)
          ORDER BY tt.sort_order, tt.id FOR UPDATE`, [id, eventoId])
      : await c.query<{ id: string; name: string }>(
        `SELECT s.id, s.name FROM sectors s
          WHERE s.event_id = $2 AND EXISTS (SELECT 1 FROM sectors x WHERE x.id = $1 AND x.event_id = $2)
          ORDER BY s.sort_order, s.id FOR UPDATE`, [id, eventoId])
    const lista = irmaos.rows.map((r) => r.id)
    const i = lista.indexOf(id)
    if (i < 0) throw createError({ statusCode: 404, statusMessage: 'Não encontrado' })
    const j = direcao === 'subir' ? i - 1 : i + 1
    if (j < 0 || j >= lista.length) return { ok: true, ordem: lista } // já está na ponta
    ;[lista[i], lista[j]] = [lista[j]!, lista[i]!]

    const tabela = o === 'tipo' ? 'ticket_types' : 'sectors'
    await c.query(
      `UPDATE ${tabela} t SET sort_order = n.pos
         FROM unnest($1::uuid[]) WITH ORDINALITY AS n(id, pos)
        WHERE t.id = n.id`, [lista])

    await registrarAuditoria({
      autor, entidade: o, entidadeId: id, acao: 'reordenado',
      antes: { posicao: i + 1 }, depois: { posicao: j + 1 },
    }, c)
    return { ok: true, ordem: lista }
  })
})
