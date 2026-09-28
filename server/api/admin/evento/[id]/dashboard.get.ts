/**
 * GET /api/admin/evento/:id/dashboard?periodo=hoje|ontem|7d  ou  ?de=AAAA-MM-DD&ate=AAAA-MM-DD
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
import { PEDIDO_VIVO, SQL_LIQUIDO, SQL_LIQUIDO_DIRETO, SQL_LIQUIDO_GATEWAY } from '../../../../utils/liquido'
import { retratoDoPublico, SQL_PUBLICO } from '../../../../utils/catraca'
import { cotaDeMeias } from '../../../../utils/meia-entrada'

/**
 * PEDIDO QUE PAGOU ALGUMA COISA — a população do ticket médio (ADM-12).
 *
 * Cortesia (`channel = 'cortesia'`) e venda que fechou em zero (lote grátis, cupom de 100%) são
 * pedido VIVO — contam em "pedidos" e ocupam lugar —, mas não trazem dinheiro: no denominador da
 * média, 40 cortesias transformavam R$ 100 por ingresso em R$ 20. Relatórios usa a mesma régua.
 */
export const PAGANTE = `o.channel <> 'cortesia' AND o.total_cents > 0`

/**
 * O FUNIL É O DO CHECKOUT DO SITE (ADM-28): só pedido online tem carrinho, PIX que expira e
 * pagamento que falha. Balcão e cortesia entram direto como pagos. Relatórios usa a mesma régua.
 * Sem prefixo de tabela: as duas consultas do funil leem `orders` sem apelido.
 */
export const CANAL_DO_FUNIL = `channel = 'online'`

/**
 * `de` e `ate` chegam como DIA (`2026-09-21`), e dia é coisa de calendário —
 * do calendário DO EVENTO, não do servidor.
 *
 * Primeiro defeito (já consertado antes): `new Date('2026-09-21')` é
 * meia-noite UTC, 21h do dia anterior na Bahia, e o "Hoje" puxava 64 pedidos
 * da noite de ontem.
 *
 * Segundo defeito, o deste bloco: o conserto lia o dia "em hora local" — a
 * hora local do processo Node. E o card "hoje" usava `date_trunc('day',
 * now())`, que é o dia no fuso da SESSÃO do Postgres. Dois relógios que só
 * concordam enquanto o servidor, o banco e o parque estiverem no mesmo fuso;
 * no dia em que o Node subir em UTC (container, é o padrão), o filtro "Hoje"
 * e o card "hoje" passam a cortar o dia em horas diferentes, calados.
 *
 * Agora os dois lados cortam no fuso do evento (`events.timezone`, que já
 * existe e é o que o checkout usa; padrão `America/Bahia`), e o corte é feito
 * pelo Postgres (`AT TIME ZONE`), que conhece horário de verão de qualquer
 * fuso. O botão "Hoje" manda `periodo=hoje` e o servidor decide que dia é —
 * o navegador do produtor pode estar em outro fuso.
 *
 * Data impossível (`?de=ontem`) vira `null` e a rota cai no padrão, em vez de
 * devolver erro 500 pra quem só digitou errado na URL.
 */
function diaValido(texto: unknown): string | null {
  const dia = String(texto ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return null
  return Number.isNaN(new Date(`${dia}T12:00:00Z`).getTime()) ? null : dia
}

/** o fuso quando o do evento não existe ou está torto */
export const FUSO_PADRAO = 'America/Bahia'

/**
 * O fuso do evento, conferido ANTES de entrar num `AT TIME ZONE` — texto torto na coluna
 * derrubaria a rota inteira com 500.
 *
 * A conferência era contra `pg_timezone_names`, que lê o diretório de fusos inteiro a cada
 * consulta: medido em 27/09, 100–200 ms por abertura do painel, e o painel se atualiza sozinho.
 * O `Intl` do Node responde a mesma pergunta em microssegundos e ainda devolve o nome canônico.
 *
 * Mora aqui (e não num util novo) porque é deste arquivo que relatórios, extrato, pontos de venda
 * e público importam — a mesma casa do `hojeNoFuso`, pra "que dia é" ter uma resposta só.
 */
export function fusoDoEvento(nome: unknown): string {
  const f = String(nome ?? '').trim()
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(f)) return FUSO_PADRAO
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: f }).resolvedOptions().timeZone || FUSO_PADRAO
  } catch {
    return FUSO_PADRAO
  }
}

/** `'America/Bahia'` pronto pra colar no SQL — só com nome que passou por `fusoDoEvento` */
export function fusoSql(fuso: string): string {
  return `'${fusoDoEvento(fuso).replace(/'/g, "''")}'`
}

/** o dia de hoje no calendário do fuso, `AAAA-MM-DD` */
export function hojeNoFuso(fuso: string, agora = new Date()): string {
  // en-CA escreve a data em ISO; `toISOString` cortaria em UTC
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(agora)
}

/** soma dias a um `AAAA-MM-DD` sem passar por fuso nenhum */
export function somarDias(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** quantos dias de calendário de `de` a `ate`, contando os dois */
export function diasEntre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000) + 1
}

/** o teto da série do gráfico: dois anos de barras ainda cabem no card; mais que isso é outra tela */
export const MAXIMO_DE_DIAS_NA_SERIE = 731

/**
 * A SÉRIE DE DIAS CONTÍNUA (ADM-20): de `de` a `ate`, TODO dia, com zero onde não houve venda.
 *
 * A curva era desenhada só com os dias que tiveram venda: 40 dias alternados viravam 20 pontos
 * colados, o tempo encolhia e a venda parecia constante. Dia sem venda é informação — é o platô
 * que diz "a campanha parou". O dia é texto `AAAA-MM-DD` do calendário do evento (a mesma chave
 * que `ritmo` usa), então aqui não entra fuso nenhum.
 *
 * Passou do teto, fica com os ÚLTIMOS dias e avisa (`cortada`) — o fim é o que se acompanha.
 */
export function serieDeDias<T extends { dia: string }>(
  de: string | null, ate: string | null, pontos: T[], zero: (dia: string) => T,
  maximo = MAXIMO_DE_DIAS_NA_SERIE,
): { serie: T[]; cortada: boolean } {
  if (!de || !ate || de > ate) return { serie: [], cortada: false }
  const total = diasEntre(de, ate)
  const cortada = total > maximo
  const inicio = cortada ? somarDias(ate, -(maximo - 1)) : de
  const porDia = new Map(pontos.map((p) => [p.dia, p]))
  const serie: T[] = []
  for (let d = inicio, i = 0; i < Math.min(total, maximo); d = somarDias(d, 1), i++) {
    serie.push(porDia.get(d) ?? zero(d))
  }
  return { serie, cortada }
}

/**
 * A variação contra o período anterior, em %, com uma casa abaixo de 10. `null` quando não há
 * base (anterior zero): "+∞%" não informa nada, e a tela escreve "sem base" no lugar.
 */
export function variacaoPct(atual: number, anterior: number): number | null {
  if (!anterior) return null
  const v = ((atual - anterior) / Math.abs(anterior)) * 100
  return Math.abs(v) < 10 ? Math.round(v * 10) / 10 : Math.round(v)
}

/**
 * OS NÚMEROS DE UMA JANELA, pela régua do painel — o mesmo `PEDIDO_VIVO`, o mesmo `SQL_LIQUIDO`,
 * o mesmo `PAGANTE`, o mesmo funil do site (`CANAL_DO_FUNIL`) e o livro da portaria.
 *
 * É uma função (e não duas cópias) porque a tabela "Comparação" põe a janela atual ao lado da
 * anterior: se cada coluna tivesse a própria conta, a diferença entre elas seria de régua, não
 * de venda. O teste confere que a janela atual daqui bate com os totais do topo.
 */
async function numerosDaJanela(id: string, inicio: Date, fim: Date) {
  const p = [id, inicio, fim]
  const [v, f, e] = await Promise.all([
    q1<any>(
      `SELECT COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
              ${SQL_LIQUIDO('o.')} AS liquido,
              COUNT(*) FILTER (WHERE ${PAGANTE})::int AS pagantes,
              COALESCE(SUM(oi.n) FILTER (WHERE o.channel <> 'cortesia'),0)::int AS vendidos
         FROM orders o
         LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n FROM order_items WHERE order_id = o.id) oi ON true
        WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')} AND o.paid_at BETWEEN $2 AND $3`, p),
    q1<any>(
      `SELECT COUNT(*)::int AS criados, COUNT(*) FILTER (WHERE ${PEDIDO_VIVO()})::int AS finalizados
         FROM orders WHERE event_id = $1 AND ${CANAL_DO_FUNIL} AND created_at BETWEEN $2 AND $3`, p),
    q1<any>(
      `SELECT COALESCE(sum(people),0)::int AS pessoas
         FROM entries WHERE event_id = $1 AND entered_at BETWEEN $2 AND $3`, p),
  ])
  const cobrado = Number(v?.cobrado ?? 0)
  const pagantes = Number(v?.pagantes ?? 0)
  const criados = Number(f?.criados ?? 0)
  return {
    de: inicio.toISOString(),
    ate: fim.toISOString(),
    cobradoCents: cobrado,
    liquidoCents: Number(v?.liquido ?? 0),
    ingressosVendidos: Number(v?.vendidos ?? 0),
    pedidosPagantes: pagantes,
    ticketMedioPorPedidoCents: pagantes ? Math.round(cobrado / pagantes) : 0,
    criadosNoSite: criados,
    conversaoDoSitePct: criados ? Math.round((Number(f?.finalizados ?? 0) / criados) * 1000) / 10 : null,
    entradasNaPortaria: Number(e?.pessoas ?? 0),
  }
}

/** as cores de cada portão no gráfico da portaria — hex das escalas da casa (pool, grape, sun, citrus) */
const PORTOES_NO_GRAFICO = 4

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const { de, ate, periodo } = getQuery(event) as { de?: string; ate?: string; periodo?: string }

  // O fuso é conferido antes de entrar no SQL (`fusoDoEvento`): um texto torto na
  // coluna faria o `AT TIME ZONE` estourar 500 no painel inteiro.
  const ev = await q1<any>(
    `SELECT id, name, status, starts_at, ends_at, fee_bps, timezone
       FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  const fuso: string = fusoDoEvento(ev.timezone)

  const hoje = hojeNoFuso(fuso)
  let diaDe = diaValido(de)
  let diaAte = diaValido(ate)
  // o NOME do período vai de volta pra tela: é ele que acende o chip certo e decide se a página
  // se atualiza sozinha ("Hoje")
  let nomeDoPeriodo: 'tudo' | 'hoje' | 'ontem' | '7d' | 'personalizado' = 'tudo'
  if (periodo === 'hoje') { diaDe = hoje; diaAte = hoje; nomeDoPeriodo = 'hoje' }
  else if (periodo === 'ontem') { diaDe = somarDias(hoje, -1); diaAte = diaDe; nomeDoPeriodo = 'ontem' }
  else if (periodo === '7d') { diaDe = somarDias(hoje, -6); diaAte = hoje; nomeDoPeriodo = '7d' }
  else if (diaDe || diaAte) {
    nomeDoPeriodo = 'personalizado'
    // "de 30 até 20" é a mesma pergunta que "de 20 até 30" — trocar vale mais que responder zero
    if (diaDe && diaAte && diaDe > diaAte) [diaDe, diaAte] = [diaAte, diaDe]
  }

  // O PERÍODO ANTERIOR, de mesma duração (tabela "Comparação" e o ▲▼ dos números do topo). Só
  // existe quando o período tem começo: "todo o período" não tem anterior.
  const fimEfetivo = diaDe ? (diaAte ?? hoje) : null
  const duracao = diaDe && fimEfetivo ? diasEntre(diaDe, fimEfetivo) : 0
  const antDe = diaDe && duracao > 0 ? somarDias(diaDe, -duracao) : null
  const antAte = diaDe && duracao > 0 ? somarDias(diaDe, -1) : null

  // "Todo o período" tem que significar TODO o período. Ancorar o padrão na
  // criação do evento parece razoável e não é: basta um pedido com data
  // anterior (importação, migração, ajuste manual) pra o total da tela ficar
  // menor que a soma da tabela logo abaixo dela, sem nenhum aviso.
  //
  // O corte do dia é do Postgres, no fuso do evento — e o começo de "hoje"
  // sai da MESMA consulta, pro card "hoje" e o filtro "Hoje" cortarem igual.
  const janela = await q1<any>(
    `SELECT CASE WHEN $2::date IS NULL THEN to_timestamp(0)
                 ELSE ($2::date)::timestamp AT TIME ZONE $1 END                        AS inicio,
            CASE WHEN $3::date IS NULL THEN now()
                 ELSE (($3::date + 1)::timestamp AT TIME ZONE $1) - interval '1 millisecond' END AS fim,
            ($4::date)::timestamp AT TIME ZONE $1                                      AS hoje_inicio,
            (($4::date - 1)::timestamp AT TIME ZONE $1)                                AS ontem_inicio,
            (($4::date + 1)::timestamp AT TIME ZONE $1)                                AS amanha_inicio,
            CASE WHEN $5::date IS NULL THEN NULL
                 ELSE ($5::date)::timestamp AT TIME ZONE $1 END                        AS ant_inicio,
            CASE WHEN $6::date IS NULL THEN NULL
                 ELSE (($6::date + 1)::timestamp AT TIME ZONE $1) - interval '1 millisecond' END AS ant_fim,
            extract(hour FROM now() AT TIME ZONE $1)::int                              AS hora_agora,
            to_char(now() AT TIME ZONE $1, 'HH24:MI')                                 AS hora_minuto_agora,
            now()                                                                      AS agora`,
    [fuso, diaDe, diaAte, hoje, antDe, antAte])
  const inicio: Date = janela.inicio
  const fim: Date = janela.fim
  const p = [id, inicio, fim]
  const agora: Date = janela.agora

  // A régua do período, uma vez só. `PEDIDO_VIVO` no lugar de `status =
  // 'pago'`: o pedido com estorno parcial continua sendo dinheiro que entrou,
  // e o que voltou já está em `refunded_cents` — quem desconta é a conta do
  // líquido, não um recorte que apaga o pedido inteiro.
  const vivoNoPeriodo = `${PEDIDO_VIVO('o.')} AND o.paid_at BETWEEN $2 AND $3`

  const [totais, vendasHoje, porDia, funil, porForma, porCanal, porSetor, publico] = await Promise.all([
    q1<any>(
      `SELECT COALESCE(SUM(o.total_cents),0)::bigint  AS cobrado,
              COALESCE(SUM(o.face_cents),0)::bigint   AS face,
              COALESCE(SUM(o.fee_cents),0)::bigint    AS taxa,
              COALESCE(SUM(o.discount_cents),0)::bigint AS desconto,
              COALESCE(SUM(o.refunded_cents),0)::bigint AS estornado,
              ${SQL_LIQUIDO('o.')}                     AS liquido,
              -- as duas metades do líquido, com a régua do financeiro (utils/liquido.ts): o que
              -- está na plataforma e o que já está com o produtor (gaveta, pix na chave dele)
              ${SQL_LIQUIDO_GATEWAY('o.')}             AS liquido_plataforma,
              ${SQL_LIQUIDO_DIRETO('o.')}              AS liquido_direto,
              COUNT(*)::int                            AS pedidos,
              COUNT(*) FILTER (WHERE o.status = 'pago')::int AS fechados,
              COUNT(*) FILTER (WHERE o.status = 'estornado_parcial')::int AS com_estorno,
              COALESCE(SUM(oi.n),0)::int               AS ingressos,
              COUNT(*) FILTER (WHERE ${PAGANTE})::int  AS pagantes,
              COALESCE(SUM(oi.n) FILTER (WHERE ${PAGANTE}),0)::int AS ingressos_pagantes
         FROM orders o
         LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n FROM order_items WHERE order_id = o.id) oi ON true
        WHERE o.event_id = $1 AND ${vivoNoPeriodo}`, p),

    q1<any>(
      `SELECT COALESCE(SUM(total_cents),0)::bigint AS cobrado,
              ${SQL_LIQUIDO()} AS liquido
         FROM orders
        WHERE event_id = $1 AND ${PEDIDO_VIVO()} AND paid_at >= $2`,
      [id, janela.hoje_inicio]),

    // o dia da curva também é o do evento — senão a venda das 22h cai no
    // ponto de amanhã quando o banco está em outro fuso. Sai como TEXTO
    // `AAAA-MM-DD`: um `date` do Postgres vira `Date` do Node à meia-noite do
    // fuso do SERVIDOR, e o navegador em outro fuso escrevia o dia anterior
    // no eixo (ADM-10). Dia de calendário não tem hora nem fuso.
    q<any>(
      `SELECT to_char(o.paid_at AT TIME ZONE ${fusoSql(fuso)}, 'YYYY-MM-DD') AS dia,
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
    //
    // SÓ O CHECKOUT DO SITE (ADM-28, `CANAL_DO_FUNIL`). Balcão e cortesia não têm carrinho: nascem
    // pagos (ou são cancelados no guichê), e somados aqui faziam a conversão do site parecer 95%
    // num dia de 100 vendas no balcão e 5 de 10 carrinhos online — e a venda de balcão cancelada
    // entrava como "abandonada".
    q1<any>(
      `SELECT COUNT(*)::int AS criados,
              COUNT(*) FILTER (WHERE ${PEDIDO_VIVO()})::int AS finalizados,
              COUNT(*) FILTER (WHERE status = 'estornado_parcial')::int AS com_estorno,
              COUNT(*) FILTER (WHERE status = 'estornado')::int AS devolvidos,
              COUNT(*) FILTER (WHERE status IN ('expirado','cancelado','falhou'))::int AS abandonados,
              COUNT(*) FILTER (WHERE status IN ('aguardando_pagamento','em_analise','rascunho'))::int
                AS abertos,
              COUNT(*) FILTER (WHERE status IN ('chargeback','disputa'))::int AS contestados
         FROM orders WHERE event_id = $1 AND ${CANAL_DO_FUNIL} AND created_at BETWEEN $2 AND $3`, p),

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

  // ------------------------------------------------------------------ o que o painel ganhou
  // (redesenho de 27/09: dias contínuos, hoje por hora, tipo de ingresso e cota de meia, próximos
  // dias, portaria de hoje e a comparação com o período anterior). Tudo com as réguas de cima.
  const [porHora, porTipo, cotas, sessoes, totalDeSessoes, entradasHoje, porQuarto, barrados,
    atual, anterior] = await Promise.all([
    // HOJE E ONTEM POR HORA, no relógio do evento — sempre, qualquer que seja o período: é o
    // "a que horas está vendendo" do dia (bilheteria e site juntos)
    q<any>(
      `SELECT extract(hour FROM o.paid_at AT TIME ZONE ${fusoSql(fuso)})::int AS hora,
              (o.paid_at >= $2) AS eh_hoje,
              COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
              COUNT(*)::int AS pedidos
         FROM orders o
        WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')}
          AND o.paid_at >= $3 AND o.paid_at < $4
        GROUP BY 1, 2`, [id, janela.hoje_inicio, janela.ontem_inicio, janela.amanha_inicio]),

    // POR TIPO DE INGRESSO no período — a espécie do tipo (`ticket_types.kind`, gerada no 015);
    // item sem tipo é inteira (o preço do lote). A cortesia fica fora: ela tem linha própria, e
    // somada aqui seria "gratuito" com outro nome. Mesma unidade de `pagos` (item do pedido).
    q<any>(
      `SELECT COALESCE(tt.kind, 'inteira') AS especie,
              COALESCE(SUM(oi.quantity),0)::int AS ingressos,
              COALESCE(SUM(oi.quantity * oi.unit_total_cents),0)::bigint AS cobrado
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN ticket_types tt ON tt.id = oi.ticket_type_id
        WHERE o.event_id = $1 AND ${vivoNoPeriodo} AND o.channel <> 'cortesia'
        GROUP BY 1`, p),

    // A COTA DE MEIA de cada lote que vende meia — a MESMA conta da trava da venda
    // (`SQL_MEIAS_DO_LOTE` + `cotaDeMeias`, utils/meia-entrada.ts): soma dos `sold` dos tipos de
    // meia contra o piso de `quantity × half_quota_bps`. É do lote inteiro, não do período.
    q<any>(
      `SELECT l.id, s.name AS setor, l.name AS lote, l.quantity::int, l.half_quota_bps::int,
              COALESCE(SUM(tt.sold) FILTER (WHERE tt.kind = 'meia'), 0)::int AS meias
         FROM sectors s
         JOIN lots l ON l.sector_id = s.id
         JOIN ticket_types tt ON tt.lot_id = l.id
        WHERE s.event_id = $1
        GROUP BY s.id, l.id
       HAVING count(*) FILTER (WHERE tt.kind = 'meia') > 0
        ORDER BY s.sort_order, l.sort_order`, [id]),

    // OS PRÓXIMOS DIAS (sessões que ainda não acabaram): a ocupação é a da trava da venda
    // (`sessao_ocupacao`, do 016) — a tela de Sessões lê a mesma função
    q<any>(
      `SELECT es.id, es.title, es.capacity,
              to_char(es.starts_at AT TIME ZONE ${fusoSql(fuso)}, 'YYYY-MM-DD') AS dia,
              to_char(es.starts_at AT TIME ZONE ${fusoSql(fuso)}, 'HH24:MI') AS hora,
              sessao_ocupacao(es.id) AS ocupadas
         FROM event_sessions es
        WHERE es.event_id = $1 AND es.ends_at >= now()
        ORDER BY es.starts_at, es.sort_order
        LIMIT 8`, [id]),
    q1<any>(
      `SELECT count(*) FILTER (WHERE ends_at >= now())::int AS futuras, count(*)::int AS todas
         FROM event_sessions WHERE event_id = $1`, [id]),

    // A PORTARIA HOJE — o livro de passagens (`entries`, pessoas) e o log de leituras
    // (`checkins`, as recusas). Hoje é o dia do evento no fuso dele, como o resto.
    q1<any>(
      `SELECT COALESCE(sum(people),0)::int AS pessoas, count(*)::int AS passagens
         FROM entries WHERE event_id = $1 AND entered_at >= $2 AND entered_at < $3`,
      [id, janela.hoje_inicio, janela.amanha_inicio]),
    q<any>(
      `SELECT (extract(hour FROM entered_at AT TIME ZONE ${fusoSql(fuso)})::int * 4
               + floor(extract(minute FROM entered_at AT TIME ZONE ${fusoSql(fuso)}) / 15)::int) AS quarto,
              COALESCE(NULLIF(trim(gate), ''), 'Sem portão') AS portao,
              COALESCE(sum(people),0)::int AS pessoas
         FROM entries WHERE event_id = $1 AND entered_at >= $2 AND entered_at < $3
        GROUP BY 1, 2 ORDER BY 1`, [id, janela.hoje_inicio, janela.amanha_inicio]),
    q<any>(
      `SELECT resultado, count(*)::int AS n
         FROM checkins
        WHERE event_id = $1 AND created_at >= $2 AND created_at < $3 AND resultado <> 'ok'
        GROUP BY 1 ORDER BY 2 DESC, 1`, [id, janela.hoje_inicio, janela.amanha_inicio]),

    // A COMPARAÇÃO: a janela atual e a anterior pela MESMA função. Janela que ainda não acabou
    // (hoje, 7 dias) compara com a anterior ATÉ A MESMA HORA: às 14h, "hoje" contra o dia
    // inteiro de ontem pareceria queda todo dia.
    numerosDaJanela(id!, inicio, fim),
    janela.ant_inicio
      ? numerosDaJanela(id!, janela.ant_inicio, fim > agora
        ? new Date(Math.min(janela.ant_fim.getTime(),
          janela.ant_inicio.getTime() + (agora.getTime() - inicio.getTime())))
        : janela.ant_fim)
      : Promise.resolve(null),
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
    `SELECT COALESCE(SUM(refunded_cents),0)::bigint AS total,
            count(*) FILTER (WHERE refunded_cents > 0)::int AS pedidos
       FROM orders
      WHERE event_id = $1 AND paid_at BETWEEN $2 AND $3`, p)

  const emitidos = Number(totais.ingressos)
  const gratis = Number(cortesias?.n ?? 0)
  const pedidos = Number(totais.pedidos)
  // quem PAGOU — a população do ticket médio (ADM-12, ver `PAGANTE`)
  const pagantes = Number(totais.pagantes)
  const ingressosPagantes = Number(totais.ingressos_pagantes)

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

  // ---- a série contínua do gráfico (ADM-20) --------------------------------------------------
  // Período com dias: do primeiro ao último. "Todo o período": do primeiro dia com venda até o
  // último — ou até hoje, se o evento ainda não acabou (os dias parados até aqui SÃO o ritmo).
  const ritmo = porDia.map((d) => ({
    dia: d.dia as string, cobradoCents: Number(d.cobrado), liquidoCents: Number(d.liquido),
    ingressos: Number(d.ingressos),
  }))
  const fimDoEvento = ev.ends_at ? hojeNoFuso(fuso, new Date(ev.ends_at)) : hoje
  const serieDe = diaDe ?? ritmo[0]?.dia ?? null
  const serieAte = diaDe || diaAte
    ? (diaAte ?? hoje)
    : ritmo.length
      ? [ritmo[ritmo.length - 1].dia, hoje < fimDoEvento ? hoje : fimDoEvento].sort().at(-1)!
      : null
  const { serie, cortada } = serieDeDias(serieDe, serieAte, ritmo,
    (dia) => ({ dia, cobradoCents: 0, liquidoCents: 0, ingressos: 0 }))

  // ---- hoje por hora: 24 posições sempre -------------------------------------------------------
  const horas = Array.from({ length: 24 }, (_, hora) => {
    const h = porHora.find((x) => x.hora === hora && x.eh_hoje)
    const o = porHora.find((x) => x.hora === hora && !x.eh_hoje)
    return {
      hora,
      hojeCents: Number(h?.cobrado ?? 0), hojePedidos: Number(h?.pedidos ?? 0),
      ontemCents: Number(o?.cobrado ?? 0), ontemPedidos: Number(o?.pedidos ?? 0),
    }
  })

  // ---- portaria: os quartos de hora de hoje, do primeiro ao último com gente --------------------
  const nomesDosPortoes = [...new Set(porQuarto.map((x) => x.portao as string))]
    .sort((a, b) => porQuarto.filter((x) => x.portao === b).reduce((n, x) => n + x.pessoas, 0)
      - porQuarto.filter((x) => x.portao === a).reduce((n, x) => n + x.pessoas, 0))
  const principais = nomesDosPortoes.slice(0, PORTOES_NO_GRAFICO)
  const quartos: { quarto: number; rotulo: string; pessoas: number; porPortao: Record<string, number> }[] = []
  if (porQuarto.length) {
    const primeiro = Number(porQuarto[0].quarto)
    const ultimo = Number(porQuarto[porQuarto.length - 1].quarto)
    for (let k = primeiro; k <= ultimo; k++) {
      const doQuarto = porQuarto.filter((x) => Number(x.quarto) === k)
      const porPortao: Record<string, number> = {}
      for (const x of doQuarto) {
        const nome = principais.includes(x.portao) ? x.portao : 'Outros'
        porPortao[nome] = (porPortao[nome] ?? 0) + Number(x.pessoas)
      }
      quartos.push({
        quarto: k,
        rotulo: `${String(Math.floor(k / 4)).padStart(2, '0')}:${String((k % 4) * 15).padStart(2, '0')}`,
        pessoas: doQuarto.reduce((n, x) => n + Number(x.pessoas), 0),
        porPortao,
      })
    }
  }

  return {
    evento: { id: ev.id, nome: ev.name, status: ev.status },
    periodo: {
      de: inicio.toISOString(), ate: fim.toISOString(), fuso, hoje,
      // o que a tela acende e escreve: o nome do período e os dias de calendário dele
      nome: nomeDoPeriodo, diaDe, diaAte: diaDe || diaAte ? (diaAte ?? hoje) : null,
      atualizadoEm: agora.toISOString(),
      /** "14:32" da leitura NO RELÓGIO DO EVENTO — a tela escreve pronto, sem formatar data na mão */
      atualizadoAs: String(janela.hora_minuto_agora),
      horaAgora: Number(janela.hora_agora),
    },
    regua: 'pedido que virou dinheiro, pela data do pagamento',
    totais: {
      cobradoCents: Number(totais.cobrado),
      faceCents: Number(totais.face),
      taxaCents: Number(totais.taxa),
      descontoCents: Number(totais.desconto),
      // tudo que voltou pro comprador, inclusive o pedido estornado por
      // inteiro — a régua está explicada na consulta lá em cima
      estornadoCents: Number(devolvido?.total ?? 0),
      // em quantos pedidos — a tela escreve "R$ X em N pedidos, fora do total"
      pedidosComDevolucao: Number(devolvido?.pedidos ?? 0),
      // a parte da devolução que já está descontada do líquido
      estornadoNoLiquidoCents: Number(totais.estornado),
      // o que sobra pro produtor — mesma conta do borderô e dos financeiros
      liquidoCents: Number(totais.liquido),
      // as duas metades dele, com o nome do Financeiro: na plataforma × recebido direto
      liquidoNaPlataformaCents: Number(totais.liquido_plataforma),
      liquidoDiretoCents: Number(totais.liquido_direto),
      hojeCents: Number(vendasHoje?.cobrado ?? 0),
      hojeLiquidoCents: Number(vendasHoje?.liquido ?? 0),
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
      //
      // E a população é a de quem PAGOU (ADM-12): cortesia e venda de R$ 0 não
      // somam nada no cobrado e, no denominador, derrubavam a média — medido:
      // 10 pedidos de R$ 100 e uma emissão de 40 cortesias davam R$ 90,91 por
      // pedido e R$ 20,00 por ingresso. `pedidos` (acima) continua sendo a
      // população dos vivos, a que as outras telas contam.
      ticketMedioPorIngressoCents: ingressosPagantes
        ? Math.round(Number(totais.cobrado) / ingressosPagantes) : 0,
      ticketMedioPorPedidoCents: pagantes ? Math.round(Number(totais.cobrado) / pagantes) : 0,
      ingressosPorPedido: pagantes ? Number((ingressosPagantes / pagantes).toFixed(2)) : 0,
      pedidosPagantes: pagantes,
      ingressosPagantes,
      // o que ficou fora da média, com nome: cortesias e vendas que fecharam em zero
      pedidosSemCobranca: pedidos - pagantes,
    },
    // quem passou pela catraca — pessoa, não ingresso emitido
    publico: {
      pessoas: Number(publico?.pessoas ?? 0),
      passagens: Number(publico?.entradas ?? 0),
      ingressosComEntrada: Number(publico?.ingressos ?? 0),
      passagensOffline: Number(publico?.offline ?? 0),
      ultimaEm: publico?.ultima ?? null,
    },
    // A PORTARIA (ADM-19): o retrato da porta pela MESMA função do leitor (`retratoDoPublico`),
    // mais o dia de hoje — quem entrou, a cada 15 minutos por portão, e quem foi barrado
    portaria: {
      ...retratoDoPublico(publico),
      hoje: { pessoas: Number(entradasHoje?.pessoas ?? 0), passagens: Number(entradasHoje?.passagens ?? 0) },
      portoes: principais.concat(nomesDosPortoes.length > PORTOES_NO_GRAFICO ? ['Outros'] : []),
      quartos,
      barradosHoje: barrados.map((b) => ({ resultado: b.resultado as string, n: Number(b.n) })),
    },
    // a série contínua do gráfico: todo dia do período, zero onde não vendeu (`ritmo`, abaixo,
    // continua só com os dias que venderam — é o que o extrato e os testes de fuso comparam)
    serie,
    serieCortada: cortada,
    porHoraHoje: horas,
    porTipo: ['inteira', 'meia', 'gratuito'].map((especie) => {
      const t = porTipo.find((x) => x.especie === especie)
      return { especie, ingressos: Number(t?.ingressos ?? 0), cobradoCents: Number(t?.cobrado ?? 0) }
    }),
    cotaDeMeia: cotas.map((c) => ({
      loteId: c.id, setor: c.setor, lote: c.lote, quantidade: Number(c.quantity),
      cotaBps: Number(c.half_quota_bps),
      cota: cotaDeMeias(Number(c.quantity), Number(c.half_quota_bps)),
      meias: Number(c.meias),
    })),
    proximosDias: sessoes.map((s) => {
      const capacidade = s.capacity === null ? null : Number(s.capacity)
      const ocupadas = Number(s.ocupadas)
      return {
        id: s.id, titulo: s.title, dia: s.dia, hora: s.hora, capacidade, ocupadas,
        vagas: capacidade === null ? null : Math.max(capacidade - ocupadas, 0),
        lotado: capacidade !== null && ocupadas >= capacidade,
      }
    }),
    sessoes: { futuras: Number(totalDeSessoes?.futuras ?? 0), todas: Number(totalDeSessoes?.todas ?? 0) },
    // o período atual e o anterior de mesma duração, pela mesma função; `null` em "todo o período"
    // (a janela atual sai da mesma função que a anterior, e bate com os totais do topo — o teste
    // confere; a variação é calculada UMA vez, aqui, pro cartão e pra tabela dizerem o mesmo)
    comparacao: anterior ? {
      atual,
      anterior,
      duracaoEmDias: duracao,
      ateAMesmaHora: fim > agora,
      variacao: {
        cobrado: variacaoPct(atual.cobradoCents, anterior.cobradoCents),
        liquido: variacaoPct(atual.liquidoCents, anterior.liquidoCents),
        ingressos: variacaoPct(atual.ingressosVendidos, anterior.ingressosVendidos),
        ticketPorPedido: variacaoPct(atual.ticketMedioPorPedidoCents, anterior.ticketMedioPorPedidoCents),
        entradas: variacaoPct(atual.entradasNaPortaria, anterior.entradasNaPortaria),
        // conversão é porcentagem: a diferença vai em pontos percentuais, não em % de %
        conversaoPp: atual.conversaoDoSitePct === null || anterior.conversaoDoSitePct === null
          ? null : Math.round((atual.conversaoDoSitePct - anterior.conversaoDoSitePct) * 10) / 10,
      },
    } : null,
    ritmo,
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
