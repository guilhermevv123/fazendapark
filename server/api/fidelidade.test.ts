/**
 * fidelidade.test.ts — o "Volte Mais" (037) pela HTTP: prévia, checkout, conta e pedido.
 *
 * O que cada caso trava:
 *   · sem 1ª visita (entrada na portaria com ingresso inteiro) não há desconto — a prévia diz por quê;
 *   · depois da visita, a prévia mostra o desconto e o limite ANTES de pagar (CDC 30–31);
 *   · o checkout grava `loyalty_program_id` + `loyalty_discount_cents` e conta o retorno;
 *   · esgotados os retornos, acabou; pedido estornado DEVOLVE o retorno (contagem dos pedidos em pé);
 *   · meia não acumula; o retorno com desconto não vira "1ª visita" de outro ciclo;
 *   · dois checkouts AO MESMO TEMPO com 1 retorno sobrando: só um leva (trava do CPF).
 *
 * O programa do teste dá 100% (retorno grátis) pra não depender de gateway: o pedido fecha em zero e
 * sai pago na hora. A conta do desconto parcial está em `server/utils/fidelidade.test.ts`.
 * Fixture própria (organização ZZ), apagada no fim. Sem servidor no ar, PULA.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1 } from '../utils/db'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../scripts/test-setup'

const BASE = process.env.BASE_TESTE ?? BASE_DE_TESTE
const MARCA = `zzfidel${Date.now().toString(36)}`
const SLUG = `${MARCA}-evento`
let orgId = '', eventId = '', setorId = '', lote = '', tipoInteira = '', tipoMeia = '', programaId = ''
let sonda: Sonda

function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

/** Um "navegador" com conta criada e sessão aberta. */
async function cliente() {
  let cookie = ''
  const chamar = async (metodo: string, rota: string, body?: unknown) => {
    const r = await fetch(`${BASE}${rota}`, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [par] = c.split(';')
      if (par!.startsWith('dt_cliente=')) cookie = par!.endsWith('=') ? '' : par!
    }
    const corpo = await r.json().catch(() => ({}))
    return { status: r.status, corpo, recado: corpo.statusMessage ?? corpo.message ?? '' }
  }
  const documento = cpf()
  const r = await chamar('POST', '/api/conta/criar', {
    nome: 'Joana Volte Mais', cpf: documento, email: `${MARCA}.${documento}@exemplo.com`,
    telefone: '73998260963', senha: 'senha-de-teste-9', evento: SLUG,
  })
  expect(r.status, r.recado).toBe(200)
  return { chamar, documento }
}

/** A 1ª visita, como a portaria deixa no banco: pedido inteiro pago + ingresso + entrada. */
async function primeiraVisita(documento: string) {
  const cu = (await q1<any>(
    `INSERT INTO customers (org_id, name, email, document) VALUES ($1, 'Joana Volte Mais', $2, $3) RETURNING id`,
    [orgId, `${MARCA}.v.${documento}@exemplo.com`, documento]))!.id
  const o = (await q1<any>(
    `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method, customer_id,
                         face_cents, fee_cents, discount_cents, total_cents, paid_at)
     VALUES ($1, $2, $3, 'pago', 'online', 'pix', $4, 3000, 0, 0, 3000, now()) RETURNING id`,
    [orgId, eventId, `${MARCA}-V-${documento}`.toUpperCase(), cu]))!.id
  const t = (await q1<any>(
    `INSERT INTO tickets (org_id, event_id, order_id, sector_id, lot_id, ticket_type_id, code, qr_secret)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'segredo-de-teste') RETURNING id`,
    [orgId, eventId, o, setorId, lote, tipoInteira, `${MARCA}-T-${documento}`.toUpperCase()]))!.id
  await q(`INSERT INTO entries (id, org_id, event_id, ticket_id, entered_at) VALUES (gen_random_uuid(), $1, $2, $3, now())`,
    [orgId, eventId, t])
}

const inteira = (quantidade = 1) => [{ lotId: lote, ticketTypeId: tipoInteira, quantidade }]
const meia = () => [{ lotId: lote, ticketTypeId: tipoMeia, quantidade: 1 }]

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu', BASE)
  anunciarPulo('fidelidade.test.ts', sonda)
  orgId = (await q1<any>(
    `INSERT INTO organizations (name, slug) VALUES ('ZZ Volte Mais', $1) RETURNING id`, [`${MARCA}-org`]))!.id
  eventId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online)
     VALUES ($1, 'ZZ Evento da Fidelidade', $2, 'ativo', now() + interval '10 days', now() + interval '11 days', 0, 'repassar')
     RETURNING id`, [orgId, SLUG]))!.id
  setorId = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1, 'Parque') RETURNING id`, [eventId]))!.id
  lote = (await q1<any>(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
     VALUES ($1, 'Dia', 3000, 200, 6, '{online}') RETURNING id`, [setorId]))!.id
  tipoInteira = (await q1<any>(
    `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps) VALUES ($1, 'Inteira', 200, 0) RETURNING id`, [lote]))!.id
  tipoMeia = (await q1<any>(
    `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps) VALUES ($1, 'Meia', 200, 5000) RETURNING id`, [lote]))!.id
  programaId = (await q1<any>(
    `INSERT INTO loyalty_programs (org_id, nome, ativo, desconto_bps, retornos, ingressos_por_compra,
                                   vigencia_inicio, vigencia_fim)
     VALUES ($1, 'Volte Mais', true, 10000, 2, 1, current_date - 1, current_date + 60) RETURNING id`, [orgId]))!.id
})

afterAll(async () => {
  const pedidos = `SELECT id FROM orders WHERE org_id = $1`
  await q(`DELETE FROM entries WHERE org_id = $1`, [orgId])
  await q(`UPDATE orders SET rescheduled_from_ticket_id = NULL WHERE org_id = $1`, [orgId]).catch(() => {})
  await q(`DELETE FROM order_items WHERE order_id IN (${pedidos})`, [orgId])
  await q(`DELETE FROM tickets WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM payment_events WHERE order_id IN (${pedidos})`, [orgId]).catch(() => {})
  await q(`DELETE FROM orders WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM loyalty_programs WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM customers WHERE org_id = $1`, [orgId]).catch(() => {})
  await q(`DELETE FROM customer_accounts WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

describe('Volte Mais · o ciclo de um CPF', () => {
  it('sem 1ª visita: a prévia diz que não tem e por quê; a conta mostra "ainda não"', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const c = await cliente()
    const p = await c.chamar('POST', '/api/fidelidade/previa', { eventSlug: SLUG, itens: inteira() })
    expect(p.status, p.recado).toBe(200)
    expect(p.corpo.disponivel).toBe(false)
    expect(p.corpo.motivo).toMatch(/primeira visita/)
    expect(p.corpo.regulamento).toMatch(/Não acumula com meia-entrada/)
    const conta = await c.chamar('GET', '/api/conta/fidelidade')
    expect(conta.corpo).toMatchObject({ ativo: true, qualificado: false, retornos: 2 })
  })

  it('sem conta na sessão: prévia 200 com "entre na sua conta" (não é erro)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE}/api/fidelidade/previa`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventSlug: SLUG, itens: inteira() }),
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ disponivel: false, motivo: 'entre na sua conta' })
  })

  it('visitou → 2 retornos com desconto; o 3º não; estorno devolve um; o retorno grátis não reabre o ciclo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const c = await cliente()
    await primeiraVisita(c.documento)

    const conta = await c.chamar('GET', '/api/conta/fidelidade')
    expect(conta.corpo).toMatchObject({ ativo: true, qualificado: true, restantes: 2 })

    const previa = await c.chamar('POST', '/api/fidelidade/previa', { eventSlug: SLUG, itens: inteira(2) })
    expect(previa.corpo).toMatchObject({ disponivel: true, descontoCents: 3000, ingressos: 1, restantesDepois: 1 })

    // 1º retorno com 1 inteira: fecha em zero e sai pago na hora (2 inteiras cobrariam a 2ª → gateway)
    const r1 = await c.chamar('POST', '/api/checkout', { eventSlug: SLUG, itens: inteira(), forma: 'pix' })
    expect(r1.status, r1.recado).toBe(200)
    expect(r1.corpo.fidelidade).toMatchObject({ nome: 'Volte Mais', descontoCents: 3000, restantesDepois: 1 })
    const o1 = await q1<any>(
      `SELECT status, loyalty_program_id, loyalty_discount_cents, discount_cents, total_cents FROM orders WHERE code = $1`,
      [r1.corpo.pedido])
    expect(o1).toMatchObject({ status: 'pago', loyalty_program_id: programaId, loyalty_discount_cents: 3000, discount_cents: 3000, total_cents: 0 })

    // o pedido mostra o selo (a portaria e o bar enxergam a consumação)
    const ped = await c.chamar('GET', `/api/pedido/${r1.corpo.pedido}`)
    expect(ped.corpo.fidelidade).toMatchObject({ nome: 'Volte Mais', consumacaoPct: 10 })

    const r2 = await c.chamar('POST', '/api/checkout', { eventSlug: SLUG, itens: inteira(), forma: 'pix' })
    expect(r2.status, r2.recado).toBe(200)
    expect(r2.corpo.fidelidade?.restantesDepois).toBe(0)

    // esgotou: a prévia diz e o checkout NÃO dá desconto
    const p3 = await c.chamar('POST', '/api/fidelidade/previa', { eventSlug: SLUG, itens: inteira() })
    expect(p3.corpo).toMatchObject({ disponivel: false })
    expect(p3.corpo.motivo).toMatch(/2 retornos com desconto já foram usados/)
    expect((await c.chamar('GET', '/api/conta/fidelidade')).corpo.restantes).toBe(0)

    // estornou o 2º: o retorno volta (uso = pedidos em pé, sem saldo pra desandar)
    await q(`UPDATE orders SET status = 'estornado' WHERE code = $1`, [r2.corpo.pedido])
    const p4 = await c.chamar('POST', '/api/fidelidade/previa', { eventSlug: SLUG, itens: inteira() })
    expect(p4.corpo).toMatchObject({ disponivel: true, restantesDepois: 0 })

    // os retornos grátis (total 0, com loyalty) não contam como "1ª visita": o CPF continua no MESMO ciclo
    const ciclo = await q1<any>(
      `SELECT count(*)::int AS n FROM orders o JOIN customers cu ON cu.id = o.customer_id
        WHERE o.org_id = $1 AND cu.document = $2 AND o.loyalty_program_id IS NOT NULL`, [orgId, c.documento])
    expect(ciclo!.n).toBe(2)
  })

  it('meia não acumula com a fidelidade', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const c = await cliente()
    await primeiraVisita(c.documento)
    const p = await c.chamar('POST', '/api/fidelidade/previa', { eventSlug: SLUG, itens: meia() })
    expect(p.corpo.disponivel).toBe(false)
    expect(p.corpo.motivo).toMatch(/meia e grátis não acumulam/)
  })

  it('programa fora da vigência (ou desligado): nada na prévia, nada na conta', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const c = await cliente()
    await primeiraVisita(c.documento)
    await q(`UPDATE loyalty_programs SET vigencia_inicio = current_date + 30, vigencia_fim = current_date + 60 WHERE id = $1`, [programaId])
    try {
      const p = await c.chamar('POST', '/api/fidelidade/previa', { eventSlug: SLUG, itens: inteira() })
      expect(p.corpo).toMatchObject({ disponivel: false, motivo: 'a promoção ainda não começou' })
      expect((await c.chamar('GET', '/api/conta/fidelidade')).corpo).toEqual({ ativo: false })
    } finally {
      await q(`UPDATE loyalty_programs SET vigencia_inicio = current_date - 1, vigencia_fim = current_date + 60 WHERE id = $1`, [programaId])
    }
  })

  it('dois checkouts ao mesmo tempo com 1 retorno sobrando: só UM leva o desconto', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const c = await cliente()
    await primeiraVisita(c.documento)
    await q(`UPDATE loyalty_programs SET retornos = 1 WHERE id = $1`, [programaId])
    try {
      const corpo = { eventSlug: SLUG, itens: inteira(), forma: 'pix' }
      await Promise.all([1, 2, 3].map(() => c.chamar('POST', '/api/checkout', corpo)))
      const com = await q1<any>(
        `SELECT count(*)::int AS n FROM orders o JOIN customers cu ON cu.id = o.customer_id
          WHERE o.org_id = $1 AND cu.document = $2 AND o.loyalty_program_id IS NOT NULL`, [orgId, c.documento])
      expect(com!.n).toBe(1)
    } finally {
      await q(`UPDATE loyalty_programs SET retornos = 2 WHERE id = $1`, [programaId])
    }
  })
})
