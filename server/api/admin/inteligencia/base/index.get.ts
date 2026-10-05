/**
 * GET /api/admin/inteligencia/base — os itens da base de conhecimento dos robôs, o histórico e
 * o texto EXATO que cada canal (WhatsApp, Instagram, comentários) está lendo agora.
 */
import { erroDoPainel, perguntarABase } from '../../../../utils/agentes'

export default defineEventHandler(async () => {
  try {
    return await perguntarABase('listar')
  } catch (e) {
    throw erroDoPainel(e)
  }
})
