/**
 * GET /api/admin/evento/:id/ingressos — a árvore setor → lote → tipo.
 *
 * Devolve também o que JÁ FOI VENDIDO em cada nível, porque é isso que decide
 * o que ainda pode ser editado ou apagado. Uma tela de configuração que não
 * sabe o que já vendeu deixa o produtor apagar um lote com ingresso na rua.
 */
import { q, q1 } from '../../../../utils/db'
import { precificar, faceDoTipo, type ModoTaxa } from '../../../../utils/dinheiro'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const ev = await q1<any>(
    `SELECT id, name, status, fee_bps, fee_mode_online, fee_mode_pos, starts_at,
            auto_rotate_lots
       FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const sessoes = await q<any>(
    `SELECT id, title, starts_at, ends_at, sort_order
       FROM event_sessions WHERE event_id = $1 ORDER BY sort_order`, [id])

  const setores = await q<any>(
    `SELECT s.id, s.name, s.kind, s.session_id, s.max_per_customer, s.sort_order,
            s.capacity, s.description, s.admits, s.sessions_covered
       FROM sectors s WHERE s.event_id = $1 ORDER BY s.sort_order`, [id])

  const lotes = await q<any>(
    `SELECT l.id, l.sector_id, l.name, l.description, l.price_cents, l.quantity,
            l.sold, l.reserved, l.min_per_order, l.max_per_order, l.channels,
            l.visible, l.starts_at, l.expires_at, l.sort_order
       FROM lots l JOIN sectors s ON s.id = l.sector_id
      WHERE s.event_id = $1 ORDER BY l.sort_order`, [id])

  const tipos = await q<any>(
    `SELECT tt.id, tt.lot_id, tt.name, tt.quantity, tt.sold, tt.discount_bps,
            tt.requires_document, tt.max_per_customer, tt.sort_order
       FROM ticket_types tt
       JOIN lots l ON l.id = tt.lot_id JOIN sectors s ON s.id = l.sector_id
      WHERE s.event_id = $1 ORDER BY tt.sort_order`, [id])

  const bps = Number(ev.fee_bps)
  const modo: ModoTaxa = ev.fee_mode_online

  return {
    evento: {
      id: ev.id, nome: ev.name, status: ev.status, inicio: ev.starts_at,
      taxaBps: bps, modoTaxaOnline: ev.fee_mode_online, modoTaxaPdv: ev.fee_mode_pos,
      giroAutomatico: ev.auto_rotate_lots,
    },
    sessoes: sessoes.map((s) => ({
      id: s.id, titulo: s.title, inicio: s.starts_at, fim: s.ends_at,
    })),
    setores: setores.map((s) => ({
      id: s.id, nome: s.name, tipo: s.kind, sessaoId: s.session_id,
      descricao: s.description, capacidade: s.capacity,
      maxPorCliente: s.max_per_customer, ordem: s.sort_order,
      // `admite` é gente por unidade (mesa de 4) e `sessoesCobertas` é quantas
      // sessões a unidade vale (passaporte de 3 dias). Os dois juntos são o
      // que diferencia passaporte, mesa e ingresso comum — sem eles a
      // portaria conta 1 onde deveria contar 4.
      admite: Number(s.admits ?? 1),
      sessoesCobertas: s.sessions_covered,
      lotes: lotes.filter((l) => l.sector_id === s.id).map((l) => {
        const p = precificar(Number(l.price_cents), bps, modo)
        return {
          id: l.id, nome: l.name, descricao: l.description,
          faceCents: Number(l.price_cents),
          taxaCents: p.feeCents,
          totalCents: p.totalCents,
          produtorRecebeCents: p.produtorCents,
          quantidade: l.quantity, vendidos: l.sold, reservados: l.reserved,
          disponivel: l.quantity - l.sold - l.reserved,
          minPorCompra: l.min_per_order, maxPorCompra: l.max_per_order,
          canais: l.channels, visivel: l.visible,
          abreEm: l.starts_at, expiraEm: l.expires_at, ordem: l.sort_order,
          // Vendido > 0 é o que trava exclusão e redução de estoque.
          podeApagar: Number(l.sold) === 0 && Number(l.reserved) === 0,
          tipos: tipos.filter((t) => t.lot_id === l.id).map((t) => {
            const face = faceDoTipo(Number(l.price_cents), Number(t.discount_bps), bps, modo)
            const pp = precificar(face, bps, modo)
            return {
              id: t.id, nome: t.name, quantidade: t.quantity, vendidos: t.sold,
              descontoBps: Number(t.discount_bps),
              exigeDocumento: t.requires_document,
              maxPorCliente: t.max_per_customer,
              faceCents: pp.faceCents, taxaCents: pp.feeCents, totalCents: pp.totalCents,
              podeApagar: Number(t.sold) === 0,
            }
          }),
        }
      }),
    })),
  }
})
