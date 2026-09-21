import { q } from '../utils/db'
export default defineEventHandler(async () => {
  const eventos = await q<any>(
    `SELECT e.name AS nome, e.slug, e.starts_at AS inicio, e.city AS cidade,
            MIN(CASE WHEN e.fee_mode_online = 'repassar'
                     THEN l.price_cents + round(l.price_cents * e.fee_bps / 10000.0)
                     ELSE l.price_cents END)::bigint AS "aPartirDeCents"
       FROM events e
       JOIN sectors s ON s.event_id = e.id
       JOIN lots l ON l.sector_id = s.id AND l.visible
      WHERE e.status = 'ativo' AND (e.sales_end_at IS NULL OR e.sales_end_at > now())
      GROUP BY e.id ORDER BY e.starts_at`)
  return { eventos }
})
