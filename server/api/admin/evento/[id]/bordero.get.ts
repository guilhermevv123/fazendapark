/**
 * GET /api/admin/evento/:id/bordero — o fechamento do evento.
 *
 * Borderô é o documento que o produtor leva pro contador e pro sócio. Ele
 * responde três coisas, e todas as três precisam FECHAR entre si:
 *
 *   1. quantos ingressos saíram, por setor/lote/tipo e por canal
 *   2. quanto cada um faturou, separando face / taxa / desconto
 *   3. quanto sobra pro produtor depois de estorno e taxa
 *
 * A linha que mais dá trabalho é a cortesia: ela ocupa lugar e não fatura. Um
 * borderô que soma cortesia na receita fecha em número bonito e errado; um que
 * esquece de contar a cortesia como ocupação faz o produtor achar que ainda
 * tem 400 lugares que já foram dados.
 *
 * Por isso tudo aqui é contado por `order_items` com o status do pedido junto,
 * e a cortesia aparece na coluna dela — nunca somada na receita.
 */
import { q, q1 } from '../../../../utils/db'
import { SQL_LIBERA_EM } from '../../../../utils/retencao'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const ev = await q1<any>(
    `SELECT id, name, slug, status, starts_at, ends_at, fee_bps,
            fee_mode_online, fee_mode_pos,
            ${SQL_LIBERA_EM()} AS libera_em, (now() >= ${SQL_LIBERA_EM()}) AS liberado
       FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  // ---------------------------------------------------------- por lote ---
  const linhas = await q<any>(
    `SELECT s.name AS setor, s.kind AS setor_tipo, s.sort_order AS ord_setor,
            l.id AS lote_id, l.name AS lote, l.sort_order AS ord_lote,
            l.price_cents, l.quantity,
            COALESCE(SUM(oi.quantity) FILTER (WHERE o.status = 'pago'
                      AND o.channel <> 'cortesia'), 0)::int AS vendidos,
            COALESCE(SUM(oi.quantity) FILTER (WHERE o.status = 'pago'
                      AND o.channel = 'cortesia'), 0)::int  AS cortesias,
            COALESCE(SUM(oi.quantity * oi.unit_face_cents)
                      FILTER (WHERE o.status = 'pago'), 0)::bigint AS face,
            COALESCE(SUM(oi.quantity * oi.unit_fee_cents)
                      FILTER (WHERE o.status = 'pago'), 0)::bigint AS taxa
       FROM lots l
       JOIN sectors s ON s.id = l.sector_id
       LEFT JOIN order_items oi ON oi.lot_id = l.id
       LEFT JOIN orders o ON o.id = oi.order_id
      WHERE s.event_id = $1
      GROUP BY s.id, s.name, s.kind, s.sort_order, l.id, l.name, l.sort_order,
               l.price_cents, l.quantity
      ORDER BY s.sort_order, l.sort_order`, [id])

  // --------------------------------------------------------- por canal ---
  const canais = await q<any>(
    `SELECT o.channel, count(*)::int AS pedidos,
            COALESCE(SUM(oi.quantity), 0)::int AS ingressos,
            COALESCE(SUM(o.face_cents), 0)::bigint AS face,
            COALESCE(SUM(o.fee_cents), 0)::bigint AS taxa,
            COALESCE(SUM(o.discount_cents), 0)::bigint AS desconto
       FROM orders o
       LEFT JOIN (SELECT order_id, SUM(quantity)::int AS quantity
                    FROM order_items GROUP BY order_id) oi ON oi.order_id = o.id
      WHERE o.event_id = $1 AND o.status = 'pago'
      GROUP BY o.channel ORDER BY face DESC`, [id])

  // ------------------------------------------------ forma de pagamento ---
  const formas = await q<any>(
    `SELECT COALESCE(payment_method, 'não informado') AS forma,
            count(*)::int AS pedidos,
            COALESCE(SUM(face_cents + fee_cents - discount_cents), 0)::bigint AS total
       FROM orders WHERE event_id = $1 AND status = 'pago'
      GROUP BY 1 ORDER BY total DESC`, [id])

  // ------------------------------------------------------------ totais ---
  const t = await q1<any>(
    `SELECT ${SQL_LIQUIDO()} AS liquido,
            COALESCE(SUM(face_cents) FILTER (WHERE status = 'pago'), 0)::bigint AS face,
            COALESCE(SUM(fee_cents) FILTER (WHERE status = 'pago'), 0)::bigint AS taxa,
            COALESCE(SUM(platform_cents) FILTER (WHERE status = 'pago'), 0)::bigint AS plataforma,
            COALESCE(SUM(discount_cents) FILTER (WHERE status = 'pago'), 0)::bigint AS desconto,
            COALESCE(SUM(refunded_cents), 0)::bigint AS estornado,
            count(*) FILTER (WHERE status = 'pago')::int AS pedidos,
            count(*) FILTER (WHERE status = 'aguardando_pagamento')::int AS pendentes,
            count(*) FILTER (WHERE status IN ('cancelado','expirado'))::int AS perdidos
       FROM orders WHERE event_id = $1`, [id])

  const emitidos = await q1<any>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE is_courtesy)::int AS cortesias,
            count(*) FILTER (WHERE status = 'usado')::int AS usados,
            count(*) FILTER (WHERE status = 'cancelado')::int AS cancelados
       FROM tickets WHERE event_id = $1`, [id])

  const pago = await q1<any>(
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status = 'concluida'), 0)::bigint AS transferido
       FROM payouts WHERE event_id = $1`, [id])

  const face = Number(t.face)
  const estornado = Number(t.estornado)
  // Líquido NÃO é a face menos o estorno: quando a taxa é absorvida ela sai
  // de dentro da face, e o cupom também. A conta única está em
  // `utils/liquido.ts` e é a mesma que limita o saque em financeiro.post.
  const liquido = Number(t.liquido)

  return {
    evento: {
      id: ev.id, nome: ev.name, slug: ev.slug, status: ev.status,
      inicio: ev.starts_at, fim: ev.ends_at,
      taxaBps: Number(ev.fee_bps),
      liberaEm: ev.libera_em, liberado: ev.liberado,
    },
    totais: {
      faceCents: face,
      taxaCents: Number(t.taxa),
      plataformaCents: Number(t.plataforma),
      descontoCents: Number(t.desconto),
      estornadoCents: estornado,
      liquidoCents: liquido,
      transferidoCents: Number(pago.transferido),
      aReceberCents: liquido - Number(pago.transferido),
      pedidosPagos: t.pedidos,
      pedidosPendentes: t.pendentes,
      pedidosPerdidos: t.perdidos,
      ingressosEmitidos: emitidos.total,
      cortesias: emitidos.cortesias,
      ingressosUsados: emitidos.usados,
      ingressosCancelados: emitidos.cancelados,
      // Comparecimento só faz sentido sobre o que vale: cancelado não ia
      // entrar mesmo, e deixá-lo no denominador faz um evento lotado parecer
      // meio vazio.
      comparecimentoPct: emitidos.total - emitidos.cancelados > 0
        ? Math.round((emitidos.usados / (emitidos.total - emitidos.cancelados)) * 100)
        : 0,
    },
    lotes: linhas.map((l) => ({
      setor: l.setor, setorTipo: l.setor_tipo, lote: l.lote, loteId: l.lote_id,
      faceUnitCents: Number(l.price_cents), estoque: l.quantity,
      vendidos: l.vendidos, cortesias: l.cortesias,
      faceCents: Number(l.face), taxaCents: Number(l.taxa),
    })),
    canais: canais.map((c) => ({
      canal: c.channel, pedidos: c.pedidos, ingressos: c.ingressos,
      faceCents: Number(c.face), taxaCents: Number(c.taxa), descontoCents: Number(c.desconto),
    })),
    formas: formas.map((f) => ({
      forma: f.forma, pedidos: f.pedidos, totalCents: Number(f.total),
    })),
  }
})
