/**
 * GET /api/admin/evento/:id/vendas — a lista de pedidos.
 *
 * Duas escolhas que mudam o que a tela consegue responder:
 *
 * 1. **A busca entra pelo documento e pelo telefone, não só pelo nome.** Na
 *    portaria a pergunta real é "comprei com o CPF tal e não achei o e-mail";
 *    procurar por nome não resolve porque metade digita o nome errado.
 *    O CPF é comparado só por dígito, porque o comprador digita com ponto e
 *    a portaria digita sem.
 *
 * 2. **Os totais da barra vêm da MESMA consulta que a lista, com o mesmo
 *    filtro.** Somar o período inteiro enquanto a lista mostra um filtro faz
 *    o rodapé contradizer o que está na tela — e quem está olhando acredita
 *    no número grande.
 */
import { q, q1 } from '../../../../utils/db'

const POR_PAGINA = 50

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const {
    busca = '', situacao = '', canal = '', forma = '', pagina = '1',
  } = getQuery(event) as Record<string, string>

  const ev = await q1<any>(`SELECT id, name FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const cond: string[] = ['o.event_id = $1']
  const par: any[] = [id]

  if (situacao) { par.push(situacao); cond.push(`o.status = $${par.length}`) }
  if (canal)    { par.push(canal);    cond.push(`o.channel = $${par.length}`) }
  if (forma)    { par.push(forma);    cond.push(`o.payment_method = $${par.length}`) }

  const termo = busca.trim()
  if (termo) {
    const digitos = termo.replace(/\D/g, '')
    par.push(`%${termo}%`)
    const like = `$${par.length}`
    // `regexp_replace(...,'\D','','g')` no documento: o banco guarda como veio,
    // e comparar texto formatado com texto sem formatação nunca acha nada.
    if (digitos.length >= 3) {
      par.push(`%${digitos}%`)
      const dig = `$${par.length}`
      cond.push(`(o.code ILIKE ${like} OR c.name ILIKE ${like} OR c.email ILIKE ${like}
                  OR regexp_replace(COALESCE(c.document,''), '\\D', '', 'g') LIKE ${dig}
                  OR regexp_replace(COALESCE(c.phone,''),    '\\D', '', 'g') LIKE ${dig})`)
    } else {
      cond.push(`(o.code ILIKE ${like} OR c.name ILIKE ${like} OR c.email ILIKE ${like})`)
    }
  }

  const onde = cond.join(' AND ')
  const p = Math.max(1, Number(pagina) || 1)

  const linhas = await q<any>(
    `SELECT o.id, o.code, o.status, o.channel, o.payment_method, o.installments,
            o.face_cents, o.fee_cents, o.discount_cents, o.total_cents,
            o.refunded_cents, o.created_at, o.paid_at, o.canceled_at, o.expires_at,
            c.name AS cliente, c.email, c.document, c.phone,
            COALESCE((SELECT SUM(quantity) FROM order_items WHERE order_id = o.id),0)::int AS itens,
            COALESCE((SELECT count(*) FROM tickets WHERE order_id = o.id
                        AND checked_in_at IS NOT NULL),0)::int AS entraram
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE ${onde}
      ORDER BY o.created_at DESC
      LIMIT ${POR_PAGINA} OFFSET ${(p - 1) * POR_PAGINA}`, par)

  // Mesmos filtros, sem paginação: o rodapé fala do que está filtrado.
  const somas = await q1<any>(
    `SELECT count(*)::int AS pedidos,
            COALESCE(SUM(o.total_cents) FILTER (WHERE o.status = 'pago'),0)::bigint AS pago,
            COALESCE(SUM(o.total_cents) FILTER (WHERE o.status = 'aguardando_pagamento'),0)::bigint AS pendente,
            COALESCE(SUM(o.refunded_cents),0)::bigint AS estornado,
            COALESCE(SUM((SELECT SUM(quantity) FROM order_items WHERE order_id = o.id))
                       FILTER (WHERE o.status = 'pago'),0)::int AS ingressos_pagos
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE ${onde}`, par)

  return {
    evento: { id: ev.id, nome: ev.name },
    pagina: p,
    porPagina: POR_PAGINA,
    total: Number(somas.pedidos),
    totais: {
      pedidos: Number(somas.pedidos),
      pagoCents: Number(somas.pago),
      pendenteCents: Number(somas.pendente),
      estornadoCents: Number(somas.estornado),
      ingressosPagos: Number(somas.ingressos_pagos),
    },
    pedidos: linhas.map((l) => ({
      id: l.id, codigo: l.code, situacao: l.status, canal: l.channel,
      forma: l.payment_method, parcelas: l.installments,
      faceCents: Number(l.face_cents), taxaCents: Number(l.fee_cents),
      descontoCents: Number(l.discount_cents), totalCents: Number(l.total_cents),
      estornadoCents: Number(l.refunded_cents),
      criadoEm: l.created_at, pagoEm: l.paid_at,
      canceladoEm: l.canceled_at, expiraEm: l.expires_at,
      cliente: l.cliente, email: l.email, documento: l.document, telefone: l.phone,
      itens: l.itens, entraram: l.entraram,
    })),
  }
})
