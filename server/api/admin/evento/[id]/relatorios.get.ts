/**
 * GET /api/admin/evento/:id/relatorios — a visão geral do evento.
 *
 * Diferença pro dashboard: o dashboard responde "como estamos AGORA", este
 * responde "como chegamos até aqui". Por isso tudo aqui é série e proporção —
 * curva por dia, funil, quem trouxe a venda — e não caixa do momento.
 *
 * ## A régua do dinheiro é UMA, e é a de `utils/liquido.ts`
 *
 * Cada consulta desta tela já fez a própria conta, e era por isso que o
 * relatório mostrava um total e o borderô mostrava outro. O padrão do defeito
 * era sempre o mesmo: `WHERE status = 'pago'` numa consulta que SOMA DINHEIRO.
 * O pedido com estorno PARCIAL — que o webhook marca `estornado_parcial`, com
 * o valor devolvido já gravado em `refunded_cents` — caía fora antes de
 * qualquer `FILTER` chegar nele. Uma devolução de R$ 20 apagava um pedido de
 * R$ 850 INTEIRO desta tela, enquanto o borderô continuava mostrando os R$ 830.
 *
 * Daqui pra frente:
 *
 * - **soma de dinheiro recorta por `PEDIDO_VIVO()`**, nunca por `'pago'`;
 * - **"quanto sobra pro produtor" é `SQL_LIQUIDO()`**, a mesma expressão que o
 *   borderô, o financeiro do evento e o financeiro da organização usam. Quatro
 *   telas, uma conta — travado em `relatorios.test.ts`;
 * - **contagem de pedido é outra pergunta** e sai de `FILTER` explícito, com o
 *   nome dizendo qual pergunta responde (`pedidosFechados` × `pedidosComEstorno`).
 *
 * ## Público sai do livro da porta, não do ingresso emitido
 *
 * Quantas pessoas entraram é `entries` (`SQL_PUBLICO`, `sum(people)`), e não
 * ingresso vendido: uma mesa de 4 é um ingresso e quatro pessoas dentro do
 * parque, e ingresso vendido que não apareceu não é público nenhum.
 *
 * ## Duas contas que quase sempre saem erradas e aqui estão explícitas
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
import { PEDIDO_VIVO, SQL_LIQUIDO } from '../../../../utils/liquido'
import { SQL_PUBLICO } from '../../../../utils/catraca'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const ev = await q1<any>(
    `SELECT id, name, starts_at, ends_at, fee_bps, created_at
       FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const [funil, porDia, porDiaSemana, porHoraDoDia, topCompradores,
         porPromoter, porCupom, porParcela, resumo, publico] = await Promise.all([
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
    //
    // `cobrado` é o que o comprador pagou no dia; `liquido` é o que sobra pro
    // produtor depois de taxa e devolução. Os dois precisam vir juntos: só o
    // cobrado esconde a devolução, e só o líquido esconde o movimento.
    q<any>(
      `SELECT date_trunc('day', paid_at) AS dia,
              count(*)::int AS pedidos,
              count(*) FILTER (WHERE status = 'estornado_parcial')::int AS com_estorno,
              COALESCE(SUM(total_cents),0)::bigint AS cobrado,
              COALESCE(SUM(face_cents),0)::bigint  AS face,
              COALESCE(SUM(refunded_cents),0)::bigint AS estornado,
              ${SQL_LIQUIDO()} AS liquido
         FROM orders
        WHERE event_id = $1 AND ${PEDIDO_VIVO()} AND paid_at IS NOT NULL
        GROUP BY 1 ORDER BY 1`, [id]),

    q<any>(
      `SELECT EXTRACT(DOW FROM paid_at)::int AS dow, count(*)::int AS pedidos,
              COALESCE(SUM(total_cents),0)::bigint AS cobrado,
              ${SQL_LIQUIDO()} AS liquido
         FROM orders
        WHERE event_id = $1 AND ${PEDIDO_VIVO()} AND paid_at IS NOT NULL
        GROUP BY 1 ORDER BY 1`, [id]),

    q<any>(
      `SELECT EXTRACT(HOUR FROM paid_at)::int AS hora, count(*)::int AS pedidos
         FROM orders
        WHERE event_id = $1 AND ${PEDIDO_VIVO()} AND paid_at IS NOT NULL
        GROUP BY 1 ORDER BY 1`, [id]),

    // Agrupa por cliente, não por pedido: quem comprou três vezes é UM
    // comprador de peso, e é isso que interessa pra base do próximo evento.
    //
    // `gasto` aqui é o que o COMPRADOR deixou — cobrado menos o que voltou pra
    // ele. Não é o líquido do produtor (esse desconta a taxa da plataforma, que
    // não é problema de quem comprou) e por isso não usa `SQL_LIQUIDO`: são
    // perguntas diferentes, e misturá-las é o que faz duas telas discordarem.
    //
    // O ingresso desta lista sai de `tickets`, e não da quantidade do item do
    // pedido, pelo mesmo motivo escrito em `publico.get.ts` e no `porSetor` do
    // painel: cortesia cancelada deixa o item lá com a quantidade cheia, e o
    // que morre é o ingresso. A aba Público mostra ESTA MESMA lista contando
    // por `tickets` — as duas dizendo números diferentes pra mesma pessoa é o
    // defeito que este arquivo existe pra fechar. O total do evento lá em
    // `resumo.ingressos` continua saindo do item, junto com o do painel.
    q<any>(
      `SELECT c.id, c.name, c.email,
              count(*)::int AS pedidos,
              COALESCE(SUM(o.total_cents - o.refunded_cents),0)::bigint AS gasto,
              COALESCE(SUM(o.refunded_cents),0)::bigint AS devolvido,
              COALESCE(SUM(tk.n),0)::int AS ingressos
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM tickets t
                             WHERE t.order_id = o.id AND t.status <> 'cancelado') tk ON true
        WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')}
        GROUP BY c.id, c.name, c.email
        ORDER BY gasto DESC LIMIT 15`, [id]),

    q<any>(
      `SELECT p.id, p.name, p.code, p.commission_bps,
              count(*)::int AS pedidos,
              COALESCE(SUM(o.face_cents),0)::bigint AS face,
              COALESCE(SUM(o.refunded_cents),0)::bigint AS estornado,
              ${SQL_LIQUIDO('o.')} AS liquido,
              COALESCE(SUM(oi.n),0)::int AS ingressos
         FROM orders o
         JOIN promoters p ON p.id = o.promoter_id
         LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n FROM order_items WHERE order_id = o.id) oi ON true
        WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')}
        GROUP BY p.id, p.name, p.code, p.commission_bps
        ORDER BY face DESC`, [id]),

    q<any>(
      `SELECT pc.id, pc.code,
              count(*)::int AS usos,
              count(*) FILTER (WHERE o.status = 'pago')::int AS usos_sem_estorno,
              COALESCE(SUM(o.discount_cents),0)::bigint AS desconto,
              COALESCE(SUM(o.face_cents),0)::bigint AS face,
              ${SQL_LIQUIDO('o.')} AS liquido
         FROM orders o
         JOIN promo_codes pc ON pc.id = o.promo_code_id
        WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')}
        GROUP BY pc.id, pc.code ORDER BY usos DESC`, [id]),

    q<any>(
      `SELECT installments AS parcelas, count(*)::int AS pedidos,
              COALESCE(SUM(total_cents),0)::bigint AS cobrado,
              ${SQL_LIQUIDO()} AS liquido
         FROM orders
        WHERE event_id = $1 AND ${PEDIDO_VIVO()} AND payment_method = 'credito'
        GROUP BY 1 ORDER BY 1`, [id]),

    // O total desta tela. `liquido` sai da MESMA expressão do borderô e dos
    // dois financeiros — é o número que `relatorios.test.ts` exige idêntico
    // nas quatro rotas.
    q1<any>(
      `SELECT COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
              COALESCE(SUM(o.face_cents),0)::bigint  AS face,
              COALESCE(SUM(o.fee_cents),0)::bigint   AS taxa,
              COALESCE(SUM(o.discount_cents),0)::bigint AS desconto,
              COALESCE(SUM(o.refunded_cents),0)::bigint AS estornado,
              ${SQL_LIQUIDO('o.')} AS liquido,
              count(*)::int AS pedidos,
              count(*) FILTER (WHERE o.status = 'pago')::int AS fechados,
              count(*) FILTER (WHERE o.status = 'estornado_parcial')::int AS com_estorno,
              COALESCE(SUM(oi.n),0)::int AS ingressos,
              MIN(o.paid_at) AS primeira, MAX(o.paid_at) AS ultima
         FROM orders o
         LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n FROM order_items WHERE order_id = o.id) oi ON true
        WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')}`, [id]),

    // Quanta gente ENTROU. Sai de `entries` (`sum(people)`), a mesma expressão
    // que a portaria usa — não de ingresso emitido, que conta papel e não
    // pessoa: uma mesa de 4 é um ingresso e quatro pessoas dentro do parque.
    q1<any>(SQL_PUBLICO, [id]),
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
       FROM orders
      WHERE event_id = $1 AND ${PEDIDO_VIVO()} AND paid_at IS NOT NULL
      GROUP BY 1 ORDER BY 1`, [id, ev.starts_at])

  return {
    evento: {
      id: ev.id, nome: ev.name, comeca: ev.starts_at, termina: ev.ends_at,
      criadoEm: ev.created_at, taxaBps: ev.fee_bps,
    },
    resumo: {
      // `pedidos` é a população que as somas abaixo usam: pedido que virou
      // dinheiro, inclusive o que devolveu uma parte. Quem quer só os
      // fechados sem devolução tem `pedidosFechados` ao lado — o ticket médio
      // divide pela MESMA população que somou, senão a média infla sozinha.
      pedidos, ingressos,
      pedidosFechados: Number(resumo.fechados),
      pedidosComEstorno: Number(resumo.com_estorno),
      cobradoCents: Number(resumo.cobrado),
      faceCents: Number(resumo.face),
      taxaCents: Number(resumo.taxa),
      descontoCents: Number(resumo.desconto),
      estornadoCents: Number(resumo.estornado),
      // o mesmo número do borderô e dos dois financeiros
      liquidoCents: Number(resumo.liquido),
      ticketMedioCents: pedidos > 0 ? Math.round(Number(resumo.cobrado) / pedidos) : 0,
      porIngressoCents: ingressos > 0 ? Math.round(Number(resumo.cobrado) / ingressos) : 0,
      ingressosPorPedido: pedidos > 0 ? Math.round((ingressos / pedidos) * 100) / 100 : 0,
      primeiraVenda: resumo.primeira, ultimaVenda: resumo.ultima,
    },
    // quem passou pela catraca — pessoa, não ingresso
    publico: {
      pessoas: Number(publico?.pessoas ?? 0),
      passagens: Number(publico?.entradas ?? 0),
      ingressosComEntrada: Number(publico?.ingressos ?? 0),
      passagensOffline: Number(publico?.offline ?? 0),
      ultimaEm: publico?.ultima ?? null,
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
      dia: d.dia, pedidos: d.pedidos, pedidosComEstorno: d.com_estorno,
      cobradoCents: Number(d.cobrado), faceCents: Number(d.face),
      estornadoCents: Number(d.estornado), liquidoCents: Number(d.liquido),
    })),
    porDiaSemana: porDiaSemana.map((d) => ({
      dow: d.dow, pedidos: d.pedidos,
      cobradoCents: Number(d.cobrado), liquidoCents: Number(d.liquido),
    })),
    porHoraDoDia: porHoraDoDia.map((h) => ({ hora: h.hora, pedidos: h.pedidos })),
    antecedencia: antecedencia.map((a) => ({ dias: a.dias, pedidos: a.pedidos })),
    topCompradores: topCompradores.map((c) => ({
      id: c.id, nome: c.name, email: c.email, pedidos: c.pedidos,
      ingressos: c.ingressos,
      gastoCents: Number(c.gasto), devolvidoCents: Number(c.devolvido),
    })),
    porPromoter: porPromoter.map((p) => ({
      id: p.id, nome: p.name, codigo: p.code, pedidos: p.pedidos, ingressos: p.ingressos,
      faceCents: Number(p.face),
      estornadoCents: Number(p.estornado),
      liquidoCents: Number(p.liquido),
      // Comissão sobre a FACE — a taxa de serviço não é receita do produtor,
      // então também não é base de comissão de quem divulgou.
      //
      // A face aqui é a do pedido VIVO: o estorno total já ficou de fora, mas
      // o estorno PARCIAL continua com a face cheia na base. Mudar isso muda
      // quanto o promoter recebe, e essa é decisão do dono, não deste arquivo
      // — por isso o valor devolvido vai ao lado, em `estornadoCents`, pra a
      // diferença estar na tela em vez de escondida na conta.
      comissaoCents: Math.round((Number(p.face) * Number(p.commission_bps)) / 10_000),
    })),
    porCupom: porCupom.map((c) => ({
      id: c.id, codigo: c.code, usos: c.usos, usosSemEstorno: c.usos_sem_estorno,
      descontoCents: Number(c.desconto), faceCents: Number(c.face),
      liquidoCents: Number(c.liquido),
    })),
    porParcela: porParcela.map((p) => ({
      parcelas: p.parcelas, pedidos: p.pedidos,
      cobradoCents: Number(p.cobrado), liquidoCents: Number(p.liquido),
    })),
  }
})
