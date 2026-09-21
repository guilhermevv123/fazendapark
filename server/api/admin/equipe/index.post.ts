/**
 * POST /api/admin/equipe — cria acesso ao painel.
 *
 * **A senha é sorteada aqui e mostrada UMA vez.** Não existe campo de senha
 * neste formulário de propósito: senha digitada por um administrador para
 * outra pessoa passa por WhatsApp, fica no histórico da conversa, e vira a
 * senha de sempre porque ninguém troca. Sorteando, o segredo nasce forte e o
 * caminho dele é explícito — quem cria vê uma vez, entrega, e acabou.
 *
 * **Só `master` cria gente.** O `middleware/03.papel.ts` já barra a área
 * inteira de equipe pros outros três papéis; a linha aqui embaixo é o cinto
 * além do suspensório, pro dia em que alguém liberar a área na grade sem
 * pensar no que "mexer em equipe" significa: sem ela, quem é de operação
 * promove a si mesmo a master em duas requisições.
 *
 * As DUAS colunas de papel são gravadas juntas, nunca separadas: `papel` é a
 * grade fina (quem decide rota a rota) e `role` é a grade grossa que o
 * porteiro antigo lê. Quem traduz uma na outra é `roleLegado()`, em
 * `utils/papeis.ts` — deixar um humano escolher as duas é deixar as duas
 * discordarem.
 *
 * ## O e-mail é UM no sistema inteiro, não um por organização
 *
 * Esta conferência já foi `WHERE org_id = $1 AND lower(email) = $2`, de mãos
 * dadas com o índice único `(org_id, email)` do banco. Só que **o login não
 * pergunta a organização**: `auth/entrar.post.ts` procura o e-mail em
 * `users` inteiro e fica com a primeira linha. Duas pessoas com o mesmo
 * endereço em lojas diferentes viravam um cadastro que nascia "com sucesso" e
 * uma pessoa que nunca mais entrava — sem erro, sem log, sem nada na tela: a
 * senha dela era conferida contra o hash da OUTRA e a resposta era
 * "E-mail ou senha não confere". O suporte não tem como adivinhar isso.
 *
 * Entre as duas saídas (ensinar a organização ao login, ou tratar o e-mail
 * como global), esta rota implementa a segunda — e recusa na cara, com frase
 * que diz o que fazer, em vez de criar um acesso que não abre. A recusa não
 * diz DE QUEM é a outra organização: quem cadastra não precisa saber, e o
 * nome do cliente vizinho não é dele.
 *
 * O índice do banco continua sendo `(org_id, email)`, então esta trava é de
 * aplicação: duas criações simultâneas do mesmo e-mail em organizações
 * diferentes ainda passariam as duas. Fechar isso de verdade pede um índice
 * único em `lower(email)` — migração, que esta rodada não tinha número pra
 * criar.
 */
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { randomInt } from 'node:crypto'
import { q1, tx } from '../../../utils/db'
import { PAPEIS, ROTULO, roleLegado } from '../../../utils/papeis'

const Entrada = z.object({
  nome: z.string().min(2).max(120),
  email: z.string().email().max(160),
  papel: z.enum(PAPEIS as [string, ...string[]]),
})

/**
 * Sem I, l, O, 0, 1: a senha vai ser LIDA em voz alta ou copiada de um print,
 * e esses seis caracteres são os que se confundem entre si.
 */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
function sortearSenha(tamanho = 14): string {
  let s = ''
  for (let i = 0; i < tamanho; i++) s += ALFABETO[randomInt(ALFABETO.length)]
  return s
}

export default defineEventHandler(async (event) => {
  const sessao = (event.context as any).sessao
  const orgId = sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })
  if ((event.context as any).papel !== 'master') {
    throw createError({ statusCode: 403, statusMessage: 'Só um master dá acesso a alguém.' })
  }

  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data
  const papel = d.papel as (typeof PAPEIS)[number]
  const email = d.email.trim().toLowerCase()

  // A busca é no sistema INTEIRO, e a linha da própria organização vem
  // primeiro — ela é a que tem conserto pela tela (reativar), então é a frase
  // que o operador precisa ouvir quando as duas existem.
  const jaExiste = await q1<any>(
    `SELECT id, active, (org_id = $1) AS mesma_organizacao
       FROM users
      WHERE lower(email) = $2
      ORDER BY (org_id = $1) DESC
      LIMIT 1`, [orgId, email])
  if (jaExiste && !jaExiste.mesma_organizacao) {
    throw createError({
      statusCode: 409,
      statusMessage: `O e-mail ${email} já é usado por outra organização aqui no sistema, e o `
        + `login é um só para todas. Se fosse criado assim, um dos dois acessos deixaria de `
        + `abrir sem avisar. Use outro endereço para esta pessoa.`,
    })
  }
  if (jaExiste) {
    throw createError({
      statusCode: 409,
      statusMessage: jaExiste.active
        ? `Já existe acesso com o e-mail ${email}.`
        : `Já existe acesso com o e-mail ${email} — está desativado. Reative em vez de criar outro.`,
    })
  }

  const senha = sortearSenha()
  const hash = await bcrypt.hash(senha, 10)

  const novo = await tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO users (org_id, name, email, password_hash, papel, role)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email, papel`,
      [orgId, d.nome.trim(), email, hash, papel, roleLegado(papel)])
    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'usuario',$2,'criado',$3::jsonb)`,
      // a senha NÃO entra no log de auditoria
      [orgId, rows[0].id, JSON.stringify({ nome: d.nome, email, papel,
                                           criadoPor: sessao.email })])
    return rows[0]
  })

  return {
    ok: true,
    usuario: { id: novo.id, nome: novo.name, email: novo.email, papel: novo.papel },
    papelRotulo: ROTULO[papel],
    // única vez que esta senha existe em texto em qualquer lugar
    senhaProvisoria: senha,
  }
})
