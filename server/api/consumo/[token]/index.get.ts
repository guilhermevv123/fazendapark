/**
 * GET /api/consumo/<token> — o cupom de consumação do Volte Mais (042), na versão PÚBLICA: o que o
 * cliente vê no celular e o que aparece pra quem abre o QR sem estar logado no painel.
 *
 * Não leva CPF nem o nome inteiro (o link pode ser repassado): só o primeiro nome + inicial, o
 * estado e as horas das baixas. A atendente, logada, lê a versão completa em
 * `/api/admin/consumacao` — é lá que a baixa acontece.
 */
import { cupomDeConsumacaoPeloToken, nomeCurtoDoTitular } from '../../../utils/cupom-consumacao'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  conferirFreio(event, 'pedido_404')
  const token = String(getRouterParam(event, 'token') ?? '')
  const s = await cupomDeConsumacaoPeloToken(token)
  if (!s) {
    marcarNoFreio(event, 'pedido_404')
    throw createError({ statusCode: 404, statusMessage: 'Cupom não encontrado.' })
  }
  return {
    estado: s.estado, recado: s.recado, consumacaoPct: s.consumacaoPct, dia: s.cupom.dia, hoje: s.hoje,
    codigo: s.cupom.codigo, programa: s.programa, evento: s.evento, pedido: s.pedido,
    titular: nomeCurtoDoTitular(s.titular), diaTodo: s.cupom.dia_todo, usosMax: s.cupom.usos_max,
    usos: s.usos.map((u) => ({ em: u.em })), restam: s.restam, entrouHoje: !!s.entradaHoje,
  }
})
