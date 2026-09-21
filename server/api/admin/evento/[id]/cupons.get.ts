/**
 * GET /api/admin/evento/:id/cupons — códigos promocionais do evento.
 *
 * Devolve o uso junto (`uses` de `max_uses`) porque cupom sem contador é
 * cupom que vaza: o código de 50% combinado pra 20 pessoas circula num grupo
 * de mil e ninguém percebe antes do fechamento do caixa.
 */
import { q, q1 } from '../../../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const ev = await q1<any>(`SELECT id, name FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const cupons = await q<any>(
    `SELECT p.id, p.code, p.kind, p.value, p.max_uses, p.uses, p.max_per_customer,
            p.starts_at, p.ends_at, p.active, p.lot_ids, p.created_at,
            -- Quanto o cupom já tirou do caixa. É a pergunta que o produtor
            -- faz depois, e ela não se responde com o contador de usos: dez
            -- usos de R$ 5 e dez de R$ 50 aparecem iguais lá.
            COALESCE((SELECT SUM(o.discount_cents) FROM orders o
                       WHERE o.promo_code_id = p.id AND o.status = 'pago'), 0)::int AS desconto_dado
       FROM promo_codes p
      WHERE p.event_id = $1
      ORDER BY p.created_at DESC`, [id])

  // Os lotes vêm junto pra tela poder mostrar "vale só no 1º lote" por nome, e
  // não por uma lista de uuid que não diz nada a ninguém.
  const lotes = await q<any>(
    `SELECT l.id, l.name, s.name AS setor
       FROM lots l JOIN sectors s ON s.id = l.sector_id
      WHERE s.event_id = $1 ORDER BY s.sort_order, l.sort_order`, [id])

  return {
    evento: { id: ev.id, nome: ev.name },
    lotes: lotes.map((l) => ({ id: l.id, nome: l.name, setor: l.setor })),
    cupons: cupons.map((c) => ({
      id: c.id, codigo: c.code, tipo: c.kind, valor: Number(c.value),
      maxUsos: c.max_uses, usos: c.uses, maxPorCliente: c.max_per_customer,
      comecaEm: c.starts_at, terminaEm: c.ends_at, ativo: c.active,
      loteIds: c.lot_ids ?? [],
      descontoDadoCents: Number(c.desconto_dado),
      // Cupom já usado não pode ser apagado: o pedido aponta pra ele e o
      // relatório de desconto ficaria sem a origem.
      podeApagar: Number(c.uses) === 0,
    })),
  }
})
