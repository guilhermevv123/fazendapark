/**
 * GET /api/pagamento/cartao?evento=<slug> — a tela de pagamento mostra o formulário de cartão NO
 * SITE? Só com o interruptor (`CARTAO_NO_SITE=1`) E o Asaas pronto pra cobrar nesta organização.
 * Senão o crédito segue pela fatura do Asaas, como sempre. Só SIM/NÃO: nada de chave nem motivo.
 */
import { q1 } from '../../utils/db'
import { cartaoNoSiteLigado, pagamentoPeloAsaas } from '../../utils/asaas'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  if (!cartaoNoSiteLigado()) return { ligado: false }
  const slug = String(getQuery(event).evento ?? '').slice(0, 200)
  if (!slug) return { ligado: false }
  const org = await q1<any>(
    `SELECT o.asaas_api_key, o.asaas_env FROM events e JOIN organizations o ON o.id = e.org_id WHERE e.slug = $1`,
    [slug])
  return { ligado: !!org && pagamentoPeloAsaas(org).ok }
})
