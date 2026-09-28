/**
 * POST /api/pedido/:id/desistir — o comprador larga o pedido que ainda não pagou.
 *
 * B13: a tela de pagamento prendia o comprador no pedido antigo. Gerou o PIX,
 * voltou, mudou a quantidade — e a tela reabria o pedido velho; queria pagar
 * com cartão — não havia como. O pedido pendurado ainda segurava o lugar e
 * contava no teto do CPF até vencer. Agora a tela oferece "desistir deste
 * pedido", e é esta rota: devolve o lugar na hora (`desistirDoPedido`) e a
 * varredura de minuto em minuto cancela a cobrança no gateway.
 *
 * Só pelo UUID do pedido — o que a aba que criou a compra tem. O código
 * PED-XXXX-XXXX é mostrado ao comprador (e-mail, página do ingresso) e não
 * serve pra cancelar a compra de ninguém.
 */
import { tx } from '../../../utils/db'
import { desistirDoPedido } from '../../../utils/estoque'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const RECADO: Record<string, string> = {
  pago: 'Este pedido já foi pago — os ingressos estão na página do pedido.',
  em_analise: 'O pagamento deste pedido está em análise pelo cartão. Espere a resposta antes de comprar de novo.',
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? ''
  if (!UUID.test(id)) throw createError({ statusCode: 404, statusMessage: 'Pedido não encontrado' })

  const r = await tx((c) => desistirDoPedido(c, id))
  if (r.ok) return { ok: true, status: 'expirado' }
  if (r.status == null) throw createError({ statusCode: 404, statusMessage: 'Pedido não encontrado' })
  // Já não estava pendente: expirou, falhou ou foi desistido antes — nada a
  // desfazer, e a tela segue pro carrinho novo do mesmo jeito.
  if (['expirado', 'falhou', 'cancelado'].includes(r.status)) return { ok: true, status: r.status }
  throw createError({ statusCode: 409,
    statusMessage: RECADO[r.status] ?? 'Este pedido não está mais aguardando pagamento.',
    data: { status: r.status } })
})
