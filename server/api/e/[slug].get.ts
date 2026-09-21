/**
 * GET /api/e/:slug — a vitrine pública do evento.
 *
 * A rota responde uma pergunta só: o que o COMPRADOR pode ver e comprar AGORA.
 * Três regras valem o arquivo inteiro.
 *
 * 1. **Preço já precificado.** Vai o total que sai do bolso, não a face. Mandar
 *    a face e deixar o navegador somar a taxa é como o total da tela passa a
 *    divergir do cobrado: duas implementações da mesma regra, uma sempre
 *    desatualizada.
 *
 * 2. **Disponibilidade sai do estoque, não do otimismo.** `situacao` é
 *    calculada aqui, no servidor, a partir de quantity/sold/reserved e das
 *    datas do lote, e respeita o giro automático (ver `situacoesDoSetor`).
 *    Vitrine que anuncia "disponível" um lote esgotado não economiza clique:
 *    empurra o comprador até o CPF pra ele levar 409 na cara do checkout.
 *
 * 3. **Só sai o que é do comprador.** Nada de contagem exata de estoque, de
 *    status interno do evento nem de configuração do produtor (política de
 *    taxa, teto por CPF, agrupamento de tela). Resposta pública é superfície
 *    de ataque e é presente pra cambista: o que a vitrine não precisa mostrar,
 *    ela não devolve.
 *
 * As funções exportadas daqui são a ÚNICA definição de "o que está à venda".
 * `eventos-publicos.get.ts` importa as mesmas — a home e a página do evento
 * discordarem sobre o "a partir de" já aconteceu e é o tipo de divergência que
 * ninguém vê, porque cada tela, sozinha, parece certa.
 */
import { q, q1 } from '../../utils/db'
import { disponivel } from '../../utils/estoque'
import { faceComDesconto, precificar, type ModoTaxa } from '../../utils/dinheiro'

/** Abaixo disto a vitrine avisa "últimas unidades" — faixa, nunca o número. */
export const LIMIAR_ULTIMAS = 10

/**
 * Lote que a vitrine ONLINE pode mostrar. Fragmento único, usado pelas duas
 * rotas públicas: lote só de bilheteria aparecendo na página é venda que o
 * comprador monta e o checkout recusa por canal.
 */
export const LOTE_DA_VITRINE = `l.visible AND 'online' = ANY(l.channels)`

export type SituacaoDoLote =
  | 'disponivel' | 'ultimas' | 'esgotado' | 'encerrado' | 'em_breve' | 'fechado'

/**
 * A linha do banco, com os nomes do banco. É de propósito: a conta de estoque
 * mora em `disponivel()` (utils/estoque.ts) e recebe a linha como ela veio, sem
 * uma cópia intermediária em português que possa envelhecer sozinha.
 */
export interface LoteParaSituacao {
  quantity: number
  sold: number
  reserved: number
  starts_at: string | Date | null
  expires_at: string | Date | null
  /**
   * Soma do que sobrou nas VARIAÇÕES do lote (inteira, meia...), ou `null`
   * quando o lote não tem variação nenhuma. Ver `restaNoLote`.
   */
  restaNasVariacoes?: number | null
}

export interface EventoParaVenda {
  status: string
  starts_at: string | Date
  sales_end_at: string | Date | null
  sales_end_minutes_after: number | null
}

/** Status em que o evento não é público — nem por link direto. */
const NAO_PUBLICADOS = new Set(['rascunho', 'oculto'])

/**
 * `is_private` NÃO entra aqui. Evento privado existe justamente pra abrir por
 * link direto (pré-venda fechada, evento corporativo); o que ele não faz é
 * aparecer em listagem — isso quem resolve é `eventos-publicos.get.ts`.
 */
export function estaPublicado(ev: { status: string }): boolean {
  return !NAO_PUBLICADOS.has(ev.status)
}

/**
 * Quando a venda fecha. O painel aceita data fixa OU "X minutos após o início"
 * — o CHECK do banco garante que só um dos dois está preenchido. Ler só o
 * `sales_end_at` deixa o evento vendendo depois de fechado, e é a mentira mais
 * cara da vitrine porque ela só aparece quando alguém já pagou.
 */
export function fimDasVendas(ev: EventoParaVenda): Date | null {
  if (ev.sales_end_at) return new Date(ev.sales_end_at)
  if (ev.sales_end_minutes_after != null) {
    return new Date(new Date(ev.starts_at).getTime() + Number(ev.sales_end_minutes_after) * 60_000)
  }
  return null
}

export function vendasAbertas(ev: EventoParaVenda, agora = new Date()): boolean {
  if (ev.status !== 'ativo') return false
  const fim = fimDasVendas(ev)
  return !fim || fim > agora
}

/** As duas únicas situações em que o botão "+" pode existir. */
export function compravel(s: SituacaoDoLote): boolean {
  return s === 'disponivel' || s === 'ultimas'
}

/**
 * Quanto o lote ainda vende DE VERDADE.
 *
 * A prateleira do lote (`quantity − sold − reserved`) é UM teto; a soma das
 * variações é outro, e vale o menor dos dois. Um lote com 40 lugares livres e
 * todas as variações esgotadas não vende nada, e olhar só a prateleira fazia
 * dois estragos ao mesmo tempo: o lote aparecia "disponível" sem uma única
 * linha comprável e, com giro ligado, ele continuava sendo o VIGENTE — o lote
 * seguinte ficava em "em breve" pra sempre, enquanto a home já dava o evento
 * por esgotado. Duas telas, duas respostas, as duas parecendo certas.
 *
 * `restaNasVariacoes` nulo = lote sem variação; aí a conta do lote é a conta
 * toda.
 */
export function restaNoLote(l: LoteParaSituacao): number {
  const naPrateleira = disponivel(l)
  if (l.restaNasVariacoes == null) return naPrateleira
  return Math.min(naPrateleira, Math.max(Number(l.restaNasVariacoes), 0))
}

/**
 * Soma, por lote, o que sobrou nas variações. Devolve o mapa que as duas rotas
 * penduram na linha do lote antes de decidir situação.
 */
export function restaDasVariacoes(
  tipos: Array<{ lot_id: string; quantity: number; sold: number }>,
): Map<string, number> {
  const porLote = new Map<string, number>()
  for (const t of tipos) {
    const sobra = Math.max(Number(t.quantity) - Number(t.sold), 0)
    porLote.set(t.lot_id, (porLote.get(t.lot_id) ?? 0) + sobra)
  }
  return porLote
}

/** Situação de UM lote, sem olhar os vizinhos do setor. */
function situacaoSozinho(
  l: LoteParaSituacao,
  ctx: { vendasAbertas: boolean; agora: Date },
): SituacaoDoLote {
  const resta = restaNoLote(l)
  // Esgotado e encerrado vêm antes de "vendas fechadas": são fatos do lote e
  // continuam verdadeiros depois que o evento fecha. O comprador que volta na
  // página merece saber que acabou, não só que fechou.
  if (resta <= 0) return 'esgotado'
  if (l.expires_at && new Date(l.expires_at) <= ctx.agora) return 'encerrado'
  if (!ctx.vendasAbertas) return 'fechado'
  if (l.starts_at && new Date(l.starts_at) > ctx.agora) return 'em_breve'
  return resta <= LIMIAR_ULTIMAS ? 'ultimas' : 'disponivel'
}

/**
 * Giro de lote: qual lote do setor está VIGENTE agora.
 *
 * Com `auto_rotate_lots` ligado, o setor vende UM lote por vez — o primeiro da
 * ordem que ainda tem estoque, já abriu e não venceu. Os anteriores ficam com
 * o que aconteceu com eles (esgotado/encerrado) e os seguintes viram
 * "em breve": é o que o produtor quer dizer com "1º lote / 2º lote", e sem
 * isso a página vende o 2º lote mais caro com o 1º ainda na prateleira.
 *
 * Desligado, cada lote responde por si e quem controla a abertura é a coluna
 * `visible` — que é o que se quer quando o 2º lote só pode abrir numa data
 * combinada com o patrocinador.
 *
 * Recebe os lotes JÁ na ordem de `sort_order` e devolve a situação de cada um
 * na mesma ordem.
 */
export function situacoesDoSetor(
  lotes: LoteParaSituacao[],
  ctx: { vendasAbertas: boolean; giroAutomatico: boolean; agora: Date },
): SituacaoDoLote[] {
  const sozinhos = lotes.map((l) => situacaoSozinho(l, ctx))
  if (!ctx.giroAutomatico) return sozinhos
  const vigente = sozinhos.findIndex(compravel)
  if (vigente < 0) return sozinhos
  return sozinhos.map((s, i) => (i > vigente && compravel(s) ? 'em_breve' : s))
}

export interface LotePrecificavel {
  id: string
  price_cents: number
  situacao: SituacaoDoLote
}
export interface TipoPrecificavel {
  lot_id: string
  discount_bps: number
  quantity: number
  sold: number
}

/**
 * O "a partir de" honesto: o menor total que alguém consegue PAGAR agora.
 *
 * Só entra lote comprável e tipo com estoque — anunciar o preço de um lote
 * esgotado é isca, e o comprador descobre na página seguinte. Também entra o
 * desconto do tipo (meia-entrada): sem ele a home dizia R$ 30,00 num evento
 * cuja meia sai por R$ 15,00.
 */
export function menorTotalCents(args: {
  lotes: LotePrecificavel[]
  tipos: TipoPrecificavel[]
  feeBps: number
  modo: ModoTaxa
}): number | null {
  let menor: number | null = null
  for (const l of args.lotes) {
    if (!compravel(l.situacao)) continue
    const tiposDoLote = args.tipos.filter((t) => t.lot_id === l.id)
    const faces = tiposDoLote.length
      ? tiposDoLote
          .filter((t) => Number(t.quantity) - Number(t.sold) > 0)
          .map((t) => faceComDesconto(Number(l.price_cents), Number(t.discount_bps)))
      : [Number(l.price_cents)]
    for (const face of faces) {
      const total = precificar(face, args.feeBps, args.modo).totalCents
      if (menor === null || total < menor) menor = total
    }
  }
  return menor
}

/** Por que a venda está fechada, em texto que o comprador entende. */
function avisoDeVendaFechada(ev: any, agora: Date): string | null {
  if (vendasAbertas(ev, agora)) return null
  if (ev.status === 'cancelado') return 'Este evento foi cancelado.'
  if (ev.status === 'adiado') return 'Este evento foi adiado. Aguarde a nova data.'
  if (ev.status === 'encerrado') return 'Este evento já aconteceu.'
  return 'As vendas deste evento já encerraram.'
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) throw createError({ statusCode: 400, statusMessage: 'Link de evento incompleto' })

  const ev = await q1<any>(
    `SELECT e.id, e.name, e.slug, e.description, e.status, e.starts_at, e.ends_at,
            e.sales_end_at, e.sales_end_minutes_after, e.hide_end_date, e.age_rating,
            e.ticket_noun, e.auto_rotate_lots,
            e.venue_name, e.address, e.address_number, e.neighborhood, e.city, e.state,
            e.is_online, e.banner_url, e.thumb_url,
            e.fee_bps, e.fee_mode_online,
            e.support_kind, e.support_value,
            o.name AS organizacao
       FROM events e JOIN organizations o ON o.id = e.org_id
      WHERE e.slug = $1`, [slug])

  // Rascunho e oculto não existem pro comprador — nem por link direto. O 404 é
  // o mesmo do slug inexistente de propósito: resposta diferente confirmaria
  // que o evento existe e está sendo preparado.
  if (!ev || !estaPublicado(ev)) {
    throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  }

  const agora = new Date()
  const abertas = vendasAbertas(ev, agora)
  const modo: ModoTaxa = ev.fee_mode_online
  const bps = Number(ev.fee_bps)

  const linhas = await q<any>(
    `SELECT s.id AS setor_id, s.name AS setor, s.kind, s.description AS setor_descricao,
            ses.id AS sessao_id, ses.title AS sessao, ses.starts_at AS sessao_inicio,
            l.id AS lote_id, l.name AS lote, l.description, l.price_cents,
            l.quantity, l.sold, l.reserved, l.expires_at, l.starts_at,
            l.min_per_order, l.max_per_order, l.sort_order AS lote_ordem
       FROM sectors s
       JOIN lots l ON l.sector_id = s.id AND ${LOTE_DA_VITRINE}
       LEFT JOIN event_sessions ses ON ses.id = s.session_id
      WHERE s.event_id = $1
      ORDER BY s.sort_order, l.sort_order`, [ev.id])

  const tipos = await q<any>(
    `SELECT tt.id, tt.lot_id, tt.name, tt.quantity, tt.sold, tt.discount_bps,
            tt.requires_document, tt.sort_order
       FROM ticket_types tt
       JOIN lots l ON l.id = tt.lot_id AND ${LOTE_DA_VITRINE}
       JOIN sectors s ON s.id = l.sector_id
      WHERE s.event_id = $1
      ORDER BY tt.sort_order`, [ev.id])

  // O teto das variações vai pendurado na linha ANTES de decidir situação: sem
  // ele o lote que só tem prateleira (e nenhuma variação pra vender) trava o
  // giro do setor. Ver `restaNoLote`.
  const restaPorLote = restaDasVariacoes(tipos)
  for (const l of linhas) l.restaNasVariacoes = restaPorLote.get(l.lote_id) ?? null

  // Agrupa primeiro: o giro de lote é uma decisão do SETOR, não da linha.
  const setores = new Map<string, { setor: any; linhas: any[] }>()
  for (const l of linhas) {
    if (!setores.has(l.setor_id)) setores.set(l.setor_id, { setor: l, linhas: [] })
    setores.get(l.setor_id)!.linhas.push(l)
  }

  const paraPreco: LotePrecificavel[] = []
  const saida = [...setores.values()].map(({ setor, linhas: doSetor }) => {
    const situacoes = situacoesDoSetor(doSetor, {
      vendasAbertas: abertas, giroAutomatico: ev.auto_rotate_lots, agora,
    })

    return {
      id: setor.setor_id,
      nome: setor.setor,
      descricao: setor.setor_descricao,
      tipo: setor.kind,
      sessao: setor.sessao
        ? { titulo: setor.sessao, inicio: setor.sessao_inicio }
        : null,
      lotes: doSetor.map((l, i) => {
        const situacao = situacoes[i]
        const resta = restaNoLote(l)
        const aberto = compravel(situacao)
        paraPreco.push({ id: l.lote_id, price_cents: Number(l.price_cents), situacao })

        // Teto de compra: nunca acima do que realmente dá pra vender. Lote
        // fora da prateleira vai a ZERO — o valor cheio que ficava aqui é o
        // que deixava a tela montar 6 ingressos de um lote esgotado.
        const maxDoLote = aberto ? Math.min(Number(l.max_per_order), resta) : 0

        const tiposDoLote = tipos.filter((t) => t.lot_id === l.lote_id)
        const variacoes = (tiposDoLote.length ? tiposDoLote : [null]).map((t: any) => {
          const face = t
            ? faceComDesconto(Number(l.price_cents), Number(t.discount_bps))
            : Number(l.price_cents)
          const p = precificar(face, bps, modo)
          // Estoque do tipo é um segundo teto: a meia acaba antes do lote, e
          // marcar só o lote fazia a meia esgotada continuar somável.
          const restaTipo = t ? Number(t.quantity) - Number(t.sold) : resta
          return {
            tipoId: t?.id ?? null,
            nome: t?.name ?? null,
            exigeDocumento: t?.requires_document ?? false,
            faceCents: p.faceCents,
            taxaCents: p.feeCents,
            totalCents: p.totalCents,
            esgotado: resta <= 0 || restaTipo <= 0,
            maxPorCompra: aberto ? Math.max(Math.min(maxDoLote, restaTipo), 0) : 0,
          }
        })

        return {
          id: l.lote_id,
          nome: l.lote,
          descricao: l.description,
          situacao,
          minPorCompra: Number(l.min_per_order),
          maxPorCompra: maxDoLote,
          // Data só quando ela quer dizer algo pro comprador: contagem
          // regressiva do que está à venda e aviso do que ainda vai abrir. Fora
          // disso é a agenda interna do produtor.
          expiraEm: aberto ? l.expires_at : null,
          abreEm: situacao === 'em_breve' ? l.starts_at : null,
          variacoes,
        }
      }),
    }
  })

  return {
    evento: {
      // O id fica: ele já é público em todo ingresso emitido (o QR é
      // `DT1:<evento>:<código>:<assinatura>`) e é por ele que a portaria
      // confere. O que sai daqui é identificador, não configuração.
      id: ev.id,
      nome: ev.name,
      slug: ev.slug,
      descricao: ev.description,
      vendasAbertas: abertas,
      avisoDeVenda: avisoDeVendaFechada(ev, agora),
      inicio: ev.starts_at,
      fim: ev.hide_end_date ? null : ev.ends_at,
      encerraVendas: fimDasVendas(ev),
      classificacao: ev.age_rating,
      substantivo: ev.ticket_noun,
      organizacao: ev.organizacao,
      // `stream_url` fica DE FORA: o link da transmissão é o produto: quem não
      // comprou não recebe o endereço da sala junto com a vitrine.
      local: ev.is_online
        ? { online: true }
        : {
            online: false, nome: ev.venue_name,
            endereco: [ev.address, ev.address_number, ev.neighborhood].filter(Boolean).join(', '),
            cidade: ev.city, estado: ev.state,
          },
      banner: ev.banner_url,
      thumb: ev.thumb_url,
      suporte: ev.support_value ? { tipo: ev.support_kind, valor: ev.support_value } : null,
      aPartirDeCents: menorTotalCents({ lotes: paraPreco, tipos, feeBps: bps, modo }),
    },
    setores: saida,
  }
})
