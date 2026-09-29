/**
 * GET /api/conta/<google|apple>?evento=<slug>&volta=<caminho> — a ida pro Google/Apple. Sem as
 * chaves no servidor, 404 (a tela nem mostra o botão).
 */
import { destinoSeguroDoCliente, PROVEDORES_SOCIAIS, urlDeEntradaSocial, type ProvedorSocial } from '../../../utils/entrar-social'
import { organizacaoDoSite } from '../../../utils/conta-do-cliente'

const SLUG = /^[a-z0-9-]{1,80}$/

export default defineEventHandler(async (event) => {
  const p = getRouterParam(event, 'provedor') as ProvedorSocial
  if (!PROVEDORES_SOCIAIS.includes(p)) throw createError({ statusCode: 404, statusMessage: 'Não encontrado' })
  const { evento, volta } = getQuery(event) as { evento?: string; volta?: string }
  const org = await organizacaoDoSite(evento && SLUG.test(String(evento)) ? String(evento) : null)
  if (!org) throw createError({ statusCode: 404, statusMessage: 'Site sem organização.' })
  const url = urlDeEntradaSocial(event, p, { orgId: org.id, volta: destinoSeguroDoCliente(volta) })
  if (!url) {
    throw createError({ statusCode: 404,
      statusMessage: `Entrar pelo ${p === 'google' ? 'Google' : 'Apple'} não está ligado neste site.` })
  }
  return sendRedirect(event, url, 302)
})
