/**
 * GET /api/admin/relatorios — as vendas da ORGANIZAÇÃO inteira, todos os
 * eventos juntos.
 *
 * Até aqui só existia relatório DENTRO de um evento (`evento/<id>/relatorios`),
 * e quem produz um fim de semana por semana durante o ano quer a pergunta de
 * cima: "quanto o parque vendeu no mês, por qual canal, de onde vem quem
 * compra". Esta rota responde isso sem obrigar a somar trinta telas na mão.
 *
 * ## Não é uma conta nova
 *
 * Toda soma de dinheiro aqui usa as mesmas duas réguas do relatório do evento:
 * `PEDIDO_VIVO()` no `WHERE` e `SQL_LIQUIDO()` no líquido (`utils/liquido.ts`).
 * Por isso o número desta tela, filtrada por UM evento, é idêntico ao do
 * relatório daquele evento — e `relatorios-organizacao.test.ts` trava isso. Uma
 * segunda definição de "quanto vendeu" é o que faz duas telas discordarem.
 *
 * ## O que NÃO vira JOIN
 *
 * Os números de dinheiro saem só de `orders`. Venda de balcão pode não ter
 * cliente (e cliente apagado deixa `customer_id` nulo), e um `JOIN customers`
 * comeria essas linhas em silêncio: o total da organização ficaria menor que a
 * soma dos eventos sem nenhum erro na tela. A parte de CLIENTES (cidade, idade)
 * é a única que precisa do cadastro, e diz em voz alta quantas vendas ficaram
 * sem cliente identificado (`pedidosSemCliente`).
 *
 * ## Filtros (todos na URL da tela)
 *
 * `evento` (id), `de` e `ate` (`AAAA-MM-DD`, pelo dia do PAGAMENTO, como a curva
 * por dia do relatório do evento). Sem filtro é a vida toda da organização.
 * `o.org_id = $1` vale sempre: um `evento` de outra organização devolve zero,
 * nunca os dados dela.
 */
import { q, q1 } from '../../utils/db'
import { PEDIDO_VIVO, SQL_LIQUIDO } from '../../utils/liquido'
import { FAIXAS_ETARIAS, SQL_FAIXA } from '../../utils/cadastro'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `AAAA-MM-DD` que é uma data de verdade (31 de fevereiro não passa). */
function diaValido(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

export default defineEventHandler(async (event) => {
  const orgId = (event.context as any).sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })

  const { de, ate, evento } = getQuery(event) as Record<string, string | undefined>
  if (evento && !UUID.test(evento)) {
    throw createError({ statusCode: 400, statusMessage: 'Evento inválido.' })
  }
  for (const [nome, v] of [['inicial', de], ['final', ate]] as const) {
    if (v && !diaValido(v)) {
      throw createError({ statusCode: 400,
        statusMessage: `A data ${nome} não é uma data válida. Use dia, mês e ano.` })
    }
  }
  if (de && ate && de > ate) {
    throw createError({ statusCode: 400, statusMessage: 'A data inicial vem depois da final.' })
  }

  // O recorte, montado uma vez e usado por todas as consultas abaixo — é o que
  // garante que resumo, curva e quebras falam da MESMA população de pedidos.
  const params: any[] = [orgId]
  const cond = [`o.org_id = $1`, PEDIDO_VIVO('o.')]
  if (evento) { params.push(evento); cond.push(`o.event_id = $${params.length}`) }
  if (de) { params.push(de); cond.push(`o.paid_at >= $${params.length}::date`) }
  if (ate) { params.push(ate); cond.push(`o.paid_at < ($${params.length}::date + 1)`) }
  const ONDE = cond.join(' AND ')

  // ingressos do pedido, somados uma vez só por pedido (LATERAL não multiplica
  // linha: pedido com três itens continua sendo UMA linha)
  const ITENS = `LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n FROM order_items
                                     WHERE order_id = o.id) oi ON true`

  const [resumo, porDia, porEvento, porForma, porCanal, base, porCidade, porFaixa, top] =
    await Promise.all([
      q1<any>(
        `SELECT COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
                COALESCE(SUM(o.face_cents),0)::bigint  AS face,
                COALESCE(SUM(o.fee_cents),0)::bigint   AS taxa,
                COALESCE(SUM(o.discount_cents),0)::bigint AS desconto,
                COALESCE(SUM(o.refunded_cents),0)::bigint AS estornado,
                ${SQL_LIQUIDO('o.')} AS liquido,
                count(*)::int AS pedidos,
                count(*) FILTER (WHERE o.customer_id IS NULL)::int AS sem_cliente,
                count(DISTINCT o.customer_id)::int AS clientes,
                COALESCE(SUM(oi.n),0)::int AS ingressos,
                MIN(o.paid_at) AS primeira, MAX(o.paid_at) AS ultima
           FROM orders o ${ITENS}
          WHERE ${ONDE}`, params),

      q<any>(
        `SELECT date_trunc('day', o.paid_at) AS dia,
                count(*)::int AS pedidos,
                COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
                ${SQL_LIQUIDO('o.')} AS liquido
           FROM orders o
          WHERE ${ONDE} AND o.paid_at IS NOT NULL
          GROUP BY 1 ORDER BY 1`, params),

      q<any>(
        `SELECT e.id, e.name, e.status, e.starts_at,
                count(*)::int AS pedidos,
                COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
                ${SQL_LIQUIDO('o.')} AS liquido,
                COALESCE(SUM(oi.n),0)::int AS ingressos
           FROM orders o
           JOIN events e ON e.id = o.event_id ${ITENS}
          WHERE ${ONDE}
          GROUP BY e.id, e.name, e.status, e.starts_at
          ORDER BY e.starts_at DESC`, params),

      q<any>(
        `SELECT o.payment_method AS forma,
                count(*)::int AS pedidos,
                COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
                ${SQL_LIQUIDO('o.')} AS liquido
           FROM orders o
          WHERE ${ONDE}
          GROUP BY 1 ORDER BY cobrado DESC`, params),

      q<any>(
        `SELECT o.channel AS canal,
                count(*)::int AS pedidos,
                COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
                ${SQL_LIQUIDO('o.')} AS liquido
           FROM orders o
          WHERE ${ONDE}
          GROUP BY 1 ORDER BY cobrado DESC`, params),

      // Quem comprou: cada cliente UMA vez, por mais pedidos que tenha. Sem
      // cliente identificado não entra aqui (e vem contado em `sem_cliente`).
      q1<any>(
        `WITH c AS (SELECT DISTINCT o.customer_id FROM orders o
                     WHERE ${ONDE} AND o.customer_id IS NOT NULL)
         SELECT count(*)::int AS total,
                count(*) FILTER (WHERE cu.registered_at IS NOT NULL)::int AS com_cadastro,
                count(*) FILTER (WHERE cu.marketing_opt_in)::int AS aceitam_novidades,
                count(*) FILTER (WHERE cu.birth_date IS NULL)::int AS sem_idade,
                count(*) FILTER (WHERE cu.city IS NULL)::int AS sem_cidade
           FROM c JOIN customers cu ON cu.id = c.customer_id`, params),

      q<any>(
        `WITH c AS (SELECT DISTINCT o.customer_id FROM orders o
                     WHERE ${ONDE} AND o.customer_id IS NOT NULL)
         SELECT cu.city AS cidade, cu.state AS estado, count(*)::int AS clientes
           FROM c JOIN customers cu ON cu.id = c.customer_id
          WHERE cu.city IS NOT NULL
          GROUP BY 1, 2 ORDER BY 3 DESC, 1 LIMIT 15`, params),

      q<any>(
        `WITH c AS (SELECT DISTINCT o.customer_id FROM orders o
                     WHERE ${ONDE} AND o.customer_id IS NOT NULL)
         SELECT ${SQL_FAIXA('cu.birth_date')} AS faixa, count(*)::int AS clientes
           FROM c JOIN customers cu ON cu.id = c.customer_id
          WHERE cu.birth_date IS NOT NULL
          GROUP BY 1`, params),

      // O que o COMPRADOR deixou (cobrado menos o que voltou pra ele) — não é o
      // líquido do produtor; mesma distinção do relatório do evento.
      q<any>(
        `SELECT cu.id, cu.name, cu.email,
                count(*)::int AS pedidos,
                COALESCE(SUM(o.total_cents - o.refunded_cents),0)::bigint AS gasto,
                COALESCE(SUM(oi.n),0)::int AS ingressos
           FROM orders o
           JOIN customers cu ON cu.id = o.customer_id ${ITENS}
          WHERE ${ONDE}
          GROUP BY cu.id, cu.name, cu.email
          ORDER BY gasto DESC, cu.name LIMIT 10`, params),
    ])

  const pedidos = Number(resumo.pedidos)
  const ingressos = Number(resumo.ingressos)
  const cobrado = Number(resumo.cobrado)
  const faixas = new Map<string, number>(porFaixa.map((f: any) => [f.faixa, Number(f.clientes)]))

  return {
    filtro: { evento: evento ?? null, de: de ?? null, ate: ate ?? null },
    resumo: {
      pedidos, ingressos,
      clientes: Number(resumo.clientes),
      // vendas sem cliente identificado (balcão sem cadastro): contam no
      // dinheiro, não em "clientes" nem nas quebras por cidade e idade
      pedidosSemCliente: Number(resumo.sem_cliente),
      cobradoCents: cobrado,
      faceCents: Number(resumo.face),
      taxaCents: Number(resumo.taxa),
      descontoCents: Number(resumo.desconto),
      estornadoNoLiquidoCents: Number(resumo.estornado),
      liquidoCents: Number(resumo.liquido),
      // a MESMA régua e o MESMO nome do relatório do evento
      ticketMedioPorPedidoCents: pedidos > 0 ? Math.round(cobrado / pedidos) : 0,
      ticketMedioPorIngressoCents: ingressos > 0 ? Math.round(cobrado / ingressos) : 0,
      primeiraVenda: resumo.primeira, ultimaVenda: resumo.ultima,
    },
    porDia: porDia.map((d) => ({
      dia: d.dia, pedidos: d.pedidos,
      cobradoCents: Number(d.cobrado), liquidoCents: Number(d.liquido),
    })),
    porEvento: porEvento.map((e) => ({
      id: e.id, nome: e.name, situacao: e.status, comeca: e.starts_at,
      pedidos: e.pedidos, ingressos: e.ingressos,
      cobradoCents: Number(e.cobrado), liquidoCents: Number(e.liquido),
    })),
    porForma: porForma.map((f) => ({
      forma: f.forma, pedidos: f.pedidos,
      cobradoCents: Number(f.cobrado), liquidoCents: Number(f.liquido),
    })),
    porCanal: porCanal.map((c) => ({
      canal: c.canal, pedidos: c.pedidos,
      cobradoCents: Number(c.cobrado), liquidoCents: Number(c.liquido),
    })),
    clientes: {
      total: Number(base?.total ?? 0),
      comCadastro: Number(base?.com_cadastro ?? 0),
      aceitamNovidades: Number(base?.aceitam_novidades ?? 0),
      semIdade: Number(base?.sem_idade ?? 0),
      semCidade: Number(base?.sem_cidade ?? 0),
      porCidade: porCidade.map((c) => ({
        cidade: c.cidade, estado: c.estado, clientes: Number(c.clientes),
      })),
      // sempre as seis faixas, na ordem, com zero onde não há ninguém: o
      // gráfico não pode mudar de forma conforme o filtro
      porFaixa: FAIXAS_ETARIAS.map((f) => ({
        chave: f.chave, rotulo: f.rotulo, clientes: faixas.get(f.chave) ?? 0,
      })),
    },
    topCompradores: top.map((c) => ({
      id: c.id, nome: c.name, email: c.email, pedidos: c.pedidos, ingressos: c.ingressos,
      gastoCents: Number(c.gasto),
    })),
  }
})
