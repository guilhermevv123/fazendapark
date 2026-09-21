/**
 * POST /api/auth/entrar — login.
 *
 * A resposta é a MESMA para e-mail inexistente, senha errada e conta
 * desativada: "E-mail ou senha não confere". Mensagem específica ("este
 * e-mail não existe") é um oráculo — deixa qualquer um descobrir quem tem
 * conta no sistema testando endereços.
 *
 * A comparação bcrypt roda mesmo quando o e-mail não existe, contra um hash
 * descartável. Sem isso, a resposta para e-mail inexistente volta em ~1ms e a
 * de senha errada em ~80ms, e o tempo entrega o que a mensagem escondeu.
 */
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { q1 } from '../../utils/db'
import { abrirSessao, ipDaRequisicao, registrarTentativa, travadoPorTentativas } from '../../utils/sessao'

const Entrada = z.object({
  email: z.string().email().max(200),
  senha: z.string().min(1).max(200),
})

// hash de uma senha aleatória, só pra gastar o mesmo tempo quando o e-mail
// não existe. Calculado uma vez no boot.
const HASH_FALSO = bcrypt.hashSync('nao-existe-' + Math.random(), 10)

export default defineEventHandler(async (event) => {
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) throw createError({ statusCode: 400, statusMessage: 'Informe e-mail e senha' })

  const email = p.data.email.trim().toLowerCase()
  const ip = ipDaRequisicao(event)

  const travado = await travadoPorTentativas(email, ip)
  if (travado) throw createError({ statusCode: 429, statusMessage: travado })

  const u = await q1<any>(
    `SELECT id, name, password_hash, role, active FROM users WHERE lower(email) = $1`, [email])

  const confere = await bcrypt.compare(p.data.senha, u?.password_hash ?? HASH_FALSO)

  if (!u || !u.active || !confere) {
    await registrarTentativa(email, ip, false)
    throw createError({ statusCode: 401, statusMessage: 'E-mail ou senha não confere' })
  }

  await registrarTentativa(email, ip, true)
  await abrirSessao(event, u.id)

  return { ok: true, usuario: { nome: u.name, email, papel: u.role } }
})
