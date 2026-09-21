/**
 * GET /api/admin/equipe — quem tem acesso ao painel.
 *
 * Traz junto a última entrada e quantas sessões estão abertas. Esses dois
 * números são o que responde "esse login ainda é de alguém?" — conta de
 * pessoa que saiu da empresa fica ativa em silêncio, e a tela de equipe é o
 * único lugar onde isso aparece.
 *
 * Nunca devolve `password_hash`. Hash em JSON vira hash em log, em cache de
 * navegador e em print de tela.
 */
import { q, q1 } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const sessao = (event.context as any).sessao
  const orgId = sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })

  const [pessoas, org] = await Promise.all([
    q<any>(
      `SELECT u.id, u.name, u.email, u.role, u.active, u.last_login_at, u.created_at,
              (SELECT count(*) FROM sessions s
                WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now())::int AS sessoes,
              (SELECT count(*) FROM checkins c WHERE c.operator_id = u.id)::int AS leituras
         FROM users u
        WHERE u.org_id = $1
        ORDER BY u.active DESC, u.name`, [orgId]),

    q1<any>(`SELECT id, name FROM organizations WHERE id = $1`, [orgId]),
  ])

  return {
    organizacao: org ? { id: org.id, nome: org.name } : null,
    eu: sessao?.usuarioId ?? null,
    pessoas: pessoas.map((p) => ({
      id: p.id, nome: p.name, email: p.email, papel: p.role, ativo: p.active,
      ultimaEntrada: p.last_login_at, criadoEm: p.created_at,
      sessoesAbertas: p.sessoes, leituras: p.leituras,
    })),
  }
})
