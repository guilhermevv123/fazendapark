/**
 * GET /api/admin/imagens-de-eventos?campo=banner|thumb&exceto=<id do evento>
 *
 * As capas (ou miniaturas) que a organização já enviou em outros eventos — a galeria do
 * "Escolher uma já enviada" (dono, 05/10). Só da organização da sessão, mais novas primeiro.
 *
 * Quem reaproveita NÃO aponta pra mesma imagem: a tela baixa e envia de novo pela rota normal
 * (`evento/<id>/imagem`), que grava uma cópia na pasta do evento novo. Apontar pro mesmo arquivo
 * faria o evento novo perder a capa no dia em que o antigo trocasse a dele (a troca apaga o
 * arquivo antigo do bucket).
 */
import { q } from '../../utils/db'

const COLUNA = { banner: 'banner_url', thumb: 'thumb_url' } as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default defineEventHandler(async (event) => {
  const orgId = (event.context as any).sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })
  const { campo, exceto } = getQuery(event) as { campo?: string; exceto?: string }
  if (!campo || !Object.hasOwn(COLUNA, campo)) {
    throw createError({ statusCode: 400, statusMessage: 'Campo inválido: use "banner" ou "thumb".' })
  }
  const coluna = COLUNA[campo as keyof typeof COLUNA]
  const linhas = await q<any>(
    `SELECT DISTINCT ON (${coluna}) ${coluna} AS url, name AS evento, updated_at
       FROM events
      WHERE org_id = $1 AND ${coluna} IS NOT NULL AND ${coluna} <> ''
        AND ($2::uuid IS NULL OR id <> $2::uuid)
      ORDER BY ${coluna}, updated_at DESC`,
    [orgId, exceto && UUID.test(exceto) ? exceto : null])
  setHeader(event, 'Cache-Control', 'no-store')
  return {
    imagens: linhas
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 30)
      .map((l) => ({ url: l.url, evento: l.evento })),
  }
})
