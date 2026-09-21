/**
 * POST /api/admin/equipe — cria acesso ao painel.
 *
 * **A senha é sorteada aqui e mostrada UMA vez.** Não existe campo de senha
 * neste formulário de propósito: senha digitada por um administrador para
 * outra pessoa passa por WhatsApp, fica no histórico da conversa, e vira a
 * senha de sempre porque ninguém troca. Sorteando, o segredo nasce forte e o
 * caminho dele é explícito — quem cria vê uma vez, entrega, e acabou.
 *
 * Só `master` e `admin` criam gente. Sem essa linha, o operacional promove a
 * si mesmo a master em duas requisições.
 */
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { randomInt } from 'node:crypto'
import { q1, tx } from '../../../utils/db'

const PAPEIS = ['master', 'admin', 'financeiro', 'marketing',
                'operacional', 'portaria', 'leitura'] as const

const Entrada = z.object({
  nome: z.string().min(2).max(120),
  email: z.string().email().max(160),
  papel: z.enum(PAPEIS),
})

/**
 * Sem I, l, O, 0, 1: a senha vai ser LIDA em voz alta ou copiada de um print,
 * e esses seis caracteres são os que se confundem entre si.
 */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
function sortearSenha(tamanho = 14): string {
  let s = ''
  for (let i = 0; i < tamanho; i++) s += ALFABETO[randomInt(ALFABETO.length)]
  return s
}

export default defineEventHandler(async (event) => {
  const sessao = (event.context as any).sessao
  const orgId = sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })
  if (sessao.papel !== 'master' && sessao.papel !== 'admin') {
    throw createError({ statusCode: 403, statusMessage: 'Só master e admin criam acesso.' })
  }

  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data
  const email = d.email.trim().toLowerCase()

  // Só master cria master. Admin que pudesse criar master escalaria o próprio
  // poder criando uma conta acima da dele e entrando nela.
  if (d.papel === 'master' && sessao.papel !== 'master') {
    throw createError({ statusCode: 403, statusMessage: 'Só um master cria outro master.' })
  }

  const jaExiste = await q1<any>(
    `SELECT id, active FROM users WHERE org_id = $1 AND lower(email) = $2`, [orgId, email])
  if (jaExiste) {
    throw createError({
      statusCode: 409,
      statusMessage: jaExiste.active
        ? `Já existe acesso com o e-mail ${email}.`
        : `Já existe acesso com o e-mail ${email} — está desativado. Reative em vez de criar outro.`,
    })
  }

  const senha = sortearSenha()
  const hash = await bcrypt.hash(senha, 10)

  const novo = await tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO users (org_id, name, email, password_hash, role)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, role`,
      [orgId, d.nome.trim(), email, hash, d.papel])
    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'usuario',$2,'criado',$3::jsonb)`,
      // a senha NÃO entra no log de auditoria
      [orgId, rows[0].id, JSON.stringify({ nome: d.nome, email, papel: d.papel,
                                           criadoPor: sessao.email })])
    return rows[0]
  })

  return {
    ok: true,
    usuario: { id: novo.id, nome: novo.name, email: novo.email, papel: novo.role },
    // única vez que esta senha existe em texto em qualquer lugar
    senhaProvisoria: senha,
  }
})
