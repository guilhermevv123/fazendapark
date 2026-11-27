/**
 * GET /api/comandas/gestao/encerrar-dia — o que falta conferir antes de encerrar o dia:
 * as contas que continuam abertas e os tablets que podem estar segurando pedido.
 */
import { aparelhosComRisco, exigirNivel, resumoDaLinha, SQL_RESUMO } from '../../../utils/comandas'
import { q } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = exigirNivel(event, 'gerente')
  const abertas = await q<any>(`${SQL_RESUMO} WHERE c.org_id = $1 AND c.situacao = 'aberta' ORDER BY c.numero`, [c.orgId])
  return { contas: abertas.map(resumoDaLinha), aparelhos: aparelhosComRisco(c.orgId) }
})
