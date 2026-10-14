/** GET /api/conectar-whatsapp/<token> — estado da instância + QR atual. Ver utils/conectar-whatsapp.ts. */
import { configDaConexao, estadoDaInstancia } from '../../../utils/conectar-whatsapp'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  conferirFreio(event, 'pedido_404')
  const c = configDaConexao(String(getRouterParam(event, 'token') ?? ''))
  if (!c) {
    marcarNoFreio(event, 'pedido_404')
    throw createError({ statusCode: 404, statusMessage: 'Link não encontrado.' })
  }
  try {
    return await estadoDaInstancia(c)
  } catch {
    throw createError({ statusCode: 502, statusMessage: 'O serviço do WhatsApp não respondeu. Tente de novo em instantes.' })
  }
})
