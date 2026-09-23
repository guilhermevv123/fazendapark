/**
 * DELETE /api/admin/evento/:id/imagem?campo=banner|thumb — tira a capa ou a
 * miniatura do evento.
 *
 * Par do `imagem.post.ts`: enviar grava na hora, então remover também grava
 * na hora. Antes, "remover" era apagar o texto de um campo de URL e lembrar de
 * clicar em "Salvar alterações" — e a foto ficava órfã no bucket.
 *
 * Autenticação, dono do evento e área são os mesmos middlewares da rota de
 * envio (área `evento`, `AREA_DA_TELA.imagem` em `utils/papeis.ts`).
 */
import { autorDaRequisicao, registrarAuditoria } from '../../../../utils/auditoria'
import { q1, tx } from '../../../../utils/db'
import { apagarImagem, chaveDoCaminho } from '../../../../utils/storage-r2'

const CAMPO_PARA_COLUNA = { banner: 'banner_url', thumb: 'thumb_url' } as const
type Campo = keyof typeof CAMPO_PARA_COLUNA

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const campoBruto = String(getQuery(event).campo ?? '')
  if (!(campoBruto in CAMPO_PARA_COLUNA)) {
    throw createError({ statusCode: 400, statusMessage: 'Campo inválido: use "banner" ou "thumb".' })
  }
  const campo = campoBruto as Campo
  const coluna = CAMPO_PARA_COLUNA[campo]

  const atual = await q1<{ url: string | null }>(
    `SELECT ${coluna} AS url FROM events WHERE id = $1`, [eventoId])
  if (!atual) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  if (!atual.url) return { ok: true }

  await tx(async (c) => {
    await c.query(`UPDATE events SET ${coluna} = NULL, updated_at = now() WHERE id = $1`, [eventoId])
    await registrarAuditoria({
      autor: autorDaRequisicao(event),
      entidade: 'evento',
      entidadeId: eventoId!,
      acao: 'editado',
      antes: { [campo]: atual.url },
      depois: { [campo]: null },
    }, c)
  })

  // só depois do banco confirmar — mesma ordem do envio
  const chave = chaveDoCaminho(atual.url)
  if (chave) await apagarImagem(chave)

  return { ok: true }
})
