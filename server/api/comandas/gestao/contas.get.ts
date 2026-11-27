/**
 * GET /api/comandas/gestao/contas?situacao=&q=&dia= — todas as contas, com busca.
 *
 * `q` acha por nome, responsável, telefone, número da conta ou número da pulseira (qualquer
 * pulseira que a conta já teve). `dia` vazio = todos os dias. `situacao=devendo` junta
 * "não paga" e "cobrada".
 */
import { exigirNivel, intervaloDoDia, resumoDaLinha, SQL_RESUMO } from '../../../utils/comandas'
import { q } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = exigirNivel(event, 'caixa')
  const { situacao, q: busca, dia } = getQuery(event) as Record<string, string | undefined>
  const onde: string[] = ['c.org_id = $1']
  const par: any[] = [c.orgId]
  if (situacao === 'devendo') onde.push(`c.situacao IN ('nao_paga','cobrada')`)
  else if (situacao) { par.push(situacao); onde.push(`c.situacao = $${par.length}`) }
  if (dia) {
    const d = intervaloDoDia(dia)
    par.push(d.inicio, d.fim)
    onde.push(`c.aberta_em BETWEEN $${par.length - 1} AND $${par.length}`)
  }
  const t = String(busca ?? '').trim()
  if (t) {
    par.push(`%${t.toLowerCase()}%`, t.replace(/\D/g, '') || '__nada__')
    const a = par.length - 1
    const b = par.length
    onde.push(`(lower(c.nome) LIKE $${a} OR lower(c.responsavel_nome) LIKE $${a}
               OR c.responsavel_telefone LIKE '%' || $${b} || '%' OR c.numero::text = $${b}
               OR EXISTS (SELECT 1 FROM comanda_vinculos v JOIN comanda_pulseiras pu ON pu.id = v.pulseira_id
                           WHERE v.comanda_id = c.id AND (pu.uid = $${b} OR lower(pu.uid) LIKE $${a})))`)
  }
  const linhas = await q<any>(`${SQL_RESUMO} WHERE ${onde.join(' AND ')} ORDER BY c.aberta_em DESC LIMIT 300`, par)
  return { contas: linhas.map(resumoDaLinha) }
})
