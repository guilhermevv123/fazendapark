/**
 * POST /api/conta/senha/redefinir — a senha nova pelo link do e-mail (035).
 *
 * `{ token, senha }`. A senha é conferida ANTES de gastar o link (senha fraca não queima o link:
 * a pessoa corrige e tenta de novo). Depois: o link é consumido num UPDATE só (dois cliques, um
 * uso), a senha é gravada, todas as sessões da conta caem e ESTE aparelho já entra.
 *
 * GET com `?t=` (sem gastar) responde se o link ainda vale — a tela avisa antes de a pessoa digitar.
 */
import { mutacaoDeOutroSite } from '../../../utils/caminho'
import { frearPortaPublica } from '../../../utils/sessao'
import {
  abrirSessaoDoCliente, contaDoClientePorId, contaParaTela, erroDaConta, gravarSenhaNovaDoCliente,
  validarSenhaDaConta,
} from '../../../utils/conta-do-cliente'
import { conferirLinkDaConta, consumirLinkDaConta } from '../../../utils/conta-email'

export const LINK_DE_SENHA_VENCIDO =
  'Este link não vale mais: ele venceu (30 minutos), já foi usado ou um link mais novo foi pedido. '
  + 'Peça outro em "Esqueci a senha".'

export default defineEventHandler(async (event) => {
  if (mutacaoDeOutroSite(event)) throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
  frearPortaPublica(event, 'conta_link')
  const b = ((await readBody(event).catch(() => null)) ?? {}) as Record<string, any>
  const vencido = () => createError({ statusCode: 410, statusMessage: LINK_DE_SENHA_VENCIDO, data: { tipo: 'link' } })

  const previa = await conferirLinkDaConta(b.token, 'redefinir_senha')
  if (!previa) throw vencido()
  const conta = await contaDoClientePorId(previa.contaId)
  if (!conta) throw vencido()
  let senha: string
  try {
    senha = validarSenhaDaConta(b.senha, { email: conta.email, cpf: conta.cpf })
  } catch (e) {
    erroDaConta(e)
  }
  const link = await consumirLinkDaConta(b.token, 'redefinir_senha')
  if (!link) throw vencido()
  await gravarSenhaNovaDoCliente(link.contaId, senha!, link.email)
  await abrirSessaoDoCliente(event, link.contaId)
  return { ok: true, conta: contaParaTela((await contaDoClientePorId(link.contaId))!) }
})
