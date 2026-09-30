/**
 * POST /api/conta/email/confirmar — o clique no link de confirmação de e-mail (035, item 4.2).
 *
 * Vale só enquanto a conta ainda tiver o e-mail pra onde o link foi: trocou o e-mail em "Meus
 * dados", o link antigo não confirma o novo. Não precisa estar logado — quem abre o link no
 * celular, fora do navegador em que se cadastrou, confirma do mesmo jeito.
 */
import { mutacaoDeOutroSite } from '../../../utils/caminho'
import { frearPortaPublica } from '../../../utils/sessao'
import { q1 } from '../../../utils/db'
import { consumirLinkDaConta } from '../../../utils/conta-email'

export default defineEventHandler(async (event) => {
  if (mutacaoDeOutroSite(event)) throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
  frearPortaPublica(event, 'conta_link')
  const b = ((await readBody(event).catch(() => null)) ?? {}) as Record<string, any>
  const link = await consumirLinkDaConta(b.token, 'confirmar_email')
  const confirmou = link
    ? await q1<any>(
      `UPDATE customer_accounts SET email_confirmed_at = COALESCE(email_confirmed_at, now())
        WHERE id = $1 AND email = $2 RETURNING email`, [link.contaId, link.email])
    : null
  if (!confirmou) {
    throw createError({ statusCode: 410, data: { tipo: 'link' },
      statusMessage: 'Este link não vale mais: venceu, já foi usado ou o e-mail da conta mudou. '
        + 'Entre na sua conta e peça outro em "Minha conta".' })
  }
  return { ok: true, email: confirmou.email }
})
