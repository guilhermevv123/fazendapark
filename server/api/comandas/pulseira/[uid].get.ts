/**
 * GET /api/comandas/pulseira/<uid> — o que aparece quando alguém encosta a pulseira.
 *
 * Livre, bloqueada, ou em uso (com a conta, o grupo de quem comprou junto e o que este
 * usuário pode fazer com ela: adicionar pedido, ver, fechar).
 *
 * Pulseira NOVA (nunca lida) é cadastrada aqui mesmo, na primeira leitura, e já volta como
 * livre — pedido do dono (11/11/2026): "leu uma vez, já fica registrada".
 */
import { configDaComanda, ctx, grupoDaConta, nivelCobre, registrar, situacaoDaPulseira } from '../../../utils/comandas'
import { q1 } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = ctx(event)
  let s = await situacaoDaPulseira(c.orgId, getRouterParam(event, 'uid'))
  let nova = false
  if (s.tipo === 'nao_cadastrada') {
    const r = await q1<any>(
      `INSERT INTO comanda_pulseiras (org_id, uid, criado_por) VALUES ($1,$2,$3)
       ON CONFLICT (org_id, uid) DO NOTHING RETURNING id`, [c.orgId, s.uid, c.usuarioId])
    if (r) {
      nova = true
      await registrar(null, c, { acao: 'pulseira_cadastrada', descricao: `Pulseira ${s.uid} cadastrada na primeira leitura` })
    }
    s = await situacaoDaPulseira(c.orgId, s.uid)
  }
  const config = await configDaComanda(c.orgId)
  const podeFechar = nivelCobre(c.nivel, 'caixa') || config.atendenteFechaConta
  if (s.tipo !== 'em_uso') return { ...s, nova, podeFechar, podeAbrir: true }
  const grupo = await grupoDaConta(c.orgId, s.conta)
  return { ...s, nova, grupo, podeFechar, podeAbrir: true }
})
