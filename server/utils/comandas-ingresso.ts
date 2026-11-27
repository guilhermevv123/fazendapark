/**
 * O ingresso da bilheteria visto pela comanda (055): quem comprou, quem usa, se já tem conta
 * e se deve alguma. Só LÊ tickets/orders/customers.
 */
import { recusa, reaisTexto, SQL_TOTAL, SQL_PAGO } from './comandas'
import { q, q1 } from './db'
import { lerQr } from './ingresso'

export async function acharIngresso(orgId: string, corpo: { qr?: string; codigo?: string } | null) {
  let codigo = String(corpo?.codigo ?? '').trim().toUpperCase()
  if (corpo?.qr) {
    const lido = lerQr(String(corpo.qr))
    // QR de chave aposentada ainda traz o código; quem confere é o banco (ingresso existe e é deste parque)
    if (!lido.code) recusa('Este QR não é de um ingresso do parque.', 'qr_invalido')
    codigo = lido.code!.toUpperCase()
  }
  if (!codigo) recusa('Leia o QR do ingresso ou digite o código dele.', 'sem_codigo')

  const t = await q1<any>(
    `SELECT t.id, t.code, t.status, t.holder_name, t.order_id, t.event_id, e.name AS evento,
            o.status AS pedido_status, o.code AS pedido_codigo, o.customer_id,
            cu.name AS comprador, cu.phone AS telefone, cu.email, cu.document,
            (SELECT COUNT(*) FROM tickets t2 WHERE t2.order_id = t.order_id) AS no_pedido,
            (SELECT COUNT(*) FROM tickets t2 WHERE t2.order_id = t.order_id
               AND (t2.issued_at, t2.id) < (t.issued_at, t.id)) + 1 AS posicao
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       LEFT JOIN orders o ON o.id = t.order_id
       LEFT JOIN customers cu ON cu.id = o.customer_id
      WHERE t.org_id = $1 AND upper(t.code) = $2`, [orgId, codigo])
  if (!t) recusa('Ingresso não encontrado neste parque. Confira o código.', 'ingresso_nao_encontrado')
  if (t.status === 'cancelado' || t.status === 'transferido') {
    recusa(`Este ingresso está ${t.status}. Peça outro documento ou abra a conta à mão.`, 'ingresso_invalido')
  }
  if (t.order_id && !['pago', 'estornado_parcial'].includes(t.pedido_status)) {
    recusa('O pedido deste ingresso não está pago. Abra a conta à mão, com o código no WhatsApp.', 'pedido_nao_pago')
  }
  if (!t.comprador) {
    recusa('Este ingresso não tem comprador cadastrado (cortesia ou balcão). Abra a conta à mão.', 'sem_comprador')
  }

  const aberta = await q1<any>(
    `SELECT c.id, c.numero, c.nome FROM comandas c WHERE c.org_id = $1 AND c.ticket_id = $2 AND c.situacao = 'aberta'`,
    [orgId, t.id])

  // conta antiga não paga de quem comprou (pelo cliente, ou pelo mesmo telefone)
  const dividas = await q<any>(
    `SELECT c.numero, c.nome, c.aberta_em, ${SQL_TOTAL} - ${SQL_PAGO} AS falta
       FROM comandas c
      WHERE c.org_id = $1 AND c.situacao IN ('nao_paga', 'cobrada')
        AND ((c.customer_id IS NOT NULL AND c.customer_id = $2) OR (c.responsavel_telefone IS NOT NULL AND c.responsavel_telefone = $3))`,
    [orgId, t.customer_id, String(t.telefone ?? '').replace(/\D/g, '') || null])
  const dividaCents = dividas.reduce((s, d) => s + Math.max(Number(d.falta), 0), 0)

  const primeiroNome = String(t.comprador).trim().split(/\s+/)[0]
  const titular = Number(t.posicao) === 1
  return {
    ingresso: { id: t.id, codigo: t.code, evento: t.evento, status: t.status, posicao: Number(t.posicao), noPedido: Number(t.no_pedido) },
    pedidoCodigo: t.pedido_codigo,
    orderId: t.order_id as string | null,
    customerId: t.customer_id as string | null,
    responsavel: { nome: t.comprador, telefone: t.telefone, email: t.email, documento: t.document },
    nomeSugerido: t.holder_name || (titular ? t.comprador : `Acompanhante ${t.posicao} de ${primeiroNome}`),
    titular,
    jaTemConta: aberta ? { id: aberta.id, numero: Number(aberta.numero), nome: aberta.nome } : null,
    divida: dividaCents > 0 ? { totalCents: dividaCents, texto: `Tem conta não paga de ${reaisTexto(dividaCents)}`, contas: dividas.length } : null,
  }
}
