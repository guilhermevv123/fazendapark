/**
 * GET /api/admin/agentes/conversa?contato=<telefone ou id do Instagram> — a conversa inteira de
 * uma pessoa com a Sofia (até 300 turnos), os casos abertos dela e o resumo já feito.
 */
import { erroDoPainel, perguntarAoPainel } from '../../../utils/agentes'
import { contatoValido } from '../../../utils/agentes-rotulos'

export default defineEventHandler(async (event) => {
  const contato = String(getQuery(event).contato ?? '').trim()
  if (!contatoValido(contato)) {
    throw createError({ statusCode: 400, statusMessage: 'Contato inválido: use o telefone com DDI (55…) ou o id do Instagram.' })
  }
  try {
    return await perguntarAoPainel('conversa', { contato })
  } catch (e) {
    throw erroDoPainel(e)
  }
})
