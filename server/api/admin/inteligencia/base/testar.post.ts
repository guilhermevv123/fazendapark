/**
 * POST /api/admin/inteligencia/base/testar { pergunta } — manda a pergunta pro fluxo REAL do
 * WhatsApp (o mesmo caminho do cliente) com um número de teste; nada é enviado a ninguém. Devolve o
 * `msg_id`; a tela pergunta `resultado` até a Sofia responder (uns 10 a 60 segundos).
 */
import { erroDoPainel, perguntarABase } from '../../../../utils/agentes'

export default defineEventHandler(async (event) => {
  const corpo = (await readBody<{ pergunta?: string }>(event)) ?? {}
  const pergunta = String(corpo.pergunta ?? '').trim()
  if (pergunta.length < 2 || pergunta.length > 600) {
    throw createError({ statusCode: 400, statusMessage: 'Escreva a pergunta (até 600 letras).' })
  }
  try {
    return await perguntarABase('testar', { pergunta })
  } catch (e) {
    throw erroDoPainel(e)
  }
})
