/**
 * POST /api/comandas/cardapio/foto — o dono/gerente envia a foto de um produto (057).
 *
 * Multipart com `arquivo` (imagem até 8 MB). Sai um webp quadrado de 600 px, guardado em
 * `comanda_fotos`; a resposta é o endereço que vai no campo `foto` do item (o item só muda
 * quando o formulário do produto é salvo).
 */
import sharp from 'sharp'
import { exigirNivel, recusa } from '../../../utils/comandas'
import { q1 } from '../../../utils/db'

const TAMANHO_MAXIMO_BYTES = 8 * 1024 * 1024

export default defineEventHandler(async (event) => {
  const c = exigirNivel(event, 'gerente')
  const partes = await readMultipartFormData(event)
  const arquivo = partes?.find((p) => p.name === 'arquivo')
  if (!arquivo?.data.length) recusa('Nenhuma foto enviada.', 'arquivo')
  if (arquivo!.data.length > TAMANHO_MAXIMO_BYTES) recusa('Foto maior que 8 MB.', 'arquivo')
  if (!arquivo!.type?.startsWith('image/')) recusa('Envie uma imagem (JPG, PNG ou WEBP).', 'arquivo')

  let webp: Buffer
  try {
    // `.rotate()` aplica o EXIF: foto de celular em pé não deita
    webp = await sharp(arquivo!.data).rotate().resize(600, 600, { fit: 'cover', position: 'attention' }).webp({ quality: 82 }).toBuffer()
  } catch {
    recusa('Não consegui ler essa imagem. O arquivo está corrompido?', 'arquivo')
  }
  const r = await q1<{ id: string }>(
    `INSERT INTO comanda_fotos (org_id, bytes, criado_por) VALUES ($1,$2,$3) RETURNING id`, [c.orgId, webp!, c.usuarioId])
  return { foto: `/api/cardapio-foto/${r!.id}.webp` }
})
