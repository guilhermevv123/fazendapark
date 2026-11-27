/**
 * GET /api/comandas/caixa — o caixa de QUEM ESTÁ LOGADO desde o último fechamento dele.
 *
 * Fechamento às cegas: Pix, débito e crédito aparecem (batem com a maquininha), o DINHEIRO
 * esperado não — a pessoa conta a gaveta e digita, e só depois vê a diferença.
 * `?todos=1` (gerente): os fechamentos do dia de toda a equipe, com as diferenças.
 */
import { exigirNivel, intervaloDoDia } from '../../utils/comandas'
import { q, q1 } from '../../utils/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = exigirNivel(event, 'atendente')
  if (getQuery(event).todos && c.nivel === 'gerente') {
    const { inicio, fim } = intervaloDoDia(getQuery(event).dia)
    const linhas = await q<any>(
      `SELECT f.*, u.name FROM comanda_fechamentos f LEFT JOIN users u ON u.id = f.user_id
        WHERE f.org_id = $1 AND f.criado_em BETWEEN $2 AND $3 ORDER BY f.criado_em DESC`, [c.orgId, inicio, fim])
    return {
      fechamentos: linhas.map((f) => ({ id: f.id, nome: f.name, desde: f.desde, ate: f.ate,
        contadoCents: Number(f.contado_cents), esperadoCents: Number(f.esperado_cents),
        diferencaCents: Number(f.contado_cents) - Number(f.esperado_cents), pixCents: Number(f.pix_cents),
        debitoCents: Number(f.debito_cents), creditoCents: Number(f.credito_cents), observacao: f.observacao, em: f.criado_em })),
    }
  }
  const ultimo = await q1<any>(`SELECT ate FROM comanda_fechamentos WHERE org_id = $1 AND user_id = $2 ORDER BY ate DESC LIMIT 1`, [c.orgId, c.usuarioId])
  const desde = ultimo?.ate ?? new Date(Date.now() - 24 * 3600_000).toISOString()
  const formas = await q<any>(
    `SELECT forma, COUNT(*) AS n, SUM(valor_cents) AS total FROM comanda_pagamentos
      WHERE org_id = $1 AND feito_por = $2 AND NOT anulado AND feito_em > $3 GROUP BY forma`, [c.orgId, c.usuarioId, desde])
  const por: Record<string, { n: number; total: number }> = {}
  for (const f of formas) por[f.forma] = { n: Number(f.n), total: Number(f.total) }
  return {
    desde,
    pagamentos: formas.reduce((s, f) => s + Number(f.n), 0),
    pixCents: por.pix?.total ?? 0,
    debitoCents: por.debito?.total ?? 0,
    creditoCents: por.credito?.total ?? 0,
    pagamentosEmDinheiro: por.dinheiro?.n ?? 0,
  }
})
