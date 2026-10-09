/**
 * POST /api/auth/redefinir — a senha nova da EQUIPE pelo link do e-mail (051).
 *
 * `{ token, senha, de? }`. A senha é conferida ANTES de gastar o link (senha curta não queima o
 * link). Numa transação: o link é consumido (dois cliques, um uso), a senha é gravada e deixa de ser
 * provisória, TODAS as sessões do acesso caem e o ato vai pra auditoria. Depois, ESTE aparelho já
 * entra e a tela segue pra onde a pessoa estava (painel ou portaria).
 */
import bcrypt from 'bcryptjs'
import { mutacaoDeOutroSite } from '../../utils/caminho'
import { tx, q1 } from '../../utils/db'
import { abrirSessao, frearPortaPublica, ipDaRequisicao } from '../../utils/sessao'
import { registrarAuditoria } from '../../utils/auditoria'
import {
  conferirLinkDaEquipe, consumirLinkDaEquipe, destinoDaEquipe, MINIMO_DA_SENHA_DA_EQUIPE,
} from '../../utils/senha-da-equipe'

export const LINK_DA_EQUIPE_VENCIDO =
  'Este link não vale mais: ele venceu (30 minutos), já foi usado ou um link mais novo foi pedido. '
  + 'Peça outro em "Esqueci a senha".'

export default defineEventHandler(async (event) => {
  if (mutacaoDeOutroSite(event)) throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
  frearPortaPublica(event, 'conta_link')
  const b = ((await readBody(event).catch(() => null)) ?? {}) as Record<string, any>
  const vencido = () => createError({ statusCode: 410, statusMessage: LINK_DA_EQUIPE_VENCIDO })

  const previa = await conferirLinkDaEquipe(b.token)
  if (!previa) throw vencido()
  const senha = typeof b.senha === 'string' ? b.senha : ''
  if (senha.length < MINIMO_DA_SENHA_DA_EQUIPE || senha.length > 200) {
    throw createError({ statusCode: 422,
      statusMessage: `A senha precisa ter pelo menos ${MINIMO_DA_SENHA_DA_EQUIPE} caracteres.` })
  }
  if (senha.trim().toLowerCase() === previa.email.trim().toLowerCase()) {
    throw createError({ statusCode: 422, statusMessage: 'A senha não pode ser o seu e-mail.' })
  }
  const hash = await bcrypt.hash(senha, 10)
  const ip = ipDaRequisicao(event)

  const usuarioId = await tx(async (c) => {
    const link = await consumirLinkDaEquipe(c, b.token)
    if (!link) return null
    await c.query(`UPDATE users SET password_hash = $2, senha_provisoria = false WHERE id = $1`, [link.usuarioId, hash])
    const { rowCount } = await c.query(
      `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [link.usuarioId])
    const org = await c.query(`SELECT org_id FROM users WHERE id = $1`, [link.usuarioId])
    // a senha NÃO entra no registro — nem a velha, nem a nova
    await registrarAuditoria({
      autor: { usuarioId: link.usuarioId, orgId: org.rows[0].org_id, email: link.email, ip },
      entidade: 'usuario', entidadeId: link.usuarioId, acao: 'senha_redefinida_por_email',
      depois: { email: link.email, sessoesEncerradas: rowCount ?? 0 },
    }, c)
    return link.usuarioId
  })
  if (!usuarioId) throw vencido()

  await abrirSessao(event, usuarioId)
  const u = await q1<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [usuarioId])
  return { ok: true, nome: u?.name ?? '', destino: destinoDaEquipe(b.de) }
})
