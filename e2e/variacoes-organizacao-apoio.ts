/**
 * Apoio da bateria de VARIAÇÕES do painel da organização (V-ORG, rodada final da matriz, 28/09).
 *
 * A bateria de variações precisa de estados que a base de E2E não tem: organização SEM evento,
 * portaria com UM leitor só, 20.001 clientes, 300+ divergências, 200+ atos de auditoria, gente pra
 * desativar e senha pra errar oito vezes. Nada disso pode nascer na organização do seed — outra
 * bateria (V-EVT) roda no mesmo banco e na mesma 3120 ao mesmo tempo, e conta eventos, leitores e
 * dinheiro dela.
 *
 * Então cada caso que precisa de terreno próprio ganha uma ORGANIZAÇÃO própria, "ZZVARORG …",
 * nascida por SQL no banco `_e2e` (a trava recusa qualquer outro nome de banco), com usuários de
 * senha conhecida — a de teste, só válida nesta 3120. Os eventos que publicamos nascem PRIVADOS:
 * abrem pelo link, mas não entram na vitrine pública que a outra bateria lê. No fim, a organização
 * inteira sai, na ordem que as chaves estrangeiras pedem (ingresso → pedido → caixa → evento →
 * cliente → usuário → organização) e com a auditoria dela expurgada do jeito que o gatilho aceita
 * (`SET LOCAL auditoria.expurgo = 'liberado'`, na mesma transação).
 *
 * Os e-mails de confirmação dos pedidos daqui caem no transporte SIMULADO (sem SMTP_URL, o
 * servidor grava .eml na pasta temporária) — e os endereços são todos `@teste.invalido`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'
import pg from 'pg'
import { expect, request as novoRequest, type APIRequestContext, type Page } from '@playwright/test'
import { BASE, SENHA, type Papel } from './apoio'
import { corpo, diaNaBahia } from './evento-apoio'

export const PREFIXO = 'ZZVARORG'

/* ------------------------------------------------------------------ banco */

let pool: pg.Pool | null = null

function urlDoBanco(): string {
  const candidatos = [join(process.cwd(), '.env.e2e')]
  const arquivo = candidatos.find((c) => existsSync(c))
  if (!arquivo) throw new Error('não achei o .env.e2e na raiz do projeto')
  const url = readFileSync(arquivo, 'utf8').match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, '')
  // trava dura: o nome do banco TEM que terminar em _e2e (nunca o real, nunca o da suíte)
  const nome = url ? new URL(url).pathname.replace(/^\//, '') : ''
  if (!url || !/_e2e$/.test(nome)) throw new Error(`recusado: o banco "${nome}" não é o _e2e`)
  return url
}

export function banco(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: urlDoBanco(), max: 4 })
  return pool
}

export async function sql<T = any>(texto: string, params: unknown[] = []): Promise<T[]> {
  const r = await banco().query(texto, params as any[])
  return r.rows as T[]
}

export async function fecharBanco() {
  const p = pool
  pool = null
  await p?.end().catch(() => {})
}

/* ------------------------------------------------------- organização isolada */

const ROLE_LEGADO: Record<Papel, string> = {
  master: 'master', financeiro: 'admin', operacao: 'operacional', portaria: 'portaria',
}

export interface UsuarioZZ { id: string; email: string; nome: string; papel: Papel }
export interface OrgZZ { id: string; nome: string; slug: string; marca: string; usuarios: Partial<Record<Papel, UsuarioZZ>> }

let hashDaSenha: string | null = null
const hashDeTeste = () => (hashDaSenha ??= bcrypt.hashSync(SENHA, 10))

/** marca curta e única desta chamada (vai no nome, no slug e nos e-mails) */
export const marcaNova = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * Uma organização "ZZVARORG <rótulo> <marca>" com um usuário por papel pedido, todos com a senha de
 * teste. Nasce sem evento, sem cliente e sem chave do Asaas (ambiente de testes).
 */
export async function criarOrganizacao(rotulo: string, papeis: Papel[] = ['master']): Promise<OrgZZ> {
  const marca = marcaNova()
  const nome = `${PREFIXO} ${rotulo} ${marca}`
  const slug = `zzvarorg-${rotulo.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${marca}`.slice(0, 80)
  const [o] = await sql<{ id: string }>(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`, [nome, slug])
  const org: OrgZZ = { id: o!.id, nome, slug, marca, usuarios: {} }
  for (const papel of papeis) await criarUsuario(org, papel)
  return org
}

/** mais um usuário na organização (o `extra` distingue dois do mesmo papel) */
export async function criarUsuario(org: OrgZZ, papel: Papel, extra = ''): Promise<UsuarioZZ> {
  const rotuloEmail = `${papel}${extra ? `.${extra}` : ''}`
  const email = `zzvarorg.${rotuloEmail}.${org.marca}@teste.invalido`.toLowerCase()
  const nome = `${PREFIXO} ${papel}${extra ? ` ${extra}` : ''}`
  const [u] = await sql<{ id: string }>(
    `INSERT INTO users (org_id, name, email, password_hash, papel, role)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [org.id, nome, email, hashDeTeste(), papel, ROLE_LEGADO[papel]])
  const usuario: UsuarioZZ = { id: u!.id, email, nome, papel }
  if (!extra) org.usuarios[papel] = usuario
  return usuario
}

/**
 * Entra pela rota de login (a mesma do formulário) e devolve os cookies — pra pôr no `context` do
 * caso — e uma API já logada, com a origem que a trava de CSRF confere.
 */
export async function entrarComo(email: string, senha = SENHA) {
  const api = await novoRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } })
  const r = await api.post('/api/auth/entrar', { data: { email, senha } })
  expect(r.status(), `login de ${email}: ${await r.text()}`).toBe(200)
  const estado = await api.storageState()
  return { api, cookies: estado.cookies }
}

/**
 * Apaga a organização ZZVARORG inteira, na ordem das chaves estrangeiras, numa transação. Recusa
 * qualquer organização cujo nome não comece por ZZVARORG — a do seed nunca passa por aqui.
 */
export async function apagarOrganizacao(orgId: string) {
  const c = await banco().connect()
  try {
    await c.query('BEGIN')
    const o = await c.query(`SELECT name FROM organizations WHERE id = $1`, [orgId])
    if (!o.rows.length) { await c.query('ROLLBACK'); return }
    if (!String(o.rows[0].name).startsWith(`${PREFIXO} `)) {
      throw new Error(`recusado: a organização "${o.rows[0].name}" não é da bateria ${PREFIXO}`)
    }
    const eventos = (await c.query(`SELECT id FROM events WHERE org_id = $1`, [orgId])).rows.map((r) => r.id)
    const pedidos = (await c.query(`SELECT id FROM orders WHERE org_id = $1`, [orgId])).rows.map((r) => r.id)
    const usuarios = (await c.query(`SELECT id, email FROM users WHERE org_id = $1`, [orgId])).rows
    const ids = [...eventos, ...pedidos, ...usuarios.map((u) => u.id)].map(String)

    await c.query(`SET LOCAL auditoria.expurgo = 'liberado'`)
    await c.query(`DELETE FROM audit_log WHERE org_id = $1 OR entity_id = ANY($2::text[])`, [orgId, ids])
    await c.query(`DELETE FROM payment_events WHERE order_id = ANY($1::uuid[]) OR external_id LIKE 'pay_zzvarorg_%'`, [pedidos])
    await c.query(`DELETE FROM checkins WHERE event_id = ANY($1::uuid[])`, [eventos])
    await c.query(`DELETE FROM tickets WHERE org_id = $1`, [orgId])
    await c.query(`DELETE FROM courtesy_grants WHERE org_id = $1`, [orgId])
    await c.query(`DELETE FROM orders WHERE org_id = $1`, [orgId])
    await c.query(`DELETE FROM email_sends WHERE org_id = $1`, [orgId])
    await c.query(`DELETE FROM pos_shifts WHERE org_id = $1`, [orgId])
    await c.query(`DELETE FROM events WHERE org_id = $1`, [orgId])
    await c.query(`DELETE FROM customers WHERE org_id = $1`, [orgId])
    await c.query(`DELETE FROM login_attempts WHERE email = ANY($1::text[])`, [usuarios.map((u) => u.email)])
    await c.query(`DELETE FROM users WHERE org_id = $1`, [orgId])
    await c.query(`DELETE FROM organizations WHERE id = $1`, [orgId])
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

/**
 * Restos de uma rodada que caiu antes do `afterAll`: organizações ZZVARORG com mais de 30 minutos
 * (as de uma rodada em curso são mais novas e ficam).
 */
export async function limparRestos() {
  const velhas = await sql<{ id: string }>(
    `SELECT id FROM organizations WHERE name LIKE $1 AND created_at < now() - interval '30 minutes'`,
    [`${PREFIXO} %`])
  for (const o of velhas) await apagarOrganizacao(o.id)
  await sql(`DELETE FROM login_attempts WHERE email LIKE 'zzvarorg.%' AND at < now() - interval '30 minutes'`)
}

/* ---------------------------------------------------------------- eventos */

/** evento direto no banco (quando o que se testa é a tela que LÊ, não a criação) */
export async function criarEventoSql(orgId: string, o: {
  nome: string; inicio: Date; fim: Date; status?: string; privado?: boolean
}): Promise<{ id: string; slug: string }> {
  const slug = `zzvarorg-${marcaNova()}`
  const [e] = await sql<{ id: string; slug: string }>(
    `INSERT INTO events (org_id, name, slug, starts_at, ends_at, fee_bps, status, is_private, city, state)
     VALUES ($1, $2, $3, $4, $5, 0, $6, $7, 'Vitória da Conquista', 'BA') RETURNING id, slug`,
    [orgId, o.nome, slug, o.inicio, o.fim, o.status ?? 'ativo', o.privado ?? true])
  return e!
}

export interface EventoZZ { id: string; slug: string; nome: string; loteId: string; inteira: string | null }

/**
 * Evento publicado e PRIVADO pela rota do painel (a mesma do assistente), com um setor, um lote de
 * R$ 30,00 e os tipos Inteira e Meia — ou só o lote, sem tipos.
 */
export async function criarEventoApi(api: APIRequestContext, o: {
  nome: string; emDias?: number; publicar?: boolean; substantivo?: string; semTipos?: boolean
}): Promise<EventoZZ> {
  const inicio = new Date(Date.now() + (o.emDias ?? 5) * 86_400_000)
  inicio.setUTCHours(13, 0, 0, 0)
  const fim = new Date(inicio.getTime() + 8 * 3_600_000)
  const criado = await corpo(await api.post('/api/admin/evento', {
    data: {
      nome: o.nome, inicio: inicio.toISOString(), fim: fim.toISOString(),
      local: { nome: 'Parque ZZVARORG', cidade: 'Vitória da Conquista', estado: 'BA' },
      suporte: { tipo: 'whatsapp', valor: '(73) 99999-0000' },
      privado: true, publicar: o.publicar ?? true,
      ...(o.substantivo ? { substantivo: o.substantivo } : {}),
      setores: [{
        nome: 'Geral',
        lotes: [{
          nome: '1º lote', faceCents: 3000, quantidade: 200, canais: ['online', 'bilheteria'],
          tipos: o.semTipos ? [] : [
            { nome: 'Inteira', quantidade: 200 },
            { nome: 'Meia', quantidade: 200, descontoBps: 5000, exigeDocumento: true },
          ],
        }],
      }],
    },
  }))
  const ing = await corpo(await api.get(`/api/admin/evento/${criado.id}/ingressos`))
  const lote = ing.setores[0].lotes[0]
  return {
    id: criado.id, slug: criado.slug, nome: o.nome, loteId: lote.id,
    inteira: lote.tipos.find((t: any) => t.nome === 'Inteira')?.id ?? null,
  }
}

/* ------------------------------------------------------------- assistente */

export interface Assistente {
  nome: string
  /** padrão: privado (não entra na vitrine que a outra bateria lê) */
  privado?: boolean
  faixa?: number
  cidade?: string
  suporte?: string
  /** preço do 1º lote em dígitos de centavos, como a pessoa digita ("1000" = R$ 10,00) */
  preco?: string
  substantivo?: string
  esconderFim?: boolean
  /** ganchos: o caso mexe no passo antes do "Prosseguir" */
  noPasso1?: (page: Page) => Promise<void>
  noPasso2?: (page: Page) => Promise<void>
  noPasso3?: (page: Page) => Promise<void>
  noPasso4?: (page: Page) => Promise<void>
  noPasso5?: (page: Page) => Promise<void>
}

export const prosseguir = (page: Page) => page.getByRole('button', { name: 'Prosseguir' })
export const caixaDeErro = (page: Page) => page.locator('[role="alert"].animate-sacode')
/** o passo atual pela trilha da lateral (computador) */
export const passoAtual = (page: Page) => page.locator('aside li[aria-current="step"]')

/**
 * Preenche os cinco passos com dados válidos (e o que o caso mudar nos ganchos) e para no passo 5,
 * ANTES de publicar. A página já tem que estar em /admin/evento/novo, hidratada.
 */
export async function preencherAssistente(page: Page, o: Assistente) {
  await page.locator('#nome').fill(o.nome)
  if (o.faixa !== undefined) await page.locator('#idade').selectOption(String(o.faixa))
  if (o.privado ?? true) await page.getByLabel('Privado').check()
  await page.locator('#cid').fill(o.cidade ?? 'Vitória da Conquista')
  await page.locator('#uf').fill('BA')
  await page.locator('#sval').fill(o.suporte ?? '(73) 99999-0000')
  if (o.noPasso1) await o.noPasso1(page)
  await prosseguir(page).click()
  await preencherDoPasso2(page, o)
}

/** do passo 2 ao 5 (o passo 1 já foi feito pelo caso e a tela está no 2) */
export async function preencherDoPasso2(page: Page, o: Omit<Assistente, 'nome'>) {
  await expect(page.getByRole('heading', { name: 'Descrição do evento (Opcional)' })).toBeVisible()
  if (o.noPasso2) await o.noPasso2(page)
  await prosseguir(page).click()
  await expect(page.getByRole('heading', { name: 'Setores, lotes e tipos de ingresso' })).toBeVisible()
  if (o.noPasso3) await o.noPasso3(page)
  await prosseguir(page).click()
  await expect(page.getByRole('heading', { name: 'Preços e quantidades' })).toBeVisible()
  if (o.substantivo) await page.locator('#substantivo').selectOption(o.substantivo)
  const precos = page.locator('input[inputmode="numeric"]')
  for (let i = 0; i < await precos.count(); i++) await precos.nth(i).fill(o.preco ?? '1000')
  if (o.noPasso4) await o.noPasso4(page)
  await prosseguir(page).click()
  await expect(page.getByRole('heading', { name: 'Datas e horários' })).toBeVisible()
  const dia = diaNaBahia(40)
  await page.locator('#inicio').fill(`${dia}T20:00`)
  await page.locator('#fim').fill(`${dia}T23:00`)
  if (o.esconderFim) await page.getByLabel('Não mostrar o término do evento').check()
  if (o.noPasso5) await o.noPasso5(page)
}

/** "Publicar evento" → ✓ → tela de ingressos. Devolve o id e o endereço do evento criado. */
export async function publicarAssistente(page: Page, api: APIRequestContext) {
  await page.getByRole('button', { name: 'Publicar evento' }).click()
  await expect(page.getByText('Evento publicado!')).toBeVisible({ timeout: 60_000 })
  await expect(page).toHaveURL(/\/admin\/evento\/[0-9a-f-]{36}\/ingressos/, { timeout: 60_000 })
  const id = page.url().match(/evento\/([0-9a-f-]{36})\//)![1]!
  const resumo = await corpo(await api.get(`/api/admin/evento/${id}/resumo`))
  return { id, slug: String(resumo.slug), resumo }
}

/* ---------------------------------------------------------------- e-mail */

const PASTA_DOS_EMAILS = process.env.EMAIL_PASTA_SIMULADO || join(tmpdir(), 'diamond-tickets-envios')

/** o .eml que o transporte simulado gravou pra este endereço (espera a fila andar) */
export async function esperarEmail(email: string, timeout = 60_000): Promise<{ arquivo: string; assunto: string; texto: string }> {
  const marca = email.replace(/[^a-zA-Z0-9]/g, '_')
  const fim = Date.now() + timeout
  while (Date.now() < fim) {
    const achado = existsSync(PASTA_DOS_EMAILS)
      ? readdirSync(PASTA_DOS_EMAILS).filter((n) => n.includes(marca) && n.endsWith('.eml')).sort().pop()
      : undefined
    if (achado) {
      const arquivo = join(PASTA_DOS_EMAILS, achado)
      return { arquivo, ...lerEml(await readFile(arquivo, 'utf8')) }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`nenhum e-mail gravado para ${email} em ${timeout / 1000}s (pasta ${PASTA_DOS_EMAILS})`)
}

/** assunto (com o `=?UTF-8?B?…?=` aberto) e as partes de texto (base64) do .eml, decodificadas */
export function lerEml(bruto: string) {
  const cru = bruto.match(/^Subject: (.*)$/m)?.[1] ?? ''
  const assunto = cru.replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b) => Buffer.from(b, 'base64').toString('utf8'))
  const partes: string[] = []
  const re = /Content-Type: text\/(?:plain|html)[^\r\n]*\r?\nContent-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n\r?\n/g
  for (const m of bruto.matchAll(re)) partes.push(Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64').toString('utf8'))
  return { assunto, texto: partes.join('\n') }
}

export async function apagarArquivo(caminho: string) { await unlink(caminho).catch(() => {}) }

/* ---------------------------------------------------------------- imagens */

/** PNG 8×4 (horizontal de propósito: a prévia quadrada tem que recortar, não esticar) */
export const PNG_8x4 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAARElEQVR4nA3JMQHAQAwDMTMJFEMJjdsM5aEYSqi0WiWhQUaLgh4qOiThwcaLgx8uPvxHhpgsCXmk5MgfHWq6NPTR0qMfwugozfh+tqwAAAAASUVORK5CYII=',
  'base64')
