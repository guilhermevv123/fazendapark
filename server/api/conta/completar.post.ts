/**
 * POST /api/conta/completar — o cadastro de quem entrou pelo Google/Apple e ainda não tinha conta:
 * CPF e celular (o provedor não tem) e, se ele não provou o e-mail, o e-mail. Cria a conta sem
 * senha, ligada ao provedor, e entra.
 */
import { mutacaoDeOutroSite } from '../../utils/caminho'
import { frearPortaPublica } from '../../utils/sessao'
import { abrirPacoteSocial, COOKIE_DO_CADASTRO_SOCIAL } from '../../utils/entrar-social'
import {
  abrirSessaoDoCliente, contaParaTela, criarContaDoCliente, erroDaConta, validarDadosDaConta,
} from '../../utils/conta-do-cliente'

export default defineEventHandler(async (event) => {
  if (mutacaoDeOutroSite(event)) throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
  frearPortaPublica(event, 'conta_criar')
  const p = abrirPacoteSocial<any>(getCookie(event, COOKIE_DO_CADASTRO_SOCIAL))
  if (!p) throw createError({ statusCode: 401, statusMessage: 'O tempo para concluir acabou. Entre de novo.' })
  const b = ((await readBody(event).catch(() => null)) ?? {}) as Record<string, any>
  try {
    // o e-mail que o provedor PROVOU não é trocável aqui; o que ele não provou, a pessoa digita
    const email = p.email && p.emailVerificado ? p.email : b.email
    const dados = validarDadosDaConta({ ...b, email, nome: b.nome || p.nome })
    const conta = await criarContaDoCliente(String(p.org), {
      ...dados, senha: null,
      googleSub: p.provedor === 'google' ? String(p.sub) : null,
      appleSub: p.provedor === 'apple' ? String(p.sub) : null,
      // o provedor provou ESTE e-mail: a conta nasce com ele confirmado (035)
      emailConfirmado: !!(p.email && p.emailVerificado && String(p.email).toLowerCase() === dados.email),
    })
    deleteCookie(event, COOKIE_DO_CADASTRO_SOCIAL, { path: '/' })
    await abrirSessaoDoCliente(event, conta.id)
    return { ok: true, conta: contaParaTela(conta), destino: String(p.volta || '/conta') }
  } catch (e) {
    erroDaConta(e)
  }
})
