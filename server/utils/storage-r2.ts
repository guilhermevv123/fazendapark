/**
 * storage-r2.ts — o bucket S3-compatível (Cloudflare R2) onde ficam banner e
 * miniatura de evento. Duas peças separadas de propósito:
 *
 *   - `subirImagem()` escreve no bucket, a partir de uma CHAVE que quem chama
 *     já decidiu (`chaveDeImagemDeEvento`).
 *   - `lerImagem()` lê de volta — só o proxy público (`/api/midia/...`) chama
 *     isto; nenhuma tela fala com o bucket direto, e a credencial nunca sai
 *     do servidor.
 *
 * `caminhoPublico()` NUNCA devolve URL absoluta. É a mesma lição já paga no
 * Diamond CRM (`feedback_url-ambiente-persistido`: gravar `https://…` no
 * banco trava o link no domínio de quando foi salvo — dev, ou um deploy que
 * um dia mudar de endereço). O caminho começa com `/` e resolve sozinho
 * contra QUALQUER origem que estiver servindo a página.
 */
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'

/** `null` quando falta variável de ambiente — nunca lança aqui: quem chama decide o que fazer. */
function cliente(): S3Client | null {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) return null
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
}

/** A mensagem é o que a tela mostra — por isso já nasce em português, dizendo o que falta. */
export class BucketNaoConfigurado extends Error {
  constructor() {
    super('O envio de imagem ainda não está ligado (falta R2_BUCKET no .env do servidor).')
  }
}

/**
 * Uma chave nova por upload — nunca reaproveita a de antes. `eventos/<org>/
 * <evento>/<campo>-<10 chars>.webp`: o prefixo por organização isola o que é
 * de quem dentro do mesmo bucket, e a chave nova a cada troca de imagem
 * invalida sozinha qualquer cache (do navegador, de CDN) que ainda apontava
 * pra anterior — sem isso, trocar o banner e ver o antigo continuar
 * aparecendo é o primeiro chamado que chega.
 */
export function chaveDeImagemDeEvento(orgId: string, eventoId: string, campo: 'banner' | 'thumb'): string {
  return `eventos/${orgId}/${eventoId}/${campo}-${nanoid(10)}.webp`
}

/** Sobe `bytes` pra `chave`. Lança `BucketNaoConfigurado` se faltar variável de ambiente. */
export async function subirImagem(chave: string, bytes: Buffer, contentType: string): Promise<void> {
  const bucket = process.env.R2_BUCKET
  const s3 = cliente()
  if (!bucket || !s3) throw new BucketNaoConfigurado()
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: chave,
    Body: bytes,
    ContentType: contentType,
    // a chave nunca muda de conteúdo (ver o comentário de `chaveDeImagemDeEvento`):
    // o navegador pode guardar pra sempre.
    CacheControl: 'public, max-age=31536000, immutable',
  }))
}

/** Lê `chave` de volta. `null` = bucket sem configuração OU chave inexistente — o proxy trata os dois como 404. */
export async function lerImagem(chave: string): Promise<{ corpo: Uint8Array; contentType: string } | null> {
  const bucket = process.env.R2_BUCKET
  const s3 = cliente()
  if (!bucket || !s3) return null
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: chave }))
    const corpo = await r.Body!.transformToByteArray()
    return { corpo, contentType: r.ContentType ?? 'application/octet-stream' }
  } catch (e: any) {
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null
    throw e
  }
}

/** O caminho pro `<img src>` — relativo, de propósito (ver o comentário do arquivo). */
export function caminhoPublico(chave: string): string {
  return `/api/midia/${chave}`
}

/** A chave de dentro de um caminho de `caminhoPublico()` — `null` se não é um dos nossos. */
export function chaveDoCaminho(caminho: string | null | undefined): string | null {
  if (!caminho?.startsWith('/api/midia/')) return null
  return caminho.slice('/api/midia/'.length)
}

/**
 * Apaga a chave de antes, ao trocar de imagem. MELHOR ESFORÇO: uma troca de
 * banner não pode falhar por causa da faxina do arquivo antigo — é
 * exatamente o tipo de acoplamento que fez o R2 do CRM irmão encher de lixo
 * de um jeito silencioso (`storage-eficiencia`). Erro aqui só vira log.
 */
export async function apagarImagem(chave: string): Promise<void> {
  const bucket = process.env.R2_BUCKET
  const s3 = cliente()
  if (!bucket || !s3) return
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: chave }))
  } catch (e) {
    console.error(`storage-r2: não consegui apagar "${chave}" (imagem trocada, a antiga ficou órfã)`, e)
  }
}
