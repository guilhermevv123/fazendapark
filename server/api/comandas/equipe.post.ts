/**
 * POST /api/comandas/equipe
 *
 * - `{ userId, nivel: 'atendente' | 'caixa' | 'gerente' | null }` dá ou tira o acesso (só gerente);
 * - `{ pin }` grava o PIN do PRÓPRIO gerente (4 a 6 números) — é o que ele digita no tablet
 *   do atendente pra liberar correção e limite;
 * - `{ criar: { nome, email, nivel } }` cria o LOGIN de um funcionário das comandas (só o dono).
 *   É um usuário do sistema como os de Configurações → Equipe, com o papel mais curto
 *   (Portaria), e já sai com o nível na comanda. A senha é sorteada e volta UMA vez, provisória:
 *   no 1º login (no app do tablet) a pessoa cria a dela — mesma regra de `admin/equipe`.
 */
import bcrypt from 'bcryptjs'
import { exigirNivel, recusa, registrar } from '../../utils/comandas'
import { q, q1, tx } from '../../utils/db'
import { autorDaRequisicao, registrarAuditoria } from '../../utils/auditoria'
import { roleLegado } from '../../utils/papeis'
import { sortearSenha } from '../admin/equipe/index.post'

const NIVEIS = ['atendente', 'caixa', 'gerente']

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

  if (b.criar !== undefined) {
    if (!c.master) recusa('Só o dono cria login de funcionário.', 'master')
    const nome = String(b.criar?.nome ?? '').trim()
    const email = String(b.criar?.email ?? '').trim().toLowerCase()
    const nivel = String(b.criar?.nivel ?? 'atendente')
    if (nome.length < 2 || nome.length > 120) recusa('Escreva o nome do funcionário.', 'nome')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) recusa('E-mail com formato errado (ex.: joao@gmail.com).', 'email')
    if (!NIVEIS.includes(nivel)) recusa('Nível inválido.', 'nivel')
    // o login é um só no sistema inteiro (ver admin/equipe/index.post.ts)
    const ja = await q1<any>(`SELECT active, (org_id = $1) AS daqui FROM users WHERE lower(email) = $2 ORDER BY (org_id = $1) DESC LIMIT 1`, [c.orgId, email])
    if (ja) recusa(ja.daqui ? `Já existe login com o e-mail ${email}. Dê o nível na lista abaixo.` : `O e-mail ${email} já é usado em outro lugar do sistema. Use outro.`, 'email')

    const senha = sortearSenha()
    const hash = await bcrypt.hash(senha, 10)
    const novo = await tx(async (cx) => {
      const { rows } = await cx.query(
        `INSERT INTO users (org_id, name, email, password_hash, papel, role, senha_provisoria)
         VALUES ($1,$2,$3,$4,'portaria',$5, true) RETURNING id`, [c.orgId, nome, email, hash, roleLegado('portaria')])
      await cx.query(`INSERT INTO comanda_acessos (user_id, org_id, nivel, criado_por) VALUES ($1,$2,$3,$4)`, [rows[0].id, c.orgId, nivel, c.usuarioId])
      await registrarAuditoria({
        autor: autorDaRequisicao(event), entidade: 'usuario', entidadeId: rows[0].id, acao: 'criado',
        depois: { nome, email, papel: 'portaria', comanda: nivel },
      }, cx)
      return rows[0]
    })
    await registrar(null, c, { acao: 'equipe', descricao: `Criou o login de ${nome} (${nivel} nas comandas)` })
    return { ok: true, id: novo.id, senha }
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
