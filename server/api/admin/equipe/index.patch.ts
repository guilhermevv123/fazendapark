/**
 * PATCH /api/admin/equipe — muda papel, ativa/desativa, ou sorteia nova senha.
 *
 * Três travas que existem porque a alternativa é a organização ficar sem dono:
 *
 * 1. **Ninguém rebaixa nem desativa a si mesmo.** É o clique que tranca a
 *    pessoa pra fora da própria conta e não tem desfazer pela tela.
 * 2. **Não dá pra tirar o último master.** Organização sem master é
 *    organização que ninguém consegue mais administrar.
 * 3. **Desativar derruba as sessões abertas.** Desativar sem revogar deixa a
 *    pessoa navegando com o cookie que já tinha até ele vencer — o acesso
 *    "cortado" continua de pé por dias.
 */
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { randomInt } from 'node:crypto'
import { q1, tx } from '../../../utils/db'

const PAPEIS = ['master', 'admin', 'financeiro', 'marketing',
                'operacional', 'portaria', 'leitura'] as const

const Entrada = z.object({
  id: z.string().uuid(),
  nome: z.string().min(2).max(120).optional(),
  papel: z.enum(PAPEIS).optional(),
  ativo: z.boolean().optional(),
  novaSenha: z.literal(true).optional(),
})

const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
const sortearSenha = (n = 14) =>
  Array.from({ length: n }, () => ALFABETO[randomInt(ALFABETO.length)]).join('')

export default defineEventHandler(async (event) => {
  const sessao = (event.context as any).sessao
  const orgId = sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })
  if (sessao.papel !== 'master' && sessao.papel !== 'admin') {
    throw createError({ statusCode: 403, statusMessage: 'Só master e admin mudam acesso.' })
  }

  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data

  const alvo = await q1<any>(
    `SELECT id, name, email, role, active FROM users WHERE id = $1 AND org_id = $2`,
    [d.id, orgId])
  if (!alvo) throw createError({ statusCode: 404, statusMessage: 'Pessoa não encontrada' })

  const euMesmo = alvo.id === sessao.usuarioId
  if (euMesmo && (d.ativo === false || (d.papel && d.papel !== alvo.role))) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Você não pode mudar o próprio papel nem se desativar. '
        + 'Peça a outro master.',
    })
  }
  if ((d.papel === 'master' || alvo.role === 'master') && sessao.papel !== 'master') {
    throw createError({ statusCode: 403, statusMessage: 'Só um master mexe em outro master.' })
  }

  // último master de pé
  if (alvo.role === 'master' && (d.ativo === false || (d.papel && d.papel !== 'master'))) {
    const outros = await q1<any>(
      `SELECT count(*)::int AS n FROM users
        WHERE org_id = $1 AND role = 'master' AND active AND id <> $2`, [orgId, alvo.id])
    if (outros.n === 0) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Este é o último master ativo. Promova outra pessoa antes.',
      })
    }
  }

  return await tx(async (c) => {
    const set: string[] = []
    const par: any[] = [alvo.id]
    const depois: any = {}

    if (d.nome !== undefined) { par.push(d.nome.trim()); set.push(`name = $${par.length}`); depois.nome = d.nome }
    if (d.papel !== undefined) { par.push(d.papel); set.push(`role = $${par.length}`); depois.papel = d.papel }
    if (d.ativo !== undefined) { par.push(d.ativo); set.push(`active = $${par.length}`); depois.ativo = d.ativo }

    let senha: string | null = null
    if (d.novaSenha) {
      senha = sortearSenha()
      par.push(await bcrypt.hash(senha, 10))
      set.push(`password_hash = $${par.length}`)
      depois.senhaTrocada = true
    }

    if (!set.length) return { ok: true, semMudanca: true }

    await c.query(`UPDATE users SET ${set.join(', ')} WHERE id = $1`, par)

    // Desativar ou trocar senha tem que derrubar quem já está dentro — senão
    // o cookie antigo continua valendo e o corte não corta nada.
    if (d.ativo === false || d.novaSenha) {
      await c.query(
        `UPDATE sessions SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`, [alvo.id])
      depois.sessoesRevogadas = true
    }

    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'usuario',$2,'editado',$3::jsonb)`,
      [orgId, alvo.id, JSON.stringify({ ...depois, porQuem: sessao.email })])

    return { ok: true, senhaProvisoria: senha }
  })
})
