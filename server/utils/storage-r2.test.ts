/**
 * storage-r2.test.ts — as duas garantias que não dependem do bucket estar
 * configurado, e uma terceira que só roda quando ele estiver.
 *
 *   · toda chave nasce ÚNICA (o cache-busting de `chaveDeImagemDeEvento`);
 *   · `caminhoPublico`/`chaveDoCaminho` fazem ida e volta sem perder nem
 *     inventar nada, e recusam qualquer caminho que não seja "dos nossos";
 *   · sem `R2_BUCKET`, subir/ler/apagar falham (ou ficam mudos) do jeito
 *     ANUNCIADO — nunca com um erro de rede genérico.
 *
 * As três primeiras não tocam rede: são puro import + chamada de função, por
 * isso rodam sempre, mesmo com o `nuxt dev` fora do ar. `R2_BUCKET` é
 * forçado em branco com `vi.stubEnv` pra não depender do que está no `.env`
 * de verdade — o dia em que o dono preencher o bucket, este arquivo continua
 * provando o caminho de erro do jeito que sempre provou.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apagarImagem, BucketNaoConfigurado, caminhoPublico, chaveDeImagemDeEvento, chaveDoCaminho,
  lerImagem, subirImagem,
} from './storage-r2'

afterEach(() => vi.unstubAllEnvs())

describe('chaveDeImagemDeEvento', () => {
  it('tem o formato eventos/<org>/<evento>/<campo>-<10 chars>.webp', () => {
    const org = '11111111-1111-1111-1111-111111111111'
    const ev = '22222222-2222-2222-2222-222222222222'
    const chave = chaveDeImagemDeEvento(org, ev, 'banner')
    expect(chave).toMatch(/^eventos\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/banner-[A-Za-z0-9_-]{10}\.webp$/)
    expect(chave.startsWith(`eventos/${org}/${ev}/banner-`)).toBe(true)
  })

  it('nunca repete: cada chamada é uma chave nova (é o que invalida cache sozinho)', () => {
    const org = '11111111-1111-1111-1111-111111111111'
    const ev = '22222222-2222-2222-2222-222222222222'
    const chaves = new Set(Array.from({ length: 20 }, () => chaveDeImagemDeEvento(org, ev, 'thumb')))
    expect(chaves.size).toBe(20)
  })

  it('banner e thumb do mesmo evento não se confundem', () => {
    const org = '11111111-1111-1111-1111-111111111111'
    const ev = '22222222-2222-2222-2222-222222222222'
    expect(chaveDeImagemDeEvento(org, ev, 'banner')).toMatch(/\/banner-/)
    expect(chaveDeImagemDeEvento(org, ev, 'thumb')).toMatch(/\/thumb-/)
  })
})

describe('caminhoPublico e chaveDoCaminho — ida e volta', () => {
  it('caminhoPublico nunca devolve URL absoluta (a lição do CRM irmão)', () => {
    const caminho = caminhoPublico('eventos/org/ev/banner-abc1234567.webp')
    expect(caminho).toBe('/api/midia/eventos/org/ev/banner-abc1234567.webp')
    expect(caminho.startsWith('/')).toBe(true)
    expect(caminho).not.toMatch(/^https?:\/\//)
  })

  it('chaveDoCaminho desfaz exatamente o que caminhoPublico fez', () => {
    const chave = 'eventos/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/banner-abc1234567.webp'
    expect(chaveDoCaminho(caminhoPublico(chave))).toBe(chave)
  })

  it('recusa (null) qualquer caminho que não seja um dos nossos', () => {
    expect(chaveDoCaminho(null)).toBeNull()
    expect(chaveDoCaminho(undefined)).toBeNull()
    expect(chaveDoCaminho('')).toBeNull()
    expect(chaveDoCaminho('https://exemplo.com/foto.jpg')).toBeNull()
    expect(chaveDoCaminho('/api/outracoisa/eventos/x/y/banner-abc.webp')).toBeNull()
  })
})

describe('sem R2_BUCKET configurado', () => {
  it('subirImagem lança BucketNaoConfigurado, com a mensagem que a tela mostra', async () => {
    vi.stubEnv('R2_BUCKET', '')
    await expect(subirImagem('eventos/a/b/banner-1234567890.webp', Buffer.from('x'), 'image/webp'))
      .rejects.toThrow(BucketNaoConfigurado)
    await expect(subirImagem('eventos/a/b/banner-1234567890.webp', Buffer.from('x'), 'image/webp'))
      .rejects.toThrow('O envio de imagem ainda não está ligado (falta R2_BUCKET no .env do servidor).')
  })

  it('lerImagem devolve null (o proxy trata como 404, não como 500)', async () => {
    vi.stubEnv('R2_BUCKET', '')
    await expect(lerImagem('eventos/a/b/banner-1234567890.webp')).resolves.toBeNull()
  })

  it('apagarImagem fica muda — melhor esforço, nunca lança', async () => {
    vi.stubEnv('R2_BUCKET', '')
    await expect(apagarImagem('eventos/a/b/banner-1234567890.webp')).resolves.toBeUndefined()
  })
})

describe('com R2_BUCKET de verdade (round-trip real no bucket)', () => {
  it('sobe, lê de volta com o mesmo conteúdo e content-type, depois apaga', async (ctx) => {
    if (!process.env.R2_BUCKET) {
      ctx.skip('R2_BUCKET não está no .env — sem nome de bucket ainda não dá pra testar upload de verdade')
    }
    const chave = chaveDeImagemDeEvento('11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222', 'banner')
    const bytes = Buffer.from(`teste storage-r2 ${Date.now()}`)
    await subirImagem(chave, bytes, 'image/webp')
    try {
      const lida = await lerImagem(chave)
      expect(lida?.contentType).toBe('image/webp')
      expect(Buffer.from(lida!.corpo)).toEqual(bytes)
    } finally {
      await apagarImagem(chave)
    }
    expect(await lerImagem(chave)).toBeNull()
  }, 30_000)
})
