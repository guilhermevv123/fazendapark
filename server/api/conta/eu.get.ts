/**
 * GET /api/conta/eu?evento=<slug> — quem está na conta (ou `null`), se este site exige a conta pra
 * comprar e quais botões de entrada existem (Google/Apple só aparecem com as chaves no servidor).
 *
 * Com `evento`, a conta só vale se for da organização DO EVENTO. Nunca guarda em cache: é por
 * pessoa.
 */
import { contaDaSessaoDoCliente, contaParaTela, organizacaoDoSite } from '../../utils/conta-do-cliente'
import { provedoresSociaisLigados } from '../../utils/entrar-social'

const SLUG = /^[a-z0-9-]{1,80}$/

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { evento } = getQuery(event) as { evento?: string }
  const slug = evento && SLUG.test(String(evento)) ? String(evento) : null
  const org = await organizacaoDoSite(slug)
  const conta = org ? await contaDaSessaoDoCliente(event, org.id) : null
  return {
    conta: conta ? contaParaTela(conta) : null,
    exigeConta: !!org?.exigeConta,
    social: provedoresSociaisLigados(),
  }
})
