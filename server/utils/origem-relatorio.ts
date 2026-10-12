/**
 * "De onde vieram as vendas" — a seção da aba Relatórios do evento (052, dono 11/10: "na aba
 * relatório preciso saber também").
 *
 * - VENDAS: os pedidos do SITE (`CANAL_DO_FUNIL`, o mesmo recorte do funil) pela origem gravada
 *   no pedido (`orders.origem.ultimo`). Pago = pedido vivo (`PEDIDO_VIVO`); receita = o que ficou
 *   (`total − devolvido`).
 * - VISITAS: `site_visits` no período de venda do evento (da criação ao fim), no site todo ou na
 *   página deste evento — o link do anúncio costuma apontar pra home.
 * - Pedido sem origem de ANTES do rastreio começar vira "sem registro (antes do rastreio)", não
 *   "direto": seria mentir que veio direto.
 * - Facebook/Instagram SEM UTM (`meta_sem_utm`) SOMA em tráfego pago (dono, 11/10: "esse Facebook e
 *   Instagram sem UTM é venda de tráfego pago" — os anúncios rodaram sem UTM e o gestor confirmou
 *   comprador por comprador). A linha da campanha continua dizendo "sem UTM"; o link da bio tem
 *   UTM própria (`ig`/`social`) e segue orgânico.
 */
import { q, q1 } from './db'
import { PEDIDO_VIVO } from './liquido'
import { ROTULO_DA_ORIGEM, type TipoDaOrigem } from './origem'

type TipoNoRelatorio = TipoDaOrigem | 'sem_registro'

const ROTULO: Record<TipoNoRelatorio, string> = {
  ...ROTULO_DA_ORIGEM,
  sem_registro: 'Sem registro (antes do rastreio)',
}
const ORDEM: TipoNoRelatorio[] = ['pago', 'robo', 'organico', 'direto', 'sem_registro']
const ROTULO_SEM_UTM = 'Tráfego pago · Facebook/Instagram sem UTM'

export interface LinhaDeOrigem {
  tipo: TipoNoRelatorio; rotulo: string
  fonte: string | null; meio: string | null; campanha: string | null; conteudo: string | null
  visitas: number; visitantes: number
  pedidos: number; pagos: number; ingressos: number; receitaCents: number
  /** pedidos pagos ÷ visitantes, em % (null sem visita registrada) */
  conversaoPct: number | null
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null)

export async function origensDoEvento(
  ev: { id: string; slug: string; created_at: string | Date; ends_at: string | Date },
  canalDoSite: string,
) {
  const inicioDoRastreio = (await q1<{ em: string | null }>(`SELECT min(criado_em) AS em FROM site_visits`))?.em ?? null
  const tipoSql = `COALESCE(o.origem->'ultimo'->>'tipo',
      CASE WHEN o.origem IS NULL AND ($2::timestamptz IS NULL OR o.created_at < $2::timestamptz)
           THEN 'sem_registro' ELSE 'direto' END)`
  const [vendas, visitas] = await Promise.all([
    q<any>(
      `SELECT ${tipoSql} AS tipo,
              -- sem UTM, o site de onde veio (instagram.com, google.com…) faz as vezes de fonte
              COALESCE(o.origem->'ultimo'->>'fonte', o.origem->'ultimo'->>'referencia') AS fonte,
              o.origem->'ultimo'->>'meio' AS meio,
              o.origem->'ultimo'->>'campanha' AS campanha, o.origem->'ultimo'->>'conteudo' AS conteudo,
              count(*)::int AS pedidos,
              count(*) FILTER (WHERE ${PEDIDO_VIVO('o.')})::int AS pagos,
              COALESCE(sum(ing.n) FILTER (WHERE ${PEDIDO_VIVO('o.')}), 0)::int AS ingressos,
              COALESCE(sum(o.total_cents - COALESCE(o.refunded_cents, 0)) FILTER (WHERE ${PEDIDO_VIVO('o.')}), 0)::bigint AS receita
         FROM orders o
         LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM tickets t
                             WHERE t.order_id = o.id AND t.status <> 'cancelado') ing ON true
        WHERE o.event_id = $1 AND ${canalDoSite.replace(/\bchannel\b/g, 'o.channel')} AND o.status <> 'rascunho'
        GROUP BY 1, 2, 3, 4, 5`, [ev.id, inicioDoRastreio]),
    q<any>(
      `SELECT tipo, COALESCE(fonte, referencia) AS fonte, meio, campanha, conteudo,
              count(*)::int AS visitas, count(DISTINCT visitante)::int AS visitantes
         FROM site_visits
        WHERE criado_em >= $1 AND criado_em <= $2 AND (evento_slug IS NULL OR evento_slug = $3)
        GROUP BY 1, 2, 3, 4, 5`, [ev.created_at, ev.ends_at, ev.slug]),
  ])

  const chave = (r: any) => [r.tipo, r.fonte ?? '', r.meio ?? '', r.campanha ?? '', r.conteudo ?? ''].join('\u0001')
  const linhas = new Map<string, LinhaDeOrigem>()
  const linha = (r: any): LinhaDeOrigem => {
    const k = chave(r)
    let l = linhas.get(k)
    if (!l) {
      const semUtm = r.tipo === 'meta_sem_utm'
      const tipo = (semUtm ? 'pago' : ORDEM.includes(r.tipo) ? r.tipo : 'direto') as TipoNoRelatorio
      l = { tipo, rotulo: semUtm ? ROTULO_SEM_UTM : ROTULO[tipo], fonte: r.fonte ?? (semUtm ? 'facebook/instagram' : null), meio: r.meio ?? null, campanha: r.campanha ?? null,
            conteudo: r.conteudo ?? null, visitas: 0, visitantes: 0, pedidos: 0, pagos: 0, ingressos: 0,
            receitaCents: 0, conversaoPct: null }
      linhas.set(k, l)
    }
    return l
  }
  for (const r of vendas) {
    const l = linha(r)
    l.pedidos += Number(r.pedidos); l.pagos += Number(r.pagos)
    l.ingressos += Number(r.ingressos); l.receitaCents += Number(r.receita)
  }
  for (const r of visitas) {
    const l = linha(r)
    l.visitas += Number(r.visitas); l.visitantes += Number(r.visitantes)
  }
  const todas = [...linhas.values()]
  for (const l of todas) l.conversaoPct = l.tipo === 'sem_registro' ? null : pct(l.pagos, l.visitantes)

  const porTipo = ORDEM.map((tipo) => {
    const ls = todas.filter((l) => l.tipo === tipo)
    const soma = (k: 'visitas' | 'visitantes' | 'pedidos' | 'pagos' | 'ingressos' | 'receitaCents') =>
      ls.reduce((s, l) => s + l[k], 0)
    const t = { tipo, rotulo: ROTULO[tipo], visitas: soma('visitas'), visitantes: soma('visitantes'),
                pedidos: soma('pedidos'), pagos: soma('pagos'), ingressos: soma('ingressos'),
                receitaCents: soma('receitaCents'), conversaoPct: null as number | null }
    t.conversaoPct = tipo === 'sem_registro' ? null : pct(t.pagos, t.visitantes)
    return t
  }).filter((t) => t.visitas || t.pedidos)

  // por campanha: só o que tem UTM ou veio de algum lugar (o "direto" e o "sem registro" já estão no total)
  const porCampanha = todas
    .filter((l) => l.tipo !== 'direto' && l.tipo !== 'sem_registro')
    .sort((a, b) => b.receitaCents - a.receitaCents || b.visitantes - a.visitantes)
    .slice(0, 40)

  return { rastreioDesde: inicioDoRastreio, porTipo, porCampanha }
}
