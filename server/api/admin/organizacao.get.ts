/**
 * GET /api/admin/organizacao — o cadastro da própria organização.
 *
 * **A chave do Asaas nunca sai daqui.** A tela precisa de duas informações
 * sobre ela — se existe e qual é o fim dela, pra conferir que é a certa — e
 * nada mais. Devolver a chave inteira num JSON a coloca no cache do
 * navegador, no log do proxy e no print que alguém manda no grupo.
 *
 * Por isso `chaveFinal` traz só os 6 últimos caracteres, que é o suficiente
 * pra alguém comparar com o que está no painel do Asaas e concluir "é essa".
 */
import { q1 } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const orgId = (event.context as any).sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })

  const o = await q1<any>(
    `SELECT o.id, o.name, o.slug, o.document, o.asaas_env, o.asaas_wallet, o.created_at,
            o.asaas_api_key IS NOT NULL AS tem_chave,
            right(COALESCE(o.asaas_api_key, ''), 6) AS chave_final,
            (SELECT count(*)::int FROM events WHERE org_id = o.id) AS eventos,
            (SELECT count(*)::int FROM users  WHERE org_id = o.id AND active) AS pessoas,
            (SELECT count(*)::int FROM customers WHERE org_id = o.id) AS clientes
       FROM organizations o WHERE o.id = $1`, [orgId])
  if (!o) throw createError({ statusCode: 404, statusMessage: 'Organização não encontrada' })

  return {
    id: o.id, nome: o.name, slug: o.slug, documento: o.document,
    ambienteAsaas: o.asaas_env, carteiraAsaas: o.asaas_wallet,
    temChave: o.tem_chave, chaveFinal: o.tem_chave ? o.chave_final : null,
    eventos: o.eventos, pessoas: o.pessoas, clientes: o.clientes,
    criadoEm: o.created_at,
  }
})
