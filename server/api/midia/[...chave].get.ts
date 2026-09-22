/**
 * GET /api/midia/<chave> — o único jeito de uma tela mostrar uma imagem do
 * bucket. PÚBLICA de propósito: banner e miniatura de evento aparecem no
 * site de vendas, pra qualquer visitante — sem sessão, sem organização.
 *
 * A credencial do bucket nunca sai daqui: quem usa `<img>` só conhece este
 * caminho, nunca o R2 direto (`server/utils/storage-r2.ts` é quem fala com
 * o bucket de verdade).
 *
 * A chave é validada contra um formato fixo — sem isso, o parâmetro solto
 * vira um jeito de pedir QUALQUER objeto do bucket só sabendo (ou chutando)
 * o nome, inclusive um que um dia entre lá por outro motivo.
 */
import { lerImagem } from '../../utils/storage-r2'

const CHAVE_VALIDA = /^eventos\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-zA-Z0-9_-]{1,60}\.[a-z0-9]{2,6}$/

export default defineEventHandler(async (event) => {
  const chave = getRouterParam(event, 'chave', { decode: true })
  if (!chave || !CHAVE_VALIDA.test(chave)) {
    throw createError({ statusCode: 400, statusMessage: 'Caminho de imagem inválido' })
  }

  const achou = await lerImagem(chave)
  if (!achou) throw createError({ statusCode: 404, statusMessage: 'Imagem não encontrada' })

  setResponseHeader(event, 'Content-Type', achou.contentType)
  // a chave nunca muda de conteúdo (server/utils/storage-r2.ts): pode
  // guardar pra sempre, sem revalidar.
  setResponseHeader(event, 'Cache-Control', 'public, max-age=31536000, immutable')
  return achou.corpo
})
