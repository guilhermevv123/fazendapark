/**
 * POST /api/admin/agentes/resumo { contato, forcar? } — resumo da conversa escrito pela IA.
 *
 * POST e não GET porque pode custar dinheiro (chamada à OpenAI) e grava o cache em
 * `fp_resumos`. O n8n devolve o cache quando a conversa não andou desde o último resumo, então
 * clicar duas vezes não paga duas vezes; `forcar` refaz mesmo assim.
 */
import { erroDoPainel, perguntarAoPainel } from '../../../utils/agentes'
import { contatoValido } from '../../../utils/agentes-rotulos'

export default defineEventHandler(async (event) => {
  const corpo = (await readBody<{ contato?: string; forcar?: boolean }>(event)) ?? {}
  const contato = String(corpo.contato ?? '').trim()
  if (!contatoValido(contato)) {
    throw createError({ statusCode: 400, statusMessage: 'Contato inválido: use o telefone com DDI (55…) ou o id do Instagram.' })
  }
  try {
    return await perguntarAoPainel('resumo', { contato, ...(corpo.forcar ? { forcar: '1' } : {}) })
  } catch (e) {
    throw erroDoPainel(e)
  }
})
