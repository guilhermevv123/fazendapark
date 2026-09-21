/**
 * POST /api/admin/evento/:id/cortesias — emite cortesia.
 *
 * Cortesia É venda, com preço zero. Ela precisa **baixar estoque igual**, ou o
 * lote vende 100 e a portaria recebe 130. Foi por isso que ela não passa pelo
 * `reservar()` comum e sim por uma reserva escrita aqui: a porta de venda de
 * lá exige evento 'ativo' e canal liberado, e cortesia se emite com o evento
 * ainda em rascunho e por fora de qualquer canal.
 *
 * O que NÃO se afrouxa é o estoque: o UPDATE condicional é o mesmo, com a
 * mesma condição `sold + reserved + n <= quantity` e o mesmo CHECK do schema
 * por trás. Cortesia que fura o teto do lote é entrada a mais no parque.
 */
import { z } from 'zod'
import { tx } from '../../../../utils/db'
import { gerarCodigo } from '../../../../utils/ingresso'

const Pessoa = z.object({
  nome: z.string().min(2).max(120),
  email: z.string().email().max(160).nullish(),
  documento: z.string().max(20).nullish(),
})

const Entrada = z.object({
  loteId: z.string().uuid(),
  tipoId: z.string().uuid().nullish(),
  motivo: z.string().max(200).nullish(),
  /** Uma linha por cortesia: quem recebe. Nome em branco não passa. */
  pessoas: z.array(Pessoa).min(1).max(200),
})

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data
  const n = d.pessoas.length
  // A sessão é plana (nome/email/papel/orgId), não `{ usuario: {...} }` — o
  // middleware grava o que `lerSessao` devolve.
  const usuario = (event.context as any).sessao

  return await tx(async (c) => {
    const { rows: lotes } = await c.query(
      `SELECT l.id, l.name, l.quantity, l.sold, l.reserved, l.price_cents,
              s.id AS sector_id, s.session_id, e.id AS event_id, e.org_id, e.slug
         FROM lots l
         JOIN sectors s ON s.id = l.sector_id
         JOIN events  e ON e.id = s.event_id
        WHERE l.id = $1 AND e.id = $2
        FOR UPDATE OF l`, [d.loteId, eventoId])
    const lote = lotes[0]
    if (!lote) throw createError({ statusCode: 404, statusMessage: 'Lote não é deste evento' })

    const disponivel = lote.quantity - lote.sold - lote.reserved
    if (n > disponivel) {
      throw createError({
        statusCode: 409,
        statusMessage: `"${lote.name}" tem ${disponivel} disponível(is) e você pediu ${n} cortesia(s).`,
      })
    }

    if (d.tipoId) {
      const { rows } = await c.query(
        `SELECT id FROM ticket_types WHERE id = $1 AND lot_id = $2`, [d.tipoId, d.loteId])
      if (!rows[0]) throw createError({ statusCode: 422, statusMessage: 'Tipo não é deste lote' })
    }

    // Baixa direto em `sold`: cortesia não tem pagamento pendente pra esperar,
    // então não existe estado de reserva — ela já nasce vendida.
    const upd = await c.query(
      `UPDATE lots SET sold = sold + $2
        WHERE id = $1 AND sold + reserved + $2 <= quantity RETURNING id`,
      [d.loteId, n])
    if (upd.rowCount !== 1) {
      throw createError({ statusCode: 409, statusMessage: 'O estoque acabou de mudar. Tente de novo.' })
    }
    if (d.tipoId) {
      const t = await c.query(
        `UPDATE ticket_types SET sold = sold + $2
          WHERE id = $1 AND sold + $2 <= quantity RETURNING id`, [d.tipoId, n])
      if (t.rowCount !== 1) {
        throw createError({ statusCode: 409, statusMessage: 'O tipo escolhido não tem essa quantidade' })
      }
    }

    // O pedido existe pra cortesia ter dono, data e rastro no mesmo lugar que
    // a venda. Sem ele, a cortesia seria um ingresso solto sem quem emitiu.
    const { rows: pedidos } = await c.query(
      `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method,
                           face_cents, fee_cents, platform_cents, discount_cents,
                           total_cents, paid_at)
       VALUES ($1,$2,$3,'pago','cortesia','cortesia',0,0,0,0,0,now())
       RETURNING id, code`,
      [lote.org_id, eventoId, `CRT-${gerarCodigo('X').slice(2)}`])
    const pedido = pedidos[0]

    const { rows: itens } = await c.query(
      `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity,
                                unit_face_cents, unit_fee_cents, unit_total_cents)
       VALUES ($1,$2,$3,$4,0,0,0) RETURNING id`,
      [pedido.id, d.loteId, d.tipoId ?? null, n])

    const prefixo = String(lote.slug || 'ING').replace(/[^a-zA-Z]/g, '').slice(0, 3) || 'ING'
    const codigos: string[] = []
    for (const pessoa of d.pessoas) {
      const code = gerarCodigo(prefixo)
      await c.query(
        `INSERT INTO tickets (org_id, event_id, session_id, order_id, order_item_id,
                              sector_id, lot_id, ticket_type_id, code, qr_secret,
                              status, is_courtesy, holder_name, holder_email, holder_document)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,encode(gen_random_bytes(16),'hex'),
                 'valido',true,$10,$11,$12)`,
        [lote.org_id, eventoId, lote.session_id, pedido.id, itens[0].id,
         lote.sector_id, d.loteId, d.tipoId ?? null, code,
         pessoa.nome.trim(), pessoa.email ?? null, pessoa.documento ?? null])
      codigos.push(code)
    }

    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'order',$2,'cortesia',$3::jsonb)`,
      [lote.org_id, pedido.id, JSON.stringify({
        quantidade: n, lote: lote.name, motivo: d.motivo ?? null,
        emitidoPor: usuario?.email ?? null,
      })])

    return { ok: true, pedido: pedido.code, quantidade: n, codigos }
  })
})
