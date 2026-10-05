/**
 * POST /api/admin/inteligencia/base/salvar { item } — cria ou edita um item da base. Vale na
 * PRÓXIMA mensagem de todo robô do canal marcado. O autor é quem está logado (não vem do corpo).
 * A validação de conteúdo mora na automação (a mesma pra qualquer cliente da API); aqui só o
 * formato, pra não mandar lixo pela rede.
 */
import { erroDoPainel, perguntarABase } from '../../../../utils/agentes'
import { autorDaSessao, lerItemDaBase } from '../../../../utils/base-conhecimento'

export default defineEventHandler(async (event) => {
  const corpo = (await readBody<{ item?: unknown }>(event)) ?? {}
  const item = lerItemDaBase(corpo.item)
  try {
    return await perguntarABase('salvar', { item, autor: autorDaSessao(event.context.sessao) })
  } catch (e) {
    throw erroDoPainel(e)
  }
})

