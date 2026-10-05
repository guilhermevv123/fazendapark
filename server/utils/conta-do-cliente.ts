/**
 * conta-do-cliente.ts — a conta de quem compra no site (034).
 *
 * Pedido do dono (28/09): pra comprar, o cliente ENTRA. Cadastro uma vez — nome completo, CPF,
 * e-mail e celular; Instagram e endereço opcionais — e o checkout para de pedir esses dados.
 * Entrar é com CPF e senha (a tela pede só o CPF desde 05/10; o e-mail ainda é aceito por quem já
 * tinha o costume), ou pelo Google/Apple (`entrar-social.ts`).
 *
 * Três regras que governam este arquivo:
 *
 * 1. **A conta só enxerga o que foi comprado COM ela** (`orders.customer_account_id`). O e-mail
 *    não é verificado: herdar os pedidos antigos do mesmo e-mail seria dar o QR de cada ingresso
 *    pra quem digitasse o e-mail alheio primeiro (o B17 de 27/09).
 * 2. **Sessão no banco, como a da equipe** (`sessao.ts`): o cookie leva um segredo opaco e a
 *    linha leva o hash. Sair derruba a sessão de verdade.
 * 3. **Uma organização, um cadastro.** A conta é do parque: o mesmo CPF pode ter conta em outra
 *    organização, e a sessão de uma não vale na outra.
 *
 * Os nomes exportados levam "DoCliente"/"DaConta" de propósito: todo export de `server/utils`
 * vira auto-import global do Nitro, e nome repetido troca o outro em silêncio.
 */
import { createHash, randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { createError, deleteCookie, getCookie, getRequestHeader, setCookie, type H3Event } from 'h3'
import { q, q1 } from './db'
import { cpfValido } from './documento'
import {
  CadastroInvalido, nomeProprio, normalizarEndereco, normalizarInstagram, validarSenha,
  type EnderecoBruto,
} from './cadastro'
import { ipDaRequisicao, origemDaRequisicao, registrarTentativa, travadoPorTentativas } from './sessao'

export const COOKIE_DO_CLIENTE = 'dt_cliente'
const DIAS_DA_SESSAO_DO_CLIENTE = 30
/** só mexe no banco se a última visita foi há mais de 1 h */
const RENOVA_VISITA_MIN = 60

const hashDoSegredo = (t: string) => createHash('sha256').update(t).digest('hex')

/* ================================================================ a conta */

export interface ContaDoCliente {
  id: string
  orgId: string
  nome: string
  email: string
  cpf: string
  telefone: string
  instagram: string | null
  endereco: {
    cep: string | null; rua: string | null; numero: string | null; bairro: string | null
    cidade: string | null; estado: string | null; complemento: string | null
  }
  aceitaNovidades: boolean
  /** entra com senha (quem só usa Google/Apple não tem) */
  temSenha: boolean
  google: boolean
  apple: boolean
  /** o dono clicou no link de confirmação (035) — ou o Google/Apple provou o e-mail */
  emailConfirmado: boolean
  criadaEm: string
}

const COLUNAS_DA_CONTA = `
  a.id, a.org_id, a.name, a.email, a.document, a.phone, a.instagram, a.zip_code, a.street,
  a.address_number, a.neighborhood, a.city, a.state, a.address_complement, a.marketing_opt_in,
  a.password_hash IS NOT NULL AS tem_senha, a.google_sub IS NOT NULL AS tem_google,
  a.apple_sub IS NOT NULL AS tem_apple, a.email_confirmed_at IS NOT NULL AS email_confirmado, a.created_at`

function contaDaLinha(r: any): ContaDoCliente {
  return {
    id: r.id, orgId: r.org_id, nome: r.name, email: r.email, cpf: r.document, telefone: r.phone,
    instagram: r.instagram ?? null,
    endereco: {
      cep: r.zip_code ?? null, rua: r.street ?? null, numero: r.address_number ?? null,
      bairro: r.neighborhood ?? null, cidade: r.city ?? null, estado: r.state ?? null,
      complemento: r.address_complement ?? null,
    },
    aceitaNovidades: !!r.marketing_opt_in,
    temSenha: !!r.tem_senha, google: !!r.tem_google, apple: !!r.tem_apple,
    emailConfirmado: !!r.email_confirmado,
    criadaEm: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }
}

export async function contaDoClientePorId(id: string): Promise<ContaDoCliente | null> {
  const r = await q1<any>(`SELECT ${COLUNAS_DA_CONTA} FROM customer_accounts a WHERE a.id = $1`, [id])
  return r ? contaDaLinha(r) : null
}

/**
 * A organização do site. Com evento, é a dona do evento; sem, a primeira organização — a MESMA
 * régua de `api/organizacao-publica.get.ts` (o site é de um parque só).
 */
export async function organizacaoDoSite(slug?: string | null): Promise<{ id: string; exigeConta: boolean } | null> {
  const r = slug
    ? await q1<any>(
      `SELECT o.id, o.customer_account_required FROM organizations o
        WHERE o.id = (SELECT e.org_id FROM events e WHERE e.slug = $1)`, [slug])
    : await q1<any>(
      `SELECT o.id, o.customer_account_required FROM organizations o ORDER BY o.created_at, o.id LIMIT 1`)
  return r ? { id: r.id, exigeConta: !!r.customer_account_required } : null
}

/* ============================================================ o cadastro */

/** A recusa que a tela mostra colada no campo. */
export class RecusaDaConta extends Error {
  constructor(public campo: string, mensagem: string, public status = 400) {
    super(mensagem)
    this.name = 'RecusaDaConta'
  }
}

export interface DadosDaConta {
  nome: string
  email: string
  cpf: string
  telefone: string
  instagram: string | null
  endereco: ReturnType<typeof normalizarEndereco>
  aceitaNovidades: boolean
}

/** Celular do Brasil só com DDD e número: tira máscara e o 55 da frente. */
export function telefoneDaConta(bruto: string | null | undefined): string {
  let d = String(bruto ?? '').replace(/\D/g, '')
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2)
  if (!/^[1-9][0-9]\d{8,9}$/.test(d)) {
    throw new RecusaDaConta('telefone', 'Confira o celular: DDD e número (ex.: (73) 99999-0000).')
  }
  return d
}

/**
 * A única porta de validação do cadastro da conta. Nome COMPLETO (nome e sobrenome: é o que vai
 * impresso no ingresso), CPF que confere, e-mail com cara de e-mail, celular com DDD; Instagram e
 * endereço passam pelas mesmas funções do checkout (`cadastro.ts`) — uma régua só.
 */
export function validarDadosDaConta(b: {
  nome?: unknown; email?: unknown; cpf?: unknown; telefone?: unknown
  instagram?: unknown; endereco?: EnderecoBruto | null; aceitaNovidades?: unknown
}): DadosDaConta {
  const nome = nomeProprio(String(b.nome ?? '').replace(/\s+/g, ' ').trim())
  if (nome.length < 3 || nome.split(' ').filter((p) => p.length >= 2).length < 2) {
    throw new RecusaDaConta('nome', 'Escreva o nome completo, com sobrenome (vai impresso no ingresso).')
  }
  if (nome.length > 120) throw new RecusaDaConta('nome', 'O nome passou de 120 letras.')

  const email = String(b.email ?? '').trim().toLowerCase()
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new RecusaDaConta('email', 'Confira o e-mail: é pra ele que vão os ingressos.')
  }

  const cpf = String(b.cpf ?? '').replace(/\D/g, '')
  if (!cpfValido(cpf)) throw new RecusaDaConta('cpf', 'CPF inválido. Confira os 11 números.')

  const telefone = telefoneDaConta(String(b.telefone ?? ''))

  let instagram: string | null
  let endereco: ReturnType<typeof normalizarEndereco>
  try {
    instagram = normalizarInstagram(b.instagram == null ? null : String(b.instagram))
    endereco = normalizarEndereco(b.endereco ?? null)
  } catch (e) {
    if (e instanceof CadastroInvalido) throw new RecusaDaConta(e.campo, e.message)
    throw e
  }
  return { nome, email, cpf, telefone, instagram, endereco, aceitaNovidades: b.aceitaNovidades === true }
}

/** Senha da conta: a MESMA régua do cadastro antigo (8+, até 72 bytes, nem e-mail nem CPF). */
export function validarSenhaDaConta(senha: unknown, quem: { email: string; cpf: string }): string {
  const s = typeof senha === 'string' ? senha : ''
  try {
    validarSenha(s, { email: quem.email, documento: quem.cpf })
  } catch (e) {
    if (e instanceof CadastroInvalido) throw new RecusaDaConta('senha', e.message)
    throw e
  }
  return s
}

/** 23505 (CPF ou e-mail repetido) vira a frase que diz o que fazer. */
function recusaDeRepetido(e: any): RecusaDaConta | null {
  if (e?.code !== '23505') return null
  const qual = String(e?.constraint ?? '')
  if (qual.includes('document')) {
    return new RecusaDaConta('cpf', 'Este CPF já tem conta. Entre com ele e a sua senha.', 409)
  }
  if (qual.includes('email')) {
    return new RecusaDaConta('email', 'Este e-mail já tem conta. Entre com ele e a sua senha.', 409)
  }
  return new RecusaDaConta('cpf', 'Esta conta já existe. Entre com o seu CPF e a senha.', 409)
}

export async function criarContaDoCliente(orgId: string, d: DadosDaConta & {
  senha?: string | null; googleSub?: string | null; appleSub?: string | null
  /** o Google/Apple já provou o e-mail: nasce confirmado */
  emailConfirmado?: boolean
}): Promise<ContaDoCliente> {
  const hash = d.senha ? await bcrypt.hash(d.senha, 10) : null
  const e = d.endereco
  try {
    const r = await q1<any>(
      `INSERT INTO customer_accounts
         (org_id, name, email, document, phone, password_hash, google_sub, apple_sub, instagram,
          zip_code, street, address_number, neighborhood, city, state, address_complement,
          marketing_opt_in, marketing_opt_in_at, last_login_at, email_confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               CASE WHEN $17 THEN now() END, now(), CASE WHEN $18 THEN now() END)
       RETURNING id`,
      [orgId, d.nome, d.email, d.cpf, d.telefone, hash, d.googleSub ?? null, d.appleSub ?? null,
       d.instagram, e?.cep ?? null, e?.rua ?? null, e?.numero ?? null, e?.bairro ?? null,
       e?.cidade ?? null, e?.estado ?? null, e?.complemento ?? null, d.aceitaNovidades,
       d.emailConfirmado === true])
    return (await contaDoClientePorId(r!.id))!
  } catch (err) {
    throw recusaDeRepetido(err) ?? err
  }
}

/** Troca os dados da conta. CPF não muda: é a identidade do ingresso e o teto de compra. */
export async function atualizarContaDoCliente(conta: ContaDoCliente, d: Omit<DadosDaConta, 'cpf'>): Promise<ContaDoCliente> {
  const e = d.endereco
  try {
    await q(
      `UPDATE customer_accounts
          SET name = $2, email = $3, phone = $4, instagram = $5,
              -- e-mail novo não está provado: a confirmação volta a zero (035)
              email_confirmed_at = CASE WHEN email IS DISTINCT FROM $3 THEN NULL ELSE email_confirmed_at END,
              zip_code = $6, street = $7, address_number = $8, neighborhood = $9, city = $10,
              state = $11, address_complement = $12,
              marketing_opt_in_at = CASE WHEN marketing_opt_in IS DISTINCT FROM $13 THEN now()
                                         ELSE marketing_opt_in_at END,
              marketing_opt_in = $13, updated_at = now()
        WHERE id = $1`,
      [conta.id, d.nome, d.email, d.telefone, d.instagram, e?.cep ?? null, e?.rua ?? null,
       e?.numero ?? null, e?.bairro ?? null, e?.cidade ?? null, e?.estado ?? null,
       e?.complemento ?? null, d.aceitaNovidades])
  } catch (err) {
    throw recusaDeRepetido(err) ?? err
  }
  return (await contaDoClientePorId(conta.id))!
}

/* ================================================================= entrar */

// hash de uma senha aleatória, pra "conta que não existe" custar o mesmo que "senha errada"
const HASH_FALSO_DO_CLIENTE = bcrypt.hashSync('nao-existe-' + randomBytes(8).toString('hex'), 10)

/** CPF (11 números, com ou sem máscara) ou e-mail. */
export function tipoDoLogin(login: string): { cpf: string } | { email: string } | null {
  const t = String(login ?? '').trim()
  if (t.includes('@')) return { email: t.toLowerCase() }
  const d = t.replace(/\D/g, '')
  return d.length === 11 ? { cpf: d } : null
}

/**
 * CPF ou e-mail + senha. O freio é o mesmo da equipe (`login_attempts`), com a chave prefixada
 * pela organização: errar a senha do cliente não tranca ninguém da equipe, nem o contrário.
 */
export async function entrarNaContaDoCliente(event: H3Event, orgId: string, login: string, senha: string): Promise<ContaDoCliente> {
  const qual = tipoDoLogin(login)
  if (!qual) throw new RecusaDaConta('login', 'Digite o seu CPF (11 números).')
  const chave = `cliente:${orgId}:${'cpf' in qual ? qual.cpf : qual.email}`
  const { ip, proxySemConfianca } = origemDaRequisicao(event)
  if (await travadoPorTentativas(chave, ip, { ipConfiavel: !proxySemConfianca })) {
    throw new RecusaDaConta('login', 'Muitas tentativas erradas. Espere 15 minutos e tente de novo.', 429)
  }
  const r = await q1<any>(
    `SELECT ${COLUNAS_DA_CONTA}, a.password_hash FROM customer_accounts a
      WHERE a.org_id = $1 AND ${'cpf' in qual ? 'a.document = $2' : 'a.email = $2'}`,
    [orgId, 'cpf' in qual ? qual.cpf : qual.email])
  const confere = await bcrypt.compare(String(senha ?? ''), r?.password_hash ?? HASH_FALSO_DO_CLIENTE)
  await registrarTentativa(chave, ip, !!(r && confere)).catch(() => {})
  if (!r || !confere) {
    // quem só entra pelo Google/Apple não tem senha: dizer isso economiza a ligação pro parque
    if (r && !r.password_hash && confere === false && (r.tem_google || r.tem_apple)) {
      throw new RecusaDaConta('senha',
        `Esta conta entra pelo ${r.tem_google ? 'Google' : 'Apple'}. Use o botão dele.`, 401)
    }
    throw new RecusaDaConta('senha', 'CPF ou senha não conferem.', 401)
  }
  await q(`UPDATE customer_accounts SET last_login_at = now() WHERE id = $1`, [r.id])
  return contaDaLinha(r)
}

/* ================================================================= sessão */

export async function abrirSessaoDoCliente(event: H3Event, contaId: string): Promise<void> {
  const segredo = randomBytes(32).toString('base64url')
  const expira = new Date(Date.now() + DIAS_DA_SESSAO_DO_CLIENTE * 86_400_000)
  await q(
    `INSERT INTO customer_sessions (account_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [contaId, hashDoSegredo(segredo), expira,
     getRequestHeader(event, 'user-agent')?.slice(0, 300) ?? null, ipDaRequisicao(event)])
  setCookie(event, COOKIE_DO_CLIENTE, segredo, {
    httpOnly: true,
    sameSite: 'lax',
    // http://localhost em desenvolvimento: secure lá faria o navegador descartar o cookie calado
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expira,
  })
}

/** A conta da sessão deste pedido HTTP, ou `null`. Com `orgId`, só vale a conta DAQUELA organização. */
export async function contaDaSessaoDoCliente(event: H3Event, orgId?: string | null): Promise<ContaDoCliente | null> {
  const guardada = (event.context as any).contaDoCliente as ContaDoCliente | null | undefined
  let conta = guardada
  if (conta === undefined) {
    const segredo = getCookie(event, COOKIE_DO_CLIENTE)
    conta = null
    if (segredo && segredo.length >= 20 && segredo.length <= 100) {
      const r = await q1<any>(
        `SELECT s.id AS sessao_id, s.last_seen_at, ${COLUNAS_DA_CONTA}
           FROM customer_sessions s JOIN customer_accounts a ON a.id = s.account_id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
        [hashDoSegredo(segredo)])
      if (r) {
        conta = contaDaLinha(r)
        if (Date.now() - new Date(r.last_seen_at).getTime() > RENOVA_VISITA_MIN * 60_000) {
          await q(`UPDATE customer_sessions SET last_seen_at = now() WHERE id = $1`, [r.sessao_id]).catch(() => {})
        }
      }
    }
    ;(event.context as any).contaDoCliente = conta
  }
  if (conta && orgId && conta.orgId !== orgId) return null
  return conta
}

export async function sairDaContaDoCliente(event: H3Event): Promise<void> {
  const segredo = getCookie(event, COOKIE_DO_CLIENTE)
  if (segredo) {
    await q(`UPDATE customer_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashDoSegredo(segredo)])
  }
  deleteCookie(event, COOKIE_DO_CLIENTE, { path: '/' })
  ;(event.context as any).contaDoCliente = null
}

/**
 * A senha nova pelo link de e-mail (035). Quem abriu o link provou a caixa de entrada: o e-mail
 * fica confirmado (se ainda for o mesmo pra onde o link foi) e TODAS as sessões caem — quem
 * estava entrando com a senha velha (o motivo da troca, às vezes) sai junto.
 */
export async function gravarSenhaNovaDoCliente(contaId: string, senha: string, emailDoLink: string): Promise<void> {
  const hash = await bcrypt.hash(senha, 10)
  await q(
    `UPDATE customer_accounts
        SET password_hash = $2, updated_at = now(),
            email_confirmed_at = CASE WHEN email = $3 THEN COALESCE(email_confirmed_at, now()) ELSE email_confirmed_at END
      WHERE id = $1`, [contaId, hash, emailDoLink])
  await derrubarSessoesDoCliente(contaId)
}

/** A conta pelo CPF ou e-mail digitado, pro "esqueci a senha". Null quando não existe. */
export async function contaPeloLogin(orgId: string, login: string): Promise<ContaDoCliente | null> {
  const qual = tipoDoLogin(login)
  if (!qual) return null
  const r = await q1<any>(
    `SELECT ${COLUNAS_DA_CONTA} FROM customer_accounts a
      WHERE a.org_id = $1 AND ${'cpf' in qual ? 'a.document = $2' : 'a.email = $2'}`,
    [orgId, 'cpf' in qual ? qual.cpf : qual.email])
  return r ? contaDaLinha(r) : null
}

/** Troca de senha (ou conta que passou pro dono do e-mail): derruba as outras sessões. */
export async function derrubarSessoesDoCliente(contaId: string): Promise<number> {
  const r = await q<any>(
    `UPDATE customer_sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL RETURNING id`,
    [contaId])
  return r.length
}

/* ============================================================ Google / Apple */

/**
 * A conta de quem o Google/Apple disse que é. Primeiro pelo id do provedor; depois pelo e-mail —
 * só quando o provedor PROVOU o e-mail. Aí quem provou é o dono: o provedor é ligado à conta e a
 * senha que ninguém provou sai, junto com as sessões (sem isso, quem cadastrou o e-mail alheio
 * com a própria senha seguiria entrando e vendo os ingressos que o dono comprasse depois).
 * Sem conta: `null`, e quem chama pede o CPF e o celular que faltam.
 */
export async function contaDaIdentidadeSocial(orgId: string, id: {
  provedor: 'google' | 'apple'; sub: string; email: string | null; emailVerificado: boolean
}): Promise<ContaDoCliente | null> {
  const coluna = id.provedor === 'google' ? 'google_sub' : 'apple_sub'
  const porSub = await q1<any>(
    `SELECT ${COLUNAS_DA_CONTA} FROM customer_accounts a WHERE a.org_id = $1 AND a.${coluna} = $2`,
    [orgId, id.sub])
  if (porSub) {
    await q(`UPDATE customer_accounts SET last_login_at = now() WHERE id = $1`, [porSub.id])
    return contaDaLinha(porSub)
  }
  if (!id.email || !id.emailVerificado) return null
  const porEmail = await q1<any>(
    `SELECT a.id, a.${coluna} AS ja_ligado FROM customer_accounts a WHERE a.org_id = $1 AND a.email = $2`,
    [orgId, id.email])
  if (!porEmail || porEmail.ja_ligado) return null
  await q(
    `UPDATE customer_accounts SET ${coluna} = $2, password_hash = NULL, last_login_at = now(), updated_at = now(),
            email_confirmed_at = COALESCE(email_confirmed_at, now())
      WHERE id = $1`, [porEmail.id, id.sub])
  await derrubarSessoesDoCliente(porEmail.id)
  console.warn(`[conta] o ${id.provedor} provou o e-mail de uma conta: ligada ao ${id.provedor}, `
    + 'e a senha anterior (que ninguém tinha provado) foi desligada')
  return contaDoClientePorId(porEmail.id)
}

/* ======================================================== o comprador */

/**
 * O comprador do checkout, a partir da conta — no formato do `comprador` que o corpo trazia. Com
 * a conta, é ELA quem compra: o CPF do teto por CPF e do ingresso não é digitável no checkout.
 */
export function compradorDaConta(c: ContaDoCliente) {
  const e = c.endereco
  const t = (v: string | null) => (v == null || v === '' ? undefined : v)
  return {
    nome: c.nome,
    email: c.email,
    documento: c.cpf,
    telefone: c.telefone,
    instagram: t(c.instagram),
    endereco: e.cidade && e.estado
      ? { cep: t(e.cep), rua: t(e.rua), numero: t(e.numero), bairro: t(e.bairro), cidade: e.cidade,
          estado: e.estado, complemento: t(e.complemento) }
      : undefined,
    aceitaNovidades: c.aceitaNovidades,
  }
}

/* ======================================================== o que sai pra tela */

/** A conta como a tela vê: sem id de provedor, com o CPF inteiro (é do próprio dono). */
export function contaParaTela(c: ContaDoCliente) {
  return {
    nome: c.nome, primeiroNome: c.nome.split(' ')[0], email: c.email, cpf: c.cpf, telefone: c.telefone,
    instagram: c.instagram, endereco: c.endereco, aceitaNovidades: c.aceitaNovidades,
    temSenha: c.temSenha, google: c.google, apple: c.apple, emailConfirmado: c.emailConfirmado,
  }
}

/** Recusa da conta → erro HTTP com o campo (a tela contorna o campo certo). */
export function erroDaConta(e: unknown): never {
  if (e instanceof RecusaDaConta) {
    throw createError({ statusCode: e.status, statusMessage: e.message, data: { tipo: 'conta', campo: e.campo } })
  }
  throw e
}
