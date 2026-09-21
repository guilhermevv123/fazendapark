/**
 * GET /api/eventos-publicos — a vitrine da home.
 *
 * Duas coisas que esta rota errava e que só se enxerga comparando com a página
 * do evento:
 *
 * 1. **Evento privado aparecia na lista.** `is_private` existe pra sustentar
 *    pré-venda fechada e evento corporativo: abre por link direto, some de
 *    listagem. Listar é vazar a pré-venda pra quem não foi convidado.
 *
 * 2. **O "a partir de" saía de um SELECT próprio**, com a conta de taxa
 *    reescrita em SQL e sem olhar estoque, data nem desconto de meia-entrada.
 *    Resultado: a home anunciava um preço que o lote esgotado não vende mais e
 *    ignorava a meia, que é justamente o menor preço. A regra agora é UMA — a
 *    de `e/[slug].get.ts`, a mesma que a página do evento usa.
 */
import { q } from '../utils/db'
import type { ModoTaxa } from '../utils/dinheiro'
import {
  LOTE_DA_VITRINE, menorTotalCents, restaDasVariacoes, situacoesDoSetor, vendasAbertas,
  type LotePrecificavel,
} from './e/[slug].get'

export default defineEventHandler(async () => {
  const agora = new Date()

  const candidatos = await q<any>(
    `SELECT e.id, e.name AS nome, e.slug, e.starts_at, e.city, e.state,
            e.status, e.sales_end_at, e.sales_end_minutes_after,
            e.auto_rotate_lots, e.fee_bps, e.fee_mode_online
       FROM events e
      WHERE e.status = 'ativo' AND e.is_private = false
      ORDER BY e.starts_at`)

  const abertos = candidatos.filter((e) => vendasAbertas(e, agora))
  if (!abertos.length) return { eventos: [] }

  const ids = abertos.map((e) => e.id)

  const lotes = await q<any>(
    `SELECT s.event_id, s.id AS setor_id, l.id, l.price_cents,
            l.quantity, l.sold, l.reserved, l.starts_at, l.expires_at
       FROM sectors s
       JOIN lots l ON l.sector_id = s.id AND ${LOTE_DA_VITRINE}
      WHERE s.event_id = ANY($1::uuid[])
      ORDER BY s.sort_order, l.sort_order`, [ids])

  const tipos = await q<any>(
    `SELECT s.event_id, tt.lot_id, tt.quantity, tt.sold, tt.discount_bps
       FROM ticket_types tt
       JOIN lots l ON l.id = tt.lot_id AND ${LOTE_DA_VITRINE}
       JOIN sectors s ON s.id = l.sector_id
      WHERE s.event_id = ANY($1::uuid[])`, [ids])

  // Mesmo teto de variação da página do evento: lote com prateleira cheia e
  // todas as variações esgotadas não é lote vigente e não vira preço. Sem isto
  // a home dava o evento por esgotado enquanto a página do evento ainda
  // mostrava o lote como disponível.
  const restaPorLote = restaDasVariacoes(tipos)
  for (const l of lotes) l.restaNasVariacoes = restaPorLote.get(l.id) ?? null

  const eventos = abertos.map((e) => {
    // Mesmo agrupamento da página do evento: giro de lote é decisão do setor.
    const porSetor = new Map<string, any[]>()
    for (const l of lotes) {
      if (l.event_id !== e.id) continue
      if (!porSetor.has(l.setor_id)) porSetor.set(l.setor_id, [])
      porSetor.get(l.setor_id)!.push(l)
    }

    const precificaveis: LotePrecificavel[] = []
    for (const doSetor of porSetor.values()) {
      const situacoes = situacoesDoSetor(doSetor, {
        vendasAbertas: true, giroAutomatico: e.auto_rotate_lots, agora,
      })
      doSetor.forEach((l, i) => precificaveis.push({
        id: l.id, price_cents: Number(l.price_cents), situacao: situacoes[i],
      }))
    }

    const aPartirDeCents = menorTotalCents({
      lotes: precificaveis,
      tipos: tipos.filter((t) => t.event_id === e.id),
      feeBps: Number(e.fee_bps),
      modo: e.fee_mode_online as ModoTaxa,
    })

    return {
      nome: e.nome,
      slug: e.slug,
      inicio: e.starts_at,
      cidade: e.city,
      estado: e.state,
      aPartirDeCents,
      // Sem nenhum lote comprável não há preço pra anunciar. Dizer "esgotado"
      // é melhor que sumir com o evento da home: quem procurou pelo nome tem
      // que achar a página, ainda que só pra descobrir que acabou.
      esgotado: aPartirDeCents === null,
    }
  })

  return { eventos }
})
