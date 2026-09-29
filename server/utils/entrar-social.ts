/**
 * entrar-social.ts — entrar com o Google ou com a Apple (OpenID Connect), pronto e DESLIGADO até a
 * organização configurar as chaves no servidor.
 *
 *   Google: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (console do Google Cloud → Credenciais →
 *           ID do cliente OAuth, tipo "Aplicativo da Web").
 *   Apple:  `APPLE_CLIENT_ID` (o Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID` e
 *           `APPLE_PRIVATE_KEY` (o .p8 do "Sign in with Apple", com as quebras de linha).
 *
 * O endereço de volta cadastrado nos dois é `<PUBLIC_BASE_URL>/api/conta/<provedor>/volta` — por
 * isso sem `PUBLIC_BASE_URL` https o botão não aparece, mesmo com as chaves.
 *
 * O que protege o caminho:
 *   · `state` e `nonce` aleatórios, guardados num cookie ASSINADO e curto (10 min): a volta que não
 *     traz o mesmo `state` é recusada (é o CSRF do OAuth), e o `id_token` que não traz o mesmo
 *     `nonce` também (é o replay);
 *   · o `id_token` é conferido com as chaves públicas do provedor (JWKS), o emissor e a audiência
 *     — o nome e o e-mail só valem depois disso;
 *   · a Apple devolve por POST de outro site (`form_post`): o cookie dela vai `SameSite=None`.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTVerifyGetKey,
} from 'jose'
import { deleteCookie, getCookie, setCookie, type H3Event } from 'h3'
import { baseDoSite } from './envio'

export type ProvedorSocial = 'google' | 'apple'
export const PROVEDORES_SOCIAIS: ProvedorSocial[] = ['google', 'apple']

const COOKIE_DO_OAUTH = 'dt_cliente_oauth'
/** o cadastro que falta (CPF e celular) depois de o Google/Apple dizer quem é */
export const COOKIE_DO_CADASTRO_SOCIAL = 'dt_cliente_social'

interface ConfigDoProvedor {
  clientId: string
  urlDeEntrada: string
  urlDoToken: string
  urlDasChaves: string
  emissores: string[]
  escopo: string
  formPost: boolean
}

function configDoProvedor(p: ProvedorSocial, env = process.env): ConfigDoProvedor | null {
  if (p === 'google') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null
    return {
      clientId: env.GOOGLE_CLIENT_ID,
      urlDeEntrada: 'https://accounts.google.com/o/oauth2/v2/auth',
      urlDoToken: 'https://oauth2.googleapis.com/token',
      urlDasChaves: 'https://www.googleapis.com/oauth2/v3/certs',
      emissores: ['https://accounts.google.com', 'accounts.google.com'],
      escopo: 'openid email profile',
      formPost: false,
    }
  }
  if (!env.APPLE_CLIENT_ID || !env.APPLE_TEAM_ID || !env.APPLE_KEY_ID || !env.APPLE_PRIVATE_KEY) return null
  return {
    clientId: env.APPLE_CLIENT_ID,
    urlDeEntrada: 'https://appleid.apple.com/auth/authorize',
    urlDoToken: 'https://appleid.apple.com/auth/token',
    urlDasChaves: 'https://appleid.apple.com/auth/keys',
    emissores: ['https://appleid.apple.com'],
    escopo: 'name email',
    formPost: true,
  }
}

/** O endereço de volta que vai cadastrado no provedor. Sem https, não há volta possível. */
export function urlDeVoltaSocial(p: ProvedorSocial): string | null {
  const base = baseDoSite()
  if (!base) return null
  if (process.env.NODE_ENV === 'production' && !base.startsWith('https://')) return null
  return `${base}/api/conta/${p}/volta`
}

/** Quais botões a tela mostra. Nunca devolve chave — só sim/não. */
export function provedoresSociaisLigados(env = process.env): Record<ProvedorSocial, boolean> {
  return {
    google: !!configDoProvedor('google', env) && !!urlDeVoltaSocial('google'),
    apple: !!configDoProvedor('apple', env) && !!urlDeVoltaSocial('apple'),
  }
}

/* ============================================================ o pacote assinado */

function chaveDoPacote(): Buffer {
  const segredo = String(process.env.NUXT_SESSION_SECRET ?? '')
  if (segredo.length < 16) throw new Error('NUXT_SESSION_SECRET ausente: não dá pra assinar o login social')
  return createHmac('sha256', 'dt:entrar-social').update(segredo).digest()
}

/** JSON com prazo, assinado: `base64url(json).base64url(hmac)`. */
export function assinarPacoteSocial(dados: Record<string, unknown>, minutos: number): string {
  const corpo = Buffer.from(JSON.stringify({ ...dados, exp: Date.now() + minutos * 60_000 })).toString('base64url')
  const assinatura = createHmac('sha256', chaveDoPacote()).update(corpo).digest('base64url')
  return `${corpo}.${assinatura}`
}

export function abrirPacoteSocial<T = Record<string, any>>(pacote: string | null | undefined): T | null {
  const [corpo, assinatura] = String(pacote ?? '').split('.')
  if (!corpo || !assinatura) return null
  const esperada = createHmac('sha256', chaveDoPacote()).update(corpo).digest()
  const veio = Buffer.from(assinatura, 'base64url')
  if (veio.length !== esperada.length || !timingSafeEqual(veio, esperada)) return null
  try {
    const d = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'))
    return d && typeof d.exp === 'number' && d.exp > Date.now() ? (d as T) : null
  } catch { return null }
}

/** Só caminho DESTE site (nada de `//outro.site` nem `https://…`). */
export function destinoSeguroDoCliente(volta: unknown): string {
  const v = String(volta ?? '')
  return /^\/(?!\/)[^\s\\]*$/.test(v) && !v.startsWith('/api/') ? v : '/conta'
}

/* ============================================================ ida */

export function urlDeEntradaSocial(event: H3Event, p: ProvedorSocial, contexto: { orgId: string; volta: string }): string | null {
  const cfg = configDoProvedor(p)
  const volta = urlDeVoltaSocial(p)
  if (!cfg || !volta) return null
  const state = randomBytes(18).toString('base64url')
  const nonce = randomBytes(18).toString('base64url')
  setCookie(event, COOKIE_DO_OAUTH, assinarPacoteSocial({
    p, state, nonce, org: contexto.orgId, volta: destinoSeguroDoCliente(contexto.volta),
  }, 10), {
    httpOnly: true,
    path: '/api/conta',
    // a Apple volta por POST de outro site: sem `None`, o navegador não manda o cookie e todo
    // login dela seria "sessão vencida"
    sameSite: cfg.formPost ? 'none' : 'lax',
    secure: cfg.formPost || process.env.NODE_ENV === 'production',
    maxAge: 600,
  })
  const u = new URL(cfg.urlDeEntrada)
  u.searchParams.set('client_id', cfg.clientId)
  u.searchParams.set('redirect_uri', volta)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', cfg.escopo)
  u.searchParams.set('state', state)
  u.searchParams.set('nonce', nonce)
  if (cfg.formPost) u.searchParams.set('response_mode', 'form_post')
  else u.searchParams.set('prompt', 'select_account')
  return u.toString()
}

/* ============================================================ volta */

export interface IdentidadeSocial {
  provedor: ProvedorSocial
  sub: string
  email: string | null
  emailVerificado: boolean
  nome: string | null
}

/**
 * Por que a entrada não deu certo. É o CÓDIGO que vai no endereço de volta (`/conta/entrar?erro=`),
 * e a tela é que tem a frase: texto livre na URL deixava qualquer um montar um link do site com
 * "seu cartão foi bloqueado, ligue para…" escrito na página.
 */
export type MotivoDaRecusaSocial = 'desligado' | 'cancelado' | 'expirou' | 'falhou' | 'sem_rede'
export class RecusaSocial extends Error {
  constructor(msg: string, public motivo: MotivoDaRecusaSocial = 'falhou') { super(msg); this.name = 'RecusaSocial' }
}

const chavesDoProvedor = new Map<ProvedorSocial, JWTVerifyGetKey>()
/** Teste: as chaves públicas do provedor de mentira (sem rede). */
export function usarChavesDoProvedorSocial(p: ProvedorSocial, chaves: JWTVerifyGetKey | null) {
  if (chaves) chavesDoProvedor.set(p, chaves)
  else chavesDoProvedor.delete(p)
}
function chavesDe(p: ProvedorSocial, cfg: ConfigDoProvedor): JWTVerifyGetKey {
  let k = chavesDoProvedor.get(p)
  if (!k) {
    k = createRemoteJWKSet(new URL(cfg.urlDasChaves))
    chavesDoProvedor.set(p, k)
  }
  return k
}

/** O `client_secret` da Apple é um JWT ES256 assinado com a chave .p8 (vale até 6 meses; aqui, 1 h). */
async function segredoDaApple(env = process.env): Promise<string> {
  const pem = String(env.APPLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n')
  const chave = await importPKCS8(pem, 'ES256')
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID! })
    .setIssuer(env.APPLE_TEAM_ID!)
    .setAudience('https://appleid.apple.com')
    .setSubject(env.APPLE_CLIENT_ID!)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(chave)
}

/**
 * A volta do provedor: confere o `state`, troca o `code` pelo `id_token`, confere o `id_token` e
 * devolve quem é. Recusa com `RecusaSocial` (a frase vai pra tela); nunca meio caminho.
 */
export async function concluirEntradaSocial(event: H3Event, p: ProvedorSocial, volta: {
  code?: unknown; state?: unknown; erro?: unknown; nomeDaApple?: string | null
}): Promise<{ identidade: IdentidadeSocial; orgId: string; destino: string }> {
  const cfg = configDoProvedor(p)
  const urlDeVolta = urlDeVoltaSocial(p)
  if (!cfg || !urlDeVolta) throw new RecusaSocial('Entrar por aqui não está ligado neste site.', 'desligado')
  const pacote = abrirPacoteSocial<{ p: string; state: string; nonce: string; org: string; volta: string }>(
    getCookie(event, COOKIE_DO_OAUTH))
  deleteCookie(event, COOKIE_DO_OAUTH, { path: '/api/conta' })
  if (volta.erro) throw new RecusaSocial('A entrada foi cancelada. Tente de novo ou use CPF e senha.', 'cancelado')
  if (!pacote || pacote.p !== p) throw new RecusaSocial('O tempo para entrar acabou. Tente de novo.', 'expirou')
  const state = String(volta.state ?? '')
  const a = Buffer.from(state)
  const b = Buffer.from(pacote.state)
  if (!state || a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new RecusaSocial('Não deu para confirmar esta entrada. Tente de novo.')
  }
  const code = String(volta.code ?? '')
  if (!code || code.length > 2048) throw new RecusaSocial('Não deu para confirmar esta entrada. Tente de novo.')

  const corpo = new URLSearchParams({
    code, client_id: cfg.clientId, redirect_uri: urlDeVolta, grant_type: 'authorization_code',
    client_secret: p === 'google' ? String(process.env.GOOGLE_CLIENT_SECRET) : await segredoDaApple(),
  })
  let resposta: any
  try {
    const r = await fetch(cfg.urlDoToken, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: corpo.toString(), signal: AbortSignal.timeout(10_000),
    })
    resposta = await r.json().catch(() => null)
    if (!r.ok || !resposta?.id_token) throw new Error(`token ${r.status}: ${resposta?.error ?? 'sem id_token'}`)
  } catch (e: any) {
    console.warn(`[entrar-social] ${p}: troca do código falhou — ${e?.message ?? e}`)
    throw new RecusaSocial(`Não consegui falar com ${p === 'google' ? 'o Google' : 'a Apple'}. Tente de novo.`, 'sem_rede')
  }

  let claims: any
  try {
    ;({ payload: claims } = await jwtVerify(String(resposta.id_token), chavesDe(p, cfg), {
      issuer: cfg.emissores, audience: cfg.clientId,
    }))
  } catch (e: any) {
    console.warn(`[entrar-social] ${p}: id_token recusado — ${e?.message ?? e}`)
    throw new RecusaSocial('Não deu para confirmar esta entrada. Tente de novo.')
  }
  if (claims.nonce !== pacote.nonce) throw new RecusaSocial('Não deu para confirmar esta entrada. Tente de novo.')
  const sub = String(claims.sub ?? '')
  if (!sub) throw new RecusaSocial('Não deu para confirmar esta entrada. Tente de novo.')
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null
  return {
    identidade: {
      provedor: p, sub, email,
      // a Apple manda "true" como texto
      emailVerificado: claims.email_verified === true || claims.email_verified === 'true',
      nome: (typeof claims.name === 'string' && claims.name.trim()) || volta.nomeDaApple || null,
    },
    orgId: pacote.org,
    destino: pacote.volta,
  }
}

/** O `user` que a Apple manda SÓ na primeira vez: `{"name":{"firstName":"…","lastName":"…"}}`. */
export function nomeQueAAppleMandou(user: unknown): string | null {
  try {
    const u = typeof user === 'string' ? JSON.parse(user) : user
    const n = [u?.name?.firstName, u?.name?.lastName].filter((x) => typeof x === 'string' && x.trim()).join(' ')
    return n || null
  } catch { return null }
}
