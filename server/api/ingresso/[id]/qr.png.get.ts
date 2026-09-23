/**
 * GET /api/ingresso/:id/qr.png?pedido=PED-XXXX — o QR do ingresso, em PNG.
 *   ou ?transferencia=tr_... — o QR de quem RECEBEU o ingresso por transferência.
 *
 * Exige uma credencial junto. Sem isso, o id do ingresso sozinho viraria
 * credencial, e id de ingresso circula (fica em URL, em log, em print). As
 * duas credenciais aceitas são as que cada dono tem na mão:
 *
 *  • `pedido` — o código do pedido, que é de quem COMPROU. Vale enquanto o
 *    ingresso é dele: transferido e aceito, o pedido do remetente para de
 *    produzir QR (senão remetente e destinatário entravam os dois);
 *  • `transferencia` — o token do link de aceite, que é de quem RECEBEU. Vale
 *    só depois do aceite, e só enquanto aquela for a transferência em vigor
 *    (se o destinatário passou adiante, o link dele para de valer).
 *
 * O QR é gerado na hora a partir da assinatura HMAC — nunca fica salvo. Assim
 * ingresso cancelado ou estornado para de produzir QR no mesmo instante, sem
 * depender de apagar arquivo em lugar nenhum.
 */
import QRCode from 'qrcode'
import { q1 } from '../../../utils/db'
import { montarQr } from '../../../utils/ingresso'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const { pedido, transferencia } = getQuery(event) as { pedido?: string; transferencia?: string }
  if (!pedido && !transferencia) {
    throw createError({ statusCode: 400, statusMessage: 'pedido ausente' })
  }
  // id que não é UUID nem chega no banco: o `$1::uuid` estourava 22P02 e a
  // rota respondia 500 pra um link digitado torto.
  if (!id || !UUID.test(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Ingresso não encontrado' })
  }

  const t = pedido
    ? await q1<any>(
        `SELECT t.code, t.status, o.event_id,
                EXISTS (SELECT 1 FROM ticket_transfers tr
                         WHERE tr.ticket_id = t.id AND tr.status = 'concluido') AS transferido
           FROM tickets t JOIN orders o ON o.id = t.order_id
          WHERE t.id = $1 AND upper(o.code) = upper($2) AND o.status = 'pago'`,
        [id, pedido])
    : await q1<any>(
        // a transferência em vigor: aceita, e nenhuma aceita DEPOIS dela
        `SELECT t.code, t.status, t.event_id, false AS transferido
           FROM ticket_transfers tr JOIN tickets t ON t.id = tr.ticket_id
          WHERE t.id = $1 AND tr.code = $2 AND tr.status = 'concluido'
            AND NOT EXISTS (SELECT 1 FROM ticket_transfers depois
                             WHERE depois.ticket_id = tr.ticket_id
                               AND depois.status = 'concluido'
                               AND depois.accepted_at > tr.accepted_at)`,
        [id, transferencia])
  if (!t) throw createError({ statusCode: 404, statusMessage: 'Ingresso não encontrado' })
  if (t.status === 'cancelado') {
    throw createError({ statusCode: 410, statusMessage: 'Ingresso cancelado' })
  }
  if (t.transferido) {
    throw createError({ statusCode: 410, statusMessage: 'Ingresso transferido para outra pessoa' })
  }

  const png = await QRCode.toBuffer(montarQr(t.code, t.event_id), {
    margin: 1, width: 560, errorCorrectionLevel: 'M',
  })
  setHeader(event, 'content-type', 'image/png')
  // Privado e curto: é credencial de entrada, não asset.
  setHeader(event, 'cache-control', 'private, max-age=60')
  return png
})
