/**
 * POST /api/admin/evento/:id/promoters — cadastra divulgador.
 *
 * O código é o que vai no link, então precisa sobreviver a ser digitado à mão
 * e colado em WhatsApp: maiúscula, sem acento, sem espaço. Quando não vem, é
 * derivado do nome — e se já existir, ganha sufixo em vez de estourar 409 na
 * cara de quem só queria cadastrar dois "João".
 */
import { z } from 'zod'
import { q1 } from '../../../../utils/db'

const Entrada = z.object({
  nome: z.string().min(2).max(120),
  email: z.string().email().max(160).nullish(),
  telefone: z.string().max(30).nullish(),
  codigo: z.string().max(32).nullish(),
  comissaoBps: z.number().int().min(0).max(10_000).default(0),
  ativo: z.boolean().default(true),
})

const limpar = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24)

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data

  const ev = await q1<any>(`SELECT id FROM events WHERE id = $1`, [eventoId])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const base = limpar(d.codigo || d.nome) || 'PROMO'
  let codigo = base
  for (let i = 2; i <= 50; i++) {
    const existe = await q1(
      `SELECT 1 FROM promoters WHERE event_id = $1 AND code = $2`, [eventoId, codigo])
    if (!existe) break
    codigo = `${base}${i}`
  }

  const r = await q1<any>(
    `INSERT INTO promoters (event_id, name, email, phone, code, commission_bps, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [eventoId, d.nome.trim(), d.email ?? null, d.telefone ?? null, codigo,
     d.comissaoBps, d.ativo])

  return { ok: true, id: r.id, codigo }
})
