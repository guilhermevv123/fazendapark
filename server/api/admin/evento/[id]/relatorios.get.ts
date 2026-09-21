/**
 * GET /api/admin/evento/:id/relatorios — a visão geral do evento.
 *
 * Diferença pro dashboard: o dashboard responde "como estamos AGORA", este
 * responde "como chegamos até aqui". Por isso tudo aqui é série e proporção —
 * curva por dia, funil, quem trouxe a venda — e não caixa do momento.
 *
 * Duas contas que quase sempre saem erradas e aqui estão explícitas:
 *
 * - **Ticket médio é por PEDIDO, não por ingresso.** Quem compra 6 de uma vez
 *   é um cliente, não seis; dividir pelo ingresso faz o número despencar e
 *   some justamente com a informação de que o comprador leva o grupo.
 *
 * - **Conversão é pedido pago ÷ pedido criado.** Rascunho abandonado conta no
 *   denominador. Tirá-lo daria uma conversão de 100% todo mês, que é o mesmo
 *   que não medir.
 */
import { q, q1 } from '../../../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const ev = await q1<any>(
    `SELECT id, name, starts_at, ends_at, fee_bps, created_at
       FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const [funil, porDia, porDiaSemana, porHoraDoDia, topCompradores,
         porPromoter, porCupom, porParcela, resumo] = await Promise.all([
    // Um bucket por status REAL do banco, em vez de uma lista de FILTER
    // escrita de cabeça. A lista de cabeça envelhece: `aguardando_pagamento`
    // já tinha virado `aguardando` no meu FILTER e a coluna aparecia zerada
    // com dois pedidos esperando PIX na tela ao lado. Agrupando, status novo
    // aparece sozinho e as partes sempre somam o todo.
    q<any>(
      `SELECT status, count(*)::int AS n
         FROM orders WHERE event_id = $1 AND status <> 'rascunho'
        GROUP BY 1 ORDER BY 2 DESC`, [id]),

    // Curva por dia de PAGAMENTO. Usar created_at aqui jogaria a venda no dia
    // em que o PIX foi gerado, não no dia em que o dinheiro entrou.
    q<any>(
      `SELECT date_trunc('day', paid_at) AS dia,
              count(*)::int AS pedidos,
              COALESCE(SUM(total_cents),0)::bigint AS cobrado,
              COALESCE(SUM(face_cents),0)::bigint  AS face
         FROM orders WHERE event_id = $1 AND status = 'pago' AND paid_at IS NOT NULL
        GROUP BY 1 ORDER BY 1`, [id]),

    q<any>(
      `SELECT EXTRACT(DOW FROM paid_at)::int AS dow, count(*)::int AS pedidos,
              COALESCE(SUM(total_cents),0)::bigint AS cobrado
         FROM orders WHERE event_id = $1 AND status = 'pago' AND paid_at IS NOT NULL
        GROUP BY 1 ORDER BY 1`, [id]),

    q<any>(
      `SELECT EXTRACT(HOUR FROM paid_at)::int AS hora, count(*)::int AS pedidos
         FROM orders WHERE event_id = $1 AND status = 'pago' AND paid_at IS NOT NULL
        GROUP BY 1 ORDER BY 1`, [id]),

    // Agrupa por cliente, não por pedido: quem comprou três vezes é UM
    // comprador de peso, e é isso que interessa pra base do próximo evento.
    q<any>(
      `SELECT c.id, c.name, c.email,
              count(*)::int AS pedidos,
              COALESCE(SUM(o.total_cents),0)::bigint AS gasto,
              COALESCE(SUM(oi.n),0)::int AS ingressos
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n FROM order_items WHERE order_id = o.id) oi ON true
        WHERE o.event_id = $1 AND o.status = 'pago'
        GROUP BY c.id, c.name, c.email
        ORDER BY gasto DESC LIMIT 15`, [id]),

    q<any>(
      `SELECT p.id, p.name, p.code, p.commission_bps,
              count(*)::int AS pedidos,
              COALESCE(SUM(o.face_cents),0)::bigint AS face,
              COALESCE(SUM(oi.n),0)::int AS ingressos
         FROM orders o
         JOIN promoters p ON p.id = o.promoter_id
         LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n FROM order_items WHERE order_id = o.id) oi ON true
        WHERE o.event_id = $1 AND o.status = 'pago'
        GROUP BY p.id, p.name, p.code, p.commission_bps
        ORDER BY face DESC`, [id]),

    q<any>(
      `SELECT pc.id, pc.code,
              count(*)::int AS usos,
              COALESCE(SUM(o.discount_cents),0)::bigint AS desconto,
              COALESCE(SUM(o.face_cents),0)::bigint AS face
         FROM orders o
         JOIN promo_codes pc ON pc.id = o.promo_code_id
        WHERE o.event_id = $1 AND o.status = 'pago'
        GROUP BY pc.id, pc.code ORDER BY usos DESC`, [id]),

    q<any>(
      `SELECT installments AS parcelas, count(*)::int AS pedidos,
              COALESCE(SUM(total_cents),0)::bigint AS cobrado
         FROM orders
        WHERE event_id = $1 AND status = 'pago' AND payment_method = 'credito'
        GROUP BY 1 ORDER BY 1`, [id]),

    q1<any>(
      `SELECT COALESCE(SUM(total_cents),0)::bigint AS cobrado,
              COALESCE(SUM(face_cents),0)::bigint  AS face,
              COALESCE(SUM(fee_cents),0)::bigint   AS taxa,
              COALESCE(SUM(discount_cents),0)::bigint AS desconto,
              count(*)::int AS pedidos,
              COALESCE(SUM(oi.n),0)::int AS ingressos,
              MIN(paid_at) AS primeira, MAX(paid_at) AS ultima
         FROM orders o
         LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n FROM order_items WHERE order_id = o.id) oi ON true
        WHERE o.event_id = $1 AND o.status = 'pago'`, [id]),
  ])

  const pedidos = Number(resumo.pedidos)
  const ingressos = Number(resumo.ingressos)

  const porStatus: Record<string, number> = {}
  for (const f of funil) porStatus[f.status] = Number(f.n)
  const criados = Object.values(porStatus).reduce((s, n) => s + n, 0)
  const naoConcluiu = (porStatus.expirado ?? 0) + (porStatus.cancelado ?? 0)
                    + (porStatus.falhou ?? 0)

  // Dias até o evento em que a venda aconteceu — responde "quando a venda
  // realmente acontece", que decide quando abrir o lote e quando anunciar.
  const antecedencia = await q<any>(
    `SELECT GREATEST(0, (DATE($2) - DATE(paid_at)))::int AS dias, count(*)::int AS pedidos
       FROM orders WHERE event_id = $1 AND status = 'pago' AND paid_at IS NOT NULL
      GROUP BY 1 ORDER BY 1`, [id, ev.starts_at])

  return {
    evento: {
      id: ev.id, nome: ev.name, comeca: ev.starts_at, termina: ev.ends_at,
      criadoEm: ev.created_at, taxaBps: ev.fee_bps,
    },
    resumo: {
      pedidos, ingressos,
      cobradoCents: Number(resumo.cobrado),
      faceCents: Number(resumo.face),
      taxaCents: Number(resumo.taxa),
      descontoCents: Number(resumo.desconto),
      ticketMedioCents: pedidos > 0 ? Math.round(Number(resumo.cobrado) / pedidos) : 0,
      porIngressoCents: ingressos > 0 ? Math.round(Number(resumo.cobrado) / ingressos) : 0,
      ingressosPorPedido: pedidos > 0 ? Math.round((ingressos / pedidos) * 100) / 100 : 0,
      primeiraVenda: resumo.primeira, ultimaVenda: resumo.ultima,
    },
    funil: {
      criados,
      porStatus: funil.map((f: any) => ({ status: f.status, n: Number(f.n) })),
      pagos: porStatus.pago ?? 0,
      aguardando: porStatus.aguardando_pagamento ?? 0,
      emAnalise: porStatus.em_analise ?? 0,
      expirados: porStatus.expirado ?? 0,
      cancelados: porStatus.cancelado ?? 0,
      estornados: (porStatus.estornado ?? 0) + (porStatus.estornado_parcial ?? 0),
      conversaoPct: criados > 0 ? Math.round(((porStatus.pago ?? 0) / criados) * 100) : 0,
      abandonoPct: criados > 0 ? Math.round((naoConcluiu / criados) * 100) : 0,
    },
    porDia: porDia.map((d) => ({
      dia: d.dia, pedidos: d.pedidos,
      cobradoCents: Number(d.cobrado), faceCents: Number(d.face),
    })),
    porDiaSemana: porDiaSemana.map((d) => ({
      dow: d.dow, pedidos: d.pedidos, cobradoCents: Number(d.cobrado),
    })),
    porHoraDoDia: porHoraDoDia.map((h) => ({ hora: h.hora, pedidos: h.pedidos })),
    antecedencia: antecedencia.map((a) => ({ dias: a.dias, pedidos: a.pedidos })),
    topCompradores: topCompradores.map((c) => ({
      id: c.id, nome: c.name, email: c.email, pedidos: c.pedidos,
      ingressos: c.ingressos, gastoCents: Number(c.gasto),
    })),
    porPromoter: porPromoter.map((p) => ({
      id: p.id, nome: p.name, codigo: p.code, pedidos: p.pedidos, ingressos: p.ingressos,
      faceCents: Number(p.face),
      // Comissão sobre a FACE — a taxa de serviço não é receita do produtor,
      // então também não é base de comissão de quem divulgou.
      comissaoCents: Math.round((Number(p.face) * Number(p.commission_bps)) / 10_000),
    })),
    porCupom: porCupom.map((c) => ({
      id: c.id, codigo: c.code, usos: c.usos,
      descontoCents: Number(c.desconto), faceCents: Number(c.face),
    })),
    porParcela: porParcela.map((p) => ({
      parcelas: p.parcelas, pedidos: p.pedidos, cobradoCents: Number(p.cobrado),
    })),
  }
})
