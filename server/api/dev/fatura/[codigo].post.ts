/**
 * POST /api/dev/fatura/:código — o "cartão aprovado" da fatura simulada.
 *
 * Confirma pela MESMA emissão que o webhook do Asaas chama (`emitirIngressos`),
 * como o `/api/dev/pagar`. Só com o gateway simulado ligado; nunca em produção.
 */
import { q1 } from '../../../utils/db'
import { emitirIngressos } from '../../../utils/emissao'
import { ligado } from '../../../utils/gateway-simulado'
import { escaparHtml, paginaDaFatura } from './[codigo].get'

export default defineEventHandler(async (event) => {
  if (!ligado()) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  const codigo = String(getRouterParam(event, 'codigo') ?? '')
  const o = await q1<any>(
    `SELECT id, code, asaas_payment_id FROM orders WHERE upper(code) = upper($1)`, [codigo])
  if (!o || !String(o.asaas_payment_id ?? '').startsWith('sim_')) {
    throw createError({ statusCode: 404, statusMessage: 'Fatura simulada não encontrada' })
  }
  const r = await emitirIngressos(o.id)
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  return paginaDaFatura(r.emitiu
    ? `<h1>Pagamento aprovado</h1><p>Pedido <strong>${escaparHtml(o.code)}</strong> pago. Volte para a
       aba da compra: ela muda sozinha.</p>`
    : `<h1>Pagamento não confirmado</h1><p>${escaparHtml(r.motivo ?? 'o pedido não está em aberto')}</p>`,
  r.emitiu ? 'Pagamento aprovado' : 'Pagamento não confirmado')
})
