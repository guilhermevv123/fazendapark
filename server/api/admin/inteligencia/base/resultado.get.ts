/** GET /api/admin/inteligencia/base/resultado?msg_id=PAINEL-… — o que a Sofia respondeu no teste. */
import { erroDoPainel, perguntarABase } from '../../../../utils/agentes'

export default defineEventHandler(async (event) => {
  const msgId = String(getQuery(event).msg_id ?? '')
  if (!/^PAINEL-[A-Z0-9]{6,30}$/.test(msgId)) throw createError({ statusCode: 400, statusMessage: 'Teste inválido.' })
  try {
    return await perguntarABase('resultado', { msg_id: msgId })
  } catch (e) {
    throw erroDoPainel(e)
  }
})
