/** GET /api/comandas/pulseiras?q= — as pulseiras do parque e em que conta cada uma está agora. */
import { exigirNivel } from '../../utils/comandas'
import { q } from '../../utils/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = exigirNivel(event, 'caixa')
  const busca = String(getQuery(event).q ?? '').trim()
  const linhas = await q<any>(
    `SELECT p.id, p.uid, p.rotulo, p.bloqueada, p.descartada, p.motivo, p.criado_em,
            c.id AS comanda_id, c.numero, c.nome,
            (SELECT COUNT(*) FROM comanda_vinculos v2 WHERE v2.pulseira_id = p.id) AS usos
       FROM comanda_pulseiras p
       LEFT JOIN comanda_vinculos v ON v.pulseira_id = p.id AND v.fim_em IS NULL
       LEFT JOIN comandas c ON c.id = v.comanda_id
      WHERE p.org_id = $1 AND ($2 = '' OR p.uid LIKE '%' || $2 || '%' OR lower(COALESCE(p.rotulo,'')) LIKE '%' || lower($2) || '%')
      ORDER BY p.criado_em DESC LIMIT 1000`, [c.orgId, busca])
  const pulseiras = linhas.map((p) => ({
    id: p.id, uid: p.uid, rotulo: p.rotulo, motivo: p.motivo, criadoEm: p.criado_em, usos: Number(p.usos),
    situacao: p.descartada ? 'descartada' : p.bloqueada ? 'bloqueada' : p.comanda_id ? 'em_uso' : 'livre',
    conta: p.comanda_id ? { id: p.comanda_id, numero: Number(p.numero), nome: p.nome } : null,
  }))
  const conta = (s: string) => pulseiras.filter((p) => p.situacao === s).length
  return { pulseiras, totais: { total: pulseiras.length, livre: conta('livre'), em_uso: conta('em_uso'), bloqueada: conta('bloqueada'), descartada: conta('descartada') } }
})
