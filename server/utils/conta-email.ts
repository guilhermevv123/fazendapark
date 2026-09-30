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

const escaparHtml = (v: unknown) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A moldura do e-mail da conta: a mesma do ingresso (tabela + estilo embutido, abre em todo cliente). */
function mensagemDaConta(d: {
  para: string; nome: string; assunto: string; titulo: string; frase: string
  botao: string; link: string; rodape: string
}): Mensagem {
  const primeiro = d.nome.split(' ')[0] || d.nome
  const texto = [
    `Olá, ${primeiro}.`, '', d.frase, '', `${d.botao}: ${d.link}`, '', d.rodape, '', 'Conquista Park',
  ].join('\n')
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escaparHtml(d.assunto)}</title></head>
<body style="margin:0;padding:0;background:#F4F7FA">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F4F7FA">
  <tr><td align="center" style="padding:24px 12px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"
           style="max-width:600px;width:100%;background:#FFFFFF;border:1px solid #E3E1EB;border-radius:16px">
      <tr><td style="padding:28px 24px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;
                     font-weight:bold;letter-spacing:.04em;text-transform:uppercase;color:#583C8D">
        Conquista Park
      </td></tr>
      <tr><td style="padding:24px;font-family:Arial,Helvetica,sans-serif;color:#1E1A2E">
        <div style="font-size:20px;font-weight:bold">${escaparHtml(d.titulo)}</div>
        <div style="font-size:15px;margin-top:16px">Olá, ${escaparHtml(primeiro)}.</div>
        <div style="font-size:15px;margin-top:8px">${escaparHtml(d.frase)}</div>
        <div style="margin:24px 0 16px">
          <a href="${escaparHtml(d.link)}"
             style="display:inline-block;background:#583C8D;color:#FFFFFF;text-decoration:none;
                    font-weight:bold;font-size:16px;padding:14px 28px;border-radius:10px">
            ${escaparHtml(d.botao)}
          </a>
        </div>
        <div style="font-size:13px;color:#5B5570">${escaparHtml(d.rodape)}</div>
        <div style="font-size:12px;color:#8A849C;margin-top:16px;word-break:break-all">
          Se o botão não abrir, copie este endereço no navegador: ${escaparHtml(d.link)}
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`
  return { de: remetente(), para: d.para, paraNome: d.nome, assunto: d.assunto, texto, html }
}

export function montarEmailDeNovaSenha(para: string, nome: string, link: string): Mensagem {
  return mensagemDaConta({
    para, nome, link,
    assunto: 'Redefinir a sua senha — Conquista Park',
    titulo: 'Redefinir a sua senha',
    frase: 'Recebemos um pedido para criar uma senha nova na sua conta do site do Conquista Park.',
    botao: 'Criar senha nova',
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
