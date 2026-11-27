/**
 * POST /api/comandas/equipe
 *
 * - `{ userId, nivel: 'atendente' | 'caixa' | 'gerente' | null }` dá ou tira o acesso (só gerente);
 * - `{ pin }` grava o PIN do PRÓPRIO gerente (4 a 6 números) — é o que ele digita no tablet
 *   do atendente pra liberar correção e limite.
 */
import bcrypt from 'bcryptjs'
import { exigirNivel, recusa, registrar } from '../../utils/comandas'
import { q, q1 } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const c = exigirNivel(event, 'gerente')
  const b = (await readBody<Record<string, any>>(event)) ?? {}

  if (b.pin !== undefined) {
    const pin = String(b.pin ?? '').replace(/\D/g, '')
    if (pin.length < 4 || pin.length > 6) recusa('O PIN tem de 4 a 6 números.', 'pin')
    const hash = await bcrypt.hash(pin, 10)
    await q(`INSERT INTO comanda_acessos (user_id, org_id, nivel, pin_hash, criado_por) VALUES ($1,$2,'gerente',$3,$1)
             ON CONFLICT (user_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash`, [c.usuarioId, c.orgId, hash])
    await registrar(null, c, { acao: 'equipe', descricao: `${c.nome} definiu o próprio PIN de gerente` })
    return { ok: true }
  }

  const alvo = await q1<any>(`SELECT id, name, papel FROM users WHERE org_id = $1 AND id::text = $2`, [c.orgId, String(b.userId ?? '')])
  if (!alvo) recusa('Pessoa não encontrada na equipe.', 'pessoa')
  if (alvo.papel === 'master') recusa('O dono já é gerente das comandas.', 'master')
  if (b.nivel === null || b.nivel === '') {
    await q(`DELETE FROM comanda_acessos WHERE user_id = $1 AND org_id = $2`, [alvo.id, c.orgId])
    await registrar(null, c, { acao: 'equipe', descricao: `Tirou o acesso de ${alvo.name} às comandas` })
    return { ok: true }
  }
  if (!['atendente', 'caixa', 'gerente'].includes(b.nivel)) recusa('Nível inválido.', 'nivel')
  await q(`INSERT INTO comanda_acessos (user_id, org_id, nivel, criado_por) VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id) DO UPDATE SET nivel = EXCLUDED.nivel`, [alvo.id, c.orgId, b.nivel, c.usuarioId])
  await registrar(null, c, { acao: 'equipe', descricao: `${alvo.name} agora é ${b.nivel} nas comandas` })
  return { ok: true }
})
