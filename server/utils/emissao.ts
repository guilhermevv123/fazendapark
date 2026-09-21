/**
 * emissao.ts — pagamento confirmado vira ingresso.
 *
 * Precisa ser IDEMPOTENTE. O Asaas reenvia webhook: manda PAYMENT_CONFIRMED e
 * depois PAYMENT_RECEIVED pra mesma cobrança, e repete quando não recebe 200.
 * Emitir duas vezes significa duas entradas válidas pro mesmo ingresso pago —
 * o parque deixa entrar gente a mais e só descobre no fim do dia.
 *
 * A proteção é o estado do pedido lido DENTRO da transação com lock: quem
 * chega segundo vê 'pago' e sai sem fazer nada.
 */
import type { PoolClient } from 'pg'
import { confirmar } from './estoque'
import { tx } from './db'
import { gerarCodigo } from './ingresso'

export interface ResultadoEmissao {
  emitiu: boolean
  motivo?: string
  ingressos: number
  pedidoCode?: string
}

/**
 * Caminho de sempre: abre a própria transação. É o que o webhook do Asaas usa.
 */
export async function emitirIngressos(orderId: string): Promise<ResultadoEmissao> {
  return tx((c) => emitirNaTransacao(c, orderId))
}

/**
 * Mesma emissão, dentro de uma transação que já está aberta.
 *
 * Existe pela bilheteria física: lá o dinheiro chega na mão junto com o
 * pedido, então gravar a venda e emitir o ingresso precisam ser o MESMO
 * commit. Separado em dois, uma queda no meio deixa o dinheiro na gaveta e o
 * cliente sem ingresso — e é o operador, com fila na frente, que descobre.
 *
 * Não abrir uma transação nova aqui também é o que evita o travamento óbvio:
 * a linha do pedido já está bloqueada pela transação de fora, e uma segunda
 * conexão pedindo `FOR UPDATE` na mesma linha esperaria pra sempre.
 */
export async function emitirNaTransacao(
  c: PoolClient, orderId: string,
): Promise<ResultadoEmissao> {
  const { rows: pedidos } = await c.query(
    `SELECT o.*, e.name AS evento_nome, e.slug AS evento_slug
       FROM orders o JOIN events e ON e.id = o.event_id
      WHERE o.id = $1
      FOR UPDATE OF o`, [orderId])
  const pedido = pedidos[0]
  if (!pedido) return { emitiu: false, motivo: 'pedido não existe', ingressos: 0 }

  // Porta da idempotência: só emite quem ainda não foi pago.
  if (pedido.status === 'pago') {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM tickets WHERE order_id = $1`, [orderId])
    return { emitiu: false, motivo: 'já emitido', ingressos: rows[0].n, pedidoCode: pedido.code }
  }
  if (!['aguardando_pagamento', 'em_analise', 'rascunho'].includes(pedido.status)) {
    return { emitiu: false, motivo: `pedido em ${pedido.status}`, ingressos: 0 }
  }

  const { rows: itens } = await c.query(
    `SELECT oi.id, oi.lot_id AS "lotId", oi.ticket_type_id AS "ticketTypeId",
            oi.quantity AS quantidade, s.id AS sector_id, s.session_id,
            c2.name AS comprador_nome, c2.email AS comprador_email,
            c2.document AS comprador_doc
       FROM order_items oi
       JOIN lots l  ON l.id = oi.lot_id
       JOIN sectors s ON s.id = l.sector_id
       LEFT JOIN customers c2 ON c2.id = $2
      WHERE oi.order_id = $1`, [orderId, pedido.customer_id])
  if (!itens.length) return { emitiu: false, motivo: 'pedido sem itens', ingressos: 0 }

  // Pedido gratuito nunca reservou via gateway, mas reservou estoque no
  // checkout — então confirma igual.
  await confirmar(c, itens.map((i: any) => ({
    lotId: i.lotId, ticketTypeId: i.ticketTypeId, quantidade: i.quantidade,
  })))

  const prefixo = String(pedido.evento_slug || 'ING').replace(/[^a-zA-Z]/g, '').slice(0, 3) || 'ING'
  let n = 0
  for (const item of itens) {
    for (let k = 0; k < item.quantidade; k++) {
      await c.query(
        `INSERT INTO tickets (org_id, event_id, session_id, order_id, order_item_id,
                              sector_id, lot_id, ticket_type_id, code, qr_secret,
                              status, is_courtesy, holder_name, holder_email, holder_document)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,encode(gen_random_bytes(16),'hex'),
                 'valido',$10,$11,$12,$13)`,
        [pedido.org_id, pedido.event_id, item.session_id, orderId, item.id,
         item.sector_id, item.lotId, item.ticketTypeId,
         gerarCodigo(prefixo), pedido.total_cents === 0,
         // O 1º ingresso fica no nome do comprador; os demais em branco pra
         // ele nomear depois. Nomear todos com o mesmo nome atrapalha a
         // portaria mais do que ajuda.
         k === 0 ? item.comprador_nome : null,
         k === 0 ? item.comprador_email : null,
         k === 0 ? item.comprador_doc : null])
      n++
    }
  }

  await c.query(
    `UPDATE orders SET status = 'pago', paid_at = COALESCE(paid_at, now()) WHERE id = $1`,
    [orderId])
  await c.query(
    `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
     VALUES ($1,'order',$2,'pago',$3::jsonb)`,
    [pedido.org_id, orderId, JSON.stringify({ ingressos: n })])

  return { emitiu: true, ingressos: n, pedidoCode: pedido.code }
}
