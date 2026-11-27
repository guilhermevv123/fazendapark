/**
 * POST /api/comandas/equipe
 *
 * - `{ userId, nivel: 'atendente' | 'caixa' | 'gerente' | null }` dá ou tira o acesso (só gerente);
 * - `{ criar: { nome, email, senha, nivel, pontos } }` cria o LOGIN de um funcionário das comandas (só o dono).
 *   É um usuário do sistema como os de Configurações → Equipe, com o papel mais curto
 *   (Portaria), e já sai com o nível na comanda. A senha é a que o DONO digita (mínimo 8) e já
 *   vale: não é sorteada nem provisória (pedido do dono, 27/11). Não volta na resposta.
 *   Nasce `so_comandas` (056): não entra em mais nada do sistema. `pontos` prende aos locais;
 * - `{ userId, pontos: string[] }` muda os locais de uma pessoa (só o dono; [] = todos).
 */
import bcrypt from 'bcryptjs'
import { exigirNivel, recusa, registrar } from '../../utils/comandas'
import { q, q1, tx } from '../../utils/db'
import { autorDaRequisicao, registrarAuditoria } from '../../utils/auditoria'
import { roleLegado } from '../../utils/papeis'

const NIVEIS = ['atendente', 'caixa', 'gerente']

/** os ids que vieram, só os que são locais desta organização; vazio = todos (null) */
async function pontosValidos(orgId: string, bruto: unknown): Promise<string[] | null> {
  const ids = Array.isArray(bruto) ? [...new Set(bruto.map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))] : []
  if (!ids.length) return null
  const r = await q<{ id: string }>(`SELECT id FROM comanda_pontos WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, ids])
  if (r.length !== ids.length) recusa('Um dos locais não existe mais. Atualize a página.', 'pontos')
  return r.map((x) => x.id)
}

export default defineEventHandler(async (event) => {
  const c = exigirNivel(event, 'gerente')
  const b = (await readBody<Record<string, any>>(event)) ?? {}


  if (b.criar !== undefined) {
    if (!c.master) recusa('Só o dono cria login de funcionário.', 'master')
    const nome = String(b.criar?.nome ?? '').trim()
    const email = String(b.criar?.email ?? '').trim().toLowerCase()
    const nivel = String(b.criar?.nivel ?? 'atendente')
    if (nome.length < 2 || nome.length > 120) recusa('Escreva o nome do funcionário.', 'nome')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) recusa('E-mail com formato errado (ex.: joao@gmail.com).', 'email')
    if (!NIVEIS.includes(nivel)) recusa('Nível inválido.', 'nivel')
    const pontos = await pontosValidos(c.orgId, b.criar?.pontos)
    // o login é um só no sistema inteiro (ver admin/equipe/index.post.ts)
    const ja = await q1<any>(`SELECT active, (org_id = $1) AS daqui FROM users WHERE lower(email) = $2 ORDER BY (org_id = $1) DESC LIMIT 1`, [c.orgId, email])
    if (ja) recusa(ja.daqui ? `Já existe login com o e-mail ${email}. Dê o nível na lista abaixo.` : `O e-mail ${email} já é usado em outro lugar do sistema. Use outro.`, 'email')

    // a senha é a que o dono digitou (pedido do dono, 27/11): mínimo de 8, a mesma regra do "Trocar senha"
    const senha = String(b.criar?.senha ?? '')
    if (senha.length < 8 || senha.length > 200) recusa('A senha precisa ter pelo menos 8 caracteres.', 'senha')
    const hash = await bcrypt.hash(senha, 10)
    const novo = await tx(async (cx) => {
      const { rows } = await cx.query(
        `INSERT INTO users (org_id, name, email, password_hash, papel, role, senha_provisoria)
         VALUES ($1,$2,$3,$4,'portaria',$5, false) RETURNING id`, [c.orgId, nome, email, hash, roleLegado('portaria')])
      await cx.query(`INSERT INTO comanda_acessos (user_id, org_id, nivel, criado_por, so_comandas, pontos) VALUES ($1,$2,$3,$4,true,$5)`,
        [rows[0].id, c.orgId, nivel, c.usuarioId, pontos])
      await registrarAuditoria({
        autor: autorDaRequisicao(event), entidade: 'usuario', entidadeId: rows[0].id, acao: 'criado',
        depois: { nome, email, papel: 'portaria', comanda: nivel, soComandas: true, pontos },
      }, cx)
      return rows[0]
    })
    await registrar(null, c, { acao: 'equipe', descricao: `Criou o login de ${nome} (${nivel} nas comandas)` })
    return { ok: true, id: novo.id }
  }

  const alvo = await q1<any>(`SELECT id, name, papel FROM users WHERE org_id = $1 AND id::text = $2`, [c.orgId, String(b.userId ?? '')])
  if (!alvo) recusa('Pessoa não encontrada na equipe.', 'pessoa')
  if (alvo.papel === 'master') recusa('O dono já é gerente das comandas.', 'master')
  if (b.pontos !== undefined) {
    if (!c.master) recusa('Só o dono muda o local de um funcionário.', 'master')
    const pontos = await pontosValidos(c.orgId, b.pontos)
    const r = await q1<any>(`UPDATE comanda_acessos SET pontos = $3 WHERE user_id = $1 AND org_id = $2 RETURNING user_id`, [alvo.id, c.orgId, pontos])
    if (!r) recusa('Dê um nível a esta pessoa antes de escolher o local.', 'nivel')
    await registrar(null, c, { acao: 'equipe', descricao: `Mudou os locais de ${alvo.name}` })
    return { ok: true }
  }
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
