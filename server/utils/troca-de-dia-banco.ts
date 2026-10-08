/**
 * Troca de dia na portaria (049) — o lado do BANCO: o preço de hoje de cada tipo do evento e quanto o
 * ingresso custou. A régua (quais tipos servem, quanto é a diferença) mora em `troca-de-dia.ts`, que é
 * pura porque o tablet sem rede roda a MESMA conta com a lista baixada.
 */
import type { PoolClient } from 'pg'
import { q } from './db'
import { faceDoTipo, type ModoTaxa } from './dinheiro'
import { limparDiasDeUso } from './dias-de-uso'
import type { TipoParaTroca } from './troca-de-dia'

/**
 * Quanto a pessoa pagou pela FACE deste ingresso: o item do pedido com o mesmo tipo (preço congelado
 * na compra). Sem item (venda antiga, cortesia emitida sem item) volta NULL e quem chama usa o preço
 * de hoje do tipo comprado — a diferença fica sendo só a dos dois tipos.
 * Pede `t` = tickets no FROM de quem usa.
 */
export const SQL_PAGO_DO_INGRESSO = `(SELECT i.unit_face_cents FROM order_items i
     WHERE i.order_id = t.order_id AND i.ticket_type_id IS NOT DISTINCT FROM t.ticket_type_id
     ORDER BY i.created_at LIMIT 1)`

/** os tipos do evento com o preço de agora — a tabela que a troca consulta (e que desce pro tablet) */
export async function tiposDaTrocaDeDia(eventId: string, c?: PoolClient): Promise<TipoParaTroca[]> {
  const sql = `SELECT tt.id, tt.name, tt.valid_dates::text[] AS dias, tt.price_cents AS preco_tipo,
            tt.discount_bps, l.price_cents AS preco_lote, COALESCE(tt.admits, s.admits, 1)::int AS pessoas,
            (l.visible AND (l.starts_at IS NULL OR l.starts_at <= now())
              AND (l.expires_at IS NULL OR l.expires_at > now())) AS disponivel,
            s.sort_order AS ordem_setor, l.sort_order AS ordem_lote, tt.sort_order AS ordem_tipo,
            ev.fee_bps, ev.fee_mode_pos
       FROM ticket_types tt
       JOIN lots l ON l.id = tt.lot_id
       JOIN sectors s ON s.id = l.sector_id
       JOIN events ev ON ev.id = s.event_id
      WHERE s.event_id = $1 AND COALESCE(s.sessions_covered, 1) <= 1
      ORDER BY s.sort_order, l.sort_order, tt.sort_order`
  const linhas: any[] = c ? (await c.query(sql, [eventId])).rows : await q<any>(sql, [eventId])
  return linhas.map((t, i) => ({
    id: t.id,
    nome: t.name,
    dias: limparDiasDeUso(t.dias),
    faceCents: faceDoTipo(Number(t.preco_lote), Number(t.discount_bps ?? 0), Number(t.fee_bps ?? 0),
      (t.fee_mode_pos ?? 'absorver') as ModoTaxa, t.preco_tipo == null ? null : Number(t.preco_tipo)),
    pessoas: Number(t.pessoas),
    disponivel: Boolean(t.disponivel),
    ordem: i,
  }))
}

/** o que a pessoa pagou, ou (sem item no pedido) o preço de hoje do tipo que ela comprou */
export function pagoDoIngressoNaTroca(pagoCents: unknown, tipoId: string | null, tipos: TipoParaTroca[]): number {
  if (pagoCents != null && Number.isFinite(Number(pagoCents))) return Math.max(0, Math.round(Number(pagoCents)))
  return Math.max(0, tipos.find((t) => t.id === tipoId)?.faceCents ?? 0)
}
