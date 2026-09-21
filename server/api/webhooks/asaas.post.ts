/**
 * POST /api/webhooks/asaas — recebe o aviso de pagamento.
 *
 * Três decisões que não são óbvias e já custaram caro no Diamond:
 *
 * 1. **Grava ANTES de agir.** O payload vira linha em payment_events antes de
 *    qualquer efeito. Se a emissão explodir, o evento fica na fila pra
 *    reprocessar em vez de sumir com a venda.
 *
 * 2. **Responde 200 mesmo quando não soube tratar.** Se devolver erro, o Asaas
 *    reenvia — e reenviar um evento que a gente já gravou só empilha trabalho.
 *    Erro de verdade fica registrado na linha, não no status HTTP. A exceção é
 *    falha de infra (banco fora): aí 500 é certo, porque aí queremos a
 *    reentrega.
 *
 * 3. **Autentica por token no header.** Sem isso qualquer um posta
 *    "PAYMENT_RECEIVED" e imprime ingresso de graça.
 */
import { q, q1 } from '../../utils/db'
import { EVENTOS_QUE_IMPORTAM, traduzirStatus } from '../../utils/asaas'
import { emitirIngressos } from '../../utils/emissao'
import { liberar } from '../../utils/estoque'
import { tx } from '../../utils/db'

export default defineEventHandler(async (event) => {
  // ---------------------------------------------------------- autenticação
  const esperado = process.env.ASAAS_WEBHOOK_TOKEN
  if (esperado) {
    const veio = getHeader(event, 'asaas-access-token')
    if (veio !== esperado) {
      // 401 de propósito: token errado não é "evento que não soube tratar",
      // é gente que não devia estar aqui.
      throw createError({ statusCode: 401, statusMessage: 'não autorizado' })
    }
  } else if (process.env.NODE_ENV === 'production') {
    // Falhar alto em produção é melhor que aceitar webhook anônimo em silêncio.
    throw createError({ statusCode: 503, statusMessage: 'webhook sem token configurado' })
  }

  const body = await readBody<any>(event)
  const nomeEvento = String(body?.event || '')
  const pagamento = body?.payment || {}
  const externalId = String(pagamento?.id || '')
  const orderId = pagamento?.externalReference || null

  // ------------------------------------------------- 1. registra o recebido
  const registro = await q1<any>(
    `INSERT INTO payment_events (provider, external_id, event_name, order_id, payload)
     VALUES ('asaas', $1, $2, $3, $4::jsonb) RETURNING id`,
    [externalId || null, nomeEvento || 'desconhecido',
     ehUuid(orderId) ? orderId : null, JSON.stringify(body ?? {})])

  const marcar = (erro?: string) =>
    q(`UPDATE payment_events SET processed_at = now(), error = $2 WHERE id = $1`,
      [registro!.id, erro ?? null])

  try {
    if (!EVENTOS_QUE_IMPORTAM.has(nomeEvento)) {
      await marcar()
      return { ok: true, ignorado: nomeEvento }
    }

    // O externalReference é nosso order.id. Se faltar, cai pro asaas_payment_id.
    const pedido = ehUuid(orderId)
      ? await q1<any>(`SELECT id, status, total_cents FROM orders WHERE id = $1`, [orderId])
      : await q1<any>(`SELECT id, status, total_cents FROM orders WHERE asaas_payment_id = $1`,
          [externalId])

    if (!pedido) {
      await marcar('pedido não encontrado')
      return { ok: true, aviso: 'pedido não encontrado' }
    }

    const novo = traduzirStatus(pagamento?.status)
    if (!novo) {
      // Status que o gateway inventou depois. Fica registrado sem virar efeito.
      await marcar(`status desconhecido: ${pagamento?.status}`)
      return { ok: true, aviso: 'status desconhecido' }
    }

    if (novo === 'pago') {
      const r = await emitirIngressos(pedido.id)
      await marcar(r.emitiu ? null : `não emitiu: ${r.motivo}`)
      return { ok: true, pedido: pedido.id, emitiu: r.emitiu, ingressos: r.ingressos }
    }

    if (novo === 'estornado' || novo === 'cancelado' || novo === 'chargeback') {
      await cancelarPedido(pedido.id, novo,
        Number(pagamento?.value ? Math.round(pagamento.value * 100) : pedido.total_cents))
      await marcar()
      return { ok: true, pedido: pedido.id, status: novo }
    }

    if (novo === 'estornado_parcial') {
      const devolvido = Math.round(Number(pagamento?.refundedValue ?? 0) * 100)
      await q(`UPDATE orders SET status = 'estornado_parcial', refunded_at = now(),
                                 refunded_cents = $2 WHERE id = $1`, [pedido.id, devolvido])
      await marcar()
      return { ok: true, pedido: pedido.id, status: novo }
    }

    // em_analise / aguardando: só anota, não mexe em estoque nem emite
    await q(`UPDATE orders SET status = $2 WHERE id = $1 AND status <> 'pago'`,
      [pedido.id, novo])
    await marcar()
    return { ok: true, pedido: pedido.id, status: novo }
  } catch (e: any) {
    await marcar(e?.message ?? String(e)).catch(() => {})
    // Banco fora → 500 pro Asaas reentregar. Erro de lógica já virou linha.
    if (/ECONNREFUSED|timeout|Connection terminated/i.test(e?.message ?? '')) {
      throw createError({ statusCode: 500, statusMessage: 'indisponível' })
    }
    return { ok: true, erro: 'registrado para reprocessar' }
  }
})

async function cancelarPedido(orderId: string, status: string, valorCents: number) {
  await tx(async (c) => {
    const { rows: atual } = await c.query(
      `SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [orderId])
    if (!atual[0]) return

    const { rows: itens } = await c.query(
      `SELECT lot_id AS "lotId", ticket_type_id AS "ticketTypeId", quantity AS quantidade
         FROM order_items WHERE order_id = $1`, [orderId])

    if (atual[0].status === 'pago') {
      // Já tinha virado venda: desfaz a venda, não a reserva.
      for (const i of itens) {
        await c.query(`UPDATE lots SET sold = GREATEST(sold - $2, 0) WHERE id = $1`,
          [i.lotId, i.quantidade])
      }
      await c.query(
        `UPDATE tickets SET status = 'cancelado', canceled_at = now()
          WHERE order_id = $1 AND status <> 'usado'`, [orderId])
      // Ingresso que JÁ ENTROU não é cancelado: a pessoa usou o parque. Vira
      // prejuízo a cobrar, não estoque de volta — e some do relatório se a
      // gente apagar.
    } else {
      await liberar(c, itens)
    }

    await c.query(
      `UPDATE orders SET status = $2, canceled_at = now(),
              refunded_at = CASE WHEN $2 LIKE 'estornado%' THEN now() ELSE refunded_at END,
              refunded_cents = $3
        WHERE id = $1`, [orderId, status, valorCents])
  })
}

function ehUuid(v: any): boolean {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}
