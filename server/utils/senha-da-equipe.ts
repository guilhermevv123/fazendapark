/**
 * senha-da-equipe.ts — "esqueci a senha" de quem trabalha no parque (051).
 *
 * Dono, 09/10: "coloca o esqueci a senha em tudo, mesmo na portaria e no admin ... pra evitar dor
 * de cabeça". Antes, quem esquecia dependia de um master gerar senha nova em Equipe — no dia do
 * evento, com fila na porta.
 *
 * A mecânica é a da conta do cliente (`conta-email.ts`, 035): segredo de 32 bytes no link, sha256
 * no banco, 30 minutos, uso único num UPDATE só, link novo aposenta os velhos, 3 links por hora por
 * acesso. Trocar a senha pelo link derruba TODAS as sessões do acesso e tira a marca de provisória.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import { q, q1 } from './db'
import type { Mensagem } from './email'
import { mensagemDaConta } from './conta-email'

export const PRAZO_DO_LINK_DA_EQUIPE_MIN = 30
export const LINKS_DA_EQUIPE_POR_HORA = 3
export const MINIMO_DA_SENHA_DA_EQUIPE = 8

const hashDoLinkDaEquipe = (t: string) => createHash('sha256').update(t).digest('hex')

/** O token cru só existe aqui e no link. Limite por hora estourado = null (não manda e-mail). */
export async function emitirLinkDaEquipe(usuarioId: string, email: string, ip: string | null): Promise<string | null> {
  const recentes = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM user_tokens
      WHERE user_id = $1 AND purpose = 'redefinir_senha' AND created_at > now() - interval '1 hour'`, [usuarioId])
  if (Number(recentes?.n ?? 0) >= LINKS_DA_EQUIPE_POR_HORA) return null
  const segredo = randomBytes(32).toString('base64url')
  await q(`UPDATE user_tokens SET used_at = now()
            WHERE user_id = $1 AND purpose = 'redefinir_senha' AND used_at IS NULL`, [usuarioId])
  await q(
    `INSERT INTO user_tokens (user_id, purpose, token_hash, email, expires_at, ip)
     VALUES ($1, 'redefinir_senha', $2, $3, now() + make_interval(mins => $4), $5)`,
    [usuarioId, hashDoLinkDaEquipe(segredo), email, PRAZO_DO_LINK_DA_EQUIPE_MIN, ip])
  return segredo
}

export interface LinkDaEquipe { usuarioId: string; email: string; nome: string }

const SQL_LINK_VIVO = `
  FROM user_tokens k JOIN users u ON u.id = k.user_id
 WHERE k.token_hash = $1 AND k.purpose = 'redefinir_senha' AND k.used_at IS NULL AND k.expires_at > now()
   AND u.active AND lower(u.email) = lower(k.email)`

/** Confere SEM gastar: a tela avisa do link vencido antes de a pessoa digitar duas senhas. */
export async function conferirLinkDaEquipe(token: unknown): Promise<LinkDaEquipe | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null
  const r = await q1<any>(`SELECT u.id, u.email, u.name ${SQL_LINK_VIVO}`, [hashDoLinkDaEquipe(token)])
  return r ? { usuarioId: r.id, email: r.email, nome: r.name } : null
}

/** Gasta o link dentro da transação de quem grava a senha: dois cliques, um uso. */
export async function consumirLinkDaEquipe(c: PoolClient, token: unknown): Promise<LinkDaEquipe | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null
  const r = await c.query(
    `UPDATE user_tokens k SET used_at = now()
       FROM users u
      WHERE u.id = k.user_id AND k.token_hash = $1 AND k.purpose = 'redefinir_senha'
        AND k.used_at IS NULL AND k.expires_at > now() AND u.active AND lower(u.email) = lower(k.email)
      RETURNING u.id, u.email, u.name`, [hashDoLinkDaEquipe(token)])
  const l = r.rows[0]
  return l ? { usuarioId: l.id, email: l.email, nome: l.name } : null
}

export function montarEmailDeSenhaDaEquipe(para: string, nome: string, link: string): Mensagem {
  return mensagemDaConta({
    para, nome, link,
    assunto: 'Criar uma senha nova — equipe Conquista Park',
    titulo: 'Criar uma senha nova',
    frase: 'Recebemos um pedido para criar uma senha nova no seu acesso de equipe do Conquista Park '
      + '(painel e portaria).',
    botao: 'Criar senha nova',
    selo: 'Acesso da equipe',
    rodape: `O link vale por ${PRAZO_DO_LINK_DA_EQUIPE_MIN} minutos e funciona uma vez só. `
      + 'Se não foi você, ignore este e-mail: a sua senha continua a mesma.',
  })
}

/** Só caminho desta casa: o "voltar pra onde estava" do link não pode levar pra outro site. */
export function destinoDaEquipe(de: unknown): string {
  const d = typeof de === 'string' ? de : ''
  return /^\/(admin|portaria)(\/[\w\-/]*)?$/.test(d) ? d : '/admin'
}
