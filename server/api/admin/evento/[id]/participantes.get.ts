/**
 * GET /api/admin/evento/:id/participantes — a lista da portaria.
 *
 * É uma lista de INGRESSOS, não de pedidos. A diferença importa: um pedido de
 * 6 ingressos é uma linha em vendas e seis pessoas aqui. Quem procura "o
 * fulano comprou?" olha vendas; quem procura "o fulano entra?" olha esta.
 *
 * Por isso a busca varre o portador (nome/documento do ingresso) E o comprador
 * — o pai compra os seis e só o nome dele está no pedido.
 */
import { q, q1 } from '../../../../utils/db'

const PAGINA = 50

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const { busca, status, setor, pagina } = getQuery(event) as Record<string, string>

  const ev = await q1<any>(`SELECT id, name FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const onde: string[] = ['t.event_id = $1']
  const par: any[] = [id]

  const b = String(busca ?? '').trim()
  if (b) {
    const dig = b.replace(/\D/g, '')
    par.push(`%${b}%`)
    const like = `$${par.length}`
    // Documento com pontuação: compara só os dígitos dos dois lados, senão
    // "000.000.000-00" nunca acha quem digitou "00000000000".
    const porDigitos = dig.length >= 3
      ? (par.push(`%${dig}%`),
         ` OR regexp_replace(COALESCE(t.holder_document,''), '\\D', '', 'g') LIKE $${par.length}
           OR regexp_replace(COALESCE(c.document,''),        '\\D', '', 'g') LIKE $${par.length}`)
      : ''
    onde.push(`(t.code ILIKE ${like} OR t.holder_name ILIKE ${like}
                OR t.holder_email ILIKE ${like} OR c.name ILIKE ${like}
                OR c.email ILIKE ${like} OR o.code ILIKE ${like}${porDigitos})`)
  }
  if (status) { par.push(status); onde.push(`t.status = $${par.length}`) }
  if (setor) { par.push(setor); onde.push(`t.sector_id = $${par.length}`) }

  const filtro = onde.join(' AND ')
  const p = Math.max(1, Number(pagina) || 1)

  const linhas = await q<any>(
    `SELECT t.id, t.code, t.status, t.is_courtesy, t.holder_name, t.holder_email,
            t.holder_document, t.issued_at, t.checked_in_at,
            s.name AS setor, l.name AS lote, tt.name AS tipo,
            o.code AS pedido, o.id AS pedido_id, o.channel,
            c.name AS comprador, c.email AS comprador_email,
            u.name AS validado_por
       FROM tickets t
       JOIN sectors s ON s.id = t.sector_id
       JOIN lots    l ON l.id = t.lot_id
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN orders o ON o.id = t.order_id
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN users u ON u.id = t.checked_in_by
      WHERE ${filtro}
      ORDER BY t.issued_at DESC
      LIMIT ${PAGINA} OFFSET ${(p - 1) * PAGINA}`, par)

  // O total usa o MESMO filtro da lista. Contar com um WHERE diferente é como
  // o rodapé passa a contradizer as linhas de cima.
  const t = await q1<any>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE t.status = 'usado')::int AS entraram,
            count(*) FILTER (WHERE t.is_courtesy)::int AS cortesias
       FROM tickets t
       LEFT JOIN orders o ON o.id = t.order_id
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE ${filtro}`, par)

  const setores = await q<any>(
    `SELECT id, name FROM sectors WHERE event_id = $1 ORDER BY sort_order`, [id])

  return {
    evento: { id: ev.id, nome: ev.name },
    setores: setores.map((s) => ({ id: s.id, nome: s.name })),
    resumo: { total: t.total, entraram: t.entraram, cortesias: t.cortesias },
    pagina: p,
    paginas: Math.max(1, Math.ceil(t.total / PAGINA)),
    participantes: linhas.map((r) => ({
      id: r.id, codigo: r.code, status: r.status, cortesia: r.is_courtesy,
      nome: r.holder_name, email: r.holder_email, documento: r.holder_document,
      emitidoEm: r.issued_at, entrouEm: r.checked_in_at, validadoPor: r.validado_por,
      setor: r.setor, lote: r.lote, tipo: r.tipo,
      pedido: r.pedido, pedidoId: r.pedido_id, canal: r.channel,
      comprador: r.comprador, compradorEmail: r.comprador_email,
    })),
  }
})
