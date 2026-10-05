/**
 * conta-email.ts — os links de uso único da conta do cliente (035) e os e-mails que os levam.
 *
 * Dois propósitos, a mesma mecânica:
 *   · **redefinir a senha** (item 4.4 da proposta): 30 minutos, derruba as outras sessões;
 *   · **confirmar o e-mail** (item 4.2): 3 dias, vale só enquanto a conta tiver aquele e-mail.
 *
 * O segredo vai no link; o banco guarda o sha256 dele. Pedir um link novo aposenta os anteriores
 * do mesmo propósito (o e-mail velho na caixa de entrada deixa de funcionar). O consumo é UM
 * `UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING`: dois cliques, um uso.
 *
 * Os e-mails saem pelo MESMO transporte do ingresso (`email.ts`: SMTP com `SMTP_URL`, senão
 * simulado em disco) — sem fila: é uma mensagem por pedido da própria pessoa, que está esperando
 * na tela, e a falha vira recado pra ela tentar de novo.
 */
import { createHash, randomBytes } from 'node:crypto'
import { q, q1 } from './db'
import { entregar, remetente, type Mensagem } from './email'
import { baseDoSite } from './envio'
import { botaoDoEmail, COR, escaparNoEmail, FONTE, moldeDoEmail } from './email-visual'

export type FinalidadeDoLink = 'redefinir_senha' | 'confirmar_email'

export const PRAZO_DO_LINK_MIN: Record<FinalidadeDoLink, number> = {
  redefinir_senha: 30,
  confirmar_email: 3 * 24 * 60,
}

/** Quantos links do mesmo propósito uma conta pode pedir por hora (e-mail é caro de desfazer). */
export const LINKS_POR_HORA = 3

const hashDoLink = (t: string) => createHash('sha256').update(t).digest('hex')

/** O token cru só aparece aqui e no link. 32 bytes: impossível de chutar. */
export async function emitirLinkDaConta(
  contaId: string, finalidade: FinalidadeDoLink, email: string, ip: string | null,
): Promise<string | null> {
  const recentes = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM customer_account_tokens
      WHERE account_id = $1 AND purpose = $2 AND created_at > now() - interval '1 hour'`,
    [contaId, finalidade])
  if (Number(recentes?.n ?? 0) >= LINKS_POR_HORA) return null
  const segredo = randomBytes(32).toString('base64url')
  // o link novo aposenta os anteriores do mesmo propósito
  await q(
    `UPDATE customer_account_tokens SET used_at = now()
      WHERE account_id = $1 AND purpose = $2 AND used_at IS NULL`, [contaId, finalidade])
  await q(
    `INSERT INTO customer_account_tokens (account_id, purpose, token_hash, email, expires_at, ip)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), $6)`,
    [contaId, finalidade, hashDoLink(segredo), email, PRAZO_DO_LINK_MIN[finalidade], ip])
  return segredo
}

export interface LinkValido { contaId: string; email: string }

/** Confere SEM gastar (a tela de nova senha valida a senha antes de queimar o link). */
export async function conferirLinkDaConta(token: unknown, finalidade: FinalidadeDoLink): Promise<LinkValido | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null
  const r = await q1<any>(
    `SELECT account_id, email FROM customer_account_tokens
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()`,
    [hashDoLink(token), finalidade])
  return r ? { contaId: r.account_id, email: r.email } : null
}

/** Gasta o link: o primeiro que chega leva, o segundo recebe null. */
export async function consumirLinkDaConta(token: unknown, finalidade: FinalidadeDoLink): Promise<LinkValido | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null
  const r = await q1<any>(
    `UPDATE customer_account_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING account_id, email`,
    [hashDoLink(token), finalidade])
  return r ? { contaId: r.account_id, email: r.email } : null
}

/* ------------------------------------------------------------------ os e-mails */

/** A moldura do e-mail da conta: o molde da marca (`email-visual.ts`), igual ao do ingresso. */
function mensagemDaConta(d: {
  para: string; nome: string; assunto: string; titulo: string; frase: string
  botao: string; link: string; rodape: string; selo: string
}): Mensagem {
  const primeiro = d.nome.split(' ')[0] || d.nome
  const texto = [
    `Olá, ${primeiro}.`, '', d.frase, '', `${d.botao}: ${d.link}`, '', d.rodape, '', 'Conquista Park',
  ].join('\n')
  const e = escaparNoEmail
  const corpo = `
        <div style="display:inline-block;background:${COR.uvaClara};color:${COR.uva};font-size:12px;font-weight:bold;
                    letter-spacing:.06em;text-transform:uppercase;padding:6px 10px;border-radius:6px">${e(d.selo)}</div>
        <h1 style="margin:14px 0 0;font-family:${FONTE};font-size:26px;line-height:1.25;color:${COR.tinta}">${e(d.titulo)}</h1>
        <p style="margin:18px 0 0;font-size:16px;color:${COR.tinta}">Olá, <strong>${e(primeiro)}</strong>!</p>
        <p style="margin:8px 0 0;font-size:16px;color:${COR.corpo}">${e(d.frase)}</p>
        <div style="margin:28px 0 24px">${botaoDoEmail(d.botao, d.link)}</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr><td bgcolor="${COR.solClaro}" style="background:${COR.solClaro};border-left:4px solid ${COR.sol};
                     border-radius:6px;padding:14px 16px;font-size:14px;color:${COR.corpo}">${e(d.rodape)}</td></tr>
        </table>
        <p style="margin:22px 0 0;font-size:12px;line-height:1.5;color:${COR.fraca};word-break:break-all">
          O botão não abriu? Copie este endereço no navegador:<br>
          <a href="${e(d.link)}" style="color:${COR.uva}">${e(d.link)}</a>
        </p>`
  const { html, imagens } = moldeDoEmail({ assunto: d.assunto, previa: d.frase, corpo })
  return { de: remetente(), para: d.para, paraNome: d.nome, assunto: d.assunto, texto, html, imagens }
}

export function montarEmailDeNovaSenha(para: string, nome: string, link: string): Mensagem {
  return mensagemDaConta({
    para, nome, link,
    assunto: 'Redefinir a sua senha — Conquista Park',
    titulo: 'Redefinir a sua senha',
    frase: 'Recebemos um pedido para criar uma senha nova na sua conta do site do Conquista Park.',
    botao: 'Criar senha nova',
    selo: 'Sua conta',
    rodape: `O link vale por ${PRAZO_DO_LINK_MIN.redefinir_senha} minutos e funciona uma vez só. `
      + 'Se não foi você, ignore este e-mail: a sua senha continua a mesma.',
  })
}

export function montarEmailDeConfirmacao(para: string, nome: string, link: string): Mensagem {
  return mensagemDaConta({
    para, nome, link,
    assunto: 'Confirme o seu e-mail — Conquista Park',
    titulo: 'Confirme o seu e-mail',
    frase: 'Falta só confirmar que este e-mail é seu. É por ele que chegam os seus ingressos.',
    botao: 'Confirmar meu e-mail',
    selo: 'Boas-vindas',
    rodape: 'O link vale por 3 dias. Se você não criou conta no site do Conquista Park, ignore este e-mail.',
  })
}

/** O endereço do link, ou null quando o site não tem URL pública (produção sem PUBLIC_BASE_URL). */
export function linkDaConta(caminho: string, token: string): string | null {
  const base = baseDoSite()
  return base ? `${base}${caminho}?t=${encodeURIComponent(token)}` : null
}

/** Manda o e-mail da conta. Falha de correio não derruba a resposta: devolve false e anota. */
export async function mandarEmailDaConta(m: Mensagem): Promise<boolean> {
  try {
    await entregar(m)
    return true
  } catch (e: any) {
    console.warn(`[conta] e-mail "${m.assunto}" não saiu: ${String(e?.message ?? e).slice(0, 200)}`)
    return false
  }
}

/** Emite o link de confirmação e manda. Silencioso quando o limite por hora já foi. */
export async function mandarConfirmacaoDeEmail(
  conta: { id: string; nome: string; email: string }, ip: string | null,
): Promise<'enviado' | 'limite' | 'sem_site' | 'falhou'> {
  const token = await emitirLinkDaConta(conta.id, 'confirmar_email', conta.email, ip)
  if (!token) return 'limite'
  const link = linkDaConta('/conta/confirmar-email', token)
  if (!link) return 'sem_site'
  return (await mandarEmailDaConta(montarEmailDeConfirmacao(conta.email, conta.nome, link))) ? 'enviado' : 'falhou'
}
