/**
 * GET /api/pedido/:id — estado do pedido e, se pago, os ingressos.
 *
 * Aceita o UUID (que a tela de pagamento tem na mão) ou o código PED-XXXX (que
 * o comprador tem no e-mail). São a mesma coisa pra quem consulta; separar em
 * duas rotas só obrigaria a tela a saber qual dos dois ela guardou.
 *
 * Não exige login de propósito: o código é a credencial. Por isso ele é
 * aleatório e longo, e por isso esta rota devolve o e-mail mascarado — quem
 * chuta um código não descobre de quem ele é.
 */
import { q, q1 } from '../../utils/db'
import { montarQr } from '../../utils/ingresso'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'pedido ausente' })

  const o = await q1<any>(
    `SELECT o.id, o.code, o.status, o.face_cents, o.fee_cents, o.discount_cents,
            o.total_cents, o.payment_method, o.installments, o.expires_at,
            o.created_at, o.paid_at, o.pix_payload, o.pix_qr_base64,
            c.name AS comprador, c.email,
            e.id AS event_id, e.name AS evento, e.slug, e.starts_at, e.ticket_noun,
            e.venue_name, e.city, e.state, e.banner_url
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN events e ON e.id = o.event_id
      WHERE ${UUID.test(id) ? 'o.id = $1' : 'upper(o.code) = upper($1)'}`, [id])
  if (!o) throw createError({ statusCode: 404, statusMessage: 'Pedido não encontrado' })

  const itens = await q<any>(
    `SELECT oi.quantity, oi.unit_face_cents, oi.unit_fee_cents, oi.unit_total_cents,
            l.name AS lote, s.name AS setor, tt.name AS tipo
       FROM order_items oi
       JOIN lots l ON l.id = oi.lot_id
       JOIN sectors s ON s.id = l.sector_id
       LEFT JOIN ticket_types tt ON tt.id = oi.ticket_type_id
      WHERE oi.order_id = $1`, [o.id])

  // QR só existe pra pedido pago. Emitir a imagem antes disso seria entregar
  // ingresso válido a quem ainda não pagou.
  const ingressos = o.status === 'pago'
    ? (await q<any>(
        `SELECT t.id, t.code, t.status, t.holder_name, t.checked_in_at, t.is_courtesy,
                l.name AS lote, s.name AS setor, tt.name AS tipo,
                ses.title AS sessao, ses.starts_at AS sessao_inicio
           FROM tickets t
           JOIN lots l ON l.id = t.lot_id
           JOIN sectors s ON s.id = l.sector_id
           LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
           LEFT JOIN event_sessions ses ON ses.id = s.session_id
          WHERE t.order_id = $1
          ORDER BY s.sort_order, t.issued_at`, [o.id]))
        .map((t) => ({
          id: t.id, codigo: t.code, status: t.status, titular: t.holder_name,
          cortesia: t.is_courtesy,
          usadoEm: t.checked_in_at, setor: t.setor, lote: t.lote, tipo: t.tipo,
          sessao: t.sessao, sessaoInicio: t.sessao_inicio,
          qr: montarQr(t.code, o.event_id),
        }))
    : []

  return {
    pedido: o.code,
    pedidoId: o.id,
    status: o.status,
    criadoEm: o.created_at,
    pagoEm: o.paid_at,
    expiraEm: o.expires_at,
    faceCents: Number(o.face_cents),
    feeCents: Number(o.fee_cents),
    descontoCents: Number(o.discount_cents),
    totalCents: Number(o.total_cents),
    comprador: { nome: o.comprador, email: mascarar(o.email) },
    evento: {
      nome: o.evento, slug: o.slug, inicio: o.starts_at, substantivo: o.ticket_noun,
      local: o.venue_name, cidade: o.city, estado: o.state, banner: o.banner_url,
    },
    itens: itens.map((i) => ({
      quantidade: i.quantity, setor: i.setor, lote: i.lote, tipo: i.tipo,
      unitFaceCents: Number(i.unit_face_cents),
      unitTotalCents: Number(i.unit_total_cents),
    })),
    pagamento: o.status === 'aguardando_pagamento'
      ? { forma: o.payment_method, pixPayload: o.pix_payload, pixQrBase64: o.pix_qr_base64 }
      : null,
    ingressos,
  }
})

/** joao.silva@gmail.com → jo•••••@gmail.com */
function mascarar(email: string) {
  const [u, d] = email.split('@')
  if (!d) return '•••'
  return `${u.slice(0, 2)}${'•'.repeat(Math.max(3, u.length - 2))}@${d}`
}
