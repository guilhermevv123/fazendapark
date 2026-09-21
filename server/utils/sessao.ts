/**
 * Sessão de login: criar, ler, renovar, encerrar.
 *
 * Três decisões que valem mais que o código:
 *
 * 1. **O cookie carrega o segredo; o banco guarda o hash.** Dump, log de
 *    query e backup vazado não viram acesso. O segredo existe uma vez só, na
 *    resposta do login.
 *
 * 2. **30 dias com renovação deslizante.** Quem usa todo dia nunca é
 *    deslogado; quem some 30 dias precisa entrar de novo. A alternativa curta
 *    já foi testada na prática e o resultado foi a equipe caindo no meio do
 *    expediente — inclusive a portaria, às 2h da manhã, com fila na frente.
 *
 * 3. **SameSite=Lax em vez de token CSRF separado.** Um token CSRF com prazo
 *    próprio expira ANTES da sessão e devolve 403 em todo salvamento, com o
 *    usuário logado e sem entender o motivo. Lax já bloqueia POST vindo de
 *    outro site, e a checagem de origem abaixo fecha o resto — sem um segundo
 *    relógio pra desencontrar do primeiro.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import { q1, tx } from './db'

export const COOKIE = 'dt_sessao'
const DIAS = 30
const RENOVA_APOS_MIN = 60 // só mexe no banco se a última visita foi há mais de 1h

export type Sessao = {
  usuarioId: string
  orgId: string
  nome: string
  email: string
  papel: Papel
}

export type Papel =
  | 'master' | 'admin' | 'financeiro' | 'marketing' | 'operacional' | 'portaria' | 'leitura'

const hash = (t: string) => createHash('sha256').update(t).digest('hex')

/** Cria a sessão e devolve o segredo que vai pro cookie (só existe aqui). */
export async function abrirSessao(event: H3Event, usuarioId: string) {
  const segredo = randomBytes(32).toString('base64url')
  const expira = new Date(Date.now() + DIAS * 86_400_000)

  await q1(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [usuarioId, hash(segredo), expira,
     getRequestHeader(event, 'user-agent')?.slice(0, 300) ?? null, ipDaRequisicao(event)])

  await q1(`UPDATE users SET last_login_at = now() WHERE id = $1 RETURNING id`, [usuarioId])

  setCookie(event, COOKIE, segredo, {
    httpOnly: true,
    sameSite: 'lax',
    // Em desenvolvimento o dev server é http://localhost; marcar secure aqui
    // faria o navegador descartar o cookie em silêncio e o login "não
    // funcionaria" sem nenhuma mensagem de erro.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expira,
  })
  return segredo
}

/** Lê a sessão do cookie. Devolve null se não existe, expirou ou foi revogada. */
export async function lerSessao(event: H3Event): Promise<Sessao | null> {
  const segredo = getCookie(event, COOKIE)
  if (!segredo) return null

  const linha = await q1<any>(
    `SELECT s.id, s.last_seen_at, u.id AS uid, u.org_id, u.name, u.email, u.role, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [hash(segredo)])

  // Usuário desativado perde o acesso na hora, sem precisar revogar sessão a
  // sessão: a checagem é no `active` do usuário, na leitura.
  if (!linha || !linha.active) return null

  // Renovação deslizante — mas só de hora em hora. Escrever no banco a cada
  // requisição transformaria a tabela de sessões no ponto mais quente do
  // sistema por nada.
  const minutos = (Date.now() - new Date(linha.last_seen_at).getTime()) / 60_000
  if (minutos > RENOVA_APOS_MIN) {
    const expira = new Date(Date.now() + DIAS * 86_400_000)
    await q1(
      `UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE id = $1 RETURNING id`,
      [linha.id, expira])
    setCookie(event, COOKIE, segredo, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
      path: '/', expires: expira,
    })
  }

  return {
    usuarioId: linha.uid, orgId: linha.org_id, nome: linha.name,
    email: linha.email, papel: linha.role as Papel,
  }
}

export async function encerrarSessao(event: H3Event) {
  const segredo = getCookie(event, COOKIE)
  if (segredo) {
    await q1(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 RETURNING id`,
      [hash(segredo)])
  }
  deleteCookie(event, COOKIE, { path: '/' })
}

/** Encerra TODAS as sessões do usuário (troca de senha, suspeita de vazamento). */
export async function encerrarTodas(usuarioId: string) {
  await q1(
    `UPDATE sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`, [usuarioId])
}

/* ------------------------------------------------------------------ freio */

/**
 * Força bruta: conta as falhas recentes por e-mail E por IP.
 *
 * Por e-mail sozinho, um atacante testa a mesma senha em mil contas sem nunca
 * bater o limite de nenhuma. Por IP sozinho, uma empresa inteira atrás de um
 * NAT se tranca junto. Os dois, com números diferentes, cobrem os dois casos.
 */
export async function travadoPorTentativas(email: string, ip: string | null) {
  const porEmail = await q1<any>(
    `SELECT count(*)::int AS n FROM login_attempts
      WHERE email = $1 AND ok = false AND at > now() - interval '15 minutes'`, [email])
  if (Number(porEmail.n) >= 8) return 'Muitas tentativas para este e-mail. Tente de novo em 15 minutos.'

  if (ip) {
    const porIp = await q1<any>(
      `SELECT count(*)::int AS n FROM login_attempts
        WHERE ip = $1 AND ok = false AND at > now() - interval '15 minutes'`, [ip])
    if (Number(porIp.n) >= 30) return 'Muitas tentativas deste endereço. Tente de novo em 15 minutos.'
  }
  return null
}

export async function registrarTentativa(email: string, ip: string | null, ok: boolean) {
  await q1(`INSERT INTO login_attempts (email, ip, ok) VALUES ($1,$2,$3) RETURNING id`,
    [email, ip, ok])
}

export function ipDaRequisicao(event: H3Event) {
  // Atrás do Cloudflare o IP real vem no CF-Connecting-IP. Sem proxy, o
  // socket. Confiar em X-Forwarded-For sem proxy na frente é deixar o próprio
  // cliente escolher o IP que o freio vai contar.
  return getRequestHeader(event, 'cf-connecting-ip')
    ?? event.node.req.socket.remoteAddress
    ?? null
}

/* ------------------------------------------------------------------ papéis */

/** O que cada papel pode fazer. Deny-by-default: não listado = não pode. */
const PODE: Record<Papel, string[]> = {
  master:      ['*'],
  admin:       ['evento', 'ingresso', 'venda', 'cortesia', 'cupom', 'promoter',
                'relatorio', 'financeiro', 'portaria', 'equipe'],
  financeiro:  ['relatorio', 'financeiro', 'venda'],
  marketing:   ['cupom', 'promoter', 'relatorio'],
  operacional: ['evento', 'ingresso', 'venda', 'cortesia', 'portaria'],
  portaria:    ['portaria'],
  leitura:     ['relatorio'],
}

export const podeFazer = (papel: Papel, area: string) =>
  PODE[papel]?.includes('*') || PODE[papel]?.includes(area) || false

/** Igual a `lerSessao`, mas explode com 401/403 em vez de devolver null. */
export async function exigir(event: H3Event, area?: string): Promise<Sessao> {
  const s = await lerSessao(event)
  if (!s) throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })
  if (area && !podeFazer(s.papel, area)) {
    throw createError({
      statusCode: 403,
      statusMessage: `Seu acesso (${s.papel}) não inclui ${area}.`,
    })
  }
  return s
}

/** Comparação de segredo em tempo constante, pros casos fora do bcrypt. */
export function iguais(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
