/**
 * POST /api/admin/evento/:id/pdv/venda — venda no balcão.
 *
 * A diferença entre isto e o checkout online não é a tela, é QUANDO o
 * dinheiro existe. Online, o pedido nasce devendo e o gateway avisa depois
 * que pagou; no guichê o dinheiro já está na mão do operador quando ele
 * aperta o botão. Então aqui não existe reserva pendente nem espera: grava a
 * venda e emite o ingresso no MESMO commit.
 *
 * É por isso que `emitirNaTransacao` existe. Commitar a venda e emitir depois
 * abriria uma janela em que uma queda deixa o dinheiro na gaveta e o cliente
 * sem ingresso — e quem descobre é o operador, com a fila esperando.
 *
 * Duas regras de dinheiro que só valem aqui:
 *   - o preço é o de BALCÃO (`fee_mode_pos`), que não é o do site;
 *   - o preço NUNCA vem do navegador, igual ao checkout. O balcão manda quais
 *     lotes e quantos; todo valor é relido do banco.
 */
import { z } from 'zod'
import { q, q1, tx } from '../../../../../utils/db'
import { EstoqueInsuficiente, LoteIndisponivel, reservar } from '../../../../../utils/estoque'
import { faceComDesconto, somarPedido, type ModoTaxa } from '../../../../../utils/dinheiro'
import { gerarCodigo } from '../../../../../utils/ingresso'
import { emitirNaTransacao } from '../../../../../utils/emissao'
import { SQL_TRAVA_TURNO_ABERTO } from '../../../../../utils/caixa'
import { cpfValido } from '../../../../../utils/documento'

const Entrada = z.object({
  turnoId: z.string().uuid(),
  itens: z.array(z.object({
    lotId: z.string().uuid(),
    ticketTypeId: z.string().uuid().nullish(),
    quantidade: z.number().int().positive().max(50),
  })).min(1).max(20),
  forma: z.enum(['dinheiro', 'debito', 'credito', 'pix']),
  /** só em dinheiro: o que a pessoa entregou, pra calcular o troco */
  recebidoCents: z.number().int().min(0).max(100_000_00).nullish(),
  /** o balcão quase nunca pede dados; quando pede, é meia-entrada ou nominal */
  comprador: z.object({
    nome: z.string().min(3).max(120).nullish(),
    email: z.string().email().nullish(),
    documento: z.string().max(18).nullish(),
    telefone: z.string().max(20).nullish(),
  }).nullish(),
  cupom: z.string().max(40).nullish(),
  observacao: z.string().max(200).nullish(),
})

export default defineEventHandler(async (event) => {
  const eventId = getRouterParam(event, 'id')!
  const sessao = (event.context as any).sessao
  if (!sessao?.usuarioId) {
    throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })
  }
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data

  // --------------------------------------------------------------- evento
  const ev = await q1<any>(
    `SELECT id, org_id, name, slug, status, fee_bps, fee_mode_pos, sales_end_at
       FROM events WHERE id = $1`, [eventId])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  if (ev.status !== 'ativo') {
    throw createError({ statusCode: 409, statusMessage: 'As vendas deste evento não estão abertas' })
  }

  // ------------------------------------------------------- ponto e formas
  // O turno vem no CORPO: cerca própria, antes de qualquer escrita. Esta é a
  // mesma folga que um dia abriu o check-in entre produtoras.
  const turno = await q1<any>(
    `SELECT t.id, t.status, t.terminal_id, p.name AS ponto, p.payment_methods
       FROM pos_shifts t JOIN pos_terminals p ON p.id = t.terminal_id
      WHERE t.id = $1 AND t.event_id = $2`, [d.turnoId, eventId])
  if (!turno) throw createError({ statusCode: 404, statusMessage: 'Caixa não encontrado' })
  if (!turno.payment_methods.includes(d.forma)) {
    throw createError({
      statusCode: 422,
      statusMessage: `${turno.ponto} não aceita essa forma de pagamento.`,
    })
  }

  // ------------------------------------------- preços, relidos do banco --
  const lotIds = [...new Set(d.itens.map((i) => i.lotId))]
  const lotes = await q<any>(
    `SELECT l.id, l.name, l.price_cents, l.sector_id, s.event_id
       FROM lots l JOIN sectors s ON s.id = l.sector_id
      WHERE l.id = ANY($1::uuid[])`, [lotIds])
  const porLote = new Map(lotes.map((l) => [l.id, l]))
  for (const it of d.itens) {
    const l = porLote.get(it.lotId)
    if (!l) throw createError({ statusCode: 404, statusMessage: 'Lote não encontrado' })
    if (l.event_id !== ev.id) {
      throw createError({ statusCode: 400, statusMessage: 'Lote não pertence a este evento' })
    }
  }

  const tipoIds = d.itens.map((i) => i.ticketTypeId).filter(Boolean) as string[]
  const tipos = tipoIds.length
    ? await q<any>(`SELECT id, lot_id, name, discount_bps, requires_document
                      FROM ticket_types WHERE id = ANY($1::uuid[])`, [tipoIds])
    : []
  const porTipo = new Map(tipos.map((t) => [t.id, t]))

  const documento = d.comprador?.documento?.replace(/\D/g, '') || null

  const linhas = d.itens.map((it) => {
    const lote = porLote.get(it.lotId)!
    let face = Number(lote.price_cents)
    if (it.ticketTypeId) {
      const t = porTipo.get(it.ticketTypeId)
      if (!t) throw createError({ statusCode: 404, statusMessage: 'Tipo de ingresso não encontrado' })
      if (t.lot_id !== it.lotId) {
        throw createError({ statusCode: 400, statusMessage: 'Tipo de ingresso não é deste lote' })
      }
      // Meia-entrada sem documento na mão é meia-entrada que a portaria vai
      // ter que discutir com a pessoa no portão. O lugar de pedir é o guichê.
      if (t.requires_document && !documento) {
        throw createError({
          statusCode: 422,
          statusMessage: `${t.name} exige o documento do beneficiário. Peça o documento antes de vender.`,
        })
      }
      face = faceComDesconto(face, Number(t.discount_bps))
    }
    return { quantidade: it.quantidade, faceUnitCents: face }
  })

  if (documento && !cpfValido(documento)) {
    throw createError({ statusCode: 400, statusMessage: 'CPF inválido' })
  }

  // --------------------------------------------------------------- cupom
  let cupom: any = null
  if (d.cupom) {
    cupom = await q1<any>(
      `SELECT * FROM promo_codes
        WHERE event_id = $1 AND upper(code) = upper($2) AND active = true
          AND (starts_at IS NULL OR starts_at <= now())
          AND (ends_at   IS NULL OR ends_at   >= now())
          AND (max_uses  IS NULL OR uses < max_uses)`, [ev.id, d.cupom])
    if (!cupom) throw createError({ statusCode: 422, statusMessage: 'Cupom inválido ou expirado' })
    if (cupom.lot_ids?.length) {
      const vale = d.itens.every((i) => cupom.lot_ids.includes(i.lotId))
      if (!vale) throw createError({ statusCode: 422, statusMessage: 'Cupom não vale para estes ingressos' })
    }
  }

  // O modo do BALCÃO, não o do site.
  const modo: ModoTaxa = ev.fee_mode_pos
  const total = somarPedido(linhas, Number(ev.fee_bps), modo,
    cupom ? { kind: cupom.kind, value: Number(cupom.value) } : undefined)

  // ------------------------------------------------------------- o troco
  let trocoCents: number | null = null
  let recebidoCents: number | null = null
  if (d.forma === 'dinheiro') {
    recebidoCents = d.recebidoCents ?? total.totalCents
    if (recebidoCents < total.totalCents) {
      throw createError({
        statusCode: 422,
        statusMessage: 'O valor recebido é menor que o total da venda.',
      })
    }
    trocoCents = recebidoCents - total.totalCents
  }

  const codigo = gerarCodigo('PDV')

  // ------------------------ tudo num commit só: venda + estoque + ingresso
  const resultado = await tx(async (c) => {
    // A trava do caixa é a primeira coisa: pega o lock da linha do turno e só
    // devolve se ele estiver aberto. Fechamento concorrente espera aqui — ou
    // esta venda entra na contagem dele, ou esta venda é recusada. Nunca as
    // duas coisas.
    const aberto = await c.query(SQL_TRAVA_TURNO_ABERTO, [d.turnoId])
    if (aberto.rowCount !== 1) {
      throw createError({
        statusCode: 409,
        statusMessage: 'O caixa deste ponto está fechado. Abra um caixa antes de vender.',
      })
    }

    await reservar(c, d.itens.map((i) => ({
      lotId: i.lotId, ticketTypeId: i.ticketTypeId ?? null, quantidade: i.quantidade,
    })), { canal: 'bilheteria' })

    // Cliente é OPCIONAL no balcão. Quem compra no portão raramente dá
    // e-mail, e exigir um faria o operador inventar um — o que polui a base
    // de contatos com endereços que não existem.
    let customerId: string | null = null
    if (d.comprador?.email) {
      const cli = await c.query(
        `INSERT INTO customers (org_id, name, email, document, phone)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_id, email) DO UPDATE
           SET name = COALESCE(EXCLUDED.name, customers.name),
               document = COALESCE(EXCLUDED.document, customers.document),
               phone = COALESCE(EXCLUDED.phone, customers.phone)
         RETURNING id`,
        [ev.org_id, d.comprador.nome ?? 'Cliente do balcão',
         d.comprador.email.toLowerCase(), documento, d.comprador.telefone ?? null])
      customerId = cli.rows[0].id
    }

    const ord = await c.query(
      `INSERT INTO orders (org_id, event_id, customer_id, code, status, channel,
                           face_cents, fee_cents, platform_cents, discount_cents, total_cents,
                           payment_method, installments, promo_code_id,
                           pos_terminal_id, pos_shift_id, sold_by,
                           cash_received_cents, change_cents)
       VALUES ($1,$2,$3,$4,'aguardando_pagamento','bilheteria',
               $5,$6,$7,$8,$9,$10,1,$11,$12,$13,$14,$15,$16)
       RETURNING id, code`,
      [ev.org_id, ev.id, customerId, codigo,
       total.faceCents, total.feeCents, total.platformCents, total.discountCents, total.totalCents,
       d.forma, cupom?.id ?? null, turno.terminal_id, d.turnoId, sessao.usuarioId,
       recebidoCents, trocoCents])

    for (let i = 0; i < d.itens.length; i++) {
      const it = d.itens[i]
      const l = total.linhas[i]
      await c.query(
        `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity,
                                  unit_face_cents, unit_fee_cents, unit_total_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [ord.rows[0].id, it.lotId, it.ticketTypeId ?? null, it.quantidade,
         l.faceCents, l.feeCents, l.totalCents])
    }

    if (cupom) await c.query(`UPDATE promo_codes SET uses = uses + 1 WHERE id = $1`, [cupom.id])

    // Emite AQUI dentro. O pedido nasceu 'aguardando_pagamento' só pra passar
    // pela mesma porta de sempre; um instante depois já é 'pago'.
    const emissao = await emitirNaTransacao(c, ord.rows[0].id)
    if (!emissao.emitiu) {
      // Não devia acontecer: acabamos de criar o pedido. Se acontecer, o
      // rollback desfaz a venda inteira, e é melhor assim — dinheiro sem
      // ingresso é pior que venda que não saiu.
      throw createError({
        statusCode: 500,
        statusMessage: `Não foi possível emitir os ingressos (${emissao.motivo ?? 'motivo desconhecido'}).`,
      })
    }

    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'order',$2,'venda_balcao',$3::jsonb)`,
      [ev.org_id, ord.rows[0].id, JSON.stringify({
        ponto: turno.ponto, forma: d.forma, totalCents: total.totalCents,
        trocoCents, por: sessao.nome, observacao: d.observacao ?? null,
      })])

    const { rows: emitidos } = await c.query(
      `SELECT t.id, t.code, l.name AS lote, s.name AS setor, tt.name AS tipo
         FROM tickets t
         JOIN lots l ON l.id = t.lot_id
         JOIN sectors s ON s.id = t.sector_id
         LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
        WHERE t.order_id = $1
        ORDER BY s.sort_order, l.name`, [ord.rows[0].id])

    return { orderId: ord.rows[0].id, code: ord.rows[0].code, ingressos: emitidos }
  }).catch((e) => {
    if (e instanceof EstoqueInsuficiente) {
      throw createError({ statusCode: 409, statusMessage: e.message,
        data: { tipo: 'estoque', disponivel: e.disponivel } })
    }
    if (e instanceof LoteIndisponivel) {
      throw createError({ statusCode: 409, statusMessage: e.message, data: { tipo: 'lote' } })
    }
    throw e
  })

  return {
    ok: true,
    pedido: resultado.code,
    pedidoId: resultado.orderId,
    ponto: turno.ponto,
    forma: d.forma,
    totalCents: total.totalCents,
    faceCents: total.faceCents,
    taxaCents: total.feeCents,
    descontoCents: total.discountCents,
    recebidoCents,
    trocoCents,
    ingressos: resultado.ingressos.map((t: any) => ({
      id: t.id, codigo: t.code, lote: t.lote, setor: t.setor, tipo: t.tipo,
    })),
  }
})
