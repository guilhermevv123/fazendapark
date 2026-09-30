/**
 * POST /api/conta/criar — o cadastro do cliente: nome completo, CPF, e-mail, celular e senha;
 * Instagram e endereço opcionais. Cria a conta e já entra.
 *
 * Mesmo freio e mesma checagem de origem de toda porta pública que muda estado: o cookie é
 * SameSite=Lax, e `mutacaoDeOutroSite` é o cinto além do suspensório.
 */
import { mutacaoDeOutroSite } from '../../utils/caminho'
import { frearPortaPublica, ipDaRequisicao } from '../../utils/sessao'
import { mandarConfirmacaoDeEmail } from '../../utils/conta-email'
import {
  abrirSessaoDoCliente, contaParaTela, criarContaDoCliente, erroDaConta, organizacaoDoSite,
  validarDadosDaConta, validarSenhaDaConta,
} from '../../utils/conta-do-cliente'

export default defineEventHandler(async (event) => {
  if (mutacaoDeOutroSite(event)) throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
  frearPortaPublica(event, 'conta_criar')
  const b = ((await readBody(event).catch(() => null)) ?? {}) as Record<string, any>
  const org = await organizacaoDoSite(typeof b.evento === 'string' ? b.evento : null)
  if (!org) throw createError({ statusCode: 404, statusMessage: 'Site sem organização.' })
  try {
    const dados = validarDadosDaConta(b)
    const senha = validarSenhaDaConta(b.senha, dados)
    const conta = await criarContaDoCliente(org.id, { ...dados, senha })
    await abrirSessaoDoCliente(event, conta.id)
    // o link de confirmação sai sem segurar a resposta (a compra não espera o e-mail — 035)
    const confirmacao = mandarConfirmacaoDeEmail(conta, ipDaRequisicao(event))
      .catch((e) => console.warn(`[conta] confirmação de e-mail: ${String(e?.message ?? e).slice(0, 200)}`))
    if (process.env.NODE_ENV !== 'production') await confirmacao
    return { ok: true, conta: contaParaTela(conta) }
  } catch (e) {
    erroDaConta(e)
  }
})
