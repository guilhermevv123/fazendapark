/**
 * GET /api/ingresso/:id/qr.png?pedido=PED-XXXX — o QR do ingresso, em PNG.
 *
 * Exige o código do pedido junto. Sem isso, o id do ingresso sozinho viraria
 * credencial, e id de ingresso circula (fica em URL, em log, em print). O
 * código do pedido é o que o comprador tem e o que ele guarda.
 *
 * O QR é gerado na hora a partir da assinatura HMAC — nunca fica salvo. Assim
 * ingresso cancelado ou estornado para de produzir QR no mesmo instante, sem
 * depender de apagar arquivo em lugar nenhum.
 */
import QRCode from 'qrcode'
import { q1 } from '../../../utils/db'
import { montarQr } from '../../../utils/ingresso'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const { pedido } = getQuery(event) as { pedido?: string }
  if (!pedido) throw createError({ statusCode: 400, statusMessage: 'pedido ausente' })

  const t = await q1<any>(
    `SELECT t.code, t.status, o.event_id
       FROM tickets t JOIN orders o ON o.id = t.order_id
      WHERE t.id = $1 AND upper(o.code) = upper($2) AND o.status = 'pago'`,
    [id, pedido])
  if (!t) throw createError({ statusCode: 404, statusMessage: 'Ingresso não encontrado' })
  if (t.status === 'cancelado') {
    throw createError({ statusCode: 410, statusMessage: 'Ingresso cancelado' })
  }

  const png = await QRCode.toBuffer(montarQr(t.code, t.event_id), {
    margin: 1, width: 560, errorCorrectionLevel: 'M',
  })
  setHeader(event, 'content-type', 'image/png')
  // Privado e curto: é credencial de entrada, não asset.
  setHeader(event, 'cache-control', 'private, max-age=60')
  return png
})
