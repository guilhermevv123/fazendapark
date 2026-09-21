/**
 * POST /api/dev/pagar — faz o "PIX cair" na máquina.
 *
 * Só existe quando o gateway simulado está ligado (e ele nunca liga em
 * produção). Chama a MESMA função de emissão que o webhook do Asaas chama —
 * se fosse um atalho próprio, o caminho testado aqui não seria o que roda de
 * verdade, e o teste não valeria nada.
 */
import { q1 } from '../../utils/db'
import { emitirIngressos } from '../../utils/emissao'
import { ligado } from '../../utils/gateway-simulado'

export default defineEventHandler(async (event) => {
  if (!ligado()) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const { pedido } = await readBody<{ pedido?: string }>(event) ?? {}
  if (!pedido) throw createError({ statusCode: 400, statusMessage: 'informe o pedido' })

  const o = await q1<any>(
    `SELECT id, code, status, asaas_payment_id FROM orders
      WHERE id::text = $1 OR upper(code) = upper($1)`, [pedido])
  if (!o) throw createError({ statusCode: 404, statusMessage: 'Pedido não encontrado' })
  if (!String(o.asaas_payment_id ?? '').startsWith('sim_')) {
    // Trava de segurança: nunca "confirmar" um pedido que foi pra um gateway
    // de verdade. Aqui só passa o que este simulador mesmo criou.
    throw createError({ statusCode: 409, statusMessage: 'Este pedido não é do gateway simulado' })
  }

  const r = await emitirIngressos(o.id)
  return { ok: true, pedido: o.code, ...r }
})
