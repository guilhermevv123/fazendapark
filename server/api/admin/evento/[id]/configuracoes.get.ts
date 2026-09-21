/**
 * GET /api/admin/evento/:id/configuracoes — o cadastro inteiro do evento.
 *
 * Devolve junto o que a tela precisa pra DECIDIR o que travar: se já houve
 * venda, o endereço público não pode mais mudar. Mandar esse sinal daqui
 * evita que a tela descubra a trava só ao tomar 409 no salvar.
 */
import { q1 } from '../../../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const e = await q1<any>(
    `SELECT e.*,
            (SELECT count(*) FROM orders WHERE event_id = e.id AND status = 'pago')::int AS pedidos_pagos,
            (SELECT count(*) FROM tickets WHERE event_id = e.id AND status <> 'cancelado')::int AS ingressos,
            o.name AS organizacao
       FROM events e
       JOIN organizations o ON o.id = e.org_id
      WHERE e.id = $1`, [id])
  if (!e) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  return {
    id: e.id,
    organizacao: e.organizacao,
    nome: e.name, slug: e.slug, descricao: e.description, status: e.status,
    comecaEm: e.starts_at, terminaEm: e.ends_at,
    vendaAte: e.sales_end_at, vendaAteMinutos: e.sales_end_minutes_after,
    esconderFim: e.hide_end_date, classificacao: e.age_rating, substantivo: e.ticket_noun,
    fuso: e.timezone, moeda: e.currency,
    online: e.is_online, urlTransmissao: e.stream_url,
    local: e.venue_name, cep: e.zip_code, endereco: e.address, numero: e.address_number,
    bairro: e.neighborhood, cidade: e.city, uf: e.state, complemento: e.complement,
    lat: e.lat, lng: e.lng,
    banner: e.banner_url, thumb: e.thumb_url,
    categoria: e.category, subcategorias: e.subcategories, tags: e.tags,
    suporteTipo: e.support_kind, suporteValor: e.support_value,
    privado: e.is_private, minutosDeReserva: e.hold_minutes,
    agruparPorSetor: e.group_by_sector, giroAutomatico: e.auto_rotate_lots,
    taxaBps: e.fee_bps, modoTaxaOnline: e.fee_mode_online, modoTaxaPdv: e.fee_mode_pos,
    maxPorCliente: e.max_per_customer,
    criadoEm: e.created_at, atualizadoEm: e.updated_at,
    // o que a tela usa pra travar campo
    jaVendeu: e.pedidos_pagos > 0,
    pedidosPagos: e.pedidos_pagos,
    ingressos: e.ingressos,
  }
})
