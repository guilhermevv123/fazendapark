/**
 * POST /api/admin/inteligencia/base/revisar { item } — a IA (a mesma OpenAI dos robôs, chave só
 * dentro do n8n) reescreve o texto claro pro robô e aponta conflito com o que já está ativo, dúvida
 * (data sem dia, horário sem fim) e alerta (preço/link de compra não se escreve aqui). Não grava
 * nada: quem decide usar a sugestão é a pessoa.
 */
import { erroDoPainel, perguntarABase } from '../../../../utils/agentes'
import { lerItemDaBase } from '../../../../utils/base-conhecimento'

export default defineEventHandler(async (event) => {
  const corpo = (await readBody<{ item?: unknown }>(event)) ?? {}
  const { tipo, titulo, texto } = lerItemDaBase(corpo.item)
  try {
    return await perguntarABase('revisar', { item: { tipo, titulo, texto } })
  } catch (e) {
    throw erroDoPainel(e)
  }
})
