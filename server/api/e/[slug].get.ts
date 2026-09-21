/**
 * GET /api/e/:slug — o que a página de compra precisa saber.
 *
 * Devolve preço JÁ PRECIFICADO (o que o comprador paga), não a face. Mandar a
 * face pro navegador e deixar ele somar a taxa é como o total da tela passa a
 * divergir do total cobrado: duas implementações da mesma regra, uma delas
 * sempre desatualizada.
 *
 * Também não devolve estoque exato — só faixa. Número exato de ingresso
 * restante é informação que ajuda cambista e assusta comprador à toa.
 */
import { q, q1 } from '../../utils/db'
import { disponivel } from '../../utils/estoque'
import { faceComDesconto, precificar, type ModoTaxa } from '../../utils/dinheiro'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) throw createError({ statusCode: 400, statusMessage: 'slug ausente' })

  const ev = await q1<any>(
    `SELECT e.id, e.name, e.slug, e.description, e.status, e.starts_at, e.ends_at,
            e.sales_end_at, e.hide_end_date, e.age_rating, e.ticket_noun,
            e.venue_name, e.address, e.address_number, e.neighborhood, e.city, e.state,
            e.is_online, e.stream_url, e.banner_url, e.thumb_url,
            e.fee_bps, e.fee_mode_online, e.group_by_sector, e.max_per_customer,
            e.support_kind, e.support_value,
            o.name AS organizacao
       FROM events e JOIN organizations o ON o.id = e.org_id
      WHERE e.slug = $1 AND e.status <> 'rascunho'`, [slug])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const vendasAbertas = ev.status === 'ativo' &&
    (!ev.sales_end_at || new Date(ev.sales_end_at) > new Date())

  const linhas = await q<any>(
    `SELECT s.id AS setor_id, s.name AS setor, s.kind, s.sort_order AS setor_ordem,
            s.max_per_customer AS setor_max,
            ses.id AS sessao_id, ses.title AS sessao, ses.starts_at AS sessao_inicio,
            l.id AS lote_id, l.name AS lote, l.description, l.price_cents,
            l.quantity, l.sold, l.reserved, l.expires_at, l.starts_at AS lote_abre,
            l.min_per_order, l.max_per_order, l.visible, l.sort_order AS lote_ordem
       FROM sectors s
       JOIN lots l ON l.sector_id = s.id
       LEFT JOIN event_sessions ses ON ses.id = s.session_id
      WHERE s.event_id = $1
      ORDER BY s.sort_order, l.sort_order`, [ev.id])

  const tipos = await q<any>(
    `SELECT tt.id, tt.lot_id, tt.name, tt.quantity, tt.sold, tt.discount_bps,
            tt.requires_document, tt.max_per_customer, tt.sort_order
       FROM ticket_types tt
       JOIN lots l ON l.id = tt.lot_id
       JOIN sectors s ON s.id = l.sector_id
      WHERE s.event_id = $1
      ORDER BY tt.sort_order`, [ev.id])

  const modo: ModoTaxa = ev.fee_mode_online
  const bps = Number(ev.fee_bps)
  const agora = new Date()

  const setores = new Map<string, any>()
  let menorTotal: number | null = null

  for (const l of linhas) {
    if (!l.visible) continue
    const resta = disponivel(l)
    const venceu = l.expires_at && new Date(l.expires_at) <= agora
    const naoAbriu = l.lote_abre && new Date(l.lote_abre) > agora
    const esgotado = resta <= 0

    const tiposDoLote = tipos.filter((t) => t.lot_id === l.lote_id)
    const variacoes = (tiposDoLote.length ? tiposDoLote : [null]).map((t: any) => {
      const face = t ? faceComDesconto(Number(l.price_cents), Number(t.discount_bps))
                     : Number(l.price_cents)
      const p = precificar(face, bps, modo)
      if (!esgotado && !venceu && !naoAbriu && vendasAbertas) {
        if (menorTotal === null || p.totalCents < menorTotal) menorTotal = p.totalCents
      }
      return {
        tipoId: t?.id ?? null,
        nome: t?.name ?? null,
        exigeDocumento: t?.requires_document ?? false,
        faceCents: p.faceCents,
        taxaCents: p.feeCents,
        totalCents: p.totalCents,
        esgotado: t ? Number(t.quantity) - Number(t.sold) <= 0 : esgotado,
      }
    })

    if (!setores.has(l.setor_id)) {
      setores.set(l.setor_id, {
        id: l.setor_id, nome: l.setor, tipo: l.kind,
        sessao: l.sessao ? { id: l.sessao_id, titulo: l.sessao, inicio: l.sessao_inicio } : null,
        lotes: [],
      })
    }
    setores.get(l.setor_id).lotes.push({
      id: l.lote_id,
      nome: l.lote,
      descricao: l.description,
      minPorCompra: l.min_per_order,
      maxPorCompra: Math.min(l.max_per_order, resta > 0 ? resta : l.max_per_order),
      // faixa em vez de número exato
      situacao: !vendasAbertas ? 'fechado'
        : naoAbriu ? 'em_breve'
        : venceu ? 'encerrado'
        : esgotado ? 'esgotado'
        : resta <= 10 ? 'ultimas'
        : 'disponivel',
      expiraEm: l.expires_at,
      abreEm: l.lote_abre,
      variacoes,
    })
  }

  return {
    evento: {
      id: ev.id, nome: ev.name, slug: ev.slug, descricao: ev.description,
      status: ev.status, vendasAbertas,
      inicio: ev.starts_at, fim: ev.hide_end_date ? null : ev.ends_at,
      encerraVendas: ev.sales_end_at,
      classificacao: ev.age_rating,
      substantivo: ev.ticket_noun,
      organizacao: ev.organizacao,
      local: ev.is_online
        ? { online: true }
        : {
            online: false, nome: ev.venue_name,
            endereco: [ev.address, ev.address_number, ev.neighborhood].filter(Boolean).join(', '),
            cidade: ev.city, estado: ev.state,
          },
      banner: ev.banner_url, thumb: ev.thumb_url,
      suporte: ev.support_value ? { tipo: ev.support_kind, valor: ev.support_value } : null,
      maxPorCliente: ev.max_per_customer,
      aPartirDeCents: menorTotal,
      agruparPorSetor: ev.group_by_sector,
    },
    setores: [...setores.values()],
  }
})
