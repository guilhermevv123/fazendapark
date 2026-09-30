/**
 * POST /api/reagendamento/:ingresso { loteId, tipoId } — troca o ingresso da conta logada
 * pelo escolhido. O antigo é cancelado e nasce um pedido novo (R$ 0,00) no dia novo; a
 * resposta traz o código dele (`/ingressos/<pedido>`). Regras em `server/utils/reagendamento.ts`.
 */
import { contaDaSessaoDoCliente } from '../../utils/conta-do-cliente'
import { reagendarIngressoDoCliente, RecusaDoReagendamento } from '../../utils/reagendamento'

const UUID = /^[0-9a-f-]{36}$/i

export default defineEventHandler(async (event) => {
  const conta = await contaDaSessaoDoCliente(event)
  if (!conta) {
    throw createError({ statusCode: 401, statusMessage: 'Entre na sua conta para reagendar.', data: { tipo: 'conta' } })
  }
  const corpo = await readBody<any>(event).catch(() => null)
  const loteId = String(corpo?.loteId ?? '')
  const tipoId = String(corpo?.tipoId ?? '')
  if (!UUID.test(loteId) || !UUID.test(tipoId)) {
    throw createError({ statusCode: 422, statusMessage: 'Escolha o dia e o ingresso da troca.' })
  }
  try {
    return await reagendarIngressoDoCliente(conta.id, String(getRouterParam(event, 'ingresso') ?? ''), { loteId, tipoId })
  } catch (e) {
    if (e instanceof RecusaDoReagendamento) throw createError({ statusCode: e.status, statusMessage: e.message })
    // pedido novo repetido pro mesmo ingresso (036, UNIQUE): outra aba confirmou primeiro
    if ((e as any)?.code === '23505') {
      throw createError({ statusCode: 409, statusMessage: 'Este ingresso já foi reagendado. Veja em Meus ingressos.' })
    }
    throw e
  }
})
