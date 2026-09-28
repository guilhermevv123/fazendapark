/**
 * A página do pedido (`GET /api/pedido/:id` e o PNG do QR) — o que o comprador
 * vê depois de pagar.
 *
 *  · B01: estorno PARCIAL não cancela ingresso nenhum (o valor devolvido não
 *    diz qual), então os ingressos continuam aparecendo, com QR — e o PNG não
 *    dá 404. Recortar por `status = 'pago'` sumia com eles.
 *  · B08: o link da fatura do cartão fica guardado no pedido, e a página do
 *    pedido oferece de qualquer aparelho.
 *
 * Fixture própria, apagada no fim. Sem servidor de dev no ar, PULA.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1, tx } from '../utils/db'
import { emitirIngressos } from '../utils/emissao'
import { reservar } from '../utils/estoque'
import { anunciarPulo, seForaDoArPula, sondarServidor, type Sonda } from '../../scripts/test-setup'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let orgId: string, eventId: string, lotId: string, customerId: string

async function pedido(qtd: number, extra: { forma?: string; fatura?: string } = {}) {
  const codigo = `PED-ZZPP-${randomUUID().slice(0, 4).toUpperCase()}`
  const o = (await q1<any>(
    `INSERT INTO orders (org_id, event_id, customer_id, code, status, channel,
                         face_cents, fee_cents, platform_cents, discount_cents, total_cents,
                         payment_method, asaas_payment_id, invoice_url, expires_at)
     VALUES ($1,$2,$3,$4,'aguardando_pagamento','online',$5,$6,$6,0,$7,$8,
             'sim_zzpp_' || gen_random_uuid(), $9, now() + interval '20 minutes')
     RETURNING id, code`,
    [orgId, eventId, customerId, codigo, 5000 * qtd, 500 * qtd, 5500 * qtd,
     extra.forma ?? 'pix', extra.fatura ?? null]))!
  await q(`INSERT INTO order_items (order_id, lot_id, quantity, unit_face_cents, unit_fee_cents,
                                    unit_total_cents) VALUES ($1,$2,$3,5000,500,5500)`,
    [o.id, lotId, qtd])
  await tx((c) => reservar(c, [{ lotId, quantidade: qtd }]))
  return o as { id: string; code: string }
}

beforeAll(async () => {
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug)
    VALUES ('ZZ Pedido Público', 'zz-pedido-publico-' || gen_random_uuid()) RETURNING id`))!.id
  eventId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps)
     VALUES ($1,'ZZ Pedido Público','zz-pedido-publico-' || gen_random_uuid(),'ativo',
             now() + interval '10 days', now() + interval '11 days', 1000) RETURNING id`,
    [orgId]))!.id
  const setor = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1,'Pista') RETURNING id`,
    [eventId]))!.id
  lotId = (await q1<any>(`INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order)
    VALUES ($1,'Lote',5000,100,20) RETURNING id`, [setor]))!.id
  customerId = (await q1<any>(`INSERT INTO customers (org_id, name, email, document)
    VALUES ($1,'Comprador Público','comprador.pedido.publico@teste.invalido','52998224725')
    RETURNING id`, [orgId]))!.id
  sonda = await sondarServidor('/api/eventos-publicos')
  anunciarPulo('server/api/pedido-publico.test.ts', sonda)
})

afterAll(async () => {
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

describe('B01 · estorno parcial não some com ingresso válido', () => {
  it('a página do pedido lista os ingressos com QR e diz quanto voltou', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const o = await pedido(3)
    expect((await emitirIngressos(o.id)).emitiu).toBe(true)
    // o que o webhook PAYMENT_PARTIALLY_REFUNDED grava: status e valor, nenhum ingresso cancelado
    await q(`UPDATE orders SET status = 'estornado_parcial', refunded_cents = 2000,
                    refunded_at = now() WHERE id = $1`, [o.id])

    const r = await fetch(`${BASE}/api/pedido/${o.code}`)
    expect(r.status).toBe(200)
    const v = await r.json()
    expect(v.status).toBe('estornado_parcial')
    expect(v.ingressos, 'o estorno de R$ 20 sumiu com os três ingressos que continuam valendo')
      .toHaveLength(3)
    for (const t of v.ingressos) {
      expect(t.status).toBe('valido')
      expect(t.qr).toMatch(/^DT[12]:/)
    }
    expect(v.estornadoCents).toBe(2000)

    const png = await fetch(`${BASE}/api/ingresso/${v.ingressos[0].id}/qr.png?pedido=${o.code}`)
    expect(png.status, 'o QR de ingresso válido deu 404 depois do estorno parcial').toBe(200)
    expect(png.headers.get('content-type')).toBe('image/png')
  })

  it('estorno TOTAL cancela: sem ingresso na lista e o PNG não abre', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const o = await pedido(1)
    await emitirIngressos(o.id)
    const t = await q1<any>(`SELECT id FROM tickets WHERE order_id = $1`, [o.id])
    await q(`UPDATE tickets SET status = 'cancelado', canceled_at = now() WHERE order_id = $1`, [o.id])
    await q(`UPDATE orders SET status = 'estornado', refunded_cents = total_cents,
                    refunded_at = now() WHERE id = $1`, [o.id])

    const v = await fetch(`${BASE}/api/pedido/${o.code}`).then((x) => x.json())
    expect(v.status).toBe('estornado')
    expect(v.ingressos).toEqual([])
    const png = await fetch(`${BASE}/api/ingresso/${t!.id}/qr.png?pedido=${o.code}`)
    expect([404, 410]).toContain(png.status)
  })
})

describe('B08 · cartão retomável de qualquer aparelho', () => {
  it('o pedido pendente no cartão devolve o link da fatura guardado no checkout', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const fatura = 'https://www.asaas.com/i/zzpp-fatura-de-teste'
    const o = await pedido(1, { forma: 'credito', fatura })
    const v = await fetch(`${BASE}/api/pedido/${o.code}`).then((x) => x.json())
    expect(v.status).toBe('aguardando_pagamento')
    expect(v.pagamento?.forma).toBe('credito')
    expect(v.pagamento?.linkFatura, 'quem fechou a aba do cartão não tem como pagar').toBe(fatura)
  })
})
