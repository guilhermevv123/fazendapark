/**
 * GET /api/cardapio-foto/<id>.webp — a foto de produto enviada pelo painel (057).
 *
 * Pública de propósito: é a foto do lanche, e o app do tablet mostra com <img> (sem cookie).
 * O id é um uuid sorteado. O conteúdo de um id nunca muda (foto nova = id novo): cache eterno.
 */
import { q1 } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const m = String(getRouterParam(event, 'arquivo') ?? '').match(/^([0-9a-f-]{36})\.webp$/i)
  if (!m) throw createError({ statusCode: 400, statusMessage: 'Foto inválida' })
  const f = await q1<{ bytes: Buffer }>(`SELECT bytes FROM comanda_fotos WHERE id = $1`, [m[1]])
  if (!f) throw createError({ statusCode: 404, statusMessage: 'Foto não encontrada' })
  setResponseHeader(event, 'Content-Type', 'image/webp')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=31536000, immutable')
  return f.bytes
})
