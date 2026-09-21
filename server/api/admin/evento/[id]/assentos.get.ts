/**
 * GET /api/admin/evento/:id/assentos — o mapa, setor por setor.
 *
 * Devolve TODOS os setores, inclusive os sem assento: é a tela que decide
 * quais viram numerados, e um setor que não aparece na lista é um setor que
 * ninguém consegue marcar.
 *
 * Ordenar é onde o mapa se perde, em DOIS níveis:
 *
 * - dentro da fileira, por `number` e não pelo rótulo pronto — texto coloca
 *   "A10" antes de "A9";
 * - entre fileiras, por TAMANHO antes do texto — senão a casa com mais de 26
 *   fileiras desenha A, AA, AB, AC, B, C…, com a fileira 27 encostada na
 *   primeira. Com `length` primeiro, sai A…Z, depois AA…AZ, que é a ordem em
 *   que as fileiras existem no chão.
 */
import { q, q1 } from '../../../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const ev = await q1<any>(`SELECT id, name FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const [setores, assentos] = await Promise.all([
    q<any>(
      `SELECT s.id, s.name, s.capacity, s.seated, s.sort_order,
              COALESCE(SUM(l.quantity),0)::int AS estoque,
              COALESCE(SUM(l.sold),0)::int     AS vendidos
         FROM sectors s
         LEFT JOIN lots l ON l.sector_id = s.id
        WHERE s.event_id = $1
        GROUP BY s.id ORDER BY s.sort_order, s.name`, [id]),

    q<any>(
      `SELECT se.id, se.sector_id, se.row_label, se.number, se.label,
              se.status, se.note, se.ticket_id,
              t.code AS ingresso, t.holder_name AS titular
         FROM seats se
         LEFT JOIN tickets t ON t.id = se.ticket_id
        WHERE se.event_id = $1
        ORDER BY length(se.row_label), se.row_label, se.number`, [id]),
  ])

  const porSetor = new Map<string, any[]>()
  for (const a of assentos) {
    if (!porSetor.has(a.sector_id)) porSetor.set(a.sector_id, [])
    porSetor.get(a.sector_id)!.push({
      id: a.id, fileira: a.row_label, numero: a.number, rotulo: a.label,
      status: a.status, nota: a.note,
      ingresso: a.ingresso, titular: a.titular,
    })
  }

  return {
    evento: { id: ev.id, nome: ev.name },
    setores: setores.map((s) => {
      const lugares = porSetor.get(s.id) ?? []
      const conta = (st: string) => lugares.filter((l) => l.status === st).length
      // fileiras já agrupadas: a tela desenha linha por linha e refazer esse
      // agrupamento em JavaScript de template é o que trava o mapa grande
      const fileiras: { nome: string; lugares: any[] }[] = []
      for (const l of lugares) {
        let f = fileiras.find((x) => x.nome === l.fileira)
        if (!f) { f = { nome: l.fileira, lugares: [] }; fileiras.push(f) }
        f.lugares.push(l)
      }
      return {
        id: s.id, nome: s.name, numerado: s.seated,
        capacidade: s.capacity, estoque: s.estoque, vendidos: s.vendidos,
        total: lugares.length,
        livres: conta('livre'), vendidosNoMapa: conta('vendido'),
        reservados: conta('reservado'), bloqueados: conta('bloqueado'),
        fileiras,
      }
    }),
  }
})
