/**
 * GET /api/comandas/gestao/aovivo — a tela "Ao vivo": contas abertas agora, quanto cada uma
 * gastou, o total do dia, os tablets (e quem está sem internet) e as pendências.
 */
import { aparelhosDaOrg, exigirNivel, intervaloDoDia, resumoDaLinha, SQL_RESUMO } from '../../../utils/comandas'
import { q, q1 } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = exigirNivel(event, 'caixa')
  const { inicio, fim, dia } = intervaloDoDia()
  const [abertas, dia_, pendencias] = await Promise.all([
    q<any>(`${SQL_RESUMO} WHERE c.org_id = $1 AND c.situacao = 'aberta' ORDER BY c.aberta_em DESC`, [c.orgId]),
    q1<any>(`SELECT
               COALESCE((SELECT SUM(i.preco_cents * i.quantidade - i.desconto_cents) FROM comanda_lancamento_itens i
                  JOIN comanda_lancamentos l ON l.id = i.lancamento_id
                 WHERE l.org_id = $1 AND NOT i.cancelado AND l.feito_em BETWEEN $2 AND $3), 0) AS vendido,
               COALESCE((SELECT SUM(p.valor_cents) FROM comanda_pagamentos p
                 WHERE p.org_id = $1 AND NOT p.anulado AND p.feito_em BETWEEN $2 AND $3), 0) AS recebido,
               (SELECT COUNT(*) FROM comanda_lancamentos l WHERE l.org_id = $1 AND l.feito_em BETWEEN $2 AND $3) AS pedidos`,
    [c.orgId, inicio, fim]),
    q1<any>(`SELECT COUNT(*)::int AS n FROM comanda_lancamentos
              WHERE org_id = $1 AND chegou_depois_de_fechada AND pendencia_resolvida_em IS NULL`, [c.orgId]),
  ])
  const contas = abertas.map(resumoDaLinha)
  return {
    dia,
    contas,
    totais: {
      abertas: contas.length,
      emAbertoCents: contas.reduce((s, x) => s + x.faltaCents, 0),
      vendidoHojeCents: Number(dia_?.vendido ?? 0),
      recebidoHojeCents: Number(dia_?.recebido ?? 0),
      pedidosHoje: Number(dia_?.pedidos ?? 0),
      pertoDoLimite: contas.filter((x) => x.limiteCents > 0 && x.totalCents >= x.limiteCents * 0.8).length,
    },
    aparelhos: aparelhosDaOrg(c.orgId),
    pendencias: pendencias?.n ?? 0,
  }
})
