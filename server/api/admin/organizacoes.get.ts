/**
 * GET /api/admin/organizacoes — as organizações que ESTA sessão pode ver.
 *
 * Nasceu sem `WHERE`: devolvia a lista inteira do banco, com nome, documento
 * e "tem Asaas configurado" de todo mundo, pra qualquer login de qualquer
 * cliente. Um produtor via a carteira de eventos do concorrente que roda na
 * mesma instalação.
 *
 * A correção não é filtrar na tela — a tela some, a rota fica. O recorte é
 * aqui, pelo `org_id` da sessão, que é a única informação que o cliente não
 * consegue forjar (vem do cookie assinado, não do payload).
 *
 * `asaas_api_key` nunca sai daqui, nem mascarada: a rota diz apenas se
 * existe. Chave que trafega é chave que fica em log e em cache.
 */
import { q } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const orgId = (event.context as any).sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })

  const linhas = await q<any>(
    `SELECT o.id, o.name, o.slug, o.document, o.asaas_env, o.created_at,
            (o.asaas_api_key IS NOT NULL) AS tem_asaas,
            (SELECT count(*)::int FROM events e WHERE e.org_id = o.id) AS eventos,
            (SELECT count(*)::int FROM events e
              WHERE e.org_id = o.id AND e.status = 'ativo') AS eventos_ativos,
            (SELECT count(*)::int FROM users u WHERE u.org_id = o.id AND u.active) AS pessoas,
            (SELECT COALESCE(SUM(od.total_cents),0)::bigint FROM orders od
              WHERE od.org_id = o.id AND od.status = 'pago') AS faturado
       FROM organizations o
      WHERE o.id = $1
      ORDER BY o.name`, [orgId])

  return linhas.map((o) => ({
    id: o.id, nome: o.name, slug: o.slug, documento: o.document,
    ambienteAsaas: o.asaas_env, temAsaas: o.tem_asaas,
    eventos: o.eventos, eventosAtivos: o.eventos_ativos, pessoas: o.pessoas,
    faturadoCents: Number(o.faturado), criadoEm: o.created_at,
  }))
})
