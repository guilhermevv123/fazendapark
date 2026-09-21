/**
 * GET /api/admin/evento/:id/extrato — o dinheiro linha a linha.
 *
 * O borderô fecha o total; este responde "de onde veio cada real". É o
 * relatório que o contador pede e o único que resolve discussão sobre número,
 * porque dá pra apontar a linha.
 *
 * Três decisões que mudam o resultado e por isso ficam explícitas:
 *
 * 1. **A régua é a data de PAGAMENTO.** Filtrar por criação joga a venda no
 *    dia em que o pix foi gerado, não no dia em que o dinheiro entrou — e aí
 *    o extrato nunca fecha com o extrato bancário.
 *
 * 2. **Estorno é linha, não subtração.** Um pedido estornado aparece com o
 *    valor original e com o estorno ao lado. Abater em silêncio faz o total
 *    bater e a história sumir: ninguém consegue explicar por que o dia caiu.
 *
 * 3. **Líquido do produtor depende de quem pagou a taxa.** No online a taxa é
 *    repassada (o produtor recebe a face); no balcão ela é absorvida (o
 *    produtor recebe a face menos a taxa). São dois números diferentes na
 *    mesma tela e é por isso que existe uma coluna pra cada um.
 */
import { q, q1 } from '../../../../utils/db'
import { SQL_LIQUIDO } from "../../../../utils/liquido"

const CANAL_LEGIVEL: Record<string, string> = {
  online: 'Site',
  bilheteria: 'Bilheteria',
  pdv_produtor: 'PDV do produtor',
  pdv_ticketeira: 'PDV da ticketeira',
  cortesia: 'Cortesia',
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const query = getQuery(event)

  const de = query.de ? String(query.de) : null
  const ate = query.ate ? String(query.ate) : null
  const canal = query.canal ? String(query.canal) : ''
  const ponto = query.ponto ? String(query.ponto) : ''
  const forma = query.forma ? String(query.forma) : ''
  const limite = Math.min(Number(query.limite ?? 300), 2000)

  const ev = await q1<any>(
    `SELECT id, name, fee_bps, fee_mode_online, fee_mode_pos FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  // Os filtros viram uma condição só, montada uma vez e reaproveitada por
  // todas as consultas. Montar duas vezes é como o total do rodapé passa a
  // discordar da soma das linhas.
  // Todo estado em que o dinheiro CHEGOU a entrar. `chargeback` e `disputa`
  // ficam na lista de propósito: sumir com eles faz o extrato parar de bater
  // com o banco justamente no mês em que alguém contestou uma compra.
  const cond: string[] = [
    `o.event_id = $1`,
    `o.status IN ('pago','estornado','estornado_parcial','chargeback','disputa')`,
  ]
  const par: any[] = [id]
  const põe = (sql: string, v: any) => { par.push(v); cond.push(sql.replace('$?', `$${par.length}`)) }

  if (de) põe(`o.paid_at >= $?::date`, de)
  // `< data + 1 dia` em vez de `<= data`: com `<=`, tudo que foi pago depois
  // da meia-noite do último dia fica de fora e o mês fecha faltando um dia.
  if (ate) põe(`o.paid_at < ($?::date + interval '1 day')`, ate)
  if (canal) põe(`o.channel = $?`, canal)
  if (ponto) põe(`o.pos_terminal_id = $?::uuid`, ponto)
  if (forma) põe(`o.payment_method = $?`, forma)

  const onde = cond.join(' AND ')

  const [linhas, porCanal, porPonto, porForma, porDia, totais, pontos] = await Promise.all([
    q<any>(
      `SELECT o.id, o.code, o.status, o.channel, o.payment_method, o.installments,
              o.face_cents, o.fee_cents, o.platform_cents, o.discount_cents,
              o.total_cents, o.refunded_cents, o.paid_at, o.refunded_at,
              o.cash_received_cents, o.change_cents,
              c.name AS comprador, c.email AS comprador_email, c.document AS comprador_doc,
              t.name AS ponto, u.name AS operador,
              pr.name AS promoter, pc.code AS cupom,
              (SELECT count(*)::int FROM tickets k WHERE k.order_id = o.id) AS ingressos
         FROM orders o
         LEFT JOIN customers c ON c.id = o.customer_id
         LEFT JOIN pos_terminals t ON t.id = o.pos_terminal_id
         LEFT JOIN users u ON u.id = o.sold_by
         LEFT JOIN promoters pr ON pr.id = o.promoter_id
         LEFT JOIN promo_codes pc ON pc.id = o.promo_code_id
        WHERE ${onde}
        ORDER BY o.paid_at DESC NULLS LAST
        LIMIT ${limite}`, par),

    q<any>(
      `SELECT o.channel, count(*)::int AS pedidos,
              COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
              COALESCE(SUM(o.face_cents),0)::bigint  AS face,
              COALESCE(SUM(o.platform_cents),0)::bigint AS taxa,
              COALESCE(SUM(o.fee_cents),0)::bigint AS taxa_do_comprador,
              COALESCE(SUM(o.refunded_cents),0)::bigint AS estornado,
              ${SQL_LIQUIDO('o.')} AS liquido,
              COALESCE(SUM((SELECT count(*) FROM tickets k WHERE k.order_id = o.id)),0)::int AS ingressos
         FROM orders o WHERE ${onde} GROUP BY 1 ORDER BY 2 DESC`, par),

    // `LEFT JOIN`, não `JOIN`: venda de balcão sem ponto registrado existe
    // (importação, seed, venda anterior ao cadastro do guichê) e precisa
    // aparecer. Com `JOIN` ela sumia daqui e continuava no total por canal —
    // dois quadros da mesma tela discordando sem explicação nenhuma.
    q<any>(
      `SELECT t.id, t.name AS ponto, u.name AS operador, count(*)::int AS pedidos,
              COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
              COALESCE(SUM(CASE WHEN o.payment_method = 'dinheiro' THEN o.total_cents END),0)::bigint
                AS dinheiro,
              COALESCE(SUM((SELECT count(*) FROM tickets k WHERE k.order_id = o.id)),0)::int AS ingressos
         FROM orders o
         LEFT JOIN pos_terminals t ON t.id = o.pos_terminal_id
         LEFT JOIN users u ON u.id = o.sold_by
        WHERE ${onde} AND o.channel IN ('bilheteria','pdv_produtor','pdv_ticketeira')
        GROUP BY 1,2,3 ORDER BY 5 DESC`, par),

    q<any>(
      `SELECT o.payment_method AS forma, count(*)::int AS pedidos,
              COALESCE(SUM(o.total_cents),0)::bigint AS cobrado
         FROM orders o WHERE ${onde} GROUP BY 1 ORDER BY 3 DESC`, par),

    q<any>(
      `SELECT date_trunc('day', o.paid_at) AS dia, count(*)::int AS pedidos,
              COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
              COALESCE(SUM(o.face_cents),0)::bigint AS face,
              COALESCE(SUM(o.platform_cents),0)::bigint AS taxa,
              COALESCE(SUM((SELECT count(*) FROM tickets k WHERE k.order_id = o.id)),0)::int AS ingressos
         FROM orders o WHERE ${onde} AND o.paid_at IS NOT NULL
        GROUP BY 1 ORDER BY 1 DESC`, par),

    q1<any>(
      `SELECT count(*)::int AS pedidos,
              COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
              COALESCE(SUM(o.face_cents),0)::bigint  AS face,
              COALESCE(SUM(o.fee_cents),0)::bigint   AS taxa_comprador,
              COALESCE(SUM(o.platform_cents),0)::bigint AS taxa_plataforma,
              COALESCE(SUM(o.discount_cents),0)::bigint AS desconto,
              COALESCE(SUM(o.refunded_cents),0)::bigint AS estornado,
              COALESCE(SUM((SELECT count(*) FROM tickets k WHERE k.order_id = o.id)),0)::int AS ingressos
         FROM orders o WHERE ${onde}`, par),

    // a lista de pontos não usa os filtros: é o seletor da tela, e um
    // seletor que some quando o filtro esvazia deixa o usuário sem saída
    q<any>(`SELECT id, name FROM pos_terminals WHERE event_id = $1 ORDER BY name`, [id]),
  ])

  /**
   * "Quem pagou a taxa" aqui é LIDO dos pedidos, não da configuração.
   *
   * A primeira versão olhava `fee_mode_pos` e errava: no evento semeado o
   * mesmo canal de bilheteria tem 10 pedidos que repassaram a taxa e 3 que a
   * absorveram, porque o modo mudou no meio. Configuração diz o que vai
   * acontecer na próxima venda; o pedido diz o que aconteceu naquela.
   */
  const quemPagouATaxa = (l: any) => {
    const taxa = Number(l.taxa)
    if (!taxa) return null
    const doComprador = Number(l.taxa_do_comprador)
    if (doComprador >= taxa) return 'comprador'
    if (doComprador === 0) return 'produtor'
    return 'os dois'
  }

  return {
    evento: { id: ev.id, nome: ev.name, feeBps: Number(ev.fee_bps),
              modoOnline: ev.fee_mode_online, modoBalcao: ev.fee_mode_pos },
    filtros: { de, ate, canal, ponto, forma, limite },
    pontos: pontos.map((p) => ({ id: p.id, nome: p.name })),
    totais: {
      pedidos: Number(totais.pedidos), ingressos: Number(totais.ingressos),
      cobradoCents: Number(totais.cobrado), faceCents: Number(totais.face),
      taxaCompradorCents: Number(totais.taxa_comprador),
      taxaPlataformaCents: Number(totais.taxa_plataforma),
      descontoCents: Number(totais.desconto), estornadoCents: Number(totais.estornado),
    },
    porCanal: porCanal.map((l) => ({
      canal: l.channel, nome: CANAL_LEGIVEL[l.channel] ?? l.channel,
      pedidos: l.pedidos, ingressos: l.ingressos,
      cobradoCents: Number(l.cobrado), faceCents: Number(l.face),
      taxaCents: Number(l.taxa), estornadoCents: Number(l.estornado),
      liquidoCents: Number(l.liquido),
      // a pergunta que o produtor faz olhando duas linhas com a mesma face e
      // líquidos diferentes; `null` quando não houve taxa nenhuma
      taxaPagaPor: quemPagouATaxa(l),
    })),
    porPonto: porPonto.map((l) => ({
      id: l.id, ponto: l.ponto ?? 'Sem ponto identificado', operador: l.operador,
      // marca a linha pra tela poder dizer POR QUE ela não tem nome, em vez
      // de mostrar um branco que parece defeito
      semPonto: l.id === null,
      pedidos: l.pedidos, ingressos: l.ingressos,
      cobradoCents: Number(l.cobrado), dinheiroCents: Number(l.dinheiro),
    })),
    porForma: porForma.map((l) => ({
      forma: l.forma ?? 'não informada', pedidos: l.pedidos, cobradoCents: Number(l.cobrado),
    })),
    porDia: porDia.map((l) => ({
      dia: l.dia, pedidos: l.pedidos, ingressos: l.ingressos,
      cobradoCents: Number(l.cobrado), faceCents: Number(l.face), taxaCents: Number(l.taxa),
    })),
    linhas: linhas.map((l) => ({
      id: l.id, pedido: l.code, status: l.status,
      canal: CANAL_LEGIVEL[l.channel] ?? l.channel,
      ponto: l.ponto, operador: l.operador,
      forma: l.payment_method, parcelas: l.installments,
      comprador: l.comprador, email: l.comprador_email, documento: l.comprador_doc,
      promoter: l.promoter, cupom: l.cupom,
      ingressos: l.ingressos,
      faceCents: Number(l.face_cents), taxaCompradorCents: Number(l.fee_cents),
      taxaPlataformaCents: Number(l.platform_cents), descontoCents: Number(l.discount_cents),
      totalCents: Number(l.total_cents), estornadoCents: Number(l.refunded_cents),
      pagoEm: l.paid_at, estornadoEm: l.refunded_at,
      recebidoCents: l.cash_received_cents === null ? null : Number(l.cash_received_cents),
      trocoCents: l.change_cents === null ? null : Number(l.change_cents),
    })),
    // avisa a tela quando a lista foi cortada — total do rodapé que não bate
    // com as linhas visíveis é a reclamação mais comum de todo extrato
    truncado: linhas.length >= limite,
  }
})
