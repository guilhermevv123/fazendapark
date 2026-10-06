/**
 * Preço próprio do tipo de ingresso (043; dono, 05/10: "o 1º lote com Normal, VIP e Black, cada
 * um com preço diferente").
 *
 * O que não pode acontecer: a vitrine mostrar um preço e o checkout cobrar outro, ou o VIP sair
 * pelo preço do lote. Pergunta-se às DUAS rotas de verdade, com um lote de R$ 50 e três tipos:
 * Normal (o lote), VIP (R$ 120, preço próprio) e Meia (50% de desconto, com documento).
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { faceDoTipo, precificar } from '../utils/dinheiro'
import { db, q, q1 } from '../utils/db'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const SLUG = `zz-preco-tipo-${randomUUID().slice(0, 8)}`
let orgId: string, lotId: string, normal: string, vip: string, meia: string
let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }

function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

describe('faceDoTipo com preço próprio', () => {
  it('preço próprio é a face, acima ou abaixo do lote; sem ele, vale o desconto', () => {
    expect(faceDoTipo(5000, 0, 1000, 'repassar', 12000)).toBe(12000)
    expect(faceDoTipo(5000, 0, 1000, 'absorver', 2000)).toBe(2000)
    expect(faceDoTipo(5000, 0, 1000, 'repassar', null)).toBe(5000)
    expect(faceDoTipo(5000, 5000, 0, 'repassar')).toBe(2500)
    // com preço próprio, o desconto (que o servidor grava 0) não mexe em nada
    expect(faceDoTipo(5000, 5000, 1000, 'repassar', 12000)).toBe(12000)
  })
})

beforeAll(async () => {
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug) VALUES ('ZZ Preço do Tipo', $1) RETURNING id`,
    [`zz-preco-tipo-${randomUUID().slice(0, 8)}`]))!.id
  const ev = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online)
     VALUES ($1, 'ZZ Preço do Tipo', $2, 'ativo', now() + interval '10 days', now() + interval '11 days', 1000, 'repassar')
     RETURNING id`, [orgId, SLUG]))!.id
  const setor = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1, 'Geral') RETURNING id`, [ev]))!.id
  lotId = (await q1<any>(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
     VALUES ($1, '1º lote', 5000, 100, 10, '{online}') RETURNING id`, [setor]))!.id
  normal = (await q1<any>(`INSERT INTO ticket_types (lot_id, name, quantity, discount_bps, sort_order)
    VALUES ($1, 'Normal', 100, 0, 1) RETURNING id`, [lotId]))!.id
  vip = (await q1<any>(`INSERT INTO ticket_types (lot_id, name, quantity, discount_bps, price_cents, sort_order)
    VALUES ($1, 'VIP', 100, 0, 12000, 2) RETURNING id`, [lotId]))!.id
  meia = (await q1<any>(`INSERT INTO ticket_types (lot_id, name, quantity, discount_bps, requires_document, sort_order)
    VALUES ($1, 'Meia-entrada', 100, 5000, true, 3) RETURNING id`, [lotId]))!.id
  sonda = await sondarServidor('/api/eventos-publicos')
  anunciarPulo('server/api/preco-do-tipo.test.ts', sonda)
})

afterAll(async () => {
  await q(`DELETE FROM orders WHERE org_id = $1`, [orgId]).catch(() => {})
  await q(`DELETE FROM customers WHERE org_id = $1`, [orgId]).catch(() => {})
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId]).catch(() => {})
  await db().end()
})

describe('vitrine e checkout com preço próprio', () => {
  it('a vitrine mostra o VIP pelo preço dele, e o "a partir de" segue o menor', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const v = await (await fetch(`${BASE}/api/e/${SLUG}`)).json() as any
    const lote = v.setores.flatMap((s: any) => s.lotes).find((l: any) => l.id === lotId)
    const porTipo = Object.fromEntries(lote.variacoes.map((x: any) => [x.nome, x]))
    expect(porTipo.Normal.totalCents).toBe(precificar(5000, 1000, 'repassar').totalCents)
    expect(porTipo.VIP.totalCents).toBe(precificar(12000, 1000, 'repassar').totalCents)
    expect(porTipo.VIP.faceCents).toBe(12000)
    expect(porTipo['Meia-entrada'].totalCents).toBeLessThan(porTipo.Normal.totalCents)
  })

  it('o checkout cobra do VIP exatamente o que a vitrine mostrou', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE}/api/checkout`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventSlug: SLUG, forma: 'pix',
        comprador: { nome: 'Comprador VIP', email: `vip.${Date.now()}@exemplo.com`, documento: cpf(), telefone: '73998260963' },
        itens: [{ lotId, ticketTypeId: vip, quantidade: 2 }],
      }),
    })
    const corpo: any = await r.json().catch(() => ({}))
    expect(r.status, JSON.stringify(corpo)).toBe(200)
    const o = await q1<any>(`SELECT o.total_cents, oi.unit_face_cents FROM orders o
      JOIN order_items oi ON oi.order_id = o.id WHERE o.code = $1`, [corpo.pedido])
    expect(Number(o.unit_face_cents)).toBe(12000)
    expect(Number(o.total_cents)).toBe(2 * precificar(12000, 1000, 'repassar').totalCents)
    void normal; void meia
  })
})
