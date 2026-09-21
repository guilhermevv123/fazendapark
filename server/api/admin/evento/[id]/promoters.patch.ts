/**
 * PATCH /api/admin/evento/:id/promoters — edita divulgador.
 *
 * Como no cupom, o CÓDIGO não muda: ele já está no link que o promoter mandou
 * pra lista dele. Trocar o código quebra todo link em circulação, e a venda
 * que vier depois chega sem dono — o que aparece como "o promoter não recebeu
 * comissão" no fim do mês.
 */
import { z } from 'zod'
import { q1 } from '../../../../utils/db'

const Entrada = z.object({
  id: z.string().uuid(),
  campos: z.object({
    nome: z.string().min(2).max(120).optional(),
    email: z.string().email().max(160).nullish(),
    telefone: z.string().max(30).nullish(),
    comissaoBps: z.number().int().min(0).max(10_000).optional(),
    ativo: z.boolean().optional(),
  }),
})

const COLUNAS: Record<string, string> = {
  nome: 'name', email: 'email', telefone: 'phone',
  comissaoBps: 'commission_bps', ativo: 'active',
}

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const { id, campos } = p.data

  const atual = await q1<any>(
    `SELECT id FROM promoters WHERE id = $1 AND event_id = $2`, [id, eventoId])
  if (!atual) throw createError({ statusCode: 404, statusMessage: 'Divulgador não encontrado' })

  const pares = Object.entries(campos).filter(([k, v]) => k in COLUNAS && v !== undefined)
  if (!pares.length) throw createError({ statusCode: 400, statusMessage: 'Nada para alterar' })

  const sets = pares.map(([k], i) => `${COLUNAS[k]} = $${i + 2}`).join(', ')
  await q1(`UPDATE promoters SET ${sets} WHERE id = $1 RETURNING id`,
    [id, ...pares.map(([, v]) => v)])

  return { ok: true, alterados: pares.map(([k]) => k) }
})
