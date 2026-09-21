/**
 * GET /api/admin/evento/:id/dashboard?de=&ate=
 *
 * DECISÃO QUE VALE A PENA LER ANTES DE MEXER: a régua do período.
 *
 * O painel de origem usa DUAS réguas diferentes na mesma plataforma — o
 * dashboard filtra por data de CRIAÇÃO do pedido e soma valor de face; o
 * relatório bancário filtra por data de PAGAMENTO e soma valor cobrado. Os
 * dois números nunca batem, e eles precisaram de uma tela inteira só pra
 * explicar a diferença pro produtor.
 *
 * Aqui é uma régua só: **pedido pago, janelado por `paid_at`**. É o dinheiro
 * que entrou, no dia em que entrou. Quando o financeiro somar o mesmo período,
 * vai dar o mesmo número — e nenhuma tela precisa pedir desculpa.
 *
 * O valor de face aparece ao lado como decomposição (face + taxa = cobrado),
 * nunca como um total concorrente.
 */
import { q, q1 } from '../../../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const { de, ate } = getQuery(event) as { de?: string; ate?: string }

  const ev = await q1<any>(
    `SELECT id, name, status, starts_at, fee_bps FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  // "Todo o período" tem que significar TODO o período. Ancorar o padrão na
  // criação do evento parece razoável e não é: basta um pedido com data
  // anterior (importação, migração, ajuste manual) pra o total da tela ficar
  // menor que a soma da tabela logo abaixo dela, sem nenhum aviso.
  const inicio = de ? new Date(de) : new Date(0)
  const fim = ate ? new Date(`${String(ate).slice(0, 10)}T23:59:59.999`) : new Date()
  const p = [id, inicio, fim]

  const pago = `o.status = 'pago' AND o.paid_at BETWEEN $2 AND $3`

  const [totais, hoje, porDia, funil, porForma, porCanal, porSetor] = await Promise.all([
    q1<any>(
      `SELECT COALESCE(SUM(o.total_cents),0)::bigint  AS cobrado,
              COALESCE(SUM(o.face_cents),0)::bigint   AS face,
              COALESCE(SUM(o.fee_cents),0)::bigint    AS taxa,
              COALESCE(SUM(o.discount_cents),0)::bigint AS desconto,
              COUNT(*)::int                            AS pedidos,
              COALESCE(SUM(oi.n),0)::int               AS ingressos
         FROM orders o
         LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n FROM order_items WHERE order_id = o.id) oi ON true
        WHERE o.event_id = $1 AND ${pago}`, p),

    q1<any>(
      `SELECT COALESCE(SUM(total_cents),0)::bigint AS cobrado
         FROM orders WHERE event_id = $1 AND status = 'pago' AND paid_at >= date_trunc('day', now())`,
      [id]),

    q<any>(
      `SELECT date_trunc('day', o.paid_at)::date AS dia,
              COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
              COALESCE(SUM(oi.n),0)::int AS ingressos
         FROM orders o
         LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n FROM order_items WHERE order_id = o.id) oi ON true
        WHERE o.event_id = $1 AND ${pago}
        GROUP BY 1 ORDER BY 1`, p),

    // Abandono: pedido criado no período que não virou pagamento.
    // Aqui a régua é created_at porque a pergunta é sobre o funil, não sobre
    // caixa — e isso está dito no rótulo da tela.
    q1<any>(
      `SELECT COUNT(*) FILTER (WHERE status = 'pago')::int AS finalizados,
              COUNT(*) FILTER (WHERE status IN ('expirado','cancelado','falhou'))::int AS abandonados,
              COUNT(*) FILTER (WHERE status = 'aguardando_pagamento')::int AS abertos
         FROM orders WHERE event_id = $1 AND created_at BETWEEN $2 AND $3`, p),

    q<any>(
      `SELECT payment_method AS forma, COALESCE(SUM(total_cents),0)::bigint AS cobrado, COUNT(*)::int AS n
         FROM orders o WHERE o.event_id = $1 AND ${pago}
        GROUP BY 1 ORDER BY 2 DESC`, p),

    q<any>(
      `SELECT channel AS canal, COALESCE(SUM(total_cents),0)::bigint AS cobrado, COUNT(*)::int AS n
         FROM orders o WHERE o.event_id = $1 AND ${pago}
        GROUP BY 1 ORDER BY 2 DESC`, p),

    // Duas armadilhas moram nesta consulta.
    //
    // 1) O FILTER não é enfeite: com a condição no ON do LEFT JOIN, o pedido
    //    fora do período vira NULL em `o` mas a linha de `oi` PERMANECE, e a
    //    soma passa a contar item de pedido não pago. Foi assim que esta
    //    coluna já mostrou 34 vendidos "no período" num lote com 25 no total.
    //
    // 2) Quantidade vendida se conta em INGRESSO, não em item de pedido. Um
    //    pedido de 3 cortesias com 1 cancelada continua com quantity = 3 no
    //    item — o ingresso é que morre e o estoque é que volta pra prateleira.
    //    Contar pelo item fazia o painel dizer 48 vendidos num lote com
    //    sold = 47: o cancelado aparecia vendido pra sempre.
    //
    // Por isso a contagem sai dos tickets (mesma unidade que `l.sold` conta) e
    // só o dinheiro sai do item — quem paga é o pedido, quem entra é o ingresso.
    q<any>(
      `SELECT s.name AS setor, l.name AS lote,
              l.quantity::int, l.sold::int, l.reserved::int,
              (SELECT COUNT(*)::int
                 FROM tickets t
                 JOIN orders ot ON ot.id = t.order_id
                WHERE t.lot_id = l.id AND t.status <> 'cancelado'
                  AND ot.status = 'pago'
                  AND ot.paid_at BETWEEN $2 AND $3) AS vendidos_periodo,
              COALESCE(SUM(oi.quantity * oi.unit_total_cents) FILTER (WHERE o.id IS NOT NULL),0)::bigint AS cobrado
         FROM sectors s
         JOIN lots l ON l.sector_id = s.id
         LEFT JOIN order_items oi ON oi.lot_id = l.id
         LEFT JOIN orders o ON o.id = oi.order_id AND o.status = 'pago'
                           AND o.paid_at BETWEEN $2 AND $3
        WHERE s.event_id = $1
        GROUP BY s.id, l.id
        ORDER BY s.sort_order, l.sort_order`, p),
  ])

  // Cortesias: pedido pago com total zero. Conta como ingresso, não como venda.
  const cortesias = await q1<any>(
    `SELECT COALESCE(SUM(oi.n),0)::int AS n
       FROM orders o
       LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n FROM order_items WHERE order_id = o.id) oi ON true
      WHERE o.event_id = $1 AND ${pago} AND o.total_cents = 0`, p)

  const emitidos = Number(totais.ingressos)
  const gratis = Number(cortesias?.n ?? 0)
  const pedidos = Number(totais.pedidos)

  return {
    periodo: { de: inicio.toISOString(), ate: fim.toISOString() },
    regua: 'pedido pago, pela data do pagamento',
    totais: {
      cobradoCents: Number(totais.cobrado),
      faceCents: Number(totais.face),
      taxaCents: Number(totais.taxa),
      descontoCents: Number(totais.desconto),
      hojeCents: Number(hoje?.cobrado ?? 0),
      pedidos,
      ingressos: emitidos,
      pagos: emitidos - gratis,
      cortesias: gratis,
      ticketMedioCents: emitidos ? Math.round(Number(totais.cobrado) / emitidos) : 0,
      ingressosPorPedido: pedidos ? Number((emitidos / pedidos).toFixed(2)) : 0,
    },
    ritmo: porDia.map((d) => ({
      dia: d.dia, cobradoCents: Number(d.cobrado), ingressos: Number(d.ingressos),
    })),
    funil: {
      finalizados: Number(funil?.finalizados ?? 0),
      abandonados: Number(funil?.abandonados ?? 0),
      abertos: Number(funil?.abertos ?? 0),
    },
    porForma: porForma.map((f) => ({ forma: f.forma, cobradoCents: Number(f.cobrado), n: f.n })),
    porCanal: porCanal.map((c) => ({ canal: c.canal, cobradoCents: Number(c.cobrado), n: c.n })),
    porSetor: porSetor.map((s) => ({
      setor: s.setor, lote: s.lote,
      quantidade: s.quantity, vendidos: s.sold, reservados: s.reserved,
      vendidosPeriodo: s.vendidos_periodo, cobradoCents: Number(s.cobrado),
    })),
  }
})
