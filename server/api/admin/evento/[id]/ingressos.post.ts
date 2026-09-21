/**
 * POST /api/admin/evento/:id/ingressos — cria setor, lote ou tipo.
 *
 * Uma rota só, com união discriminada, em vez de três. O que importa aqui é
 * que TODA criação passa pela checagem de que o pai pertence a ESTE evento —
 * e isso é fácil de esquecer quando a regra está espalhada em três arquivos.
 * Sem essa checagem, mandar o id de um lote de outro produtor no corpo do
 * pedido cria um tipo de ingresso dentro do evento alheio.
 */
import { z } from 'zod'
import { q1, tx } from '../../../../utils/db'

const Setor = z.object({
  o: z.literal('setor'),
  nome: z.string().min(1).max(120),
  tipo: z.enum(['ingresso', 'passaporte', 'mesa', 'camarote']).default('ingresso'),
  sessaoId: z.string().uuid().nullish(),
  descricao: z.string().max(500).nullish(),
  capacidade: z.number().int().min(1).max(1_000_000).nullish(),
  maxPorCliente: z.number().int().min(1).max(200).nullish(),
})

const Lote = z.object({
  o: z.literal('lote'),
  setorId: z.string().uuid(),
  nome: z.string().min(1).max(120),
  descricao: z.string().max(500).nullish(),
  faceCents: z.number().int().min(0).max(100_000_00),
  quantidade: z.number().int().min(1).max(1_000_000),
  minPorCompra: z.number().int().min(1).max(50).default(1),
  maxPorCompra: z.number().int().min(1).max(50).default(10),
  canais: z.array(z.enum(['online', 'bilheteria', 'cortesia'])).min(1).default(['online']),
  visivel: z.boolean().default(true),
  abreEm: z.string().datetime({ offset: true }).nullish(),
  expiraEm: z.string().datetime({ offset: true }).nullish(),
})

const Tipo = z.object({
  o: z.literal('tipo'),
  loteId: z.string().uuid(),
  nome: z.string().min(1).max(80),
  quantidade: z.number().int().min(1).max(1_000_000),
  descontoBps: z.number().int().min(0).max(10_000).default(0),
  exigeDocumento: z.boolean().default(false),
  maxPorCliente: z.number().int().min(1).max(200).nullish(),
})

const Entrada = z.discriminatedUnion('o', [Setor, Lote, Tipo])

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data

  const ev = await q1<any>(`SELECT id, status FROM events WHERE id = $1`, [eventoId])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  // ------------------------------------------------------------- setor ---
  if (d.o === 'setor') {
    if (d.sessaoId) {
      const s = await q1(`SELECT 1 FROM event_sessions WHERE id = $1 AND event_id = $2`,
        [d.sessaoId, eventoId])
      if (!s) throw createError({ statusCode: 422, statusMessage: 'Sessão não é deste evento' })
    }
    const r = await q1<any>(
      `INSERT INTO sectors (event_id, session_id, name, kind, description, capacity,
                            max_per_customer, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,
               COALESCE((SELECT MAX(sort_order) + 1 FROM sectors WHERE event_id = $1), 1))
       RETURNING id`,
      [eventoId, d.sessaoId ?? null, d.nome.trim(), d.tipo, d.descricao ?? null,
       d.capacidade ?? null, d.maxPorCliente ?? null])
    return { ok: true, tipo: 'setor', id: r.id }
  }

  // -------------------------------------------------------------- lote ---
  if (d.o === 'lote') {
    const setor = await q1<any>(
      `SELECT id, capacity FROM sectors WHERE id = $1 AND event_id = $2`, [d.setorId, eventoId])
    if (!setor) throw createError({ statusCode: 422, statusMessage: 'Setor não é deste evento' })
    if (d.minPorCompra > d.maxPorCompra) {
      throw createError({ statusCode: 422, statusMessage: 'O mínimo por compra não pode passar do máximo' })
    }
    if (d.abreEm && d.expiraEm && new Date(d.expiraEm) <= new Date(d.abreEm)) {
      throw createError({ statusCode: 422, statusMessage: 'O lote não pode expirar antes de abrir' })
    }

    // Capacidade do setor é teto da soma dos lotes. Sem esta conta, dois
    // lotes de 500 num setor de 600 vendem 1000 pessoas pra um espaço de 600.
    if (setor.capacity) {
      const usado = await q1<any>(
        `SELECT COALESCE(SUM(quantity),0)::int AS n FROM lots WHERE sector_id = $1`, [d.setorId])
      if (Number(usado.n) + d.quantidade > Number(setor.capacity)) {
        throw createError({
          statusCode: 422,
          statusMessage: `Estoura a capacidade do setor: ${usado.n} já alocados de ${setor.capacity}`,
        })
      }
    }

    const r = await q1<any>(
      `INSERT INTO lots (sector_id, name, description, price_cents, quantity,
                         min_per_order, max_per_order, channels, visible,
                         starts_at, expires_at, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               COALESCE((SELECT MAX(sort_order) + 1 FROM lots WHERE sector_id = $1), 1))
       RETURNING id`,
      [d.setorId, d.nome.trim(), d.descricao ?? null, d.faceCents, d.quantidade,
       d.minPorCompra, d.maxPorCompra, d.canais, d.visivel,
       d.abreEm ?? null, d.expiraEm ?? null])
    return { ok: true, tipo: 'lote', id: r.id }
  }

  // -------------------------------------------------------------- tipo ---
  const lote = await q1<any>(
    `SELECT l.id, l.quantity FROM lots l JOIN sectors s ON s.id = l.sector_id
      WHERE l.id = $1 AND s.event_id = $2`, [d.loteId, eventoId])
  if (!lote) throw createError({ statusCode: 422, statusMessage: 'Lote não é deste evento' })

  // A soma dos tipos não pode passar do lote: o estoque real é o do lote, e
  // tipo que promete mais do que existe vira "esgotado" na cara do comprador
  // no meio do checkout.
  const somaTipos = await q1<any>(
    `SELECT COALESCE(SUM(quantity),0)::int AS n FROM ticket_types WHERE lot_id = $1`, [d.loteId])
  if (Number(somaTipos.n) + d.quantidade > Number(lote.quantity)) {
    throw createError({
      statusCode: 422,
      statusMessage: `Estoura o lote: ${somaTipos.n} já distribuídos de ${lote.quantity}`,
    })
  }

  const r = await q1<any>(
    `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps, requires_document,
                               max_per_customer, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,
             COALESCE((SELECT MAX(sort_order) + 1 FROM ticket_types WHERE lot_id = $1), 1))
     RETURNING id`,
    [d.loteId, d.nome.trim(), d.quantidade, d.descontoBps, d.exigeDocumento,
     d.maxPorCliente ?? null])
  return { ok: true, tipo: 'tipo', id: r.id }
})
