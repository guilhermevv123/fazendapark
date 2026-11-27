/**
 * GET /api/comandas/gestao/resumo?dia=AAAA-MM-DD — o resumo do dia.
 *
 * Quanto foi vendido (itens lançados no dia, sem os cancelados), quanto entrou por forma de
 * pagamento, quantas contas por situação, quem saiu sem pagar, correções, e os recortes por
 * atendente, por ponto, por hora e os itens mais vendidos.
 *
 * O FECHAMENTO (hora em Equipe e regras, padrão 18:00): antes dele, conta aberta é cliente
 * ainda no parque; depois, conta com saldo vira "saiu sem pagar". Nada disso é gravado — é
 * calculado a cada chamada, então quem paga às 18:30 sai da lista na hora e aparece em
 * "pagaram depois do fechamento".
 */
import { configDaComanda, exigirNivel, intervaloDoDia, SQL_PAGO, SQL_TOTAL } from '../../../utils/comandas'
import { q, q1 } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = exigirNivel(event, 'gerente')
  const { dia, inicio, fim } = intervaloDoDia(getQuery(event).dia)
  const par = [c.orgId, inicio, fim]
  const ITENS_DO_DIA = `FROM comanda_lancamento_itens i JOIN comanda_lancamentos l ON l.id = i.lancamento_id
                        WHERE l.org_id = $1 AND l.feito_em BETWEEN $2 AND $3`

  const [vendas, formas, situacoes, atendentes, pontos, horas, itens, correcoes, quemRecebeu] = await Promise.all([
    q1<any>(`SELECT COALESCE(SUM(i.preco_cents * i.quantidade - i.desconto_cents) FILTER (WHERE NOT i.cancelado), 0) AS vendido,
                    COALESCE(SUM(i.preco_cents * i.quantidade) FILTER (WHERE i.cancelado), 0) AS cancelado,
                    COALESCE(SUM(i.desconto_cents) FILTER (WHERE NOT i.cancelado), 0) AS desconto,
                    (SELECT COALESCE(SUM(desconto_cents), 0) FROM comandas WHERE org_id = $1 AND aberta_em BETWEEN $2 AND $3) AS desconto_conta,
                    COUNT(DISTINCT l.id) AS pedidos ${ITENS_DO_DIA}`, par),
    q<any>(`SELECT forma, SUM(valor_cents) AS total, COUNT(*) AS n FROM comanda_pagamentos
             WHERE org_id = $1 AND NOT anulado AND feito_em BETWEEN $2 AND $3 GROUP BY forma`, par),
    q<any>(`SELECT situacao, COUNT(*) AS n FROM comandas WHERE org_id = $1 AND aberta_em BETWEEN $2 AND $3 GROUP BY situacao`, par),
    q<any>(`SELECT COALESCE(u.name, '—') AS nome, COUNT(DISTINCT l.id) AS pedidos,
                   SUM(i.preco_cents * i.quantidade - i.desconto_cents) FILTER (WHERE NOT i.cancelado) AS vendido,
                   COUNT(*) FILTER (WHERE i.cancelado) AS cancelados
              ${ITENS_DO_DIA.replace('WHERE', 'LEFT JOIN LATERAL (SELECT COALESCE((SELECT k.nome FROM comanda_links k WHERE k.id = l.link_id), (SELECT x.name FROM users x WHERE x.id = l.atendente_id)) AS name) u ON true WHERE')}
             GROUP BY u.name ORDER BY vendido DESC NULLS LAST`, par),
    q<any>(`SELECT COALESCE(p.nome, 'Sem ponto') AS nome,
                   SUM(i.preco_cents * i.quantidade - i.desconto_cents) FILTER (WHERE NOT i.cancelado) AS vendido
              ${ITENS_DO_DIA.replace('WHERE', 'LEFT JOIN comanda_pontos p ON p.id = l.ponto_id WHERE')}
             GROUP BY p.nome ORDER BY vendido DESC NULLS LAST`, par),
    q<any>(`SELECT EXTRACT(HOUR FROM l.feito_em AT TIME ZONE 'America/Bahia')::int AS hora,
                   SUM(i.preco_cents * i.quantidade - i.desconto_cents) FILTER (WHERE NOT i.cancelado) AS vendido
              ${ITENS_DO_DIA} GROUP BY 1 ORDER BY 1`, par),
    q<any>(`SELECT i.nome, SUM(i.quantidade) AS qtd, SUM(i.preco_cents * i.quantidade - i.desconto_cents) AS vendido
              ${ITENS_DO_DIA} AND NOT i.cancelado GROUP BY i.nome ORDER BY qtd DESC LIMIT 15`, par),
    q<any>(`SELECT h.quando, h.quem_nome, h.acao, h.descricao, c.numero, c.nome, c.id AS comanda_id
              FROM comanda_historico h LEFT JOIN comandas c ON c.id = h.comanda_id
             WHERE h.org_id = $1 AND h.quando BETWEEN $2 AND $3
               AND h.acao IN ('cancelar_item','corrigir_quantidade','trocar_item','desconto_item','desconto_conta','desfazer_pedido',
                              'reabrir','anular_pagamento','forma_pagamento','perdoar','limite','mover_saida','pedido_apos_fechar')
             ORDER BY h.quando DESC`, par),
    q<any>(`SELECT COALESCE(u.name, '—') AS nome, p.forma, SUM(p.valor_cents) AS total
              FROM comanda_pagamentos p LEFT JOIN LATERAL (SELECT COALESCE((SELECT k.nome FROM comanda_links k WHERE k.id = p.link_id), (SELECT x.name FROM users x WHERE x.id = p.feito_por)) AS name) u ON true
             WHERE p.org_id = $1 AND NOT p.anulado AND p.feito_em BETWEEN $2 AND $3
             GROUP BY u.name, p.forma ORDER BY u.name`, par),
  ])

  // o fechamento do dia: "18:00" no fuso da Bahia (UTC−3 o ano todo)
  const { horaFechamento } = await configDaComanda(c.orgId)
  const fechamentoEm = new Date(`${dia}T${horaFechamento}:00-03:00`)
  const passouDoFechamento = Date.now() >= fechamentoEm.getTime()

  // todas as contas abertas no dia, com o que falta, quando fechou e a última pulseira
  const contasDoDia = (await q<any>(
    `SELECT c.id, c.numero, c.nome, c.responsavel_nome, c.responsavel_telefone, c.situacao, c.fechada_em, c.aberta_em,
            ${SQL_TOTAL} AS total, ${SQL_PAGO} AS pago,
            (SELECT MAX(l.feito_em) FROM comanda_lancamentos l WHERE l.comanda_id = c.id) AS ultimo_pedido_em,
            (SELECT p.uid FROM comanda_vinculos v JOIN comanda_pulseiras p ON p.id = v.pulseira_id
              WHERE v.comanda_id = c.id ORDER BY v.inicio_em DESC LIMIT 1) AS pulseira,
            (SELECT COALESCE(SUM(pg.valor_cents), 0) FROM comanda_pagamentos pg
              WHERE pg.comanda_id = c.id AND NOT pg.anulado AND pg.feito_em >= $4) AS pago_depois
       FROM comandas c
      WHERE c.org_id = $1 AND c.aberta_em BETWEEN $2 AND $3 AND c.situacao <> 'juntada'
      ORDER BY c.numero`, [...par, fechamentoEm.toISOString()]))
    .map((r) => ({ id: r.id, numero: Number(r.numero), nome: r.nome, responsavelNome: r.responsavel_nome,
      responsavelTelefone: r.responsavel_telefone, situacao: r.situacao, abertaEm: r.aberta_em, fechadaEm: r.fechada_em,
      ultimoPedidoEm: r.ultimo_pedido_em, pulseira: r.pulseira, totalCents: Number(r.total),
      faltaCents: Math.max(Number(r.total) - Number(r.pago), 0), pagoDepoisCents: Number(r.pago_depois) }))
  const devendo = contasDoDia.filter((x) => x.faltaCents > 0 && ['aberta', 'nao_paga', 'cobrada'].includes(x.situacao))
  const naoPagas = passouDoFechamento ? devendo : devendo.filter((x) => x.situacao !== 'aberta')
  const pagasDepois = contasDoDia.filter((x) => ['paga', 'paga_depois'].includes(x.situacao)
    && x.fechadaEm && new Date(x.fechadaEm).getTime() >= fechamentoEm.getTime())

  const porForma: Record<string, number> = { dinheiro: 0, pix: 0, debito: 0, credito: 0 }
  for (const f of formas) porForma[f.forma] = Number(f.total)
  const recebido = Object.values(porForma).reduce((s, v) => s + v, 0)
  const porSituacao: Record<string, number> = {}
  for (const s of situacoes) porSituacao[s.situacao] = Number(s.n)

  const prestacao = new Map<string, Record<string, number>>()
  for (const r of quemRecebeu) {
    const m = prestacao.get(r.nome) ?? { dinheiro: 0, pix: 0, debito: 0, credito: 0 }
    m[r.forma] = Number(r.total)
    prestacao.set(r.nome, m)
  }

  return {
    dia,
    vendidoCents: Number(vendas?.vendido ?? 0),
    canceladoCents: Number(vendas?.cancelado ?? 0),
    descontoCents: Number(vendas?.desconto ?? 0) + Number(vendas?.desconto_conta ?? 0),
    descontoContaCents: Number(vendas?.desconto_conta ?? 0),
    pedidos: Number(vendas?.pedidos ?? 0),
    recebidoCents: recebido,
    porForma,
    fechamento: { hora: horaFechamento, em: fechamentoEm.toISOString(), passou: passouDoFechamento },
    naoPagoCents: naoPagas.reduce((s, n) => s + n.faltaCents, 0),
    aindaNoParque: passouDoFechamento ? [] : devendo.filter((x) => x.situacao === 'aberta'),
    pagasDepois,
    pagoDepoisCents: pagasDepois.reduce((s, n) => s + n.pagoDepoisCents, 0),
    contas: {
      total: Object.values(porSituacao).reduce((s, v) => s + v, 0),
      ...porSituacao,
    },
    naoPagas,
    // contas ainda abertas sem nada a pagar (pedido desfeito, tudo pago): só falta soltar a pulseira
    abertasSemValor: passouDoFechamento ? contasDoDia.filter((x) => x.situacao === 'aberta' && x.faltaCents <= 0).map((x) => x.id) : [],
    porAtendente: atendentes.map((a) => ({ nome: a.nome, pedidos: Number(a.pedidos), vendidoCents: Number(a.vendido ?? 0), cancelados: Number(a.cancelados) })),
    porPonto: pontos.map((p) => ({ nome: p.nome, vendidoCents: Number(p.vendido ?? 0) })),
    porHora: horas.map((h) => ({ hora: Number(h.hora), vendidoCents: Number(h.vendido ?? 0) })),
    maisVendidos: itens.map((i) => ({ nome: i.nome, quantidade: Number(i.qtd), vendidoCents: Number(i.vendido) })),
    correcoes: correcoes.map((h) => ({ quando: h.quando, quem: h.quem_nome, acao: h.acao, descricao: h.descricao,
      comandaId: h.comanda_id, numero: h.numero ? Number(h.numero) : null, nome: h.nome })),
    prestacaoDeContas: [...prestacao.entries()].map(([nome, f]) => ({ nome, ...f,
      totalCents: f.dinheiro + f.pix + f.debito + f.credito })),
  }
})
