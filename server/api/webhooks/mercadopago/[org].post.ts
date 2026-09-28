/**
 * POST /api/webhooks/mercadopago/:org — o aviso do Mercado Pago de que um Pix mudou.
 *
 * O endereço vai em cada Pix criado (`notification_url`, ver `urlDoAviso`), com o id da
 * organização no caminho: é ele que diz com QUAL token perguntar ao MP. Não precisa configurar
 * nada no painel do MP pra funcionar; a assinatura secreta de lá é a segunda parede, opcional.
 *
 * Quatro decisões:
 *
 * 1. **O aviso é só um aviso.** O corpo traz o id e nada mais em que se possa confiar. O estado
 *    vem de `GET /v1/payments/{id}` com o token da organização, e é ESSA resposta que vira efeito
 *    (`processarPagamentoMp`). Aviso forjado, no pior caso, faz a gente perguntar ao MP por um
 *    pagamento nosso — e a resposta é a verdade.
 *
 * 2. **A assinatura, quando vem, tem que conferir.** Com a assinatura secreta salva em Dados e
 *    cobrança, `x-signature` torto é 401 (e nada é gravado: quem não passou da porta não escreve
 *    no banco). Sem `x-signature` o aviso segue pela regra 1 — o MP não promete assinar o aviso
 *    que vem do `notification_url` de cada pagamento, e recusar derrubaria o aviso de verdade.
 *
 * 3. **Pagamento que não é de pedido desta organização não custa nada.** Nem consulta ao MP: o
 *    pedido é achado por `(org, mp_payment_id)` antes de qualquer rede.
 *
 * 4. **Falha passageira é 500; o resto é 200.** O MP reenvia o que não recebeu 200 em 22 s (a cada
 *    15 min, e continua depois da 3ª). MP fora ou banco fora: 500, queremos a reentrega. Erro de
 *    regra fica escrito na linha do fato em `payment_events`, e a varredura de minuto em minuto
 *    pergunta de novo — reenvio eterno do mesmo erro não conserta nada.
 */
import { q1 } from '../../../utils/db'
import { ehUuid } from '../../../utils/asaas'
import { abrirSegredo, CofreFechado } from '../../../utils/cofre'
import { assinaturaConfere } from '../../../utils/mercadopago-conta'
import { processarPagamentoMp } from '../../../utils/mercadopago'

export default defineEventHandler(async (event) => {
  const orgId = getRouterParam(event, 'org')
  if (!ehUuid(orgId)) throw createError({ statusCode: 404, statusMessage: 'Não encontrado' })

  const consulta = getQuery(event) as Record<string, any>
  const corpo = ((await readBody<any>(event).catch(() => null)) ?? {}) as any
  // formato novo: `?data.id=…&type=payment`; IPN antigo: `?id=…&topic=payment`
  const idDaUrl = consulta['data.id'] ?? consulta.id
  const tipo = String(consulta.type ?? consulta.topic ?? corpo?.type ?? corpo?.topic ?? '')
  const paymentId = String(idDaUrl ?? corpo?.data?.id ?? '').trim()

  const org = await q1<any>(
    `SELECT id, mp_access_token, mp_webhook_secret FROM organizations WHERE id = $1`, [orgId])
  if (!org) throw createError({ statusCode: 404, statusMessage: 'Não encontrado' })

  // ------------------------------------------------------------ 2. assinatura
  const assinatura = getHeader(event, 'x-signature')
  if (assinatura) {
    let segredo: string | null = null
    try { segredo = abrirSegredo(org.mp_webhook_secret) } catch (e) { if (!(e instanceof CofreFechado)) throw e }
    if (segredo && !assinaturaConfere({
      assinatura, requestId: getHeader(event, 'x-request-id'),
      dataId: consulta['data.id'] != null ? String(consulta['data.id']) : null, segredo,
    })) {
      console.warn(`[webhook mercadopago] assinatura não confere (org ${orgId}, pagamento ${paymentId || '?'})`)
      throw createError({ statusCode: 401, statusMessage: 'Assinatura do aviso não confere.' })
    }
  }

  if (tipo !== 'payment' || !/^\d{1,30}$/.test(paymentId)) {
    // `merchant_order`, `topic_claims_integration_wh`… e o teste do painel: registrados pelo MP,
    // nada a fazer aqui. 200 pra não virar reenvio eterno.
    return { ok: true, ignorado: tipo || 'aviso sem tipo' }
  }
  if (!org.mp_access_token) return { ok: true, ignorado: 'organização sem Mercado Pago' }

  // ------------------------------------------------------------ 1 e 3. o efeito
  const r = await processarPagamentoMp({ orgId: org.id, paymentId }).catch((e: any) => ({
    ok: false as const, erro: e?.message ?? String(e), passageira: true,
  }))
  if (!r.ok && r.passageira) {
    console.warn(`[webhook mercadopago] pagamento ${paymentId}: ${r.erro} (fica pro reenvio)`)
    throw createError({ statusCode: 500, statusMessage: 'indisponível' })
  }
  if (!r.ok) console.warn(`[webhook mercadopago] pagamento ${paymentId}: ${r.erro}`)
  // nada do pagamento sai daqui: o MP só precisa do 200
  return { ok: true }
})
