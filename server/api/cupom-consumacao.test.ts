/**
 * cupom-consumacao.test.ts — o Volte Mais PERMANENTE e o cupom do bar (042), de ponta a ponta.
 *
 * O que cada caso trava:
 *   · permanente (retornos NULL, sem data de fim): o 3º, 4º… retorno continuam com desconto;
 *   · o pedido do retorno devolve o cupom (token + código) e a 1ª visita devolve o CONVITE;
 *   · o cupom público não mostra CPF nem o nome inteiro; o do caixa mostra o CPF mascarado;
 *   · `/api/admin/consumacao` exige login, e o acesso de PORTARIA basta (é quem fica no bar);
 *   · a baixa: sem entrada do dia → 409 `sem_entrada`; "conferi o documento" → passa e fica marcada;
 *     a segunda → 409 JÁ USADO (print reaproveitado não engana: quem responde é o servidor);
 *   · duas atendentes ao mesmo tempo no cupom de uso único: UMA baixa;
 *   · "o dia todo": a 1ª baixa ativa, as próximas ficam ATIVO sem gravar de novo;
 *   · outro dia (antes/depois) e pedido cancelado: recusa com o motivo;
 *   · a portaria de OUTRO parque não enxerga o cupom (404, igual a inexistente).
 *
 * O programa do teste dá 100% no ingresso (retorno grátis) pra não depender de gateway.
 * Fixture própria (organização ZZ), apagada no fim. Sem servidor no ar, os casos HTTP PULAM.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1 } from '../utils/db'
import { CupomRecusadoNoCaixa, darBaixaNoCupom, garantirCupomDeConsumacao } from '../utils/cupom-consumacao'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../scripts/test-setup'

const BASE = process.env.BASE_TESTE ?? BASE_DE_TESTE
const MARCA = `zzcupom${Date.now().toString(36)}`
const SLUG = `${MARCA}-evento`
const EMAIL_BAR = `bar.${MARCA}@cupom.invalido`
const EMAIL_BAR_VIZINHO = `bar2.${MARCA}@cupom.invalido`
let orgId = '', orgVizinha = '', eventId = '', eventoHoje = '', setorId = '', lote = '', tipoInteira = '', programaId = ''
let sonda: Sonda
let cookieBar = '', cookieVizinho = ''

function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

async function http(metodo: string, rota: string, body?: unknown, cookie = '') {
  const r = await fetch(`${BASE}${rota}`, {
    method: metodo,
    headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const corpo = await r.json().catch(() => ({}))
  return { status: r.status, corpo, cookies: r.headers.getSetCookie?.() ?? [] }
}

async function cliente() {
  let cookie = ''
  const chamar = async (metodo: string, rota: string, body?: unknown) => {
    const r = await http(metodo, rota, body, cookie)
    for (const c of r.cookies) {
      const [par] = c.split(';')
      if (par!.startsWith('dt_cliente=')) cookie = par!.endsWith('=') ? '' : par!
    }
    return { ...r, recado: r.corpo.statusMessage ?? r.corpo.message ?? '' }
  }
  const documento = cpf()
  const r = await chamar('POST', '/api/conta/criar', {
    nome: 'Joana Cupom do Bar', cpf: documento, email: `${MARCA}.${documento}@exemplo.com`,
    telefone: '73998260963', senha: 'senha-de-teste-9', evento: SLUG,
  })
  expect(r.status, r.recado).toBe(200)
  return { chamar, documento }
}

/** A 1ª visita, como a portaria deixa no banco: pedido inteiro pago + ingresso + entrada. */
async function primeiraVisita(documento: string) {
  const cu = (await q1<any>(
    `INSERT INTO customers (org_id, name, email, document) VALUES ($1, 'Joana Cupom do Bar', $2, $3) RETURNING id`,
    [orgId, `${MARCA}.v.${documento}@exemplo.com`, documento]))!.id
  const o = (await q1<any>(
    `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method, customer_id,
                         face_cents, fee_cents, discount_cents, total_cents, paid_at)
     VALUES ($1, $2, $3, 'pago', 'online', 'pix', $4, 3000, 0, 0, 3000, now()) RETURNING id, code`,
    [orgId, eventId, `${MARCA}-V-${documento}`.toUpperCase(), cu]))!
  const t = (await q1<any>(
    `INSERT INTO tickets (org_id, event_id, order_id, sector_id, lot_id, ticket_type_id, code, qr_secret)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'segredo-de-teste') RETURNING id`,
    [orgId, eventId, o.id, setorId, lote, tipoInteira, `${MARCA}-T-${documento}`.toUpperCase()]))!.id
  await q(`INSERT INTO entries (id, org_id, event_id, ticket_id, entered_at) VALUES (gen_random_uuid(), $1, $2, $3, now() - interval '1 hour')`,
    [orgId, eventId, t])
  return { orderId: o.id as string, code: o.code as string, customerId: cu as string }
}

/** Um pedido de retorno direto no banco (pros casos que não precisam do checkout). */
async function retornoNoBanco(status = 'pago') {
  const doc = cpf()
  const cu = (await q1<any>(
    `INSERT INTO customers (org_id, name, email, document) VALUES ($1, 'Carla Retorno Teste', $2, $3) RETURNING id`,
    [orgId, `${MARCA}.r.${doc}@exemplo.com`, doc]))!.id
  const o = (await q1<any>(
    `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method, customer_id,
                         face_cents, fee_cents, discount_cents, total_cents, paid_at, loyalty_program_id, loyalty_discount_cents)
     VALUES ($1, $2, $3, $4, 'online', 'pix', $5, 3000, 0, 1500, 1500, now(), $6, 1500) RETURNING id`,
    [orgId, eventoHoje, `${MARCA}-R-${doc}`.toUpperCase(), status, cu, programaId]))!.id
  const t = (await q1<any>(
    `INSERT INTO tickets (org_id, event_id, order_id, sector_id, lot_id, ticket_type_id, code, qr_secret)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'segredo-de-teste') RETURNING id`,
    [orgId, eventoHoje, o, setorId, lote, tipoInteira, `${MARCA}-RT-${doc}`.toUpperCase()]))!.id
  return { orderId: o as string, ticketId: t as string }
}
const entrarHoje = (ticketId: string) =>
  q(`INSERT INTO entries (id, org_id, event_id, ticket_id, entered_at) VALUES (gen_random_uuid(), $1, $2, $3, now())`, [orgId, eventoHoje, ticketId])

async function entrarNoPainel(email: string): Promise<string> {
  const r = await http('POST', '/api/auth/entrar', { email, senha: 'diamond123' })
  return r.cookies.map((c) => c.split(';')[0]).find((c) => c!.startsWith('dt_sessao=')) ?? ''
}

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu', BASE)
  anunciarPulo('cupom-consumacao.test.ts', sonda)
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug) VALUES ('ZZ Cupom do Bar', $1) RETURNING id`, [`${MARCA}-org`]))!.id
  orgVizinha = (await q1<any>(`INSERT INTO organizations (name, slug) VALUES ('ZZ Parque Vizinho', $1) RETURNING id`, [`${MARCA}-viz`]))!.id
  // o evento da VENDA é daqui a 10 dias (vendas abertas); o dos cupons é HOJE (o cupom vale hoje)
  eventId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online, timezone)
     VALUES ($1, 'ZZ Evento do Retorno', $2, 'ativo', now() + interval '10 days', now() + interval '11 days', 0, 'repassar', 'America/Bahia')
     RETURNING id`, [orgId, SLUG]))!.id
  eventoHoje = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online, timezone)
     VALUES ($1, 'ZZ Dia de Parque', $2, 'ativo',
             ((now() AT TIME ZONE 'America/Bahia')::date + time '12:00') AT TIME ZONE 'America/Bahia',
             ((now() AT TIME ZONE 'America/Bahia')::date + time '23:00') AT TIME ZONE 'America/Bahia',
             0, 'repassar', 'America/Bahia')
     RETURNING id`, [orgId, `${SLUG}-hoje`]))!.id
  setorId = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1, 'Parque') RETURNING id`, [eventId]))!.id
  lote = (await q1<any>(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
     VALUES ($1, 'Dia', 3000, 200, 6, '{online}') RETURNING id`, [setorId]))!.id
  tipoInteira = (await q1<any>(
    `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps) VALUES ($1, 'Inteira', 200, 0) RETURNING id`, [lote]))!.id
  // PERMANENTE: sem limite de retornos, sem data de fim
  programaId = (await q1<any>(
    `INSERT INTO loyalty_programs (org_id, nome, ativo, desconto_bps, retornos, ingressos_por_compra,
                                   consumacao_bps, consumacao_usos, vigencia_inicio, vigencia_fim)
     VALUES ($1, 'Volte Mais', true, 10000, NULL, 1, 1000, 1, current_date - 1, NULL) RETURNING id`, [orgId]))!.id
  // atendentes do bar = acesso de PORTARIA (a senha vem do hash já semeado, igual à catraca)
  for (const [email, org] of [[EMAIL_BAR, orgId], [EMAIL_BAR_VIZINHO, orgVizinha]]) {
    await q(`INSERT INTO users (org_id, name, email, password_hash, role)
             SELECT $1, 'Atendente do Bar', $2, password_hash, 'portaria' FROM users WHERE email = 'dono@fazendapark.com.br'`,
      [org, email])
  }
  if (sonda.noAr) {
    cookieBar = await entrarNoPainel(EMAIL_BAR)
    cookieVizinho = await entrarNoPainel(EMAIL_BAR_VIZINHO)
  }
}, 60_000)

afterAll(async () => {
  const pedidos = `SELECT id FROM orders WHERE org_id = $1`
  await q(`DELETE FROM entries WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM loyalty_vouchers WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM order_items WHERE order_id IN (${pedidos})`, [orgId])
  await q(`DELETE FROM tickets WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM payment_events WHERE order_id IN (${pedidos})`, [orgId]).catch(() => {})
  await q(`DELETE FROM email_sends WHERE org_id = $1`, [orgId]).catch(() => {})
  await q(`DELETE FROM orders WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM loyalty_programs WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM customers WHERE org_id = $1`, [orgId]).catch(() => {})
  await q(`DELETE FROM customer_accounts WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email IN ($1, $2))`, [EMAIL_BAR, EMAIL_BAR_VIZINHO]).catch(() => {})
  await q(`DELETE FROM users WHERE email IN ($1, $2)`, [EMAIL_BAR, EMAIL_BAR_VIZINHO]).catch(() => {})
  await q(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[orgId, orgVizinha]]).catch(() => {})
  await db().end()
})

describe('Volte Mais permanente · pela HTTP', () => {
  it('depois da 1ª visita, TODAS as próximas compras saem com desconto (sem limite)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const c = await cliente()
    await primeiraVisita(c.documento)
    for (let i = 1; i <= 4; i++) {
      const p = await c.chamar('POST', '/api/fidelidade/previa', { eventSlug: SLUG, itens: [{ lotId: lote, ticketTypeId: tipoInteira, quantidade: 1 }] })
      expect(p.corpo.disponivel, `retorno ${i}: ${p.corpo.motivo}`).toBe(true)
      expect(p.corpo.restantesDepois, 'permanente não conta retornos').toBeNull()
      const r = await c.chamar('POST', '/api/checkout', {
        eventSlug: SLUG, forma: 'pix', itens: [{ lotId: lote, ticketTypeId: tipoInteira, quantidade: 1 }],
      })
      expect(r.status, `retorno ${i}: ${r.recado}`).toBe(200)
      expect(r.corpo.status, `retorno ${i}`).toBe('pago')
    }
    const usados = await q1<any>(`SELECT count(*)::int AS n FROM orders WHERE loyalty_program_id = $1 AND status = 'pago'`, [programaId])
    expect(usados!.n).toBeGreaterThanOrEqual(4)
  }, 60_000)

  it('o pedido do retorno traz o cupom do bar; o público não mostra CPF; a 1ª visita traz o convite', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ret = await q1<any>(`SELECT id, code FROM orders WHERE loyalty_program_id = $1 AND status = 'pago' ORDER BY created_at LIMIT 1`, [programaId])
    const p = await http('GET', `/api/pedido/${ret!.code}`)
    expect(p.status).toBe(200)
    expect(p.corpo.cupomConsumacao).toMatchObject({ consumacaoPct: 10, codigo: expect.stringMatching(/^[A-HJ-NP-Z2-9]{6}$/) })
    expect(p.corpo.conviteVolteMais).toBeNull()
    const token = p.corpo.cupomConsumacao.token
    // idempotente: a segunda leitura devolve o MESMO cupom
    expect((await http('GET', `/api/pedido/${ret!.code}`)).corpo.cupomConsumacao.token).toBe(token)

    const pub = await http('GET', `/api/consumo/${token}`)
    expect(pub.status).toBe(200)
    // o retorno é daqui a 10 dias: o cupom existe, mas ainda não é o dia
    expect(pub.corpo).toMatchObject({ estado: 'antes_do_dia', recado: 'AINDA NÃO É O DIA', consumacaoPct: 10, titular: 'Joana B.' })
    expect(JSON.stringify(pub.corpo)).not.toMatch(/\d{3}\.\d{3}|cpf|document/i)
    const qr = await fetch(`${BASE}/api/consumo/${token}/qr.png`)
    expect(qr.status).toBe(200)
    expect(qr.headers.get('content-type')).toBe('image/png')
    expect((await http('GET', `/api/consumo/${'x'.repeat(24)}`)).status).toBe(404)

    const primeira = await q1<any>(`SELECT code FROM orders WHERE org_id = $1 AND loyalty_program_id IS NULL AND status = 'pago' LIMIT 1`, [orgId])
    const conv = await http('GET', `/api/pedido/${primeira!.code}`)
    expect(conv.corpo.cupomConsumacao).toBeNull()
    expect(conv.corpo.conviteVolteMais).toEqual({ nome: 'Volte Mais', descontoPct: 100, consumacaoPct: 10, permanente: true })
  }, 30_000)
})

describe('Caixa do bar · pela HTTP', () => {
  it('sem login: 401; com acesso de PORTARIA: confere pelo token e pelo código', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookieBar, 'login da atendente falhou — o teste ficaria verde à toa').toBeTruthy()
    const { orderId } = await retornoNoBanco()
    const cupom = (await garantirCupomDeConsumacao(orderId))!
    expect((await http('GET', `/api/admin/consumacao?token=${cupom.token}`)).status).toBe(401)
    const r = await http('GET', `/api/admin/consumacao?token=${cupom.token}`, undefined, cookieBar)
    expect(r.status, r.corpo.statusMessage).toBe(200)
    expect(r.corpo.cupom).toMatchObject({ estado: 'valido', titular: 'Carla Retorno Teste', entradaHoje: null,
                                          cpf: expect.stringMatching(/^\*\*\*\.\d{3}\.\d{3}-\*\*$/) })
    const porCodigo = await http('GET', `/api/admin/consumacao?codigo=${cupom.codigo.toLowerCase()}`, undefined, cookieBar)
    expect(porCodigo.corpo.cupom.token).toBe(cupom.token)
    // a portaria do parque vizinho não enxerga (404 igual a inexistente)
    expect((await http('GET', `/api/admin/consumacao?token=${cupom.token}`, undefined, cookieVizinho)).status).toBe(404)
    expect((await http('POST', '/api/admin/consumacao', { token: cupom.token }, cookieVizinho)).status).toBe(404)
  }, 30_000)

  it('baixa: sem entrada → pede documento; liberado → BAIXA; a segunda → JÁ USADO', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { orderId } = await retornoNoBanco()
    const cupom = (await garantirCupomDeConsumacao(orderId))!
    const sem = await http('POST', '/api/admin/consumacao', { token: cupom.token }, cookieBar)
    expect(sem.status).toBe(409)
    expect(sem.corpo.data.tipo).toBe('sem_entrada')
    const ok = await http('POST', '/api/admin/consumacao', { token: cupom.token, semEntrada: true }, cookieBar)
    expect(ok.status, ok.corpo.statusMessage).toBe(200)
    expect(ok.corpo.cupom).toMatchObject({ estado: 'usado', restam: 0 })
    expect(ok.corpo.cupom.usos[0]).toMatchObject({ semEntrada: true, por: expect.stringContaining(EMAIL_BAR) })
    const de_novo = await http('POST', '/api/admin/consumacao', { codigo: cupom.codigo, semEntrada: true }, cookieBar)
    expect(de_novo.status).toBe(409)
    expect(de_novo.corpo.data.tipo).toBe('usado')
    expect(de_novo.corpo.statusMessage).toMatch(/já foi usado às \d{2}:\d{2}/)
    // o cliente com a tela aberta vê o JÁ USADO
    expect((await http('GET', `/api/consumo/${cupom.token}`)).corpo.recado).toBe('JÁ USADO')
    // a lista de baixas do caixa mostra
    const lista = await http('GET', '/api/admin/consumacao', undefined, cookieBar)
    expect(lista.corpo.baixas.some((b: any) => b.codigo === cupom.codigo && b.semEntrada)).toBe(true)
  }, 30_000)

  it('com a entrada de hoje, passa direto (sem marca de "sem entrada")', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { orderId, ticketId } = await retornoNoBanco()
    await entrarHoje(ticketId)
    const cupom = (await garantirCupomDeConsumacao(orderId))!
    const ok = await http('POST', '/api/admin/consumacao', { codigo: cupom.codigo }, cookieBar)
    expect(ok.status, ok.corpo.statusMessage).toBe(200)
    expect(ok.corpo.cupom.entradaHoje).toMatch(/^\d{2}:\d{2}$/)
    expect(ok.corpo.cupom.usos[0].semEntrada).toBe(false)
  }, 30_000)
})

describe('cupom do bar · regras no banco', () => {
  it('só nasce pra pedido de retorno de pé', async () => {
    const primeira = await q1<any>(
      `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method, face_cents, fee_cents, discount_cents, total_cents)
       VALUES ($1, $2, $3, 'pago', 'online', 'pix', 3000, 0, 0, 3000) RETURNING id`, [orgId, eventoHoje, `${MARCA}-SEM`.toUpperCase()])
    expect(await garantirCupomDeConsumacao(primeira!.id)).toBeNull()
    const { orderId } = await retornoNoBanco('aguardando_pagamento')
    expect(await garantirCupomDeConsumacao(orderId)).toBeNull()
  })

  it('duas atendentes ao mesmo tempo no cupom de uso único: UMA baixa', async () => {
    const { orderId, ticketId } = await retornoNoBanco()
    await entrarHoje(ticketId)
    const cupom = (await garantirCupomDeConsumacao(orderId))!
    const r = await Promise.allSettled(Array.from({ length: 4 }, (_, i) =>
      darBaixaNoCupom({ orgId, token: cupom.token }, `caixa ${i}`)))
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    for (const x of r.filter((x) => x.status === 'rejected')) {
      expect((x as PromiseRejectedResult).reason).toBeInstanceOf(CupomRecusadoNoCaixa)
      expect((x as PromiseRejectedResult).reason.tipo).toBe('usado')
    }
    const n = await q1<any>(`SELECT count(*)::int AS n FROM loyalty_voucher_usos WHERE voucher_id = $1`, [cupom.id])
    expect(n!.n).toBe(1)
  })

  it('"o dia todo": a 1ª baixa ativa; as próximas seguem ATIVO sem gravar de novo', async () => {
    await q(`UPDATE loyalty_programs SET consumacao_dia_todo = true WHERE id = $1`, [programaId])
    try {
      const { orderId, ticketId } = await retornoNoBanco()
      await entrarHoje(ticketId)
      const cupom = (await garantirCupomDeConsumacao(orderId))!
      expect(cupom.dia_todo).toBe(true)
      expect((await darBaixaNoCupom({ orgId, token: cupom.token }, 'caixa')).estado).toBe('ativo')
      expect((await darBaixaNoCupom({ orgId, token: cupom.token }, 'caixa')).estado).toBe('ativo')
      const n = await q1<any>(`SELECT count(*)::int AS n FROM loyalty_voucher_usos WHERE voucher_id = $1`, [cupom.id])
      expect(n!.n).toBe(1)
    } finally {
      await q(`UPDATE loyalty_programs SET consumacao_dia_todo = false WHERE id = $1`, [programaId])
    }
  })

  it('mudar o programa depois não muda o cupom que já nasceu (percentual congelado)', async () => {
    const { orderId } = await retornoNoBanco()
    const antes = (await garantirCupomDeConsumacao(orderId))!
    await q(`UPDATE loyalty_programs SET consumacao_bps = 2000 WHERE id = $1`, [programaId])
    try {
      expect((await garantirCupomDeConsumacao(orderId))!.consumacao_bps).toBe(antes.consumacao_bps)
    } finally {
      await q(`UPDATE loyalty_programs SET consumacao_bps = 1000 WHERE id = $1`, [programaId])
    }
  })

  it('outro dia e pedido cancelado: recusa com o motivo', async () => {
    const { orderId } = await retornoNoBanco()
    const cupom = (await garantirCupomDeConsumacao(orderId))!
    const ontem = new Date(Date.now() - 36 * 3600_000)
    const amanha = new Date(Date.now() + 36 * 3600_000)
    await expect(darBaixaNoCupom({ orgId, token: cupom.token }, 'caixa', { semEntrada: true, agora: ontem }))
      .rejects.toMatchObject({ tipo: 'antes_do_dia' })
    await expect(darBaixaNoCupom({ orgId, token: cupom.token }, 'caixa', { semEntrada: true, agora: amanha }))
      .rejects.toMatchObject({ tipo: 'passou_o_dia' })
    await q(`UPDATE orders SET status = 'cancelado' WHERE id = $1`, [orderId])
    await expect(darBaixaNoCupom({ orgId, token: cupom.token }, 'caixa', { semEntrada: true }))
      .rejects.toMatchObject({ tipo: 'pedido_cancelado' })
    await expect(darBaixaNoCupom({ orgId: orgVizinha, token: cupom.token }, 'caixa', { semEntrada: true }))
      .rejects.toMatchObject({ tipo: 'inexistente' })
  })
})
