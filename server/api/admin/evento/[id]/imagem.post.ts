/**
 * POST /api/admin/evento/:id/imagem — sobe banner ou miniatura pro bucket.
 *
 * Separada do PATCH de configurações (`configuracoes.patch.ts`) porque o
 * corpo aqui é multipart (arquivo) — misturar upload de arquivo com o resto
 * do cadastro em JSON no mesmo `readBody` não dá.
 *
 * Autenticação, dono do evento e área são o MESMO middleware que já tranca
 * `configuracoes` — `server/middleware/01/02/03`, área `evento` (ver
 * `AREA_DA_TELA.imagem` em `utils/papeis.ts`). Nada disso é repetido aqui.
 *
 * O arquivo é redimensionado e convertido pra webp ANTES de subir: a lição
 * já paga no Diamond CRM (`avatar-compressao`, `storage-eficiencia`) é que
 * foto direto de celular pesa MB pra caber numa faixa de 1200px na tela —
 * guardar o bruto é a mesma classe de desperdício que já encheu um bucket
 * inteiro uma vez.
 */
import sharp from 'sharp'
import { q1, tx } from '../../../../utils/db'
import {
  apagarImagem, BucketNaoConfigurado, caminhoPublico, chaveDeImagemDeEvento, chaveDoCaminho, subirImagem,
} from '../../../../utils/storage-r2'

const CAMPO_PARA_COLUNA = { banner: 'banner_url', thumb: 'thumb_url' } as const
type Campo = keyof typeof CAMPO_PARA_COLUNA

/**
 * Banner é a faixa larga do topo da página pública; miniatura é o quadrado
 * do card na lista de eventos (`/admin`). Larguras diferentes de propósito:
 * subir os dois na mesma faixa deixaria um granulado ou pesado à toa.
 */
const LARGURA_MAXIMA: Record<Campo, number> = { banner: 1600, thumb: 480 }
/** O bruto, antes do `sharp` comprimir — trava cedo, sem gastar CPU num arquivo absurdo. */
const TAMANHO_MAXIMO_BYTES = 8 * 1024 * 1024

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')

  const partes = await readMultipartFormData(event)
  const arquivo = partes?.find((p) => p.name === 'arquivo')
  const campoBruto = partes?.find((p) => p.name === 'campo')?.data.toString('utf8')

  if (!campoBruto || !(campoBruto in CAMPO_PARA_COLUNA)) {
    throw createError({ statusCode: 400, statusMessage: 'Campo inválido: use "banner" ou "thumb".' })
  }
  const campo = campoBruto as Campo

  if (!arquivo?.data.length) {
    throw createError({ statusCode: 400, statusMessage: 'Nenhum arquivo enviado.' })
  }
  if (arquivo.data.length > TAMANHO_MAXIMO_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Arquivo maior que 8MB.' })
  }
  if (!arquivo.type?.startsWith('image/')) {
    throw createError({ statusCode: 415, statusMessage: 'Envie uma imagem (JPG, PNG ou WEBP).' })
  }

  const atual = await q1<{ org_id: string; banner_url: string | null; thumb_url: string | null }>(
    `SELECT org_id, banner_url, thumb_url FROM events WHERE id = $1`, [eventoId])
  if (!atual) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  let processada: Buffer
  try {
    processada = await sharp(arquivo.data)
      // aplica a orientação do EXIF antes de medir largura — sem isto, foto
      // vertical de celular vira deitada (o sensor grava sempre do mesmo
      // jeito; quem gira é o metadado que o navegador lê e o sharp, sem
      // `.rotate()`, ignora).
      .rotate()
      .resize({ width: LARGURA_MAXIMA[campo], withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()
  } catch {
    throw createError({
      statusCode: 422,
      statusMessage: 'Não consegui ler essa imagem — o arquivo está corrompido?',
    })
  }

  const chave = chaveDeImagemDeEvento(atual.org_id, eventoId!, campo)
  try {
    await subirImagem(chave, processada, 'image/webp')
  } catch (e) {
    // mesmo padrão do Asaas ausente em `payout/executar.post.ts`: dependência
    // não configurada é 503 com o recado pronto, nunca um 500 cru — sem isto
    // a mensagem em português da própria classe nunca chegava na tela.
    if (e instanceof BucketNaoConfigurado) throw createError({ statusCode: 503, statusMessage: e.message })
    throw e
  }
  const url = caminhoPublico(chave)

  const coluna = CAMPO_PARA_COLUNA[campo]
  await tx(async (c) => {
    await c.query(`UPDATE events SET ${coluna} = $1, updated_at = now() WHERE id = $2`, [url, eventoId])
    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'evento',$2,'editado',$3::jsonb)`,
      [atual.org_id, eventoId, JSON.stringify({ [campo]: url })])
  })

  // a imagem de antes só é apagada DEPOIS do banco confirmar a nova — trocar
  // e a gravação falhar não pode deixar o evento sem imagem nenhuma.
  const chaveAntiga = chaveDoCaminho(campo === 'banner' ? atual.banner_url : atual.thumb_url)
  if (chaveAntiga && chaveAntiga !== chave) await apagarImagem(chaveAntiga)

  return { ok: true, url }
})
