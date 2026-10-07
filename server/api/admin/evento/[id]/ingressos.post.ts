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
import { ESTOQUE_SEM_LIMITE } from '../../../../utils/estoque-sem-limite'
import { q1, tx } from '../../../../utils/db'
import { CANAIS_PADRAO, explicarErro } from '../index.post'
import { ROTULOS_INGRESSOS } from './ingressos.patch'
import { TETO_POR_COMPRA } from '../../../../utils/limite-de-compra'
import { conferirDiasDeUso, diasDoEvento, limparDiasDeUso } from '../../../../utils/dias-de-uso'

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
  /** R$ 0,00 só com esta marca — ver o porquê em `evento/index.post.ts` */
  gratuito: z.boolean().default(false),
  /** sem número = SEM LIMITE (dono, 06/10) — ver utils/estoque-sem-limite */
  quantidade: z.number().int().min(1).max(ESTOQUE_SEM_LIMITE).default(ESTOQUE_SEM_LIMITE),
  minPorCompra: z.number().int().min(1).max(50).default(1),
  maxPorCompra: z.number().int().min(1).max(TETO_POR_COMPRA).default(TETO_POR_COMPRA),
  // Sem `canais`, site E balcão. O padrão antigo aqui (e o do banco) era só
  // `online`, e nenhum lote criado pelo painel vendia na bilheteria.
  canais: z.array(z.enum(['online', 'bilheteria', 'cortesia'])).min(1)
    .default(() => [...CANAIS_PADRAO]),
  visivel: z.boolean().default(true),
  abreEm: z.string().datetime({ offset: true }).nullish(),
  expiraEm: z.string().datetime({ offset: true }).nullish(),
})

const Tipo = z.object({
  o: z.literal('tipo'),
  loteId: z.string().uuid(),
  nome: z.string().min(1).max(80),
  /** sem número = acompanha o lote (sem limite) */
  quantidade: z.number().int().min(1).max(ESTOQUE_SEM_LIMITE).optional(),
  descontoBps: z.number().int().min(0).max(10_000, 'não pode passar de 100%').default(0),
  /** preço próprio do tipo (043) — em vez do desconto */
  precoCents: z.number().int().min(1, 'o preço do tipo precisa ser maior que zero').max(10_000_000).nullish(),
  exigeDocumento: z.boolean().default(false),
  maxPorCliente: z.number().int().min(1).max(200).nullish(),
  /**
   * dias em que passa na catraca (047), 'AAAA-MM-DD'. Sem o campo, herda os do tipo de MESMO NOME
   * em outro lote deste evento (os dias são do tipo, não do lote); `[]`/`null` = qualquer dia.
   */
  diasDeUso: z.array(z.string().max(10)).max(62).nullish(),
})

const Entrada = z.discriminatedUnion('o', [Setor, Lote, Tipo])

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    // os rótulos da tela de ingressos: com os do assistente, o nome vazio de um lote saía
    // "Nome do evento: …"
    throw createError({ statusCode: 400, statusMessage: explicarErro(p.error, ROTULOS_INGRESSOS), data: p.error.flatten() })
  }
  const d = p.data

  const ev = await q1<any>(`SELECT id, status, starts_at, ends_at, timezone FROM events WHERE id = $1`, [eventoId])
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
    if (d.faceCents === 0 && !d.gratuito) {
      throw createError({
        statusCode: 422,
        statusMessage: 'O valor está R$ 0,00. Digite o preço ou marque "Ingresso gratuito" — '
          + 'sem isso o lote sairia de graça no site.',
      })
    }
    if (d.faceCents > 0 && d.gratuito) {
      throw createError({
        statusCode: 422,
        statusMessage: 'O lote está marcado como gratuito e tem preço. Desmarque "Ingresso gratuito" ou zere o valor.',
      })
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

  // Os tipos compartilham o estoque do lote (ver `evento/index.post.ts`):
  // cada um vai no máximo até o lote, e o lote segura o total — a vitrine
  // mostra por tipo o menor entre a sobra do tipo e a do lote, então tipo
  // "maior" que o que resta não vira "esgotado" no meio do checkout.
  // tipo sem número acompanha o lote (sem limite, ou o número que o lote tiver)
  const qtdDoTipo = d.quantidade ?? Number(lote.quantity)
  if (qtdDoTipo > Number(lote.quantity)) {
    throw createError({
      statusCode: 422,
      statusMessage: `O tipo não pode ter mais que o lote (${lote.quantity})`,
    })
  }

  // Dias de uso (047): os mandados, conferidos contra o calendário do evento; sem o campo, os do
  // tipo de mesmo nome que já existir em outro lote — "SEXTA" do 2º lote passa na mesma sexta.
  let dias: string[] | null = null
  if (d.diasDeUso !== undefined) {
    const c = conferirDiasDeUso(d.diasDeUso, diasDoEvento(ev.starts_at, ev.ends_at, ev.timezone))
    if (!c.ok) throw createError({ statusCode: 422, statusMessage: c.erro })
    dias = c.dias
  } else {
    const irmao = await q1<any>(
      `SELECT tt.valid_dates::text[] AS dias
         FROM ticket_types tt JOIN lots l ON l.id = tt.lot_id JOIN sectors s ON s.id = l.sector_id
        WHERE s.event_id = $1 AND lower(btrim(tt.name)) = lower(btrim($2))
          AND COALESCE(cardinality(tt.valid_dates), 0) > 0
        LIMIT 1`, [eventoId, d.nome])
    dias = limparDiasDeUso(irmao?.dias)
  }

  const r = await q1<any>(
    `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps, requires_document,
                               max_per_customer, sort_order, price_cents, valid_dates)
     VALUES ($1,$2,$3,$4,$5,$6,
             COALESCE((SELECT MAX(sort_order) + 1 FROM ticket_types WHERE lot_id = $1), 1), $7, $8::date[])
     RETURNING id`,
    [d.loteId, d.nome.trim(), qtdDoTipo, d.precoCents != null ? 0 : d.descontoBps, d.exigeDocumento,
     d.maxPorCliente ?? null, d.precoCents ?? null, dias])
  return { ok: true, tipo: 'tipo', id: r.id, diasDeUso: dias }
})
