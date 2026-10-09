/**
 * POST /api/auth/esqueci — "esqueci a senha" da EQUIPE (051), no login do painel e da portaria.
 *
 * `{ email, de? }`. Manda pro e-mail do acesso um link de uso único que vale 30 minutos. A resposta
 * é SEMPRE a mesma, exista o acesso ou não (a tela não vira um jeito de descobrir quem é da equipe),
 * e o e-mail sai sem a resposta esperar por ele (o tempo não denuncia o acesso que existe).
 *
 * Freios: por endereço (`conta_link`, o mesmo do "esqueci" do cliente) e por acesso (3 por hora).
 */
import { mutacaoDeOutroSite } from '../../utils/caminho'
import { frearPortaPublica, ipDaRequisicao } from '../../utils/sessao'
import { q } from '../../utils/db'
import { pendenciaDoEmail } from '../../utils/email'
import { linkDaConta, mandarEmailDaConta } from '../../utils/conta-email'
import { destinoDaEquipe, emitirLinkDaEquipe, montarEmailDeSenhaDaEquipe } from '../../utils/senha-da-equipe'

export const RESPOSTA_DO_ESQUECI_DA_EQUIPE =
  'Se esse e-mail tiver acesso de equipe, mandamos para ele um link para criar uma senha nova. '
  + 'O link vale por 30 minutos. Confira também a caixa de spam.'

export default defineEventHandler(async (event) => {
  if (mutacaoDeOutroSite(event)) throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
  frearPortaPublica(event, 'conta_link')
  const b = ((await readBody(event).catch(() => null)) ?? {}) as Record<string, any>
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) {
    throw createError({ statusCode: 400, statusMessage: 'Digite o e-mail do seu acesso (ex.: nome@gmail.com).' })
  }
  // sem servidor de e-mail o link não sai — e "mandamos o link" seria mentira (estado do SITE)
  if (pendenciaDoEmail()) {
    console.warn(`[equipe] esqueci a senha sem e-mail configurado: ${pendenciaDoEmail()}`)
    throw createError({ statusCode: 503,
      statusMessage: 'O envio de e-mails está fora do ar agora. Peça a um master para gerar uma senha nova em Equipe.' })
  }
  const de = destinoDaEquipe(b.de)
  const ip = ipDaRequisicao(event)
  const trabalho = (async () => {
    const acessos = await q<{ id: string; name: string; email: string }>(
      `SELECT id, name, email FROM users WHERE lower(email) = $1 AND active`, [email])
    for (const u of acessos) {
      const token = await emitirLinkDaEquipe(u.id, u.email, ip)
      if (!token) continue
      const link = linkDaConta('/redefinir-senha', token)
      if (!link) { console.warn('[equipe] "esqueci a senha" sem PUBLIC_BASE_URL'); return }
      await mandarEmailDaConta(montarEmailDeSenhaDaEquipe(u.email, u.name, `${link}&de=${encodeURIComponent(de)}`))
    }
  })().catch((e) => console.warn(`[equipe] esqueci a senha: ${String(e?.message ?? e).slice(0, 200)}`))
  // no teste o trabalho termina antes da resposta (o caso lê o e-mail em seguida); em produção não espera
  if (process.env.NODE_ENV !== 'production') await trabalho

  return { ok: true, mensagem: RESPOSTA_DO_ESQUECI_DA_EQUIPE }
})
