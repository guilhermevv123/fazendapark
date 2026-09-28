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
 * Os campos que o redesenho de 27/09 acrescentou são DECOMPOSIÇÃO dos mesmos
 * pedidos, não outra régua: a taxa da plataforma (`SUM(platform_cents)`, a
 * parcela que `SQL_LIQUIDO` desconta), a cortesia separada (o pedido de R$ 0,00
 * do canal `cortesia`, a mesma marca do borderô) e o que já voltou pro comprador
 * em qualquer status (a régua de devolução do dashboard do evento). Os campos
 * antigos continuam com o MESMO nome e a MESMA conta do relatório do evento.
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
 * `evento` (id), e o período: `periodo` (`hoje`, `7d`, `30d`, `mes`,
 * `mes_passado`, `ano`, `tudo` — resolvido AQUI, no calendário do parque) ou
 * `de`/`ate` (`AAAA-MM-DD`) escritos à mão, que ganham do atalho. É pelo dia do
 * PAGAMENTO, como a curva do relatório do evento. Sem filtro nenhum é a vida
 * toda da organização. `o.org_id = $1` vale sempre: um `evento` de outra
 * organização devolve zero, nunca os dados dela.
 *
 * ## O dia é texto
 *
 * `porDia[].dia` sai `AAAA-MM-DD` (o dia no calendário do parque — a sessão do
 * banco está em America/Bahia, `utils/db.ts`), não um instante. O instante
 * (`…T03:00:00.000Z`) era lido pelo navegador no fuso DELE e a barra saía com o
 * rótulo do dia anterior fora da Bahia (auditoria REL-01, a metade do navegador).
 */
import { FUSO_DO_BANCO, q, q1 } from '../../utils/db'
import { PEDIDO_VIVO, SQL_LIQUIDO } from '../../utils/liquido'
import { FAIXAS_ETARIAS, SQL_FAIXA } from '../../utils/cadastro'
import { CANAL_CORTESIA } from '../../utils/emissao'
import { papelPode, type Papel } from '../../utils/papeis'
import {
  diaDeCalendario, ehChavePeriodo, faixaDoPeriodo, periodoAnterior, type ChavePeriodo,
} from '../../../app/composables/painelPeriodo'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** O dia de hoje no calendário do PARQUE (`en-CA` escreve ISO; `toISOString` cortaria em UTC). */
export function hojeNoParque(agora = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_DO_BANCO, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(agora)
}

/**
 * "an***@exemplo.com". O e-mail inteiro dos maiores compradores é dado da BASE de clientes, que é
 * área só do master (`utils/papeis.ts`); o financeiro vê o nome e o valor, não o contato
 * (auditoria REL-05 — decisão pendente do dono, ver o relatório; a direção segura é mascarar).
 */
export function mascararEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const [usuario, dominio] = String(email).split('@')
  if (!dominio) return '***'
  return `${(usuario ?? '').slice(0, 2)}***@${dominio}`
}

type Recorte = { orgId: string; evento?: string; de?: string; ate?: string }

/** O `WHERE` do dinheiro — o MESMO pra resumo, curva e quebras (é o que as faz fechar). */
function ondeDoDinheiro(r: Recorte) {
  const params: any[] = [r.orgId]
  const cond = [`o.org_id = $1`, PEDIDO_VIVO('o.')]
  if (r.evento) { params.push(r.evento); cond.push(`o.event_id = $${params.length}`) }
  if (r.de) { params.push(r.de); cond.push(`o.paid_at >= $${params.length}::date`) }
  if (r.ate) { params.push(r.ate); cond.push(`o.paid_at < ($${params.length}::date + 1)`) }
  return { params, onde: cond.join(' AND ') }
}

// ingressos do pedido, somados uma vez só por pedido (LATERAL não multiplica
// linha: pedido com três itens continua sendo UMA linha)
const ITENS = `LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n FROM order_items
                                   WHERE order_id = o.id) oi ON true`

const SQL_RESUMO = (onde: string) =>
  `SELECT COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
          COALESCE(SUM(o.face_cents),0)::bigint  AS face,
          COALESCE(SUM(o.fee_cents),0)::bigint   AS taxa,
          COALESCE(SUM(o.discount_cents),0)::bigint AS desconto,
          COALESCE(SUM(o.refunded_cents),0)::bigint AS estornado,
          COALESCE(SUM(o.platform_cents),0)::bigint AS plataforma,
          ${SQL_LIQUIDO('o.')} AS liquido,
          count(*)::int AS pedidos,
          count(*) FILTER (WHERE o.channel = '${CANAL_CORTESIA}')::int AS pedidos_cortesia,
          count(*) FILTER (WHERE o.customer_id IS NULL)::int AS sem_cliente,
          count(DISTINCT o.customer_id)::int AS clientes,
          COALESCE(SUM(oi.n),0)::int AS ingressos,
          COALESCE(SUM(oi.n) FILTER (WHERE o.channel = '${CANAL_CORTESIA}'),0)::int AS ingressos_cortesia,
          MIN(o.paid_at) AS primeira, MAX(o.paid_at) AS ultima,
          to_char(MIN(o.paid_at), 'YYYY-MM-DD') AS primeiro_dia
     FROM orders o ${ITENS}
    WHERE ${onde}`

const SQL_POR_DIA = (onde: string) =>
  `SELECT to_char(date_trunc('day', o.paid_at), 'YYYY-MM-DD') AS dia,
          count(*)::int AS pedidos,
          COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
          ${SQL_LIQUIDO('o.')} AS liquido
     FROM orders o
    WHERE ${onde} AND o.paid_at IS NOT NULL
    GROUP BY 1 ORDER BY 1`

/** O resumo em números, com os campos antigos (iguais ao relatório do evento) e a decomposição nova. */
function montarResumo(resumo: any) {
  const pedidos = Number(resumo.pedidos)
  const ingressos = Number(resumo.ingressos)
  const cobrado = Number(resumo.cobrado)
  const pedidosCortesia = Number(resumo.pedidos_cortesia ?? 0)
  const ingressosCortesia = Number(resumo.ingressos_cortesia ?? 0)
  const pedidosVenda = pedidos - pedidosCortesia
  const ingressosVenda = ingressos - ingressosCortesia
  return {
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

    // ---- a decomposição (27/09): nenhum campo acima mudou de conta --------
    // a parcela da plataforma que o líquido desconta: cobrado − isto − estornado = líquido
    taxaPlataformaCents: Number(resumo.plataforma ?? 0),
    // cortesia é o pedido de R$ 0,00 do canal `cortesia` (a mesma marca do borderô): ela não
    // é venda, e contada como pedido derrubava o ticket médio a cada convite (auditoria REL-06)
    pedidosCortesia, ingressosCortesia, pedidosVenda, ingressosVenda,
    ticketMedioVendaCents: pedidosVenda > 0 ? Math.round(cobrado / pedidosVenda) : 0,
  }
}

export default defineEventHandler(async (event) => {
  const orgId = (event.context as any).sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })
  const papel = (event.context as any).papel as Papel | undefined

  const consulta = getQuery(event) as Record<string, string | undefined>
  const { evento } = consulta
  let { de, ate } = consulta
  if (evento && !UUID.test(evento)) {
    throw createError({ statusCode: 400, statusMessage: 'Evento inválido.' })
  }
  for (const [nome, v] of [['inicial', de], ['final', ate]] as const) {
    if (v && !diaDeCalendario(v)) {
      throw createError({ statusCode: 400,
        statusMessage: `A data ${nome} não é uma data válida. Use dia, mês e ano.` })
    }
  }
  if (de && ate && de > ate) {
    throw createError({ statusCode: 400, statusMessage: 'A data inicial vem depois da final.' })
  }
  if (consulta.periodo !== undefined && !ehChavePeriodo(consulta.periodo)) {
    throw createError({ statusCode: 400, statusMessage: 'Período desconhecido. Escolha um dos atalhos da tela.' })
  }

  // O atalho só vale quando ninguém digitou data: as datas à mão ganham.
  const hoje = hojeNoParque()
  const periodo: ChavePeriodo | null = !de && !ate && consulta.periodo ? consulta.periodo as ChavePeriodo : null
  if (periodo) {
    const f = faixaDoPeriodo(periodo, hoje)
    de = f.de ?? undefined
    ate = f.ate ?? undefined
  }

  // O recorte, montado uma vez e usado por todas as consultas abaixo — é o que
  // garante que resumo, curva e quebras falam da MESMA população de pedidos.
  const { params, onde: ONDE } = ondeDoDinheiro({ orgId, evento, de, ate })

  /**
   * O recorte da Cobrança é OUTRO, de propósito: todo o resto desta rota usa
   * `PEDIDO_VIVO` (só pago/estornado parcial) e filtra por `paid_at`, que é
   * NULO em quem nunca pagou. Um funil que só soubesse contar quem já pagou
   * não seria funil — a pergunta aqui é "de quem tentou comprar no período,
   * quanto virou dinheiro e quanto ficou pra trás", por isso o filtro de data
   * é por `created_at` (existe sempre) e todo status entra, exceto rascunho
   * (carrinho que nem chegou a existir pro comprador).
   */
  const paramsFunil: any[] = [orgId]
  const condFunil = [`o.org_id = $1`, `o.status <> 'rascunho'`]
  if (evento) { paramsFunil.push(evento); condFunil.push(`o.event_id = $${paramsFunil.length}`) }
  if (de) { paramsFunil.push(de); condFunil.push(`o.created_at >= $${paramsFunil.length}::date`) }
  if (ate) { paramsFunil.push(ate); condFunil.push(`o.created_at < ($${paramsFunil.length}::date + 1)`) }
  const ONDE_FUNIL = condFunil.join(' AND ')

  /**
   * A devolução em QUALQUER status (o estorno total incluso), pelo dia do pagamento — a mesma régua
   * do dashboard do evento (`estornadoCents`). `estornadoNoLiquidoCents` do resumo é só a parte
   * dos pedidos vivos, a que fecha a conta do líquido; os dois aparecem, cada um com o seu nome.
   */
  const paramsDev: any[] = [orgId]
  const condDev = [`o.org_id = $1`]
  if (evento) { paramsDev.push(evento); condDev.push(`o.event_id = $${paramsDev.length}`) }
  if (de) { paramsDev.push(de); condDev.push(`o.paid_at >= $${paramsDev.length}::date`) }
  if (ate) { paramsDev.push(ate); condDev.push(`o.paid_at < ($${paramsDev.length}::date + 1)`) }

  const [resumo, porDia, porEvento, porForma, porCanal, base, porCidade, porFaixa, top, funil, porTipo, devolvido] =
    await Promise.all([
      q1<any>(SQL_RESUMO(ONDE), params),
      q<any>(SQL_POR_DIA(ONDE), params),

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
                ${SQL_LIQUIDO('o.')} AS liquido,
                COALESCE(SUM(oi.n),0)::int AS ingressos
           FROM orders o ${ITENS}
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

      q<any>(
        `SELECT o.status, count(*)::int AS n,
                COALESCE(SUM(o.total_cents),0)::bigint AS cobrado
           FROM orders o
          WHERE ${ONDE_FUNIL}
          GROUP BY 1 ORDER BY 2 DESC`, paramsFunil),

      // Por tipo de ingresso (Inteira, Meia, Criança…): quantidade e o valor dos ingressos pela
      // MESMA conta do quadro por lote do dashboard do evento (`quantidade × unit_total_cents`),
      // que é o preço de tabela do item — antes de cupom e de devolução, por isso não é o cobrado.
      // LEFT JOIN no tipo: lote vendido sem tipo aparece como "Sem tipo", não some. Cortesia fora.
      q<any>(
        `SELECT COALESCE(tt.name, 'Sem tipo') AS tipo,
                COALESCE(SUM(oi.quantity),0)::int AS ingressos,
                COALESCE(SUM(oi.quantity * oi.unit_total_cents),0)::bigint AS valor
           FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
           LEFT JOIN ticket_types tt ON tt.id = oi.ticket_type_id
          WHERE ${ONDE} AND o.channel <> '${CANAL_CORTESIA}'
          GROUP BY 1 ORDER BY 3 DESC, 1`, params),

      q1<any>(
        `SELECT COALESCE(SUM(o.refunded_cents),0)::bigint AS total
           FROM orders o WHERE ${condDev.join(' AND ')}`, paramsDev),
    ])

  const faixas = new Map<string, number>(porFaixa.map((f: any) => [f.faixa, Number(f.clientes)]))

  // A comparação: o período de MESMO tamanho imediatamente antes (só existe com as duas pontas).
  const antes = periodoAnterior(de ?? null, ate ?? null)
  let anterior: null | { de: string; ate: string; resumo: ReturnType<typeof montarResumo>; porDia: any[] } = null
  if (antes) {
    const r = ondeDoDinheiro({ orgId, evento, de: antes.de, ate: antes.ate })
    const [resumoAntes, porDiaAntes] = await Promise.all([
      q1<any>(SQL_RESUMO(r.onde), r.params), q<any>(SQL_POR_DIA(r.onde), r.params),
    ])
    anterior = {
      ...antes,
      resumo: montarResumo(resumoAntes),
      porDia: porDiaAntes.map((d) => ({
        dia: d.dia, pedidos: d.pedidos, cobradoCents: Number(d.cobrado), liquidoCents: Number(d.liquido),
      })),
    }
  }

  const veContato = !!papel && papelPode(papel, 'clientes')

  return {
    filtro: {
      evento: evento ?? null, de: de ?? null, ate: ate ?? null, periodo,
      // o calendário do parque, pra tela desenhar o eixo de "Tudo" sem adivinhar o fuso
      hoje, primeiroDia: resumo.primeiro_dia ?? null,
    },
    resumo: {
      ...montarResumo(resumo),
      devolvidoTotalCents: Number(devolvido?.total ?? 0),
    },
    anterior,
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
      canal: c.canal, pedidos: c.pedidos, ingressos: Number(c.ingressos ?? 0),
      cobradoCents: Number(c.cobrado), liquidoCents: Number(c.liquido),
    })),
    porTipo: porTipo.map((t) => ({
      tipo: t.tipo, ingressos: Number(t.ingressos), valorCents: Number(t.valor),
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
      id: c.id, nome: c.name,
      // o e-mail inteiro é da base de clientes (só do master); o resto vê mascarado
      email: veContato ? c.email : mascararEmail(c.email),
      pedidos: c.pedidos, ingressos: c.ingressos,
      gastoCents: Number(c.gasto),
    })),
    // Cobrança: todo pedido que saiu do rascunho, não só quem pagou — a régua
    // e o comentário de `ONDE_FUNIL` explicam o porquê do recorte diferente.
    cobranca: {
      criados: funil.reduce((s: number, f: any) => s + Number(f.n), 0),
      porStatus: funil.map((f: any) => ({
        status: f.status, pedidos: Number(f.n), cobradoCents: Number(f.cobrado),
      })),
    },
  }
})
