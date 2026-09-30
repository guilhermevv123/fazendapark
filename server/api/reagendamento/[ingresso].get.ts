/**
 * GET /api/reagendamento/:ingresso — o ingresso da conta logada e os dias/ingressos
 * pra onde ele pode ir. Quando não pode reagendar, vem `motivo` (frase pro cliente)
 * e nenhuma opção. Regras em `server/utils/reagendamento.ts`.
 */
import { contaDaSessaoDoCliente } from '../../utils/conta-do-cliente'
import {
  ingressoDaContaParaReagendar, motivoSemReagendamento, opcoesDeReagendamento,
} from '../../utils/reagendamento'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const conta = await contaDaSessaoDoCliente(event)
  if (!conta) {
    throw createError({ statusCode: 401, statusMessage: 'Entre na sua conta para reagendar.', data: { tipo: 'conta' } })
  }
  const i = await ingressoDaContaParaReagendar(conta.id, String(getRouterParam(event, 'ingresso') ?? ''))
  if (!i) throw createError({ statusCode: 404, statusMessage: 'Ingresso não encontrado na sua conta.' })

  const motivo = motivoSemReagendamento(i)
  return {
    ingresso: {
      id: i.id, codigo: i.codigo, pedido: i.pedido, evento: i.evento, inicio: i.eventoInicio, fuso: i.fuso,
      setor: i.setor, lote: i.lote, tipo: i.tipo, pagoCents: i.pagoCents,
    },
    motivo,
    opcoes: motivo ? [] : await opcoesDeReagendamento(i),
  }
})
