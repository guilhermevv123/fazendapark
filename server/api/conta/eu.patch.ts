/**
 * PATCH /api/conta/eu — "Meus dados": nome, e-mail, celular, Instagram, endereço e novidades.
 * O CPF não muda por aqui: é a identidade do ingresso e a régua do teto por CPF (e do grátis).
 */
import { mutacaoDeOutroSite } from '../../utils/caminho'
import { ipDaRequisicao } from '../../utils/sessao'
import { mandarConfirmacaoDeEmail } from '../../utils/conta-email'
import {
  atualizarContaDoCliente, contaDaSessaoDoCliente, contaParaTela, erroDaConta, validarDadosDaConta,
} from '../../utils/conta-do-cliente'

export default defineEventHandler(async (event) => {
  if (mutacaoDeOutroSite(event)) throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
  const conta = await contaDaSessaoDoCliente(event)
  if (!conta) throw createError({ statusCode: 401, statusMessage: 'Entre na sua conta.', data: { tipo: 'conta' } })
  const b = ((await readBody(event).catch(() => null)) ?? {}) as Record<string, any>
  try {
    const { cpf: _cpf, ...dados } = validarDadosDaConta({ ...b, cpf: conta.cpf })
    const nova = await atualizarContaDoCliente(conta, dados)
    // e-mail trocado volta a "não confirmado": o link vai pro endereço NOVO (035)
    if (nova.email !== conta.email) {
      const envio = mandarConfirmacaoDeEmail(nova, ipDaRequisicao(event))
        .catch((e) => console.warn(`[conta] confirmação de e-mail: ${String(e?.message ?? e).slice(0, 200)}`))
      if (process.env.NODE_ENV !== 'production') await envio
    }
    return { ok: true, conta: contaParaTela(nova) }
  } catch (e) {
    erroDaConta(e)
  }
})
