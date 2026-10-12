/**
 * De onde veio a pessoa (052). Dono, 11/10: "a gente está com o tráfego pago ativo e eu não consigo
 * saber de onde está vindo a pessoa".
 *
 * Funções PURAS — o navegador (plugin `origem.client.ts`) e o servidor (checkout, visita, relatório)
 * usam as mesmas, então a regra de "isto é anúncio" mora num lugar só.
 *
 * ## O que conta como TRÁFEGO PAGO
 *
 * - UTM com `utm_medium` de anúncio (cpc, ppc, paid, pago, ads, anuncio, trafego, cpm, paid_social…)
 *   ou `utm_source` com "ads" (facebook_ads, meta_ads…);
 * - `gclid` (só existe em clique de anúncio do Google).
 *
 * O ROBÔ (Sofia no WhatsApp / Instagram) manda o link de compra com `utm_medium=robo`: a venda que
 * nasce desse toque é do robô (`robo`), separada do anúncio e do orgânico.
 *
 * `fbclid` SOZINHO não é prova de anúncio: o Facebook e o Instagram põem esse código em QUALQUER
 * link clicado dentro deles (bio, story, post orgânico). Vira `meta_sem_utm` — "veio do Facebook/
 * Instagram, sem UTM: pode ser anúncio ou orgânico". Com a UTM no anúncio, a dúvida some. O RELATÓRIO
 * soma esse tipo em tráfego pago (decisão do dono, 11/10 — ver `origem-relatorio.ts`).
 */
import { z } from 'zod'

export type TipoDaOrigem = 'pago' | 'robo' | 'meta_sem_utm' | 'organico' | 'direto'

export interface Origem {
  tipo: TipoDaOrigem
  fonte: string | null
  meio: string | null
  campanha: string | null
  conteudo: string | null
  termo: string | null
  clique: 'fbclid' | 'gclid' | 'ttclid' | null
  /** o site de onde a pessoa clicou (só o domínio), quando não é o nosso */
  referencia: string | null
  /** a página em que ela chegou */
  entrada: string | null
  /** quando chegou (ISO) */
  em?: string | null
}

export const ROTULO_DA_ORIGEM: Record<TipoDaOrigem, string> = {
  pago: 'Tráfego pago',
  robo: 'Robô (WhatsApp / Instagram)',
  meta_sem_utm: 'Tráfego pago · Facebook/Instagram sem UTM',
  organico: 'Orgânico / indicação',
  direto: 'Direto (sem origem)',
}

const MEIO_PAGO = /(^|[^a-z])(cpc|ppc|cpm|cpv|paid|pago|paga|ads?|anuncios?|anúncios?|trafego|tráfego|patrocinad[oa])([^a-z]|$)|paid[_-]?social|social[_-]?paid/i
const MEIO_ROBO = /(^|[^a-z])(robo|robô|bot|chatbot|sofia|atendente[_-]?ia)([^a-z]|$)/i
const FONTE_PAGA = /(^|[^a-z])ads([^a-z]|$)|_ads$|-ads$/i

/** texto curto e limpo: o que vem na URL é do mundo, não nosso */
function limpo(v: unknown, max = 120): string | null {
  if (Array.isArray(v)) v = v[0]
  if (v == null) return null
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
  return s || null
}

/** o domínio de quem mandou a pessoa, sem o caminho (o caminho pode ter dado pessoal) */
export function dominioDaReferencia(referencia: unknown, nossoHost?: string | null): string | null {
  const s = limpo(referencia, 500)
  if (!s) return null
  try {
    const host = new URL(s).hostname.toLowerCase().replace(/^www\./, '')
    const nosso = String(nossoHost ?? '').toLowerCase().replace(/^www\./, '')
    if (!host || (nosso && host === nosso)) return null
    return host.slice(0, 120)
  } catch {
    return null
  }
}

/** pago, Meta sem UTM, orgânico ou direto — a regra do cabeçalho */
export function tipoDaOrigem(o: Pick<Origem, 'fonte' | 'meio' | 'campanha' | 'clique' | 'referencia'>): TipoDaOrigem {
  if (o.meio && MEIO_ROBO.test(o.meio)) return 'robo'
  if (o.clique === 'gclid') return 'pago'
  if ((o.meio && MEIO_PAGO.test(o.meio)) || (o.fonte && FONTE_PAGA.test(o.fonte))) return 'pago'
  const temUtm = !!(o.fonte || o.meio || o.campanha)
  if (!temUtm && (o.clique === 'fbclid' || o.clique === 'ttclid')) return 'meta_sem_utm'
  if (temUtm || o.referencia || o.clique) return 'organico'
  return 'direto'
}

/**
 * A origem que a URL de chegada carrega — ou `null` quando ela não diz nada (sem UTM, sem clique de
 * anúncio e sem site externo antes). `null` NÃO apaga a origem guardada: quem chegou pelo anúncio e
 * voltou digitando o endereço continua sendo do anúncio (último toque com informação).
 */
export function origemDaUrl(
  query: Record<string, unknown>, referencia?: string | null,
  ctx: { entrada?: string | null; nossoHost?: string | null; em?: string | null } = {},
): Origem | null {
  const clique = limpo(query.gclid) ? 'gclid' as const
    : limpo(query.fbclid) ? 'fbclid' as const
      : limpo(query.ttclid) ? 'ttclid' as const : null
  const base = {
    fonte: limpo(query.utm_source), meio: limpo(query.utm_medium), campanha: limpo(query.utm_campaign),
    conteudo: limpo(query.utm_content), termo: limpo(query.utm_term), clique,
    referencia: dominioDaReferencia(referencia, ctx.nossoHost),
  }
  if (!base.fonte && !base.meio && !base.campanha && !base.conteudo && !base.clique && !base.referencia) return null
  return { ...base, tipo: tipoDaOrigem(base), entrada: limpo(ctx.entrada, 200), em: ctx.em ?? null }
}

// texto longo é CORTADO, não recusado: a origem é informação, nunca motivo pra perder a visita ou a compra
const Texto = (max: number) => z.string().max(2000).nullish().transform((v) => limpo(v, max))

/** A origem como chega do navegador — revalidada e RECLASSIFICADA aqui (o tipo do cliente não vale). */
export const OrigemDoNavegador = z.object({
  fonte: Texto(120), meio: Texto(120), campanha: Texto(120), conteudo: Texto(120), termo: Texto(120),
  clique: z.enum(['fbclid', 'gclid', 'ttclid']).nullish().transform((v) => v ?? null),
  referencia: Texto(120), entrada: Texto(200),
  em: z.string().max(40).nullish().transform((v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null)),
}).transform((o): Origem => ({ ...o, tipo: tipoDaOrigem(o) }))

/** o que o checkout grava em `orders.origem`: o último toque com informação e o primeiro */
export const OrigemDoPedido = z.object({
  ultimo: OrigemDoNavegador.nullish(),
  primeiro: OrigemDoNavegador.nullish(),
})
