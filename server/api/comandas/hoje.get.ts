/**
 * GET /api/comandas/hoje?q= — as contas de HOJE, para o atendente resolver sozinho
 * (achar o cliente, ver o que consumiu, receber, trocar pulseira perdida).
 *
 * Só o dia de hoje e só as contas: sem total vendido do dia, sem histórico de outros dias.
 * É a lista que o link do funcionário abre na aba "Hoje".
 */
import { exigirNivel, intervaloDoDia, resumoDaLinha, SQL_RESUMO } from '../../utils/comandas'
import { q } from '../../utils/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = exigirNivel(event, 'atendente')
  const { inicio, fim } = intervaloDoDia()
  const par: any[] = [c.orgId, inicio, fim]
  const onde = [`c.org_id = $1`, `(c.aberta_em BETWEEN $2 AND $3 OR c.situacao = 'aberta')`, `c.situacao <> 'juntada'`]
  const t = String(getQuery(event).q ?? '').trim()
  if (t) {
    par.push(`%${t.toLowerCase()}%`, t.replace(/\D/g, '') || '__nada__')
    const a = par.length - 1
    const b = par.length
    onde.push(`(lower(c.nome) LIKE $${a} OR lower(c.responsavel_nome) LIKE $${a} OR c.numero::text = $${b}
               OR EXISTS (SELECT 1 FROM comanda_vinculos v JOIN comanda_pulseiras pu ON pu.id = v.pulseira_id
                           WHERE v.comanda_id = c.id AND (pu.uid = $${b} OR lower(pu.uid) LIKE $${a})))`)
  }
  const linhas = await q<any>(
    `SELECT r.*, (SELECT pu.uid FROM comanda_vinculos v JOIN comanda_pulseiras pu ON pu.id = v.pulseira_id
                   WHERE v.comanda_id = r.id ORDER BY v.inicio_em DESC LIMIT 1) AS ultima_pulseira
       FROM (${SQL_RESUMO} WHERE ${onde.join(' AND ')}) r
      ORDER BY (r.situacao = 'aberta') DESC, r.aberta_em DESC LIMIT 300`, par)
  return { contas: linhas.map((r) => ({ ...resumoDaLinha(r), pulseira: r.pulseira ?? r.ultima_pulseira ?? null })) }
})
