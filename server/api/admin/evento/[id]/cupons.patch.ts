/**
 * PATCH /api/admin/evento/:id/cupons — edita cupom.
 *
 * O código em si NÃO muda depois de criado: ele já saiu em post, flyer e
 * mensagem de WhatsApp. Renomear um cupom em circulação transforma todo
 * material impresso em código inválido — e quem recebeu não tem como saber.
 * Para trocar o código, desative este e crie outro.
 */
import { z } from 'zod'
import { q1 } from '../../../../utils/db'
import { explicarErro } from '../index.post'

const Entrada = z.object({
  id: z.string().uuid(),
  campos: z.object({
    valor: z.number().int().positive().optional(),
    maxUsos: z.number().int().min(1).max(1_000_000).nullish(),
    maxPorCliente: z.number().int().min(1).max(100).optional(),
    comecaEm: z.string().datetime({ offset: true }).nullish(),
    terminaEm: z.string().datetime({ offset: true }).nullish(),
    loteIds: z.array(z.string().uuid()).optional(),
    ativo: z.boolean().optional(),
  }),
})

const COLUNAS: Record<string, string> = {
  valor: 'value', maxUsos: 'max_uses', maxPorCliente: 'max_per_customer',
  comecaEm: 'starts_at', terminaEm: 'ends_at', loteIds: 'lot_ids', ativo: 'active',
}

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: explicarErro(p.error), data: p.error.flatten() })
  }
  const { id, campos } = p.data

  const atual = await q1<any>(
    `SELECT * FROM promo_codes WHERE id = $1 AND event_id = $2`, [id, eventoId])
  if (!atual) throw createError({ statusCode: 404, statusMessage: 'Cupom não encontrado' })

  if (campos.valor !== undefined && atual.kind === 'percentual' && campos.valor > 10_000) {
    throw createError({ statusCode: 422, statusMessage: 'Desconto percentual não pode passar de 100%' })
  }
  // Baixar o teto abaixo do que já foi usado deixaria o cupom num estado que a
  // tela mostra como "12 de 10" — e o comprador seguinte levaria um "esgotado"
  // sem explicação.
  if (campos.maxUsos != null && campos.maxUsos < Number(atual.uses)) {
    throw createError({
      statusCode: 409,
      statusMessage: `Este cupom já foi usado ${atual.uses} vezes. O limite não pode ficar abaixo disso.`,
    })
  }

  // As duas travas do POST, que a edição pulava: sem elas o cupom editado
  // podia terminar antes de começar (nunca vale, e ninguém sabe por quê) ou
  // ficar restrito a lote de OUTRO evento. Mandar só uma das datas compara
  // contra a outra que já está gravada; `null` é "sem data".
  const comeca = campos.comecaEm !== undefined ? campos.comecaEm : atual.starts_at
  const termina = campos.terminaEm !== undefined ? campos.terminaEm : atual.ends_at
  if (comeca && termina && new Date(termina).getTime() <= new Date(comeca).getTime()) {
    throw createError({ statusCode: 422, statusMessage: 'O cupom não pode terminar antes de começar' })
  }
  if (campos.loteIds?.length) {
    const n = await q1<any>(
      `SELECT count(*)::int AS n FROM lots l JOIN sectors s ON s.id = l.sector_id
        WHERE l.id = ANY($1::uuid[]) AND s.event_id = $2`, [campos.loteIds, eventoId])
    if (Number(n.n) !== new Set(campos.loteIds).size) {
      throw createError({ statusCode: 422, statusMessage: 'Há lote que não é deste evento na restrição' })
    }
  }

  const pares = Object.entries(campos).filter(([k, v]) => k in COLUNAS && v !== undefined)
  if (!pares.length) throw createError({ statusCode: 400, statusMessage: 'Nada para alterar' })

  const sets = pares.map(([k], i) => `${COLUNAS[k]} = $${i + 2}`).join(', ')
  await q1(`UPDATE promo_codes SET ${sets} WHERE id = $1 RETURNING id`,
    [id, ...pares.map(([, v]) => v)])

  return { ok: true, alterados: pares.map(([k]) => k) }
})
