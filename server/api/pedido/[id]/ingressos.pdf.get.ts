/**
 * GET /api/pedido/:codigo/ingressos.pdf — os ingressos do pedido em PDF, uma página por ingresso.
 *
 * Mesma credencial da página `/ingressos/<codigo>` e do QR em PNG: o código do pedido (aleatório e
 * longo; o freio `pedido_404` segura quem chuta). Só entram os ingressos que ENTRAM por este
 * pedido — válidos e não transferidos —, a mesma régua de `ingresso/[id]/qr.png`: cancelado não
 * entra e o transferido é de outra pessoa agora (dois PDFs com o mesmo QR = duas pessoas na porta).
 */
import { q, q1 } from '../../../utils/db'
import { fraseDosDiasDeUso } from '../../../utils/dias-de-uso'
import { montarQr } from '../../../utils/ingresso'
import { montarPdfDosIngressos } from '../../../utils/ingresso-pdf'
import { PEDIDO_VIVO } from '../../../utils/liquido'
import { conferirFreio, marcarNoFreio } from '../../../utils/sessao'

const CODIGO = /^[A-Z0-9-]{6,40}$/i

export default defineEventHandler(async (event) => {
  const codigo = String(getRouterParam(event, 'id') ?? '')
  conferirFreio(event, 'pedido_404')
  if (!CODIGO.test(codigo)) {
    marcarNoFreio(event, 'pedido_404')
    throw createError({ statusCode: 404, statusMessage: 'Pedido não encontrado' })
  }
  const o = await q1<any>(
    `SELECT o.id, o.code, e.id AS event_id, e.name AS evento, e.starts_at, e.timezone, e.venue_name, e.city, e.state
       FROM orders o JOIN events e ON e.id = o.event_id
      WHERE upper(o.code) = upper($1) AND ${PEDIDO_VIVO('o.')}`, [codigo])
  if (!o) {
    marcarNoFreio(event, 'pedido_404')
    throw createError({ statusCode: 404, statusMessage: 'Pedido não encontrado' })
  }
  const ingressos = await q<any>(
    `SELECT t.code, t.holder_name, l.name AS lote, s.name AS setor, tt.name AS tipo, ses.title AS sessao,
            tt.valid_dates::text[] AS dias_de_uso
       FROM tickets t
       JOIN lots l ON l.id = t.lot_id
       JOIN sectors s ON s.id = l.sector_id
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN event_sessions ses ON ses.id = s.session_id
      WHERE t.order_id = $1 AND t.status = 'valido'
        AND NOT EXISTS (SELECT 1 FROM ticket_transfers tr WHERE tr.ticket_id = t.id AND tr.status = 'concluido')
      ORDER BY t.issued_at, t.code`, [o.id])
  if (!ingressos.length) {
    throw createError({ statusCode: 410, statusMessage: 'Este pedido não tem ingresso válido para baixar.' })
  }

  let comQr: { code: string; qr: string; t: any }[]
  try {
    comQr = ingressos.map((t) => ({ code: t.code, qr: montarQr(t.code, o.event_id), t }))
  } catch (e: any) {
    console.error(`[ingressos.pdf] ${e?.message ?? e}`)
    throw createError({ statusCode: 503,
      statusMessage: 'O QR está indisponível agora. Na entrada, informe o código do ingresso.' })
  }

  const local = [o.venue_name, [o.city, o.state].filter(Boolean).join('/')].filter(Boolean).join(' · ')
  const bytes = await montarPdfDosIngressos({
    evento: o.evento, local: local || null, pedido: o.code,
    ingressos: comQr.map(({ code, qr, t }) => ({
      codigo: code, qr, tipo: t.tipo, setor: t.setor, lote: t.lote, titular: t.holder_name, sessao: t.sessao,
      diasDeUso: fraseDosDiasDeUso(t.dias_de_uso) || null,
    })),
  })
  setHeader(event, 'Content-Type', 'application/pdf')
  setHeader(event, 'Content-Disposition', `attachment; filename="ingressos-${o.code}.pdf"`)
  setHeader(event, 'Cache-Control', 'no-store')
  return Buffer.from(bytes)
})
