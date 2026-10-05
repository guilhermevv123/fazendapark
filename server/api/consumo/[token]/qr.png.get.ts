/**
 * GET /api/consumo/<token>/qr.png — o QR do cupom de consumação (042). Ele aponta pra PÁGINA do
 * cupom (`/consumo/<token>`): a atendente abre com a câmera comum do celular, sem app nenhum;
 * logada no painel, a página mostra o botão de dar baixa. O token é a credencial (aleatório,
 * 24 caracteres) — cupom que não existe não gera QR.
 */
import QRCode from 'qrcode'
import { q1 } from '../../../utils/db'
import { enderecoDoCupom } from '../../../utils/cupom-consumacao'

export default defineEventHandler(async (event) => {
  const token = String(getRouterParam(event, 'token') ?? '')
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token) || !(await q1(`SELECT 1 FROM loyalty_vouchers WHERE token = $1`, [token]))) {
    throw createError({ statusCode: 404, statusMessage: 'Cupom não encontrado' })
  }
  const png = await QRCode.toBuffer(enderecoDoCupom(token, getRequestURL(event).origin), {
    margin: 1, width: 360, errorCorrectionLevel: 'M',
  })
  setHeader(event, 'Content-Type', 'image/png')
  setHeader(event, 'Cache-Control', 'private, max-age=3600')
  return png
})
