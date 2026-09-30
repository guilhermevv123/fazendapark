/**
 * conta.test.ts — a conta de quem compra (034), pela HTTP, e o checkout com ela.
 *
 * O que cada caso trava:
 *   · criar, entrar (por CPF e por e-mail), sair — e a sessão sendo do SERVIDOR (cookie opaco);
 *   · CPF e e-mail repetidos voltam com o recado de "entre com ele";
 *   · senha errada é 401 com a MESMA frase pra CPF inexistente (não revela quem tem conta);
 *   · "Meus dados" não troca o CPF;
 *   · o checkout tira o comprador da SESSÃO: o corpo que diz outro nome é ignorado, e o pedido
 *     nasce com `customer_account_id`; organização que exige conta recusa quem chega sem ela;
 *   · débito vai como cartão à vista; grátis sai pago na hora, sem limite de 1 por CPF (saiu 30/09);
 *   · uma conta não vê o pedido da outra em "Meus ingressos".
 *
 * Fixture própria (organização ZZ), apagada no fim. Sem servidor no ar, PULA.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1 } from '../utils/db'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../scripts/test-setup'

const BASE = process.env.BASE_TESTE ?? BASE_DE_TESTE
const MARCA = `zzconta${Date.now().toString(36)}`
const SLUG = `${MARCA}-evento`
let orgId = '', eventId = '', lotePago = '', tipoPago = '', loteGratis = '', tipoGratis = ''
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
const SENHA = 'senha-de-teste-9'
const novaPessoa = () => {
  const c = cpf()
  return { nome: 'Maria Conta Teste', cpf: c, email: `${MARCA}.${c}@exemplo.com`, telefone: '73998260963', senha: SENHA }
}

/** Um "navegador": guarda o cookie da conta entre as chamadas. */
function navegador() {
  let cookie = ''
  const chamar = async (metodo: string, rota: string, body?: unknown) => {
    const r = await fetch(`${BASE}${rota}`, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const posto = r.headers.getSetCookie?.() ?? []
    for (const c of posto) {
      const [par] = c.split(';')
      if (par!.startsWith('dt_cliente=')) cookie = par!.endsWith('=') ? '' : par!
    }
    const corpo = await r.json().catch(() => ({}))
    return { status: r.status, corpo, recado: corpo.statusMessage ?? corpo.message ?? '' }
  }
  return { chamar, temCookie: () => !!cookie }
}

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu', BASE)
  anunciarPulo('conta.test.ts', sonda)
  orgId = (await q1<any>(
    `INSERT INTO organizations (name, slug) VALUES ('ZZ Conta', $1) RETURNING id`, [`${MARCA}-org`]))!.id
  eventId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online)
     VALUES ($1, 'ZZ Evento da Conta', $2, 'ativo', now() + interval '10 days', now() + interval '11 days', 0, 'repassar')
     RETURNING id`, [orgId, SLUG]))!.id
  const setor = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1, 'Pista') RETURNING id`, [eventId]))!.id
  lotePago = (await q1<any>(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
     VALUES ($1, 'Pago', 3000, 100, 6, '{online}') RETURNING id`, [setor]))!.id
  tipoPago = (await q1<any>(
    `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps) VALUES ($1, 'Inteira', 100, 0) RETURNING id`, [lotePago]))!.id
  const setorG = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1, 'Grátis') RETURNING id`, [eventId]))!.id
  loteGratis = (await q1<any>(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
     VALUES ($1, 'Grátis', 0, 100, 6, '{online}') RETURNING id`, [setorG]))!.id
  tipoGratis = (await q1<any>(
    `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps) VALUES ($1, 'Entrada grátis', 100, 0) RETURNING id`, [loteGratis]))!.id
})

afterAll(async () => {
  const pedidos = `SELECT id FROM orders WHERE org_id = $1`
  await q(`DELETE FROM order_items WHERE order_id IN (${pedidos})`, [orgId])
  await q(`DELETE FROM tickets WHERE order_id IN (${pedidos})`, [orgId])
  await q(`DELETE FROM payment_events WHERE order_id IN (${pedidos})`, [orgId]).catch(() => {})
  await q(`DELETE FROM orders WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM customers WHERE org_id = $1`, [orgId]).catch(() => {})
  await q(`DELETE FROM customer_accounts WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

const itens = (lote: string, tipo: string, quantidade = 1) => [{ lotId: lote, ticketTypeId: tipo, quantidade }]

describe('conta · criar, entrar, sair', () => {
  it('cria a conta e já entra; /eu devolve a conta', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const b = navegador()
    const p = novaPessoa()
    const r = await b.chamar('POST', '/api/conta/criar', { ...p, evento: SLUG })
    expect(r.status, r.recado).toBe(200)
    expect(b.temCookie(), 'criou sem abrir sessão').toBe(true)
    const eu = await b.chamar('GET', `/api/conta/eu?evento=${SLUG}`)
    expect(eu.corpo.conta.email).toBe(p.email)
    expect(eu.corpo.conta.cpf).toBe(p.cpf)
    // a senha nunca volta, nem embaralhada
    expect(JSON.stringify(eu.corpo)).not.toMatch(/password|hash|senha-de-teste/)
  })

  it('CPF ou e-mail repetido: 409 com o caminho ("entre com ele")', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const p = novaPessoa()
    expect((await navegador().chamar('POST', '/api/conta/criar', { ...p, evento: SLUG })).status).toBe(200)
    const outroEmail = await navegador().chamar('POST', '/api/conta/criar', { ...p, email: `x.${p.email}`, evento: SLUG })
    expect(outroEmail.status).toBe(409)
    expect(outroEmail.recado).toMatch(/CPF já tem conta/)
    const outroCpf = await navegador().chamar('POST', '/api/conta/criar', { ...p, cpf: cpf(), evento: SLUG })
    expect(outroCpf.status).toBe(409)
  })

  it('entra por CPF e por e-mail; senha errada e CPF inexistente dão a MESMA frase', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const p = novaPessoa()
    await navegador().chamar('POST', '/api/conta/criar', { ...p, evento: SLUG })
    const porCpf = navegador()
    expect((await porCpf.chamar('POST', '/api/conta/entrar', { login: p.cpf, senha: SENHA, evento: SLUG })).status).toBe(200)
    expect(porCpf.temCookie()).toBe(true)
    expect((await navegador().chamar('POST', '/api/conta/entrar', { login: p.email.toUpperCase(), senha: SENHA, evento: SLUG })).status).toBe(200)
    const errada = await navegador().chamar('POST', '/api/conta/entrar', { login: p.cpf, senha: 'outra-senha-1', evento: SLUG })
    const ninguem = await navegador().chamar('POST', '/api/conta/entrar', { login: cpf(), senha: 'outra-senha-1', evento: SLUG })
    expect(errada.status).toBe(401)
    expect(ninguem.status).toBe(401)
    expect(errada.recado).toBe(ninguem.recado)
  })

  it('sair derruba a sessão no servidor', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const b = navegador()
    await b.chamar('POST', '/api/conta/criar', { ...novaPessoa(), evento: SLUG })
    await b.chamar('POST', '/api/conta/sair', {})
    expect((await b.chamar('GET', `/api/conta/eu?evento=${SLUG}`)).corpo.conta).toBeNull()
  })

  it('"Meus dados" troca o nome e não troca o CPF', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const b = navegador()
    const p = novaPessoa()
    await b.chamar('POST', '/api/conta/criar', { ...p, evento: SLUG })
    const r = await b.chamar('PATCH', '/api/conta/eu', { nome: 'Maria Trocada Silva', email: p.email, telefone: p.telefone, cpf: cpf() })
    expect(r.status, r.recado).toBe(200)
    expect(r.corpo.conta.nome).toBe('Maria Trocada Silva')
    expect(r.corpo.conta.cpf).toBe(p.cpf)
  })
})

describe('checkout com a conta', () => {
  it('o comprador sai da SESSÃO: o corpo com outro nome é ignorado, e o pedido leva a conta', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const b = navegador()
    const p = novaPessoa()
    await b.chamar('POST', '/api/conta/criar', { ...p, evento: SLUG })
    const r = await b.chamar('POST', '/api/checkout', {
      eventSlug: SLUG, itens: itens(lotePago, tipoPago), forma: 'pix',
      comprador: { nome: 'Outra Pessoa Qualquer', email: 'outra@exemplo.com', documento: cpf() },
    })
    expect(r.status, r.recado).toBe(200)
    const o = await q1<any>(
      `SELECT o.customer_account_id, a.email, c.document, c.email AS cliente_email
         FROM orders o JOIN customer_accounts a ON a.id = o.customer_account_id
         LEFT JOIN customers c ON c.id = o.customer_id WHERE o.code = $1`, [r.corpo.pedido])
    expect(o, 'o pedido nasceu sem a conta').toBeTruthy()
    expect(o!.email).toBe(p.email)
    expect(o!.document).toBe(p.cpf)
    expect(o!.cliente_email).toBe(p.email)
  })

  it('organização que exige conta recusa o checkout sem ela (401)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    await q(`UPDATE organizations SET customer_account_required = true WHERE id = $1`, [orgId])
    try {
      const r = await navegador().chamar('POST', '/api/checkout', {
        eventSlug: SLUG, itens: itens(lotePago, tipoPago), forma: 'pix',
        comprador: { nome: 'Sem Conta Nenhuma', email: 'sem@exemplo.com', documento: cpf() },
      })
      expect(r.status).toBe(401)
      expect(r.corpo.data?.tipo).toBe('conta')
    } finally {
      await q(`UPDATE organizations SET customer_account_required = false WHERE id = $1`, [orgId])
    }
  })

  it('débito vai como cartão à vista (1 parcela)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const b = navegador()
    await b.chamar('POST', '/api/conta/criar', { ...novaPessoa(), evento: SLUG })
    const r = await b.chamar('POST', '/api/checkout', { eventSlug: SLUG, itens: itens(lotePago, tipoPago), forma: 'debito', parcelas: 6 })
    expect(r.status, r.recado).toBe(200)
    const o = await q1<any>(`SELECT payment_method, installments FROM orders WHERE code = $1`, [r.corpo.pedido])
    expect(o!.payment_method).toBe('credito')
    expect(Number(o!.installments ?? 1)).toBe(1)
  })

  it('grátis: sai pago na hora, e o mesmo CPF pode pegar mais de um (o limite de 1 por CPF saiu, 30/09)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const b = navegador()
    await b.chamar('POST', '/api/conta/criar', { ...novaPessoa(), evento: SLUG })
    const dois = await b.chamar('POST', '/api/checkout', { eventSlug: SLUG, itens: itens(loteGratis, tipoGratis, 2), forma: 'pix' })
    expect(dois.status, dois.recado).toBe(200)
    expect(dois.corpo.status).toBe('pago')
    const denovo = await b.chamar('POST', '/api/checkout', { eventSlug: SLUG, itens: itens(loteGratis, tipoGratis, 1), forma: 'pix' })
    expect(denovo.status, denovo.recado).toBe(200)
    expect(denovo.corpo.status).toBe('pago')
  })

  it('"Meus ingressos": cada conta vê só o que comprou com ela', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const a = navegador(), b = navegador()
    await a.chamar('POST', '/api/conta/criar', { ...novaPessoa(), evento: SLUG })
    await b.chamar('POST', '/api/conta/criar', { ...novaPessoa(), evento: SLUG })
    const compra = await a.chamar('POST', '/api/checkout', { eventSlug: SLUG, itens: itens(lotePago, tipoPago), forma: 'pix' })
    expect(compra.status, compra.recado).toBe(200)
    const deA = (await a.chamar('GET', '/api/conta/ingressos')).corpo.pedidos.map((x: any) => x.codigo)
    const deB = (await b.chamar('GET', '/api/conta/ingressos')).corpo.pedidos.map((x: any) => x.codigo)
    expect(deA).toContain(compra.corpo.pedido)
    expect(deB).not.toContain(compra.corpo.pedido)
    expect((await navegador().chamar('GET', '/api/conta/ingressos')).status).toBe(401)
  })
})
