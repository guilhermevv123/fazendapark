/**
 * imagem.test.ts — POST /api/admin/evento/:id/imagem, o upload de banner e
 * miniatura pro bucket R2.
 *
 * O que trava aqui:
 *
 *   · toda validação (campo, arquivo ausente, tamanho, tipo, conteúdo
 *     corrompido) responde o código certo ANTES de qualquer coisa tocar o
 *     bucket — por isso essa parte roda sempre, com ou sem `R2_BUCKET`;
 *   · a área é `evento` (ver `AREA_DA_TELA.imagem` em `utils/papeis.ts`):
 *     financeiro e portaria levam 403, master e operação passam;
 *   · dono de outra organização, id inexistente e id torto continuam 404
 *     pelo MESMO portão que já tranca `configuracoes` (`middleware/02.tenant`);
 *   · sem bucket configurado, o erro chega como 503 com o recado pronto —
 *     nunca um 500 cru (é a garantia que faltava antes deste arquivo: ver o
 *     `try/catch` de `BucketNaoConfigurado` acrescentado em `imagem.post.ts`);
 *   · COM bucket configurado, sobe de verdade: a URL fica relativa
 *     (`/api/midia/...`), o banco grava, a auditoria registra, e trocar de
 *     imagem apaga a anterior do bucket (o proxy passa a responder 404 pra
 *     ela).
 *
 * Fixture própria (ids sorteados, e-mails deste arquivo), apagada no
 * `afterAll` — inclusive as chaves que realmente subiram no bucket, se
 * `R2_BUCKET` estiver configurado. Sem servidor de dev no ar, PULA.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../../../../scripts/test-setup'
import { db, q, q1 } from '../../../../utils/db'
import { roleLegado, type Papel } from '../../../../utils/papeis'
import { apagarImagem, chaveDoCaminho } from '../../../../utils/storage-r2'

const BASE = BASE_DE_TESTE
const ORG = randomUUID()
const OUTRA_ORG = randomUUID()
const EV = randomUUID()
const EV_FORA = randomUUID()

const EMAILS: Record<Papel, string> = {
  master: 'imagem.api.master@teste.invalido',
  financeiro: 'imagem.api.financeiro@teste.invalido',
  operacao: 'imagem.api.operacao@teste.invalido',
  portaria: 'imagem.api.portaria@teste.invalido',
}
const cookies: Partial<Record<Papel, string>> = {}
let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }

/** 1x1 PNG transparente de verdade — o `sharp` do handler precisa DECODIFICAR o arquivo, não só ver o mimetype. */
const PNG_VALIDO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

/** chaves que efetivamente subiram no bucket real — apagadas no afterAll, mesmo se o teste falhar no meio */
const chavesSobem: string[] = []

async function entrarCom(email: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha: 'diamond123' }),
  })
  return (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}

function corpoMultipart(campos: Record<string, string | { bytes: Buffer; tipo: string; nome: string }>) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(campos)) {
    if (typeof v === 'string') fd.append(k, v)
    else fd.append(k, new Blob([v.bytes], { type: v.tipo }), v.nome)
  }
  return fd
}

async function subir(
  eventoId: string,
  papel: Papel | null,
  campos: Record<string, string | { bytes: Buffer; tipo: string; nome: string }>,
) {
  const r = await fetch(`${BASE}/api/admin/evento/${eventoId}/imagem`, {
    method: 'POST',
    headers: papel ? { cookie: cookies[papel] ?? '', origin: BASE } : { origin: BASE },
    body: corpoMultipart(campos),
  })
  const corpo: any = await r.json().catch(() => ({}))
  return { status: r.status, corpo, mensagem: corpo.statusMessage ?? corpo.message ?? '' }
}

/**
 * Apaga linha de auditoria pela única porta que o gatilho da 019 aceita —
 * mesma receita de `clientes.test.ts`.
 */
async function expurgar(onde: string, par: any[] = []) {
  const c = await db().connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL auditoria.expurgo = 'liberado'`)
    await c.query(`DELETE FROM audit_log WHERE ${onde}`, par)
    await c.query('COMMIT')
  } finally {
    try { await c.query('ROLLBACK') } catch { /* já fechou */ }
    c.release()
  }
}

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/evento/[id]/imagem.test.ts', sonda)
  if (!sonda.noAr) return

  const restos = `SELECT id FROM organizations WHERE slug LIKE 'zz-imgapi-%' OR slug LIKE 'zz-imgfora-%'`
  await expurgar(`org_id IN (${restos})`)
  await q(`DELETE FROM events WHERE org_id IN (${restos})`)
  await q(`DELETE FROM organizations WHERE id IN (${restos})`)

  await q(`INSERT INTO organizations (id, name, slug) VALUES ($1,'ZZ Imagem Api',$2), ($3,'ZZ Imagem Fora',$4)`,
    [ORG, `zz-imgapi-${ORG.slice(0, 8)}`, OUTRA_ORG, `zz-imgfora-${OUTRA_ORG.slice(0, 8)}`])
  await q(`INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
           VALUES ($1,$2,'ZZ Evento Imagem',$3, now() + interval '5 days', now() + interval '6 days', 1000, 'ativo')`,
    [EV, ORG, `zz-imgapi-ev-${EV.slice(0, 8)}`])
  await q(`INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
           VALUES ($1,$2,'ZZ Evento Fora',$3, now() + interval '5 days', now() + interval '6 days', 1000, 'ativo')`,
    [EV_FORA, OUTRA_ORG, `zz-imgfora-ev-${EV_FORA.slice(0, 8)}`])

  for (const papel of Object.keys(EMAILS) as Papel[]) {
    await q(
      `INSERT INTO users (org_id, name, email, password_hash, papel, role)
       SELECT $1, $2, $3, password_hash, $4, $5 FROM users WHERE email = 'dono@fazendapark.com.br'`,
      [ORG, `Teste ${papel}`, EMAILS[papel], papel, roleLegado(papel)])
    cookies[papel] = await entrarCom(EMAILS[papel])
  }
}, 90_000)

afterAll(async () => {
  if (sonda.noAr) {
    for (const chave of chavesSobem) await apagarImagem(chave)
    await expurgar(`org_id = ANY($1::uuid[])`, [[ORG, OUTRA_ORG]])
    await q(`DELETE FROM events WHERE org_id = ANY($1::uuid[])`, [[ORG, OUTRA_ORG]])
    await q(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OUTRA_ORG]])
  }
  await db().end()
})

describe('validação (roda com ou sem bucket configurado)', () => {
  it('campo ausente ou inválido: 400 com recado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const semCampo = await subir(EV, 'master', { arquivo: { bytes: PNG_VALIDO, tipo: 'image/png', nome: 'a.png' } })
    expect(semCampo.status).toBe(400)
    expect(semCampo.mensagem).toMatch(/campo/i)

    const campoErrado = await subir(EV, 'master',
      { campo: 'logo', arquivo: { bytes: PNG_VALIDO, tipo: 'image/png', nome: 'a.png' } })
    expect(campoErrado.status).toBe(400)
  })

  it('nenhum arquivo enviado: 400', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await subir(EV, 'master', { campo: 'banner' })
    expect(r.status).toBe(400)
    expect(r.mensagem).toMatch(/nenhum arquivo/i)
  })

  it('arquivo maior que 8MB: 413', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const grande = Buffer.alloc(8 * 1024 * 1024 + 1)
    const r = await subir(EV, 'master', { campo: 'banner', arquivo: { bytes: grande, tipo: 'image/png', nome: 'grande.png' } })
    expect(r.status).toBe(413)
  })

  it('mimetype que não é imagem: 415', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await subir(EV, 'master',
      { campo: 'banner', arquivo: { bytes: Buffer.from('não é imagem'), tipo: 'text/plain', nome: 'a.txt' } })
    expect(r.status).toBe(415)
  })

  it('mimetype de imagem mas conteúdo corrompido: 422, não 500', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await subir(EV, 'master',
      { campo: 'banner', arquivo: { bytes: Buffer.from('isto não é um png de verdade'), tipo: 'image/png', nome: 'a.png' } })
    expect(r.status).toBe(422)
  })

  it('evento de outra organização, inexistente e id torto: 404, sem distinguir', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    for (const id of [EV_FORA, randomUUID(), 'nao-e-uuid']) {
      const r = await subir(id, 'master', { campo: 'banner', arquivo: { bytes: PNG_VALIDO, tipo: 'image/png', nome: 'a.png' } })
      expect(r.status, id).toBe(404)
    }
  })
})

describe('quem abre — a área é "evento", igual a configurações', () => {
  it('financeiro e portaria levam 403; master e operação passam da porta (chegam na validação)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    for (const papel of ['financeiro', 'portaria'] as Papel[]) {
      const r = await subir(EV, papel, {})
      expect(r.status, papel).toBe(403)
    }
    for (const papel of ['master', 'operacao'] as Papel[]) {
      // corpo vazio de propósito: se a resposta for 400 (não 403), é porque
      // o papel passou da grade e chegou na validação do handler.
      const r = await subir(EV, papel, {})
      expect(r.status, papel).toBe(400)
    }
  })

  it('sem sessão nenhuma, nada sobe', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await subir(EV, null, { campo: 'banner', arquivo: { bytes: PNG_VALIDO, tipo: 'image/png', nome: 'a.png' } })
    expect([401, 403]).toContain(r.status)
  })
})

describe('sem R2_BUCKET no servidor', () => {
  it('upload válido responde 503 com o recado pronto — nunca 500 cru', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    if (process.env.R2_BUCKET) {
      ctx.skip('R2_BUCKET está configurado neste ambiente — este caso é só pra quando NÃO está')
    }
    const r = await subir(EV, 'master',
      { campo: 'banner', arquivo: { bytes: PNG_VALIDO, tipo: 'image/png', nome: 'a.png' } })
    expect(r.status).toBe(503)
    expect(r.mensagem).toBe('O envio de imagem ainda não está ligado (falta R2_BUCKET no .env do servidor).')
  })
})

describe('com R2_BUCKET de verdade — sobe, grava e troca', () => {
  it('sobe o banner, grava caminho relativo no evento, deixa rastro na auditoria', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    if (!process.env.R2_BUCKET) {
      ctx.skip('sem nome de bucket no .env ainda não dá pra testar upload de verdade')
    }
    await expurgar('org_id = $1', [ORG])
    const r = await subir(EV, 'master',
      { campo: 'banner', arquivo: { bytes: PNG_VALIDO, tipo: 'image/png', nome: 'a.png' } })
    expect(r.status).toBe(200)
    expect(r.corpo.url).toMatch(new RegExp(`^/api/midia/eventos/${ORG}/${EV}/banner-[A-Za-z0-9_-]{10}\\.webp$`))
    const chave = chaveDoCaminho(r.corpo.url)!
    chavesSobem.push(chave)

    const evento = await q1<any>('SELECT banner_url FROM events WHERE id = $1', [EV])
    expect(evento.banner_url).toBe(r.corpo.url)

    const imagem = await fetch(`${BASE}${r.corpo.url}`)
    expect(imagem.status).toBe(200)
    expect(imagem.headers.get('content-type')).toBe('image/webp')

    const linha = await q1<any>(
      `SELECT entity, action, actor_email, after FROM audit_log WHERE org_id = $1`, [ORG])
    expect(linha).toMatchObject({ entity: 'evento', action: 'editado', actor_email: EMAILS.master })
    expect(linha.after).toEqual({ banner: r.corpo.url })
  })

  it('subir de novo apaga a imagem anterior do bucket (o proxy passa a dar 404 nela)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    if (!process.env.R2_BUCKET) {
      ctx.skip('sem nome de bucket no .env ainda não dá pra testar upload de verdade')
    }
    const primeiro = await subir(EV, 'master',
      { campo: 'thumb', arquivo: { bytes: PNG_VALIDO, tipo: 'image/png', nome: 'a.png' } })
    expect(primeiro.status).toBe(200)
    const urlAntiga = primeiro.corpo.url as string

    const segundo = await subir(EV, 'master',
      { campo: 'thumb', arquivo: { bytes: PNG_VALIDO, tipo: 'image/png', nome: 'b.png' } })
    expect(segundo.status).toBe(200)
    const urlNova = segundo.corpo.url as string
    expect(urlNova).not.toBe(urlAntiga)
    chavesSobem.push(chaveDoCaminho(urlNova)!)

    expect((await fetch(`${BASE}${urlAntiga}`)).status).toBe(404)
    expect((await fetch(`${BASE}${urlNova}`)).status).toBe(200)
  })
})
