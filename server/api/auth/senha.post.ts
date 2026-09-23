/**
 * POST /api/auth/senha — a pessoa logada troca a PRÓPRIA senha.
 *
 * Até 22/09 não existia: a senha sorteada na tela de Equipe virava a senha de
 * sempre, e o único jeito de trocar a do master era sortear pela Equipe — o
 * que derrubava a própria sessão no meio do clique e trancava ele de fora.
 *
 * Regras, cada uma com o porquê:
 *
 * - **Pede a senha atual.** Sessão aberta num computador do guichê não pode
 *   virar "troco a senha do dono e ele nunca mais entra".
 * - **Errar a atual conta no freio de login** (`travadoPorTentativas`), no
 *   mesmo balde e-mail + IP: é o mesmo segredo, e sem isso esta rota seria um
 *   jeito de chutar senha sem freio nenhum.
 * - **Derruba as OUTRAS sessões e mantém esta.** Quem troca a senha porque
 *   desconfia de vazamento quer o outro aparelho fora; mas ser jogado pro
 *   login logo depois de trocar é o tipo de susto que faz a pessoa achar que
 *   deu errado.
 * - **Autentica sozinha.** O porteiro (`middleware/01.autenticacao.ts`) só
 *   cobre `/api/admin/*` e `/api/checkin`; `/api/auth/*` passa por fora dele,
 *   então a sessão e a origem são conferidas aqui.
 */
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { q1, tx } from '../../utils/db'
import { mutacaoDeOutroSite } from '../../utils/caminho'
import { autorDaRequisicao, registrarAuditoria } from '../../utils/auditoria'
import { exigir, ipDaRequisicao, registrarTentativa, travadoPorTentativas } from '../../utils/sessao'

const MINIMO = 8

const Entrada = z.object({
  atual: z.string().min(1).max(200),
  nova: z.string().max(200),
})

export default defineEventHandler(async (event) => {
  // Origem antes de tudo: é mutação com cookie, e o porteiro não passa aqui.
  if (mutacaoDeOutroSite(event)) {
    throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
  }
  const sessao = await exigir(event)

  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Informe a senha atual e a nova.' })
  }
  const { atual, nova } = p.data

  if (nova.length < MINIMO) {
    throw createError({
      statusCode: 422,
      statusMessage: `A nova senha precisa ter pelo menos ${MINIMO} caracteres.`,
    })
  }
  if (nova === atual) {
    throw createError({ statusCode: 422, statusMessage: 'A nova senha precisa ser diferente da atual.' })
  }

  const email = sessao.email.trim().toLowerCase()
  const ip = ipDaRequisicao(event)
  const travado = await travadoPorTentativas(email, ip)
  if (travado) throw createError({ statusCode: 429, statusMessage: travado })

  const u = await q1<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1 AND active`, [sessao.usuarioId])
  // 422 e não 401: 401 aqui faria a tela achar que a sessão caiu.
  if (!u || !(await bcrypt.compare(atual, u.password_hash ?? ''))) {
    await registrarTentativa(email, ip, false)
    throw createError({ statusCode: 422, statusMessage: 'A senha atual não confere.' })
  }

  const hash = await bcrypt.hash(nova, 10)

  // `autorDaRequisicao` lê do contexto, que o porteiro não preencheu nesta rota.
  event.context.sessao = sessao

  const encerradas = await tx(async (c) => {
    await c.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [sessao.usuarioId, hash])
    const { rowCount } = await c.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`,
      [sessao.usuarioId, sessao.sessaoId])
    // a senha NÃO entra no registro — nem a velha, nem a nova
    await registrarAuditoria({
      autor: autorDaRequisicao(event),
      entidade: 'usuario',
      entidadeId: sessao.usuarioId,
      acao: 'senha_trocada',
      depois: { email, sessoesEncerradas: rowCount ?? 0 },
    }, c)
    return rowCount ?? 0
  })

  return { ok: true, sessoesEncerradas: encerradas }
})
