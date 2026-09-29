/**
 * POST /api/conta/entrar — CPF (ou e-mail) e senha. O freio por conta mora em
 * `entrarNaContaDoCliente` (o mesmo `login_attempts` da equipe, com chave própria); o freio por
 * endereço é o da porta pública.
 */
import { mutacaoDeOutroSite } from '../../utils/caminho'
import { frearPortaPublica } from '../../utils/sessao'
import {
  abrirSessaoDoCliente, contaParaTela, entrarNaContaDoCliente, erroDaConta, organizacaoDoSite,
} from '../../utils/conta-do-cliente'

export default defineEventHandler(async (event) => {
  if (mutacaoDeOutroSite(event)) throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
  frearPortaPublica(event, 'conta_entrar')
  const b = ((await readBody(event).catch(() => null)) ?? {}) as Record<string, any>
  const org = await organizacaoDoSite(typeof b.evento === 'string' ? b.evento : null)
  if (!org) throw createError({ statusCode: 404, statusMessage: 'Site sem organização.' })
  try {
    const conta = await entrarNaContaDoCliente(event, org.id, String(b.login ?? ''), String(b.senha ?? ''))
    await abrirSessaoDoCliente(event, conta.id)
    return { ok: true, conta: contaParaTela(conta) }
  } catch (e) {
    erroDaConta(e)
  }
})
