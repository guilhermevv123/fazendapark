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
 * Aqui é uma régua só: **pedido que virou dinheiro, janelado por `paid_at`**.
 * É o dinheiro que entrou, no dia em que entrou. Quando o financeiro somar o
 * mesmo período, vai dar o mesmo número — e nenhuma tela precisa pedir
 * desculpa.
 *
 * "Pedido que virou dinheiro" é `PEDIDO_VIVO()`, de `utils/liquido.ts`, e não
 * `status = 'pago'`. A diferença entre os dois é o pedido com estorno PARCIAL:
 * com o recorte antigo, uma devolução de R$ 20 tirava um pedido de R$ 850
 * INTEIRO deste painel — e o borderô, que já usa a régua certa, continuava
 * mostrando os R$ 830. Dois números da mesma venda em duas telas é chamado
 * aberto no dia seguinte.
 *
 * O valor de face aparece ao lado como decomposição (face + taxa = cobrado),
 * nunca como um total concorrente. O líquido — o que sobra pro produtor — sai
 * da mesma `SQL_LIQUIDO()` que o borderô e os dois financeiros usam.
 *
 * Quanta gente está dentro sai de `entries` (`SQL_PUBLICO`, `sum(people)`), e
 * não de ingresso emitido: uma mesa de 4 é um ingresso e quatro pessoas.
 */
import { q, q1 } from '../../../../utils/db'
import { PEDIDO_VIVO, SQL_LIQUIDO } from '../../../../utils/liquido'
import { SQL_PUBLICO } from '../../../../utils/catraca'

/**
 * `de` e `ate` chegam como DIA (`2026-09-21`), e dia é coisa de calendário
 * local — não de UTC.
 *
 * `new Date('2026-09-21')` é MEIA-NOITE UTC, ou seja 21h do dia ANTERIOR na
 * Bahia. O botão "Hoje" mandava a data certa e a rota abria a janela três
 * horas cedo demais: medido no evento semeado às 02h47 de 21/09, o painel
 * dizia R$ 11.228,00 de "hoje" contra R$ 6.732,00 de verdade — 64 pedidos da
 * noite de ontem (21h–24h) entravam no dia de hoje, e a própria curva do
 * painel mostrava DOIS dias dentro de um filtro de um dia só.
 *
 * O fim do período já era lido em hora local (`...T23:59:59.999`, sem `Z`).
 * Era só o começo que falava UTC — e janela com as duas pontas em fusos
 * diferentes não erra por igual: ela cresce.
 *
 * Data impossível (`?de=ontem`) vira `null` e a rota cai no padrão, em vez de
 * mandar `Invalid Date` pro banco e devolver erro 500 pra quem só digitou
 * errado na URL.
 */
function diaLocal(texto: string, horas: string): Date | null {
  const dia = String(texto).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return null
  const d = new Date(`${dia}T${horas}`)
  return Number.isNaN(d.getTime()) ? null : d
}
const inicioDoDiaLocal = (texto: string) => diaLocal(texto, '00:00:00.000')
const fimDoDiaLocal = (texto: string) => diaLocal(texto, '23:59:59.999')

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
  const inicio = de ? inicioDoDiaLocal(de) ?? new Date(0) : new Date(0)
  const fim = ate ? fimDoDiaLocal(ate) ?? new Date() : new Date()
  const p = [id, inicio, fim]

  // A régua do período, uma vez só. `PEDIDO_VIVO` no lugar de `status =
  // 'pago'`: o pedido com estorno parcial continua sendo dinheiro que entrou,
  // e o que voltou já está em `refunded_cents` — quem desconta é a conta do
  // líquido, não um recorte que apaga o pedido inteiro.
  const vivoNoPeriodo = `${PEDIDO_VIVO('o.')} AND o.paid_at BETWEEN $2 AND $3`

  const [totais, hoje, porDia, funil, porForma, porCanal, porSetor, publico] = await Promise.all([
    q1<any>(
      `SELECT COALESCE(SUM(o.total_cents),0)::bigint  AS cobrado,
              COALESCE(SUM(o.face_cents),0)::bigint   AS face,
              COALESCE(SUM(o.fee_cents),0)::bigint    AS taxa,
              COALESCE(SUM(o.discount_cents),0)::bigint AS desconto,
              COALESCE(SUM(o.refunded_cents),0)::bigint AS estornado,
              ${SQL_LIQUIDO('o.')}                     AS liquido,
              COUNT(*)::int                            AS pedidos,
              COUNT(*) FILTER (WHERE o.status = 'pago')::int AS fechados,
              COUNT(*) FILTER (WHERE o.status = 'estornado_parcial')::int AS com_estorno,
              COALESCE(SUM(oi.n),0)::int               AS ingressos
         FROM orders o
         LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n FROM order_items WHERE order_id = o.id) oi ON true
        WHERE o.event_id = $1 AND ${vivoNoPeriodo}`, p),

    q1<any>(
      `SELECT COALESCE(SUM(total_cents),0)::bigint AS cobrado,
              ${SQL_LIQUIDO()} AS liquido
         FROM orders
        WHERE event_id = $1 AND ${PEDIDO_VIVO()} AND paid_at >= date_trunc('day', now())`,
      [id]),

    q<any>(
      `SELECT date_trunc('day', o.paid_at)::date AS dia,
              COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
              ${SQL_LIQUIDO('o.')} AS liquido,
              COALESCE(SUM(oi.n),0)::int AS ingressos
         FROM orders o
         LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n FROM order_items WHERE order_id = o.id) oi ON true
        WHERE o.event_id = $1 AND ${vivoNoPeriodo}
        GROUP BY 1 ORDER BY 1`, p),

    // Abandono: pedido criado no período que não virou pagamento.
    // Aqui a régua é created_at porque a pergunta é sobre o funil, não sobre
    // caixa — e isso está dito no rótulo da tela.
    //
    // `finalizados` conta o pedido com estorno parcial junto: ele FINALIZOU,
    // o comprador levou o ingresso e parte do dinheiro voltou depois. Deixá-lo
    // fora fazia as partes do funil não somarem o total criado, e o pedido
    // sumia das três colunas sem aparecer em nenhuma.
    //
    // O MESMO BURACO ESTAVA ABERTO PRO ESTORNO TOTAL — e pra mais quatro.
    //
    // As três colunas cobriam `pago`/`estornado_parcial`, `expirado`/
    // `cancelado`/`falhou` e `aguardando_pagamento`. O `CHECK` da tabela
    // permite ONZE status: `estornado`, `em_analise`, `rascunho`, `chargeback`
    // e `disputa` não caíam em nenhuma, e a rosca da tela divide por
    // `finalizados + abandonados + abertos`. Medido numa fixture de 6 pedidos
    // com 1 estornado por inteiro: a rosca somava 5 e `/relatorios` dizia 6
    // criados. Duas telas, dois números, e as porcentagens da rosca calculadas
    // sobre uma população que não é a do evento.
    //
    // Agora vem `criados` (o total de verdade) e cada status tem balde. O que
    // sobrar cai em `outros`, que é o balde que NÃO PODE ser esquecido quando
    // alguém acrescentar um status novo ao `CHECK`: a soma das partes volta a
    // fechar sozinha em vez de o pedido sumir em silêncio.
    q1<any>(
      `SELECT COUNT(*)::int AS criados,
              COUNT(*) FILTER (WHERE ${PEDIDO_VIVO()})::int AS finalizados,
              COUNT(*) FILTER (WHERE status = 'estornado_parcial')::int AS com_estorno,
              COUNT(*) FILTER (WHERE status = 'estornado')::int AS devolvidos,
              COUNT(*) FILTER (WHERE status IN ('expirado','cancelado','falhou'))::int AS abandonados,
              COUNT(*) FILTER (WHERE status IN ('aguardando_pagamento','em_analise','rascunho'))::int
                AS abertos,
              COUNT(*) FILTER (WHERE status IN ('chargeback','disputa'))::int AS contestados
         FROM orders WHERE event_id = $1 AND created_at BETWEEN $2 AND $3`, p),

    q<any>(
      `SELECT o.payment_method AS forma,
              COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
              ${SQL_LIQUIDO('o.')} AS liquido,
              COUNT(*)::int AS n
         FROM orders o WHERE o.event_id = $1 AND ${vivoNoPeriodo}
        GROUP BY 1 ORDER BY 2 DESC`, p),

    q<any>(
      `SELECT o.channel AS canal,
              COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
              ${SQL_LIQUIDO('o.')} AS liquido,
              COUNT(*)::int AS n
         FROM orders o WHERE o.event_id = $1 AND ${vivoNoPeriodo}
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
                  AND ${PEDIDO_VIVO('ot.')}
                  AND ot.paid_at BETWEEN $2 AND $3) AS vendidos_periodo,
              COALESCE(SUM(oi.quantity * oi.unit_total_cents) FILTER (WHERE o.id IS NOT NULL),0)::bigint AS cobrado
         FROM sectors s
         JOIN lots l ON l.sector_id = s.id
         LEFT JOIN order_items oi ON oi.lot_id = l.id
         LEFT JOIN orders o ON o.id = oi.order_id AND ${PEDIDO_VIVO('o.')}
                           AND o.paid_at BETWEEN $2 AND $3
        WHERE s.event_id = $1
        GROUP BY s.id, l.id
        ORDER BY s.sort_order, l.sort_order`, p),

    // Quanta gente está dentro — pessoa, não leitura e não ingresso emitido.
    // Mesma expressão que a portaria usa (`utils/catraca.ts`), pra o painel e
    // o portão não contarem público de jeitos diferentes.
    q1<any>(SQL_PUBLICO, [id]),
  ])

  // Cortesia é o que a CASA deu — o pedido que nasceu na rota de cortesia
  // (`channel = 'cortesia'`), a mesma régua da tela de Cortesias e do borderô.
  //
  // Era `total_cents = 0`, e isso põe VENDA GRATUITA na coluna de cortesia:
  // lote de R$ 0, cupom de 100%. Venda que fechou em zero é venda — aparece em
  // Vendas e em Participantes, e contá-la aqui inflava a cortesia do painel
  // contra a tela que existe pra controlar cortesia. Duas telas, dois números,
  // mesma pergunta.
  //
  // A unidade é a mesma do `ingressos` logo acima (item do pedido), porque
  // este número é a decomposição DELE: emitidos = pagos + cortesias. Misturar
  // ingresso e item aqui faria a soma não fechar com o próprio KPI ao lado.
  const cortesias = await q1<any>(
    `SELECT COALESCE(SUM(oi.n),0)::int AS n
       FROM orders o
       LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n FROM order_items WHERE order_id = o.id) oi ON true
      WHERE o.event_id = $1 AND ${vivoNoPeriodo} AND o.channel = 'cortesia'`, p)

  // A RÉGUA DA DEVOLUÇÃO — a mesma do borderô, escrita igual nos dois lugares.
  //
  // "Quanto foi devolvido ao comprador" é TODO `refunded_cents`, em qualquer
  // status. O pedido estornado POR INTEIRO é devolução tanto quanto o parcial;
  // ele só não tem mais líquido a apurar, e por isso cai fora de `PEDIDO_VIVO`.
  // Recortar a devolução pelos vivos escondia o estorno total de todas as
  // telas: medido, R$ 20,00 apareciam de devolução num evento que devolveu
  // R$ 240,00.
  //
  // Por isso são DOIS números com nomes diferentes, e nenhum deles some:
  //
  //   estornadoCents          — tudo que voltou pro comprador (qualquer status)
  //   estornadoNoLiquidoCents — a parte que está descontada do líquido, que é
  //                             só a dos pedidos vivos. É ela que fecha
  //                             `cobrado − plataforma − devolvido = líquido`;
  //                             usar o total aí faria a conta da tela não bater
  //                             com ela mesma.
  const devolvido = await q1<any>(
    `SELECT COALESCE(SUM(refunded_cents),0)::bigint AS total
       FROM orders
      WHERE event_id = $1 AND paid_at BETWEEN $2 AND $3`, p)

  const emitidos = Number(totais.ingressos)
  const gratis = Number(cortesias?.n ?? 0)
  const pedidos = Number(totais.pedidos)

  /**
   * O FUNIL FECHA POR CONSTRUÇÃO.
   *
   * `outros` é o resto da subtração, não mais um `FILTER`: status que ninguém
   * previu entra aqui em vez de evaporar. As cinco partes somam `criados`
   * SEMPRE, e é isso que a rosca da tela divide — a versão anterior dividia
   * por `finalizados + abandonados + abertos` e desenhava porcentagens de uma
   * população menor que a do evento toda vez que um pedido era estornado por
   * inteiro.
   */
  const baldes = {
    finalizados: Number(funil?.finalizados ?? 0),
    devolvidos: Number(funil?.devolvidos ?? 0),
    abandonados: Number(funil?.abandonados ?? 0),
    abertos: Number(funil?.abertos ?? 0),
    contestados: Number(funil?.contestados ?? 0),
  }
  const criados = Number(funil?.criados ?? 0)
  const funilDoPeriodo = {
    criados,
    ...baldes,
    // o pedido com estorno parcial já está dentro de `finalizados`; este
    // número é o detalhe dele, não um balde
    comEstorno: Number(funil?.com_estorno ?? 0),
    outros: criados - Object.values(baldes).reduce((s, n) => s + n, 0),
  }

  return {
    periodo: { de: inicio.toISOString(), ate: fim.toISOString() },
    regua: 'pedido que virou dinheiro, pela data do pagamento',
    totais: {
      cobradoCents: Number(totais.cobrado),
      faceCents: Number(totais.face),
      taxaCents: Number(totais.taxa),
      descontoCents: Number(totais.desconto),
      // tudo que voltou pro comprador, inclusive o pedido estornado por
      // inteiro — a régua está explicada na consulta lá em cima
      estornadoCents: Number(devolvido?.total ?? 0),
      // a parte da devolução que já está descontada do líquido
      estornadoNoLiquidoCents: Number(totais.estornado),
      // o que sobra pro produtor — mesma conta do borderô e dos financeiros
      liquidoCents: Number(totais.liquido),
      hojeCents: Number(hoje?.cobrado ?? 0),
      hojeLiquidoCents: Number(hoje?.liquido ?? 0),
      pedidos,
      pedidosFechados: Number(totais.fechados),
      pedidosComEstorno: Number(totais.com_estorno),
      ingressos: emitidos,
      pagos: emitidos - gratis,
      // EMITIDAS, não "ocupando lugar" — e o nome diz qual das duas é.
      //
      // Este número é a decomposição de `ingressos` (item do pedido): tudo que
      // saiu, inclusive a cortesia que depois foi cancelada. O borderô responde
      // a outra pergunta com a MESMA palavra — `totais.cortesias` lá é
      // cortesia de pé, que come cota (medido no evento semeado: 3 aqui, 2 lá).
      // Dois campos `cortesias` em duas rotas querendo dizer coisas diferentes
      // é a armadilha do `ticketMedioCents` de novo; aqui ela morre no nome.
      cortesiasEmitidas: gratis,
      // O nome DIZ a régua, porque "ticket médio" não é uma conta só: dividir
      // por pedido e dividir por ingresso dão números bem diferentes (medido
      // no evento semeado: R$ 87,28 por pedido contra R$ 43,13 por ingresso) e
      // os dois são legítimos. O campo chamava-se `ticketMedioCents` aqui e
      // `ticketMedioCents` em `/relatorios` querendo dizer coisas OPOSTAS —
      // armadilha armada pro primeiro relatório que lesse as duas rotas e
      // somasse os dois campos de mesmo nome.
      //
      // Os dois saem daqui agora, cada um com o nome da sua régua, e a tela
      // escolhe qual mostrar em vez de adivinhar.
      ticketMedioPorIngressoCents: emitidos ? Math.round(Number(totais.cobrado) / emitidos) : 0,
      ticketMedioPorPedidoCents: pedidos ? Math.round(Number(totais.cobrado) / pedidos) : 0,
      ingressosPorPedido: pedidos ? Number((emitidos / pedidos).toFixed(2)) : 0,
    },
    // quem passou pela catraca — pessoa, não ingresso emitido
    publico: {
      pessoas: Number(publico?.pessoas ?? 0),
      passagens: Number(publico?.entradas ?? 0),
      ingressosComEntrada: Number(publico?.ingressos ?? 0),
      passagensOffline: Number(publico?.offline ?? 0),
      ultimaEm: publico?.ultima ?? null,
    },
    ritmo: porDia.map((d) => ({
      dia: d.dia, cobradoCents: Number(d.cobrado), liquidoCents: Number(d.liquido),
      ingressos: Number(d.ingressos),
    })),
    funil: funilDoPeriodo,
    porForma: porForma.map((f) => ({
      forma: f.forma, cobradoCents: Number(f.cobrado), liquidoCents: Number(f.liquido), n: f.n,
    })),
    porCanal: porCanal.map((c) => ({
      canal: c.canal, cobradoCents: Number(c.cobrado), liquidoCents: Number(c.liquido), n: c.n,
    })),
    porSetor: porSetor.map((s) => ({
      setor: s.setor, lote: s.lote,
      quantidade: s.quantity, vendidos: s.sold, reservados: s.reserved,
      vendidosPeriodo: s.vendidos_periodo, cobradoCents: Number(s.cobrado),
    })),
  }
})
