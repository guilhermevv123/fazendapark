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
 * Por isso a cortesia tem coluna própria e nunca entra na receita — e as duas
 * perguntas são contadas em unidades diferentes, de propósito:
 *
 *   - **ocupação** (vendidos, cortesias, emitidos) conta INGRESSO não
 *     cancelado, que é quem passa na catraca e ocupa lugar;
 *   - **dinheiro** (face, taxa, desconto, líquido) sai do pedido/item,
 *     recortado por `PEDIDO_VIVO()` — nunca por `status = 'pago'`, que derruba
 *     o pedido com estorno parcial inteiro e faz esta tela discordar do painel
 *     e de relatórios.
 */
import { q, q1 } from '../../../../utils/db'
import { SQL_LIBERA_EM } from '../../../../utils/retencao'
import { PEDIDO_VIVO, SQL_LIQUIDO } from '../../../../utils/liquido'
import { eCortesiaMesmo } from './cortesias.post'

/**
 * O que a CASA chama de cortesia — importado da rota que emite, não reescrito
 * aqui.
 *
 * `is_courtesy` sozinho é marca de "saiu de graça", e `utils/emissao.ts` a
 * carimba em todo ingresso de pedido que fechou em zero: lote gratuito, cupom
 * de 100%. Venda que deu zero é VENDA, aparece em Vendas e em Participantes, e
 * contá-la como cortesia aqui fazia o borderô dizer um número e a tela de
 * Cortesias dizer outro — medido no evento semeado: 3 contra 2.
 *
 * O `status <> 'cancelado'` é a outra metade do mesmo defeito: cortesia
 * cancelada devolve a cota e libera o lugar (é o que a tela de Cortesias
 * conta, é o que a rota de emissão usa pra recusar). Mantê-la no borderô fazia
 * o produtor achar que tinha dado uma entrada que não deu.
 */
const E_CORTESIA = (apelido: string) =>
  `${apelido}.is_courtesy AND ${eCortesiaMesmo(apelido)}`

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const ev = await q1<any>(
    `SELECT id, name, slug, status, starts_at, ends_at, fee_bps,
            fee_mode_online, fee_mode_pos,
            ${SQL_LIBERA_EM()} AS libera_em, (now() >= ${SQL_LIBERA_EM()}) AS liberado
       FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  // ---------------------------------------------------------- por lote ---
  //
  // Duas unidades diferentes na mesma linha, de propósito, e cada uma com a
  // régua da pergunta que responde:
  //
  //   ocupação (vendidos / cortesias) conta INGRESSO não cancelado. É quem
  //   passa na catraca e ocupa lugar. Contar pela quantidade do item do pedido
  //   deixava o ingresso cancelado vendido pra sempre — a mesma armadilha que
  //   o `porSetor` do painel já documenta. As duas colunas PARTICIONAM os
  //   ingressos do lote (cortesia da casa de um lado, todo o resto do outro),
  //   então nenhuma linha some entre elas: venda que fechou em zero é venda e
  //   cai em `vendidos`, com o valor que ela teve — zero.
  //
  //   dinheiro (face / taxa) sai do item do pedido, recortado por
  //   `PEDIDO_VIVO`. Era `status = 'pago'`: o pedido com estorno PARCIAL caía
  //   fora inteiro e a face do lote ficava menor que a do painel e a de
  //   relatórios, que já usam a régua certa.
  const linhas = await q<any>(
    `SELECT s.name AS setor, s.kind AS setor_tipo, s.sort_order AS ord_setor,
            l.id AS lote_id, l.name AS lote, l.sort_order AS ord_lote,
            l.price_cents, l.quantity,
            (SELECT count(*)::int FROM tickets t
              WHERE t.lot_id = l.id AND t.status <> 'cancelado'
                AND NOT (${E_CORTESIA('t')})) AS vendidos,
            (SELECT count(*)::int FROM tickets t
              WHERE t.lot_id = l.id AND t.status <> 'cancelado'
                AND ${E_CORTESIA('t')}) AS cortesias,
            COALESCE(SUM(oi.quantity * oi.unit_face_cents)
                      FILTER (WHERE ${PEDIDO_VIVO('o.')}), 0)::bigint AS face,
            COALESCE(SUM(oi.quantity * oi.unit_fee_cents)
                      FILTER (WHERE ${PEDIDO_VIVO('o.')}), 0)::bigint AS taxa
       FROM lots l
       JOIN sectors s ON s.id = l.sector_id
       LEFT JOIN order_items oi ON oi.lot_id = l.id
       LEFT JOIN orders o ON o.id = oi.order_id
      WHERE s.event_id = $1
      GROUP BY s.id, s.name, s.kind, s.sort_order, l.id, l.name, l.sort_order,
               l.price_cents, l.quantity
      ORDER BY s.sort_order, l.sort_order`, [id])

  // --------------------------------------------------------- por canal ---
  // `PEDIDO_VIVO` pelo mesmo motivo de todo o resto do arquivo: era
  // `status = 'pago'`, e a soma por canal perdia o pedido com estorno parcial
  // enquanto o total lá embaixo (que já usava `SQL_LIQUIDO`) o mantinha. As
  // partes não somavam o todo DENTRO DA MESMA TELA.
  const canais = await q<any>(
    `SELECT o.channel, count(*)::int AS pedidos,
            COALESCE(SUM(oi.quantity), 0)::int AS ingressos,
            COALESCE(SUM(o.face_cents), 0)::bigint AS face,
            COALESCE(SUM(o.fee_cents), 0)::bigint AS taxa,
            COALESCE(SUM(o.discount_cents), 0)::bigint AS desconto
       FROM orders o
       LEFT JOIN (SELECT order_id, SUM(quantity)::int AS quantity
                    FROM order_items GROUP BY order_id) oi ON oi.order_id = o.id
      WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')}
      GROUP BY o.channel ORDER BY face DESC`, [id])

  // ------------------------------------------------ forma de pagamento ---
  // `total_cents` em vez de `face + taxa − desconto`: o banco garante que são
  // o mesmo número (CHECK `total_fecha`), e somar a MESMA coluna que o painel
  // soma em `porForma` é o que impede as duas telas de responderem diferente
  // à mesma pergunta por caminhos "equivalentes".
  const formas = await q<any>(
    `SELECT COALESCE(payment_method, 'não informado') AS forma,
            count(*)::int AS pedidos,
            COALESCE(SUM(total_cents), 0)::bigint AS total
       FROM orders WHERE event_id = $1 AND ${PEDIDO_VIVO()}
      GROUP BY 1 ORDER BY total DESC`, [id])

  // ------------------------------------------------------------ totais ---
  //
  // A RÉGUA DA DEVOLUÇÃO — a mesma escrita no painel, palavra por palavra.
  //
  // A pergunta é "quanto foi devolvido ao comprador neste evento", e a resposta
  // honesta conta TODO `refunded_cents`, em qualquer status: o pedido estornado
  // POR INTEIRO devolveu dinheiro tanto quanto o parcial. Ele só não tem mais
  // líquido a apurar, e é por isso que `PEDIDO_VIVO` o deixa de fora do resto
  // da conta — não porque a devolução dele não existiu.
  //
  // Recortar a devolução pelos vivos era o outro lado da mesma moeda do
  // defeito que este arquivo já carregava: aqui o estornado somava TUDO
  // enquanto face e taxa somavam só `'pago'` (medido: R$ 240,00 de estorno
  // contra R$ 20,00 em relatórios, duas telas, duas respostas). Agora face,
  // taxa, plataforma e desconto recortam por `PEDIDO_VIVO` — o pedido com
  // estorno parcial volta inteiro pra conta — e a devolução aparece em DOIS
  // números com nomes diferentes, porque são duas perguntas:
  //
  //   estornado         — tudo que voltou pro comprador
  //   estornado_liquido — a parte que está descontada do líquido (só vivos).
  //                       É ela que fecha `total − plataforma − devolvido =
  //                       líquido`; usar o total aí faria a tela não bater com
  //                       ela mesma.
  const t = await q1<any>(
    `SELECT ${SQL_LIQUIDO()} AS liquido,
            COALESCE(SUM(face_cents) FILTER (WHERE ${PEDIDO_VIVO()}), 0)::bigint AS face,
            COALESCE(SUM(fee_cents) FILTER (WHERE ${PEDIDO_VIVO()}), 0)::bigint AS taxa,
            COALESCE(SUM(platform_cents) FILTER (WHERE ${PEDIDO_VIVO()}), 0)::bigint AS plataforma,
            COALESCE(SUM(discount_cents) FILTER (WHERE ${PEDIDO_VIVO()}), 0)::bigint AS desconto,
            COALESCE(SUM(refunded_cents), 0)::bigint AS estornado,
            COALESCE(SUM(refunded_cents) FILTER (WHERE ${PEDIDO_VIVO()}), 0)::bigint
              AS estornado_liquido,
            count(*) FILTER (WHERE status = 'pago')::int AS pedidos,
            count(*) FILTER (WHERE status = 'aguardando_pagamento')::int AS pendentes,
            count(*) FILTER (WHERE status IN ('cancelado','expirado'))::int AS perdidos
       FROM orders WHERE event_id = $1`, [id])

  // Cortesia é o que a CASA deu — ver `E_CORTESIA` no topo do arquivo. Dizia 3
  // aqui e 2 na tela de Cortesias no evento semeado: uma cortesia CANCELADA,
  // que já devolveu a cota e não ocupa mais lugar nenhum.
  const emitidos = await q1<any>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE ${E_CORTESIA('t')} AND t.status <> 'cancelado')::int AS cortesias,
            count(*) FILTER (WHERE t.status = 'usado')::int AS usados,
            count(*) FILTER (WHERE t.status = 'cancelado')::int AS cancelados
       FROM tickets t WHERE t.event_id = $1`, [id])

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
      // tudo que voltou pro comprador — inclusive o pedido estornado inteiro
      estornadoCents: estornado,
      // a parte da devolução que já está descontada do líquido
      estornadoNoLiquidoCents: Number(t.estornado_liquido),
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
