/**
 * POST /api/conta/senha/esqueci — "esqueci a senha" (035, item 4.4 da proposta).
 *
 * Recebe o CPF ou o e-mail e manda, pro e-mail DA CONTA, um link de uso único que vale 30 minutos.
 * A resposta é SEMPRE a mesma, exista a conta ou não: a tela não pode virar um jeito de descobrir
 * quem é cliente do parque. Pelo mesmo motivo o e-mail sai sem a resposta esperar por ele (o
 * tempo da resposta não denuncia a conta que existe).
 *
 * Freios: por endereço (`conta_link`) e por conta (3 links por hora, `emitirLinkDaConta`).
 */
import { mutacaoDeOutroSite } from '../../../utils/caminho'
import { frearPortaPublica, ipDaRequisicao } from '../../../utils/sessao'
import { contaPeloLogin, organizacaoDoSite, tipoDoLogin } from '../../../utils/conta-do-cliente'
import { emitirLinkDaConta, linkDaConta, mandarEmailDaConta, montarEmailDeNovaSenha } from '../../../utils/conta-email'
import { pendenciaDoEmail } from '../../../utils/email'

export const RESPOSTA_DO_ESQUECI =
  'Se existir uma conta com esse CPF ou e-mail, mandamos um link para o e-mail cadastrado. '
  + 'Ele vale por 30 minutos. Confira também a caixa de spam.'

export default defineEventHandler(async (event) => {
  if (mutacaoDeOutroSite(event)) throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
  frearPortaPublica(event, 'conta_link')
  const b = ((await readBody(event).catch(() => null)) ?? {}) as Record<string, any>
  const login = typeof b.login === 'string' ? b.login : ''
  if (!tipoDoLogin(login)) {
    throw createError({ statusCode: 400, statusMessage: 'Digite o seu CPF (11 números) ou o e-mail da conta.',
      data: { tipo: 'conta', campo: 'login' } })
  }
  // Sem servidor de e-mail o link não sai — e "mandamos o link" seria mentira. É estado do SITE,
  // não da conta: dizer isso não revela quem é cliente.
  if (pendenciaDoEmail()) {
    console.warn(`[conta] esqueci a senha sem e-mail configurado: ${pendenciaDoEmail()}`)
    throw createError({ statusCode: 503, data: { tipo: 'email' },
      statusMessage: 'O envio de e-mails do site está fora do ar agora. Tente mais tarde ou fale com o parque.' })
  }
  const org = await organizacaoDoSite(typeof b.evento === 'string' ? b.evento : null)
  if (!org) throw createError({ statusCode: 404, statusMessage: 'Site sem organização.' })

  const ip = ipDaRequisicao(event)
  const trabalho = (async () => {
    const conta = await contaPeloLogin(org.id, login)
    if (!conta) return
    const token = await emitirLinkDaConta(conta.id, 'redefinir_senha', conta.email, ip)
    if (!token) return
    const link = linkDaConta('/conta/redefinir', token)
    if (!link) {
      console.warn('[conta] "esqueci a senha" sem PUBLIC_BASE_URL: o link não tem pra onde apontar')
      return
    }
    await mandarEmailDaConta(montarEmailDeNovaSenha(conta.email, conta.nome, link))
  })().catch((e) => console.warn(`[conta] esqueci a senha: ${String(e?.message ?? e).slice(0, 200)}`))
  // no teste o trabalho termina antes da resposta (o caso lê o e-mail em seguida); em produção não espera
  if (process.env.NODE_ENV !== 'production') await trabalho

  return { ok: true, mensagem: RESPOSTA_DO_ESQUECI }
})
