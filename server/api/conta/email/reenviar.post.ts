/**
 * POST /api/conta/email/reenviar — manda de novo o link de confirmação pro e-mail da conta logada.
 * Até 3 por hora por conta (`emitirLinkDaConta`), mais o freio por endereço.
 */
import { mutacaoDeOutroSite } from '../../../utils/caminho'
import { frearPortaPublica, ipDaRequisicao } from '../../../utils/sessao'
import { contaDaSessaoDoCliente } from '../../../utils/conta-do-cliente'
import { mandarConfirmacaoDeEmail } from '../../../utils/conta-email'

export default defineEventHandler(async (event) => {
  if (mutacaoDeOutroSite(event)) throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
  frearPortaPublica(event, 'conta_link')
  const conta = await contaDaSessaoDoCliente(event)
  if (!conta) throw createError({ statusCode: 401, statusMessage: 'Entre na sua conta.', data: { tipo: 'conta' } })
  if (conta.emailConfirmado) return { ok: true, jaConfirmado: true }
  const r = await mandarConfirmacaoDeEmail(conta, ipDaRequisicao(event))
  if (r === 'limite') {
    throw createError({ statusCode: 429, statusMessage: 'Já mandamos 3 links na última hora. Confira a caixa de entrada e o spam.' })
  }
  if (r !== 'enviado') {
    throw createError({ statusCode: 503, statusMessage: 'Não deu pra mandar o e-mail agora. Tente de novo em alguns minutos.' })
  }
  return { ok: true, email: conta.email }
})
