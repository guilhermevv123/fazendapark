/**
 * PATCH /api/admin/evento/:id/ingressos — edita setor, lote ou tipo.
 *
 * A guarda que importa: **a quantidade nunca pode cair abaixo do que já saiu**.
 * Baixar o estoque de 100 pra 50 num lote com 80 vendidos deixaria
 * `sold + reserved > quantity` — que é exatamente o estado que o CHECK do
 * banco proíbe. Sem esta conta aqui, o erro chega como violação de constraint
 * no meio de um UPDATE, e a tela mostra "erro interno" no lugar do motivo.
 *
 * Preço é livre de mudar, inclusive com venda feita: quem comprou pagou o
 * preço do momento e o pedido guarda o valor cobrado. O que não pode é o
 * estoque virar mentira.
 */
import { z } from 'zod'
import { tx } from '../../../../utils/db'

const Entrada = z.object({
  // 'evento' entra aqui porque as chaves que a tela de ingressos liga e
  // desliga (giro automático de lote, política de taxa) moram no evento, não
  // no lote — e separá-las em outra rota faria a mesma tela falar com duas.
  o: z.enum(['setor', 'lote', 'tipo', 'evento']),
  id: z.string().uuid(),
  campos: z.object({
    nome: z.string().min(1).max(120).optional(),
    descricao: z.string().max(500).nullish(),
    faceCents: z.number().int().min(0).max(100_000_00).optional(),
    quantidade: z.number().int().min(0).max(1_000_000).optional(),
    minPorCompra: z.number().int().min(1).max(50).optional(),
    maxPorCompra: z.number().int().min(1).max(50).optional(),
    visivel: z.boolean().optional(),
    canais: z.array(z.enum(['online', 'bilheteria', 'cortesia'])).min(1).optional(),
    abreEm: z.string().datetime({ offset: true }).nullish(),
    expiraEm: z.string().datetime({ offset: true }).nullish(),
    descontoBps: z.number().int().min(0).max(10_000).optional(),
    exigeDocumento: z.boolean().optional(),
    maxPorCliente: z.number().int().min(1).max(200).nullish(),
    capacidade: z.number().int().min(1).max(1_000_000).nullish(),
    admite: z.number().int().min(1).max(100).optional(),
    sessoesCobertas: z.number().int().min(1).max(365).nullish(),
    giroAutomatico: z.boolean().optional(),
    taxaBps: z.number().int().min(0).max(5000).optional(),
    modoTaxaOnline: z.enum(['repassar', 'absorver']).optional(),
    modoTaxaPdv: z.enum(['repassar', 'absorver']).optional(),
  }),
})

/** campo da API → coluna do banco, por entidade */
const COLUNAS: Record<string, Record<string, string>> = {
  setor: {
    nome: 'name', descricao: 'description', capacidade: 'capacity',
    maxPorCliente: 'max_per_customer',
    admite: 'admits', sessoesCobertas: 'sessions_covered',
  },
  lote: {
    nome: 'name', descricao: 'description', faceCents: 'price_cents',
    quantidade: 'quantity', minPorCompra: 'min_per_order', maxPorCompra: 'max_per_order',
    visivel: 'visible', canais: 'channels', abreEm: 'starts_at', expiraEm: 'expires_at',
  },
  tipo: {
    nome: 'name', quantidade: 'quantity', descontoBps: 'discount_bps',
    exigeDocumento: 'requires_document', maxPorCliente: 'max_per_customer',
  },
  evento: {
    nome: 'name', descricao: 'description', giroAutomatico: 'auto_rotate_lots',
    taxaBps: 'fee_bps', modoTaxaOnline: 'fee_mode_online', modoTaxaPdv: 'fee_mode_pos',
    maxPorCliente: 'max_per_customer',
  },
}

const TABELA = {
  setor: 'sectors', lote: 'lots', tipo: 'ticket_types', evento: 'events',
} as const

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const { o, id, campos } = p.data

  const mapa = COLUNAS[o]
  const pares = Object.entries(campos).filter(([k, v]) => k in mapa && v !== undefined)
  if (!pares.length) throw createError({ statusCode: 400, statusMessage: 'Nada para alterar' })

  return await tx(async (c) => {
    // dono: a linha tem que ser deste evento, sempre.
    // Para 'evento', o id do corpo TEM que ser o mesmo da URL — senão a rota
    // de um evento viraria uma porta para editar outro.
    const dono = o === 'evento'
      ? `SELECT e.* FROM events e WHERE e.id = $1 AND e.id = $2 FOR UPDATE OF e`
      : o === 'setor'
      ? `SELECT s.* FROM sectors s WHERE s.id = $1 AND s.event_id = $2 FOR UPDATE OF s`
      : o === 'lote'
        ? `SELECT l.* FROM lots l JOIN sectors s ON s.id = l.sector_id
            WHERE l.id = $1 AND s.event_id = $2 FOR UPDATE OF l`
        : `SELECT tt.* FROM ticket_types tt JOIN lots l ON l.id = tt.lot_id
            JOIN sectors s ON s.id = l.sector_id
           WHERE tt.id = $1 AND s.event_id = $2 FOR UPDATE OF tt`
    const atual = await c.query(dono, [id, eventoId])
    if (!atual.rowCount) throw createError({ statusCode: 404, statusMessage: 'Não encontrado' })
    const linha = atual.rows[0]

    if (campos.quantidade !== undefined && (o === 'lote' || o === 'tipo')) {
      const saiu = Number(linha.sold) + Number(linha.reserved ?? 0)
      if (campos.quantidade < saiu) {
        throw createError({
          statusCode: 409,
          statusMessage: `Já saíram ${saiu} deste ${o}. A quantidade não pode ficar abaixo disso.`,
        })
      }
    }
    if (o === 'lote') {
      const min = campos.minPorCompra ?? Number(linha.min_per_order)
      const max = campos.maxPorCompra ?? Number(linha.max_per_order)
      if (min > max) {
        throw createError({ statusCode: 422, statusMessage: 'O mínimo por compra não pode passar do máximo' })
      }
    }

    // A posse já foi provada no SELECT ... FOR UPDATE acima, dentro desta
    // mesma transação e com a linha travada: o UPDATE não precisa repetir a
    // condição. Tentar "usar" o eventoId aqui com `$2 IS NOT NULL` custou caro
    // — um parâmetro solto num IS NOT NULL não tem tipo que o Postgres possa
    // inferir, e o UPDATE inteiro falhava com "Server Error" enquanto a tela
    // dizia que salvou.
    const sets = pares.map(([k], i) => `${mapa[k]} = $${i + 2}`).join(', ')
    const valores = pares.map(([, v]) => v)
    await c.query(`UPDATE ${TABELA[o]} SET ${sets} WHERE id = $1`, [id, ...valores])

    await c.query(
      `INSERT INTO audit_log (entity, entity_id, action, before, after)
       VALUES ($1,$2,'editado',$3::jsonb,$4::jsonb)`,
      [o, id,
       JSON.stringify(Object.fromEntries(pares.map(([k]) => [k, linha[mapa[k]]]))),
       JSON.stringify(Object.fromEntries(pares))])

    return { ok: true, alterados: pares.map(([k]) => k) }
  })
})
