/**
 * PATCH /api/admin/evento/:id/pdv — edita ou desliga um ponto de venda.
 *
 * Desligar ≠ apagar. O ponto guarda o histórico de tudo que passou por ele; o
 * relatório do dia seguinte precisa do nome do guichê que vendeu. Por isso não
 * existe DELETE aqui: `active = false` some da tela de venda e continua
 * existindo no relatório.
 *
 * Ponto com caixa aberto não desliga. Desligar por baixo do operador que está
 * vendendo é a forma mais rápida de perder uma venda e ninguém entender por quê.
 */
import { z } from 'zod'
import { q1 } from '../../../../../utils/db'

const Entrada = z.object({
  id: z.string().uuid(),
  nome: z.string().min(2).max(80).optional(),
  local: z.string().max(120).nullish(),
  formas: z.array(z.enum(['dinheiro', 'debito', 'credito', 'pix'])).min(1).optional(),
  ativo: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const eventId = getRouterParam(event, 'id')!
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    const campos = p.error.flatten().fieldErrors
    throw createError({
      statusCode: 400,
      statusMessage: campos.formas ? 'Marque pelo menos uma forma de pagamento para este ponto.'
        : campos.nome ? 'O nome do ponto precisa ter de 2 a 80 letras.'
          : 'Não entendi os dados do ponto de venda. Confira e salve de novo.',
      data: p.error.flatten(),
    })
  }
  const d = p.data

  // O id do ponto vem no CORPO — o middleware de tenant cerca pelo id da URL,
  // então esta rota faz a própria cerca. Já foi essa exata folga que abriu o
  // check-in entre produtoras.
  const ponto = await q1<any>(
    `SELECT id, active FROM pos_terminals WHERE id = $1 AND event_id = $2`, [d.id, eventId])
  if (!ponto) throw createError({ statusCode: 404, statusMessage: 'Ponto de venda não encontrado' })

  if (d.ativo === false) {
    const aberto = await q1<any>(
      `SELECT id FROM pos_shifts WHERE terminal_id = $1 AND status = 'aberto'`, [d.id])
    if (aberto) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Este ponto está com o caixa aberto. Feche o caixa antes de desativar.',
      })
    }
  }

  const campos: string[] = []
  const vals: any[] = [d.id]
  const põe = (col: string, v: any) => { vals.push(v); campos.push(`${col} = $${vals.length}`) }
  if (d.nome !== undefined) põe('name', d.nome.trim())
  if (d.local !== undefined) põe('location', d.local?.trim() || null)
  if (d.formas !== undefined) põe('payment_methods', d.formas)
  if (d.ativo !== undefined) põe('active', d.ativo)
  if (!campos.length) return { ok: true, semMudanca: true }

  try {
    await q1(`UPDATE pos_terminals SET ${campos.join(', ')} WHERE id = $1 RETURNING id`, vals)
  } catch (e: any) {
    if (e?.code === '23505') {
      throw createError({ statusCode: 409, statusMessage: 'Já existe um ponto de venda com esse nome neste evento.' })
    }
    throw e
  }
  return { ok: true }
})
