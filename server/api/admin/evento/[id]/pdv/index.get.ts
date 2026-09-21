/**
 * GET /api/admin/evento/:id/pdv — os pontos de venda e o estado de cada caixa.
 *
 * É a tela que o produtor abre às 19h pra saber quem está vendendo, com
 * quanto, e qual guichê ainda não fechou. Por isso cada ponto vem com o turno
 * aberto embutido: a pergunta "o caixa 2 está aberto?" não pode custar uma
 * segunda visita à tela.
 */
import { q } from '../../../../../utils/db'
import { PEDIDO_VIVO } from '../../../../../utils/liquido'

/**
 * O QUE PASSOU POR ESTE CAIXA — a mesma conta de `contarTurno`
 * (`utils/caixa.ts`), que é a que o operador confere no fechamento.
 *
 *     SUM(total_cents − refunded_cents) FILTER (pedido vivo)
 *
 * As duas metades importam, e cada uma fechava um buraco diferente:
 *
 * - `PEDIDO_VIVO` no lugar de `status = 'pago'`: o pedido em
 *   `estornado_parcial` — status que o webhook grava num reembolso de parte —
 *   sumia INTEIRO do total do turno nesta tela, enquanto a contagem de
 *   ingressos do mesmo turno continuava contando ele. Guichê com 12 ingressos
 *   e o valor de 11 vendas é diferença de caixa que ninguém consegue explicar.
 *
 * - `− refunded_cents`: o total cheio contava dinheiro que já voltou pra mão
 *   do cliente. A gaveta não tem esse dinheiro, e `contarTurno` — que é quem
 *   fecha o caixa — nunca contou.
 *
 * Com as duas, o cartão do ponto nesta tela e o extrato do caixa dizem o mesmo
 * número. Era o par de telas que mais brigava: as duas abertas lado a lado na
 * noite do evento, com o gerente numa e o operador na outra.
 */
const NO_CAIXA = (a = 'o.') =>
  `COALESCE(SUM(${a}total_cents - ${a}refunded_cents), 0)::bigint`

/**
 * O QUE É VENDA DE BALCÃO — a mesma lista que `extrato.get.ts` usa no quadro
 * por ponto e que o painel usa em `porCanal`. Escrita uma vez aqui pra as três
 * telas não terem cada uma a sua ideia de "balcão".
 */
const CANAIS_DE_BALCAO = `o.channel IN ('bilheteria','pdv_produtor','pdv_ticketeira')`

export default defineEventHandler(async (event) => {
  const eventId = getRouterParam(event, 'id')!

  const pontos = await q<any>(
    `SELECT p.id, p.name, p.location, p.kind, p.payment_methods, p.active, p.created_at,
            t.id                  AS turno_id,
            t.opened_at           AS turno_abriu,
            t.opening_float_cents AS turno_fundo,
            u.name                AS turno_operador,
            COALESCE(v.pedidos, 0)::int     AS turno_pedidos,
            COALESCE(v.total, 0)::bigint    AS turno_total,
            COALESCE(v.estornado, 0)::bigint AS turno_estornado,
            COALESCE(d.pedidos_hoje, 0)::int  AS pedidos_hoje,
            COALESCE(d.total_hoje, 0)::bigint AS total_hoje,
            COALESCE(d.estornado_hoje, 0)::bigint AS estornado_hoje
       FROM pos_terminals p
       LEFT JOIN pos_shifts t ON t.terminal_id = p.id AND t.status = 'aberto'
       LEFT JOIN users u ON u.id = t.operator_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS pedidos, ${NO_CAIXA()} AS total,
                COALESCE(SUM(o.refunded_cents),0)::bigint AS estornado
           FROM orders o WHERE o.pos_shift_id = t.id AND ${PEDIDO_VIVO('o.')}) v ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS pedidos_hoje, ${NO_CAIXA()} AS total_hoje,
                COALESCE(SUM(o.refunded_cents),0)::bigint AS estornado_hoje
           FROM orders o
          WHERE o.pos_terminal_id = p.id AND ${PEDIDO_VIVO('o.')}
            AND o.paid_at >= date_trunc('day', now())) d ON true
      WHERE p.event_id = $1
      ORDER BY p.active DESC, p.name`, [eventId])

  // Turnos fechados recentes: é onde a diferença de caixa aparece, e é o que
  // o gerente confere no dia seguinte.
  const turnos = await q<any>(
    `SELECT t.id, t.status, t.opened_at, t.closed_at,
            t.opening_float_cents, t.closing_counted_cents, t.closing_expected_cents,
            t.note, p.name AS ponto, u.name AS operador, f.name AS fechou_quem,
            COALESCE(v.pedidos, 0)::int  AS pedidos,
            COALESCE(v.total, 0)::bigint AS total,
            COALESCE(v.estornado, 0)::bigint AS estornado
       FROM pos_shifts t
       JOIN pos_terminals p ON p.id = t.terminal_id
       JOIN users u ON u.id = t.operator_id
       LEFT JOIN users f ON f.id = t.closed_by
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS pedidos, ${NO_CAIXA()} AS total,
                COALESCE(SUM(o.refunded_cents),0)::bigint AS estornado
           FROM orders o WHERE o.pos_shift_id = t.id AND ${PEDIDO_VIVO('o.')}) v ON true
      WHERE t.event_id = $1
      ORDER BY t.opened_at DESC
      LIMIT 40`, [eventId])

  // O total do balcão no evento inteiro. `dinheiro` também desconta o que
  // voltou: nota devolvida saiu da gaveta, e é a gaveta que este número
  // descreve.
  //
  // VENDA DE BALCÃO SEM GUICHÊ CADASTRADO CONTA — e aparece com nome próprio.
  //
  // O recorte era `o.pos_terminal_id IS NOT NULL`, que é a mesma armadilha do
  // `JOIN` que come linha sem par, escrita num `WHERE`. Venda de balcão sem
  // ponto registrado existe de montão (importação, seed, venda anterior ao
  // cadastro do guichê): medido no evento semeado, 10 dos 13 pedidos de
  // bilheteria não têm `pos_terminal_id`. O cartão desta tela — rotulado
  // "Vendido na bilheteria" — dizia R$ 470,00 / 3 vendas enquanto o painel
  // (`porCanal`) e o extrato (`porPonto`) diziam R$ 2.202,80 / 13 pelo MESMO
  // evento. Três telas, duas respostas, e a errada era justamente a que leva o
  // nome do balcão.
  //
  // A régua passa a ser a mesma das outras duas: canal de balcão. A união com
  // `pos_terminal_id IS NOT NULL` é cinto e suspensório — assim nenhuma venda
  // cai no vão entre as duas maneiras de marcar que ela foi no guichê.
  //
  // E o órfão não some dentro do total: `semPontoCents` / `pedidosSemPonto`
  // NOMEIAM a diferença, que é a regra da casa pra todo total que o operador
  // não consegue rastrear até um ponto da lista acima. Sem isso a soma dos
  // cartões dos pontos não fecha com o total do evento e ninguém sabe por quê.
  const total = await q<any>(
    `SELECT ${NO_CAIXA()} AS bruto,
            count(*)::int AS pedidos,
            COALESCE(SUM(o.refunded_cents),0)::bigint AS estornado,
            COALESCE(SUM(CASE WHEN o.payment_method = 'dinheiro'
                              THEN o.total_cents - o.refunded_cents END),0)::bigint
              AS dinheiro,
            COALESCE(SUM(o.total_cents - o.refunded_cents)
                      FILTER (WHERE o.pos_terminal_id IS NULL), 0)::bigint AS sem_ponto,
            count(*) FILTER (WHERE o.pos_terminal_id IS NULL)::int AS pedidos_sem_ponto
       FROM orders o
      WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')}
        AND (${CANAIS_DE_BALCAO} OR o.pos_terminal_id IS NOT NULL)`,
    [eventId])

  return {
    pontos: pontos.map((p) => ({
      id: p.id,
      nome: p.name,
      local: p.location,
      tipo: p.kind,
      formas: p.payment_methods,
      ativo: p.active,
      turno: p.turno_id
        ? {
            id: p.turno_id,
            abriuEm: p.turno_abriu,
            fundoCents: Number(p.turno_fundo),
            operador: p.turno_operador,
            pedidos: p.turno_pedidos,
            totalCents: Number(p.turno_total),
            // o que voltou pro cliente neste turno — nomeado em vez de
            // escondido dentro do total, senão vira "o sistema comeu a venda"
            estornadoCents: Number(p.turno_estornado),
          }
        : null,
      hoje: {
        pedidos: p.pedidos_hoje,
        totalCents: Number(p.total_hoje),
        estornadoCents: Number(p.estornado_hoje),
      },
    })),
    turnos: turnos.map((t) => ({
      id: t.id,
      status: t.status,
      ponto: t.ponto,
      operador: t.operador,
      fechouQuem: t.fechou_quem,
      abriuEm: t.opened_at,
      fechouEm: t.closed_at,
      fundoCents: Number(t.opening_float_cents),
      contadoCents: t.closing_counted_cents === null ? null : Number(t.closing_counted_cents),
      esperadoCents: t.closing_expected_cents === null ? null : Number(t.closing_expected_cents),
      // a diferença é calculada na leitura a partir dos dois números
      // congelados — nunca recalculada do zero, senão o fechamento de ontem
      // muda sozinho quando um pedido de ontem for estornado hoje.
      diferencaCents: t.closing_counted_cents === null || t.closing_expected_cents === null
        ? null
        : Number(t.closing_counted_cents) - Number(t.closing_expected_cents),
      pedidos: t.pedidos,
      totalCents: Number(t.total),
      estornadoCents: Number(t.estornado),
      observacao: t.note,
    })),
    resumo: {
      brutoCents: Number(total[0]?.bruto ?? 0),
      pedidos: Number(total[0]?.pedidos ?? 0),
      dinheiroCents: Number(total[0]?.dinheiro ?? 0),
      estornadoCents: Number(total[0]?.estornado ?? 0),
      // a parte do balcão que não dá pra atribuir a nenhum ponto da lista
      // acima — nomeada em vez de descartada, senão o total da tela e a soma
      // dos cartões discordam sem explicação
      semPontoCents: Number(total[0]?.sem_ponto ?? 0),
      pedidosSemPonto: Number(total[0]?.pedidos_sem_ponto ?? 0),
    },
  }
})
