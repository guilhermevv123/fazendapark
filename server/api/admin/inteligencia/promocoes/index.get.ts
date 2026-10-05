/**
 * GET /api/admin/inteligencia/promocoes — o programa "Volte Mais" da organização (ou o rascunho
 * padrão, desligado, quando ainda não existe), o regulamento que sai das regras, os números de
 * uso e os próximos eventos (pra marcar onde NÃO vale).
 */
import { db, q, q1 } from '../../../../utils/db'
import { programaDeFidelidadeDaOrg } from '../../../../utils/fidelidade'
import { PROGRAMA_DE_FIDELIDADE_PADRAO, regulamentoDaFidelidade, type ProgramaDeFidelidade } from '../../../../utils/fidelidade-texto'

export default defineEventHandler(async (event) => {
  const orgId = event.context.sessao.orgId as string
  const p = await programaDeFidelidadeDaOrg(db(), orgId)
  const programa = p ?? { id: '', org_id: orgId, ...PROGRAMA_DE_FIDELIDADE_PADRAO }
  const numeros = p
    ? await q1<any>(
        `SELECT count(*) FILTER (WHERE o.status IN ('pago','estornado_parcial'))::int AS retornos_pagos,
                count(*) FILTER (WHERE o.status IN ('aguardando_pagamento','em_analise'))::int AS retornos_aguardando,
                COALESCE(sum(o.loyalty_discount_cents) FILTER (WHERE o.status IN ('pago','estornado_parcial')), 0)::bigint AS desconto_cents,
                COALESCE(sum(o.total_cents) FILTER (WHERE o.status IN ('pago','estornado_parcial')), 0)::bigint AS faturado_cents,
                count(DISTINCT cu.document) FILTER (WHERE o.status IN ('pago','estornado_parcial'))::int AS clientes
           FROM orders o JOIN customers cu ON cu.id = o.customer_id
          WHERE o.loyalty_program_id = $1`, [p.id])
    : null
  const eventos = await q<any>(
    `SELECT id, name, to_char(starts_at AT TIME ZONE timezone, 'YYYY-MM-DD') AS dia
       FROM events WHERE org_id = $1 AND starts_at > now() - interval '1 day' AND status <> 'cancelado'
      ORDER BY starts_at LIMIT 40`, [orgId])
  return {
    programa,
    existe: !!p,
    regulamentoPadrao: regulamentoDaFidelidade(programa as ProgramaDeFidelidade),
    numeros: numeros && {
      retornosPagos: numeros.retornos_pagos, retornosAguardando: numeros.retornos_aguardando,
      descontoCents: Number(numeros.desconto_cents), faturadoCents: Number(numeros.faturado_cents), clientes: numeros.clientes,
    },
    eventos,
  }
})
