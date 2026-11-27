/**
 * POST /api/comandas/caixa — fecha o caixa de quem está logado: `{ contadoCents, observacao }`.
 * Grava o que foi contado e o que o sistema esperava, e só AGORA mostra a diferença.
 */
import { exigirNivel, reaisTexto, recusa, registrar, texto } from '../../utils/comandas'
import { q, q1 } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const c = exigirNivel(event, 'atendente')
  const b = (await readBody<{ contadoCents?: number; observacao?: string }>(event)) ?? {}
  const contado = Math.trunc(Number(b.contadoCents))
  if (!Number.isInteger(contado) || contado < 0) recusa('Digite quanto você contou de dinheiro na gaveta.', 'contado')
  const ultimo = await q1<any>(`SELECT ate FROM comanda_fechamentos WHERE org_id = $1 AND user_id = $2 ORDER BY ate DESC LIMIT 1`, [c.orgId, c.usuarioId])
  const desde = ultimo?.ate ?? new Date(Date.now() - 24 * 3600_000).toISOString()
  const formas = await q<any>(
    `SELECT forma, SUM(valor_cents) AS total FROM comanda_pagamentos
      WHERE org_id = $1 AND feito_por = $2 AND NOT anulado AND feito_em > $3 GROUP BY forma`, [c.orgId, c.usuarioId, desde])
  const por: Record<string, number> = { dinheiro: 0, pix: 0, debito: 0, credito: 0 }
  for (const f of formas) por[f.forma] = Number(f.total)
  const r = await q1<any>(
    `INSERT INTO comanda_fechamentos (org_id, user_id, desde, contado_cents, esperado_cents, pix_cents, debito_cents, credito_cents, observacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, ate`,
    [c.orgId, c.usuarioId, desde, contado, por.dinheiro, por.pix, por.debito, por.credito, texto(b.observacao, 300)])
  const diferenca = contado - por.dinheiro
  await registrar(null, c, { acao: 'fechar_caixa',
    descricao: `${c.nome} fechou o caixa: contou ${reaisTexto(contado)}, esperado ${reaisTexto(por.dinheiro)} — `
      + (diferenca === 0 ? 'bateu' : diferenca > 0 ? `sobrou ${reaisTexto(diferenca)}` : `faltou ${reaisTexto(-diferenca)}`) })
  return { id: r.id, desde, ate: r.ate, contadoCents: contado, esperadoCents: por.dinheiro, diferencaCents: diferenca,
    pixCents: por.pix, debitoCents: por.debito, creditoCents: por.credito }
})


