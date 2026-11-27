/**
 * GET /api/comandas/gestao/vendas?de=AAAA-MM-DD&ate=AAAA-MM-DD — as vendas de um período.
 *
 * Tudo o que saiu pelas comandas entre `de` e `ate` (padrão: hoje): números gerais, e os
 * recortes por item (todos, não só os mais vendidos), categoria, local, atendente, dia,
 * hora e forma de pagamento. Cancelados ficam fora das vendas e aparecem à parte.
 */
import { exigirNivel, intervaloDoDia } from '../../../utils/comandas'
import { q, q1 } from '../../../utils/db'

const VENDA = 'i.preco_cents * i.quantidade - i.desconto_cents'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = exigirNivel(event, 'gerente')
  const qy = getQuery(event)
  const de = intervaloDoDia(qy.de)
  let ate = intervaloDoDia(qy.ate ?? de.dia)
  if (ate.dia < de.dia) ate = de
  const dias = Math.round((Date.parse(ate.dia) - Date.parse(de.dia)) / 86_400_000) + 1
  if (dias > 370) throw createError({ statusCode: 400, statusMessage: 'Escolha um período de até 1 ano.' })
  const par = [c.orgId, de.inicio, ate.fim]
  const ITENS = `FROM comanda_lancamento_itens i JOIN comanda_lancamentos l ON l.id = i.lancamento_id
                 LEFT JOIN comanda_itens ci ON ci.id = i.item_id
                 LEFT JOIN comanda_categorias k ON k.id = ci.categoria_id
                 LEFT JOIN comanda_pontos p ON p.id = l.ponto_id
                 LEFT JOIN LATERAL (SELECT COALESCE((SELECT k.nome FROM comanda_links k WHERE k.id = l.link_id), (SELECT x.name FROM users x WHERE x.id = l.atendente_id)) AS name) u ON true
                WHERE l.org_id = $1 AND l.feito_em BETWEEN $2 AND $3`
  const DIA = `(l.feito_em AT TIME ZONE 'America/Bahia')`

  const [geral, contas, formas, porItem, porCategoria, porLocal, porAtendente, porDia, porHora, porDiaSemana] = await Promise.all([
    q1<any>(`SELECT COALESCE(SUM(${VENDA}) FILTER (WHERE NOT i.cancelado), 0) AS vendido,
                    COALESCE(SUM(i.quantidade) FILTER (WHERE NOT i.cancelado), 0) AS itens,
                    COALESCE(SUM(i.preco_cents * i.quantidade) FILTER (WHERE i.cancelado), 0) AS cancelado,
                    COUNT(*) FILTER (WHERE i.cancelado) AS itens_cancelados,
                    COALESCE(SUM(i.desconto_cents) FILTER (WHERE NOT i.cancelado), 0) AS desconto,
                    (SELECT COALESCE(SUM(desconto_cents), 0) FROM comandas WHERE org_id = $1 AND aberta_em BETWEEN $2 AND $3) AS desconto_conta,
                    COUNT(DISTINCT l.id) AS pedidos,
                    COUNT(DISTINCT l.id) FILTER (WHERE l.feito_sem_internet) AS sem_internet,
                    COUNT(DISTINCT l.comanda_id) AS contas_com_consumo ${ITENS}`, par),
    q<any>(`SELECT situacao, COUNT(*) AS n FROM comandas WHERE org_id = $1 AND aberta_em BETWEEN $2 AND $3 GROUP BY situacao`, par),
    q<any>(`SELECT forma, SUM(valor_cents) AS total, COUNT(*) AS n FROM comanda_pagamentos
             WHERE org_id = $1 AND NOT anulado AND feito_em BETWEEN $2 AND $3 GROUP BY forma`, par),
    q<any>(`SELECT i.nome, COALESCE(k.nome, 'Sem categoria') AS categoria, SUM(i.quantidade) AS qtd,
                   SUM(${VENDA}) AS vendido, ROUND(AVG(i.preco_cents)) AS preco_medio,
                   COUNT(DISTINCT l.comanda_id) AS contas
              ${ITENS} AND NOT i.cancelado GROUP BY i.nome, k.nome ORDER BY vendido DESC`, par),
    q<any>(`SELECT COALESCE(k.nome, 'Sem categoria') AS nome, SUM(i.quantidade) AS qtd, SUM(${VENDA}) AS vendido
              ${ITENS} AND NOT i.cancelado GROUP BY k.nome ORDER BY vendido DESC`, par),
    q<any>(`SELECT COALESCE(p.nome, 'Sem local') AS nome, COUNT(DISTINCT l.id) AS pedidos, SUM(i.quantidade) AS qtd, SUM(${VENDA}) AS vendido,
                   (array_agg(i.nome ORDER BY i.quantidade DESC))[1] AS destaque
              ${ITENS} AND NOT i.cancelado GROUP BY p.nome ORDER BY vendido DESC`, par),
    q<any>(`SELECT COALESCE(u.name, '—') AS nome, COUNT(DISTINCT l.id) AS pedidos, SUM(i.quantidade) FILTER (WHERE NOT i.cancelado) AS qtd,
                   COALESCE(SUM(${VENDA}) FILTER (WHERE NOT i.cancelado), 0) AS vendido,
                   COUNT(*) FILTER (WHERE i.cancelado) AS cancelados
              ${ITENS} GROUP BY u.name ORDER BY vendido DESC`, par),
    q<any>(`SELECT to_char(${DIA}, 'YYYY-MM-DD') AS dia, COUNT(DISTINCT l.id) AS pedidos, SUM(${VENDA}) AS vendido
              ${ITENS} AND NOT i.cancelado GROUP BY 1 ORDER BY 1`, par),
    q<any>(`SELECT EXTRACT(HOUR FROM ${DIA})::int AS hora, COUNT(DISTINCT l.id) AS pedidos, SUM(${VENDA}) AS vendido
              ${ITENS} AND NOT i.cancelado GROUP BY 1 ORDER BY 1`, par),
    q<any>(`SELECT EXTRACT(ISODOW FROM ${DIA})::int AS dsem, SUM(${VENDA}) AS vendido
              ${ITENS} AND NOT i.cancelado GROUP BY 1 ORDER BY 1`, par),
  ])

  const n = (v: unknown) => Number(v ?? 0)
  const vendido = n(geral?.vendido)
  const porForma: Record<string, number> = { dinheiro: 0, pix: 0, debito: 0, credito: 0 }
  for (const f of formas) porForma[f.forma] = n(f.total)
  const recebido = Object.values(porForma).reduce((s, v) => s + v, 0)
  const porSituacao: Record<string, number> = {}
  for (const s of contas) porSituacao[s.situacao] = n(s.n)
  const contasComConsumo = n(geral?.contas_com_consumo)

  return {
    de: de.dia,
    ate: ate.dia,
    dias,
    vendidoCents: vendido,
    recebidoCents: recebido,
    itens: n(geral?.itens),
    pedidos: n(geral?.pedidos),
    pedidosSemInternet: n(geral?.sem_internet),
    canceladoCents: n(geral?.cancelado),
    itensCancelados: n(geral?.itens_cancelados),
    // desconto na conta inteira não está nos itens: o vendido segue pelos itens e o desconto aparece aqui
    descontoCents: n(geral?.desconto) + n(geral?.desconto_conta),
    descontoContaCents: n(geral?.desconto_conta),
    contas: { total: Object.values(porSituacao).reduce((s, v) => s + v, 0), comConsumo: contasComConsumo, ...porSituacao },
    ticketMedioCents: contasComConsumo ? Math.round(vendido / contasComConsumo) : 0,
    mediaPorPedidoCents: n(geral?.pedidos) ? Math.round(vendido / n(geral?.pedidos)) : 0,
    mediaPorDiaCents: Math.round(vendido / dias),
    porForma,
    porItem: porItem.map((i) => ({ nome: i.nome, categoria: i.categoria, quantidade: n(i.qtd), vendidoCents: n(i.vendido),
      precoMedioCents: n(i.preco_medio), contas: n(i.contas) })),
    porCategoria: porCategoria.map((k) => ({ nome: k.nome, quantidade: n(k.qtd), vendidoCents: n(k.vendido) })),
    porLocal: porLocal.map((p) => ({ nome: p.nome, pedidos: n(p.pedidos), quantidade: n(p.qtd), vendidoCents: n(p.vendido), destaque: p.destaque })),
    porAtendente: porAtendente.map((a) => ({ nome: a.nome, pedidos: n(a.pedidos), quantidade: n(a.qtd), vendidoCents: n(a.vendido), cancelados: n(a.cancelados) })),
    porDia: porDia.map((d) => ({ dia: d.dia, pedidos: n(d.pedidos), vendidoCents: n(d.vendido) })),
    porHora: porHora.map((h) => ({ hora: n(h.hora), pedidos: n(h.pedidos), vendidoCents: n(h.vendido) })),
    porDiaDaSemana: porDiaSemana.map((d) => ({ dia: n(d.dsem), vendidoCents: n(d.vendido) })),
  }
})
