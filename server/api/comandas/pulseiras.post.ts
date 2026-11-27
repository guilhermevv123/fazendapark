/**
 * POST /api/comandas/pulseiras — cadastra ou muda uma pulseira.
 *
 * `{ uid, rotulo? }` cadastra (encostar no leitor do computador, uma por uma). Já cadastrada
 * responde `jaExistia` sem erro, pra a fila de cadastro não travar.
 * `{ id, acao: 'bloquear' | 'desbloquear' | 'descartar', motivo }` muda a situação. Pulseira
 * em uso não é bloqueada por aqui: isso é "trocar pulseira" na conta, que já liga a nova.
 */
import { exigirNivel, recusa, registrar, texto, uidLimpo } from '../../utils/comandas'
import { q1 } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const c = exigirNivel(event, 'caixa')
  const b = (await readBody<Record<string, any>>(event)) ?? {}
  if (b.acao) {
    if (c.nivel !== 'gerente') recusa('Bloquear ou descartar pulseira é do gerente.', 'so_gerente')
    const p = await q1<any>(`SELECT p.*, EXISTS (SELECT 1 FROM comanda_vinculos v WHERE v.pulseira_id = p.id AND v.fim_em IS NULL) AS em_uso
                               FROM comanda_pulseiras p WHERE p.org_id = $1 AND p.id::text = $2`, [c.orgId, String(b.id ?? '')])
    if (!p) recusa('Pulseira não encontrada.', 'pulseira')
    if (p.em_uso && b.acao !== 'desbloquear') recusa('Esta pulseira está numa conta aberta. Use "Trocar pulseira" na conta.', 'em_uso')
    const motivo = texto(b.motivo, 200)
    if (b.acao === 'bloquear') await q1(`UPDATE comanda_pulseiras SET bloqueada = true, motivo = $2 WHERE id = $1 RETURNING id`, [p.id, motivo])
    else if (b.acao === 'desbloquear') await q1(`UPDATE comanda_pulseiras SET bloqueada = false, descartada = false, motivo = NULL WHERE id = $1 RETURNING id`, [p.id])
    else if (b.acao === 'descartar') await q1(`UPDATE comanda_pulseiras SET descartada = true, motivo = $2 WHERE id = $1 RETURNING id`, [p.id, motivo])
    else recusa('Ação desconhecida.', 'acao')
    await registrar(null, c, { acao: 'pulseira', descricao: `Pulseira ${p.uid}: ${b.acao}${motivo ? ` — ${motivo}` : ''}` })
    return { ok: true }
  }
  const uid = uidLimpo(b.uid)
  if (!uid) recusa('Leitura inválida. Encoste a pulseira de novo.', 'leitura_invalida')
  const r = await q1<any>(
    `INSERT INTO comanda_pulseiras (org_id, uid, rotulo, criado_por) VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id, uid) DO NOTHING RETURNING id`, [c.orgId, uid, texto(b.rotulo, 30), c.usuarioId])
  if (!r) return { uid, jaExistia: true }
  await registrar(null, c, { acao: 'pulseira', descricao: `Pulseira ${uid} cadastrada` })
  return { uid, jaExistia: false, id: r.id }
})
