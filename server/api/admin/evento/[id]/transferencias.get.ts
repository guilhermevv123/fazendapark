/**
 * GET /api/admin/evento/:id/transferencias — o que foi passado adiante.
 *
 * Lista sem paginação cega: a busca aceita e-mail, código do ingresso e
 * código do pedido porque é assim que a pergunta chega no balcão — "o
 * ingresso do fulano", e o fulano pode ser quem mandou ou quem recebeu.
 */
import { q, q1 } from '../../../../utils/db'
import { STATUS_LEGIVEL } from '../../../../utils/transferencia'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const { busca = '', status = '' } = getQuery(event) as Record<string, string>

  const ev = await q1<any>(
    `SELECT id, name, allow_transfer FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const termo = String(busca).trim()
  const linhas = await q<any>(
    `SELECT tr.id, tr.status, tr.created_at, tr.accepted_at, tr.canceled_at, tr.expires_at,
            tr.de_nome, tr.de_email, tr.para_nome, tr.para_email, tr.para_telefone,
            t.code AS ingresso, t.status AS ingresso_status,
            o.code AS pedido,
            s.name AS setor, l.name AS lote, tt.name AS tipo,
            l.price_cents,
            se.label AS assento,
            es.title AS sessao, es.starts_at AS sessao_inicio,
            u.name AS enviado_por
       FROM ticket_transfers tr
       JOIN tickets t ON t.id = tr.ticket_id
       JOIN sectors s ON s.id = t.sector_id
       JOIN lots l    ON l.id = t.lot_id
       LEFT JOIN ticket_types tt   ON tt.id = t.ticket_type_id
       LEFT JOIN orders o          ON o.id = t.order_id
       LEFT JOIN seats se          ON se.ticket_id = t.id
       LEFT JOIN event_sessions es ON es.id = t.session_id
       LEFT JOIN users u           ON u.id = tr.criado_por
      WHERE tr.event_id = $1
        AND ($2 = '' OR tr.status = $2)
        AND ($3 = '' OR tr.para_email ILIKE '%'||$3||'%' OR tr.de_email ILIKE '%'||$3||'%'
             OR upper(t.code) = upper($3) OR upper(o.code) = upper($3)
             OR tr.para_nome ILIKE '%'||$3||'%' OR tr.de_nome ILIKE '%'||$3||'%')
      ORDER BY tr.created_at DESC
      LIMIT 300`, [id, String(status), termo])

  const contas = await q<any>(
    `SELECT status, count(*)::int AS n FROM ticket_transfers
      WHERE event_id = $1 GROUP BY status`, [id])
  const porStatus: Record<string, number> = {}
  for (const c of contas) porStatus[c.status] = c.n

  return {
    evento: { id: ev.id, nome: ev.name, permite: ev.allow_transfer },
    resumo: {
      total: Object.values(porStatus).reduce((s, n) => s + n, 0),
      aguardando: porStatus.aguardando ?? 0,
      concluido: porStatus.concluido ?? 0,
      cancelado: porStatus.cancelado ?? 0,
      expirado: porStatus.expirado ?? 0,
    },
    transferencias: linhas.map((r) => ({
      id: r.id,
      status: r.status,
      statusTexto: STATUS_LEGIVEL[r.status] ?? r.status,
      criadaEm: r.created_at,
      aceitaEm: r.accepted_at,
      canceladaEm: r.canceled_at,
      venceEm: r.expires_at,
      de: { nome: r.de_nome, email: r.de_email },
      para: { nome: r.para_nome, email: r.para_email, telefone: r.para_telefone },
      ingresso: {
        codigo: r.ingresso, status: r.ingresso_status, pedido: r.pedido,
        setor: r.setor, lote: r.lote, tipo: r.tipo, assento: r.assento,
        sessao: r.sessao, sessaoInicio: r.sessao_inicio,
        precoCents: Number(r.price_cents ?? 0),
      },
      enviadoPor: r.enviado_por,
    })),
  }
})
