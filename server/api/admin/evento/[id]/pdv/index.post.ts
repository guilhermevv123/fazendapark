/**
 * POST /api/admin/evento/:id/pdv — cria um ponto de venda.
 *
 * `payment_methods` não é enfeite: o que não está aqui não aparece na tela de
 * venda. Guichê sem maquininha listando "crédito" é o operador escolhendo a
 * forma errada com fila na frente e o caixa fechando torto à noite.
 */
import { z } from 'zod'
import { q1 } from '../../../../../utils/db'
import { FORMAS_PDV } from '../../../../../utils/caixa'

const Entrada = z.object({
  nome: z.string().min(2).max(80),
  local: z.string().max(120).nullish(),
  tipo: z.enum(['bilheteria', 'pdv_produtor', 'pdv_ticketeira']).default('bilheteria'),
  formas: z.array(z.enum(['dinheiro', 'debito', 'credito', 'pix'])).min(1).default(FORMAS_PDV),
})

export default defineEventHandler(async (event) => {
  const eventId = getRouterParam(event, 'id')!
  const sessao = (event.context as any).sessao
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    const campos = p.error.flatten().fieldErrors
    throw createError({
      statusCode: 400,
      statusMessage: campos.formas ? 'Marque pelo menos uma forma de pagamento para este ponto.'
        : campos.nome ? 'Dê um nome ao ponto de venda (de 2 a 80 letras).'
          : 'Não entendi os dados do ponto de venda. Confira e tente de novo.',
      data: p.error.flatten(),
    })
  }

  const ev = await q1<any>(`SELECT org_id FROM events WHERE id = $1`, [eventId])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  try {
    const ponto = await q1<any>(
      `INSERT INTO pos_terminals (org_id, event_id, name, location, kind, payment_methods, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name`,
      [ev.org_id, eventId, p.data.nome.trim(), p.data.local?.trim() || null,
       p.data.tipo, p.data.formas, sessao?.usuarioId ?? null])
    return { ok: true, id: ponto.id, nome: ponto.name }
  } catch (e: any) {
    // dois guichês com o mesmo nome viram dois relatórios que ninguém
    // consegue separar depois
    if (e?.code === '23505') {
      throw createError({ statusCode: 409, statusMessage: 'Já existe um ponto de venda com esse nome neste evento.' })
    }
    throw e
  }
})
