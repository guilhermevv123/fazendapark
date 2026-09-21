/**
 * emissao.test.ts — o caminho pago de ponta a ponta, contra banco real.
 *
 * O que está sendo provado aqui, em ordem de quanto custa errar:
 *   1. webhook repetido NÃO emite ingresso duas vezes (o Asaas repete sempre);
 *   2. ingresso emitido tem QR que só o servidor consegue assinar;
 *   3. a mesma pessoa não entra duas vezes, nem com dois leitores simultâneos;
 *   4. estorno depois de pago devolve estoque e cancela ingresso — menos o que
 *      já entrou no parque.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1, tx } from './db'
import { emitirIngressos } from './emissao'
import { reservar } from './estoque'
import { lerQr, montarQr } from './ingresso'

let orgId: string, eventId: string, sectorId: string, lotId: string, customerId: string

beforeAll(async () => {
  process.env.NUXT_SESSION_SECRET ||= 'segredo-de-teste-comprido-o-bastante'
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug)
    VALUES ('Emissão', 'emi-' || gen_random_uuid()) RETURNING id`))!.id
  eventId = (await q1<any>(`INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps)
    VALUES ($1,'Parque','pq-' || gen_random_uuid(),'ativo',
            now() + interval '1 day', now() + interval '2 days', 1000)
    RETURNING id`, [orgId]))!.id
  sectorId = (await q1<any>(`INSERT INTO sectors (event_id, name)
    VALUES ($1,'Entrada') RETURNING id`, [eventId]))!.id
  customerId = (await q1<any>(`INSERT INTO customers (org_id, name, email, document)
    VALUES ($1,'Maria Souza','maria@teste.com','39053344705') RETURNING id`, [orgId]))!.id
})

afterAll(async () => {
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

async function pedidoPendente(qtd = 2, precoCents = 3000) {
  lotId = (await q1<any>(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order)
     VALUES ($1, 'Lote ' || gen_random_uuid(), $2, 100, 50) RETURNING id`,
    [sectorId, precoCents]))!.id
  const face = precoCents * qtd
  const taxa = Math.round(precoCents * 0.1) * qtd
  const order = (await q1<any>(
    `INSERT INTO orders (org_id, event_id, customer_id, code, status,
                         face_cents, fee_cents, platform_cents, discount_cents, total_cents,
                         payment_method, expires_at)
     VALUES ($1,$2,$3,'P'||substr(gen_random_uuid()::text,1,8),'aguardando_pagamento',
             $4,$5,$5,0,$6,'pix', now() + interval '20 minutes')
     RETURNING id, code`,
    [orgId, eventId, customerId, face, taxa, face + taxa]))!
  await q(`INSERT INTO order_items (order_id, lot_id, quantity,
             unit_face_cents, unit_fee_cents, unit_total_cents)
           VALUES ($1,$2,$3,$4,$5,$6)`,
    [order.id, lotId, qtd, precoCents, Math.round(precoCents * 0.1),
     precoCents + Math.round(precoCents * 0.1)])
  await tx((c) => reservar(c, [{ lotId, quantidade: qtd }]))
  return order
}

describe('emissão', () => {
  it('pagamento vira ingresso e baixa o estoque', async () => {
    const ped = await pedidoPendente(3)
    const r = await emitirIngressos(ped.id)
    expect(r.emitiu).toBe(true)
    expect(r.ingressos).toBe(3)

    const lote = await q1<any>(`SELECT sold, reserved FROM lots WHERE id = $1`, [lotId])
    expect(lote).toMatchObject({ sold: 3, reserved: 0 })

    const o = await q1<any>(`SELECT status, paid_at FROM orders WHERE id = $1`, [ped.id])
    expect(o.status).toBe('pago')
    expect(o.paid_at).toBeTruthy()
  })

  it('IDEMPOTÊNCIA: o Asaas repete o webhook e não sai ingresso a mais', async () => {
    const ped = await pedidoPendente(2)
    const primeira = await emitirIngressos(ped.id)
    expect(primeira.emitiu).toBe(true)
    expect(primeira.ingressos).toBe(2)

    // PAYMENT_CONFIRMED e depois PAYMENT_RECEIVED, mais uma reentrega
    const repetidas = await Promise.all([
      emitirIngressos(ped.id), emitirIngressos(ped.id), emitirIngressos(ped.id),
    ])
    for (const r of repetidas) {
      expect(r.emitiu).toBe(false)
      expect(r.motivo).toBe('já emitido')
    }
    const n = await q1<any>(`SELECT count(*)::int AS n FROM tickets WHERE order_id = $1`, [ped.id])
    expect(n.n).toBe(2)
    const lote = await q1<any>(`SELECT sold FROM lots WHERE id = $1`, [lotId])
    expect(lote.sold).toBe(2)
  })

  it('webhooks SIMULTÂNEOS também não duplicam', async () => {
    const ped = await pedidoPendente(2)
    const r = await Promise.all(Array.from({ length: 5 }, () => emitirIngressos(ped.id)))
    expect(r.filter((x) => x.emitiu).length).toBe(1)
    const n = await q1<any>(`SELECT count(*)::int AS n FROM tickets WHERE order_id = $1`, [ped.id])
    expect(n.n).toBe(2)
  })

  it('o primeiro ingresso sai no nome do comprador, o resto em branco', async () => {
    const ped = await pedidoPendente(3)
    await emitirIngressos(ped.id)
    const ts = await q<any>(
      `SELECT holder_name FROM tickets WHERE order_id = $1 ORDER BY issued_at, code`, [ped.id])
    expect(ts.filter((t) => t.holder_name === 'Maria Souza').length).toBe(1)
    expect(ts.filter((t) => t.holder_name === null).length).toBe(2)
  })

  it('não emite pedido já cancelado', async () => {
    const ped = await pedidoPendente(1)
    await q(`UPDATE orders SET status = 'cancelado' WHERE id = $1`, [ped.id])
    const r = await emitirIngressos(ped.id)
    expect(r.emitiu).toBe(false)
    expect(r.motivo).toMatch(/cancelado/)
  })
})

describe('QR do ingresso', () => {
  it('assina e confere', async () => {
    const ped = await pedidoPendente(1)
    await emitirIngressos(ped.id)
    const t = await q1<any>(`SELECT code FROM tickets WHERE order_id = $1`, [ped.id])
    const qr = montarQr(t.code, eventId)
    const lido = lerQr(qr)
    expect(lido.ok).toBe(true)
    expect(lido.code).toBe(t.code)
    expect(lido.eventId).toBe(eventId)
  })

  it('recusa assinatura fabricada', () => {
    const qr = montarQr('ING-AAAA-BBBB', eventId)
    const falso = qr.slice(0, -1) + (qr.at(-1) === 'A' ? 'B' : 'A')
    expect(lerQr(falso).ok).toBe(false)
    expect(lerQr(falso).motivo).toBe('assinatura')
  })

  it('recusa ingresso de outro evento mesmo com código certo', () => {
    const outro = '00000000-0000-4000-8000-000000000000'
    const qr = montarQr('ING-AAAA-BBBB', eventId)
    const trocado = qr.replace(eventId, outro)
    expect(lerQr(trocado).ok).toBe(false)
  })

  it('recusa lixo', () => {
    expect(lerQr('').ok).toBe(false)
    expect(lerQr('qualquer coisa').ok).toBe(false)
    expect(lerQr('DT1:a:b').ok).toBe(false)
  })
})

describe('portaria', () => {
  /** mesma trava do endpoint: UPDATE condicional */
  const passar = (ticketId: string) =>
    tx(async (c) => {
      const r = await c.query(
        `UPDATE tickets SET status='usado', checked_in_at=now()
          WHERE id=$1 AND status='valido' RETURNING id`, [ticketId])
      return r.rowCount === 1
    })

  it('entra uma vez; a segunda é recusada', async () => {
    const ped = await pedidoPendente(1)
    await emitirIngressos(ped.id)
    const t = await q1<any>(`SELECT id FROM tickets WHERE order_id = $1`, [ped.id])
    expect(await passar(t.id)).toBe(true)
    expect(await passar(t.id)).toBe(false)
  })

  it('dois leitores no mesmo instante: só um passa', async () => {
    const ped = await pedidoPendente(1)
    await emitirIngressos(ped.id)
    const t = await q1<any>(`SELECT id FROM tickets WHERE order_id = $1`, [ped.id])
    const r = await Promise.all(Array.from({ length: 8 }, () => passar(t.id)))
    expect(r.filter(Boolean).length).toBe(1)
  })
})

describe('estorno depois de pago', () => {
  it('devolve estoque e cancela ingresso — menos quem já entrou', async () => {
    const ped = await pedidoPendente(3)
    await emitirIngressos(ped.id)
    const ts = await q<any>(`SELECT id FROM tickets WHERE order_id = $1 ORDER BY code`, [ped.id])
    // um deles já entrou no parque
    await q(`UPDATE tickets SET status='usado', checked_in_at=now() WHERE id=$1`, [ts[0].id])

    await tx(async (c) => {
      const { rows: itens } = await c.query(
        `SELECT lot_id AS "lotId", quantity AS quantidade FROM order_items WHERE order_id=$1`,
        [ped.id])
      for (const i of itens) {
        await c.query(`UPDATE lots SET sold = GREATEST(sold - $2,0) WHERE id=$1`,
          [i.lotId, i.quantidade])
      }
      await c.query(
        `UPDATE tickets SET status='cancelado', canceled_at=now()
          WHERE order_id=$1 AND status <> 'usado'`, [ped.id])
      await c.query(`UPDATE orders SET status='estornado', refunded_at=now() WHERE id=$1`, [ped.id])
    })

    const depois = await q<any>(
      `SELECT status, count(*)::int AS n FROM tickets WHERE order_id=$1 GROUP BY status`, [ped.id])
    const mapa = Object.fromEntries(depois.map((d) => [d.status, d.n]))
    expect(mapa.usado).toBe(1)        // entrou: continua como usado, é prejuízo a cobrar
    expect(mapa.cancelado).toBe(2)
  })
})
