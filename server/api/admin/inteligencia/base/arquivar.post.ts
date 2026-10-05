/**
 * POST /api/admin/inteligencia/base/arquivar { id } — desliga o item (os robôs param de ler na
 * próxima mensagem). Nada é apagado: o histórico guarda o antes e o depois.
 */
import { erroDoPainel, perguntarABase } from '../../../../utils/agentes'
import { autorDaSessao, UUID_DA_BASE } from '../../../../utils/base-conhecimento'

export default defineEventHandler(async (event) => {
  const corpo = (await readBody<{ id?: string }>(event)) ?? {}
  const id = String(corpo.id ?? '')
  if (!UUID_DA_BASE.test(id)) throw createError({ statusCode: 400, statusMessage: 'Item inválido.' })
  try {
    return await perguntarABase('arquivar', { id, autor: autorDaSessao(event.context.sessao) })
  } catch (e) {
    throw erroDoPainel(e)
  }
})
