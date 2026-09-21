/**
 * POST /api/admin/evento/:id/cupons — cria código promocional.
 *
 * O código é normalizado pra MAIÚSCULA sem espaço antes de gravar. Sem isso,
 * "Verao10" e "VERAO10" viram dois cupons e o comprador que digitou com a
 * caixa "errada" leva um "código inválido" na cara de um cupom que existe.
 */
import { z } from 'zod'
import { q1 } from '../../../../utils/db'

const Entrada = z.object({
  codigo: z.string().min(3).max(32),
  tipo: z.enum(['percentual', 'fixo']),
  /** percentual → bps (1000 = 10%); fixo → centavos */
  valor: z.number().int().positive(),
  maxUsos: z.number().int().min(1).max(1_000_000).nullish(),
  maxPorCliente: z.number().int().min(1).max(100).default(1),
  comecaEm: z.string().datetime({ offset: true }).nullish(),
  terminaEm: z.string().datetime({ offset: true }).nullish(),
  loteIds: z.array(z.string().uuid()).default([]),
  ativo: z.boolean().default(true),
})

export const normalizarCodigo = (s: string) =>
  s.trim().toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9_-]/g, '')

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data

  const codigo = normalizarCodigo(d.codigo)
  if (codigo.length < 3) {
    throw createError({ statusCode: 422, statusMessage: 'Código curto demais depois de limpar espaços e acentos' })
  }
  if (d.tipo === 'percentual' && d.valor > 10_000) {
    throw createError({ statusCode: 422, statusMessage: 'Desconto percentual não pode passar de 100%' })
  }
  if (d.comecaEm && d.terminaEm && new Date(d.terminaEm) <= new Date(d.comecaEm)) {
    throw createError({ statusCode: 422, statusMessage: 'O cupom não pode terminar antes de começar' })
  }

  const ev = await q1<any>(`SELECT id FROM events WHERE id = $1`, [eventoId])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  // Lote de OUTRO evento na lista restringiria o cupom a algo que este evento
  // não vende — o cupom nunca valeria e ninguém saberia por quê.
  if (d.loteIds.length) {
    const n = await q1<any>(
      `SELECT count(*)::int AS n FROM lots l JOIN sectors s ON s.id = l.sector_id
        WHERE l.id = ANY($1::uuid[]) AND s.event_id = $2`, [d.loteIds, eventoId])
    if (Number(n.n) !== d.loteIds.length) {
      throw createError({ statusCode: 422, statusMessage: 'Há lote que não é deste evento na restrição' })
    }
  }

  try {
    const r = await q1<any>(
      `INSERT INTO promo_codes (event_id, code, kind, value, max_uses, max_per_customer,
                                starts_at, ends_at, lot_ids, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [eventoId, codigo, d.tipo, d.valor, d.maxUsos ?? null, d.maxPorCliente,
       d.comecaEm ?? null, d.terminaEm ?? null, d.loteIds, d.ativo])
    return { ok: true, id: r.id, codigo }
  } catch (e: any) {
    // 23505 = unique_violation. O par (event_id, code) é único no schema; sem
    // traduzir aqui, o duplicado chega na tela como "erro interno".
    if (e?.code === '23505') {
      throw createError({ statusCode: 409, statusMessage: `Já existe um cupom ${codigo} neste evento` })
    }
    throw e
  }
})
