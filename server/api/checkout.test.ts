/**
 * checkout.test.ts — os limites que seguram o dinheiro e o lote.
 *
 * O que está sendo testado aqui não é aritmética: é o que o checkout RECUSA.
 * Cada teste tenta furar um limite e exige o 409 com o recado certo. Três
 * camadas, porque nenhuma sozinha basta:
 *
 *   1. a régua do cupom (`utils/cupom.ts`) contra o Postgres de verdade,
 *      inclusive com DUAS CONEXÕES forçando a ordem — `Promise.all` com dois
 *      `fetch` não chega junto no servidor de dev e testa serialização
 *      nenhuma;
 *   2. a rota inteira pela HTTP, que é onde o comprador está;
 *   3. os CHECKs da migração 014, a rede pra quando um caminho novo esquecer
 *      as duas de cima.
 *
 * Fixture própria, ids próprios, `DELETE` no `afterAll`. O evento semeado não
 * é tocado. Sem servidor de dev no ar, a parte HTTP PULA em vez de falhar:
 * teste vermelho por infra ausente treina todo mundo a ignorar vermelho.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db, q, q1, tx } from '../utils/db'
import {
  aplicarCupom, CupomRecusado, PEDIDO_EM_PE, resgatarCupom, SQL_TRAVA_CUPOM,
} from '../utils/cupom'

/**
 * O mesmo número de `TETO_PADRAO_POR_PEDIDO` em checkout.post.ts, repetido
 * aqui de propósito: importar a rota não dá (o módulo chama
 * `defineEventHandler` no topo e esse global não existe fora do Nitro), e um
 * teto que muda sem ninguém decidir é exatamente o que este teste existe pra
 * impedir. Se alguém mexer no número lá, este teste fica vermelho e a mudança
 * vira uma escolha.
 */
const TETO_PADRAO_POR_PEDIDO = 20

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
const SLUG = 'zz-checkout-limites'

let orgId: string, eventId: string, sectorId: string, lotId: string, tipoId: string
let noAr = false

/** CPF sintético que passa no dígito verificador. */
function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

const post = (rota: string, body: unknown) =>
  fetch(`${BASE}${rota}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

/** O que a rota devolve quando recusa: status + o recado que o comprador lê. */
async function comprar(body: Record<string, any>) {
  const r = await post('/api/checkout', {
    eventSlug: SLUG,
    comprador: {
      nome: 'Comprador de Teste', email: `c.${Date.now()}.${Math.random()}@exemplo.com`,
      documento: cpf(), telefone: '73998260963',
    },
    forma: 'pix',
    ...body,
  })
  const corpo = await r.json().catch(() => ({}))
  return { status: r.status, recado: corpo.statusMessage ?? corpo.message ?? '', corpo }
}

beforeAll(async () => {
  orgId = (await q1<any>(
    `INSERT INTO organizations (name, slug) VALUES ('ZZ Checkout', 'zz-checkout-' || gen_random_uuid())
     RETURNING id`))!.id
  eventId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online)
     VALUES ($1, 'ZZ Limites do Checkout', $2, 'ativo',
             now() + interval '10 days', now() + interval '11 days', 1000, 'repassar')
     RETURNING id`, [orgId, SLUG]))!.id
  sectorId = (await q1<any>(
    `INSERT INTO sectors (event_id, name) VALUES ($1, 'Pista') RETURNING id`, [eventId]))!.id
  lotId = (await q1<any>(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
     VALUES ($1, 'Lote Único', 10000, 500, 50, '{online}') RETURNING id`, [sectorId]))!.id
  tipoId = (await q1<any>(
    `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps)
     VALUES ($1, 'Inteira', 500, 0) RETURNING id`, [lotId]))!.id

  try {
    const r = await fetch(`${BASE}/api/e/${SLUG}`, { signal: AbortSignal.timeout(3000) })
    noAr = r.ok
  } catch { noAr = false }
})

afterAll(async () => {
  // Ordem: pedidos primeiro (FK RESTRICT em lots), depois a organização leva
  // evento/setor/lote/cupom junto por CASCATA.
  await q(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [orgId])
  await q(`DELETE FROM tickets WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [orgId])
  await q(`DELETE FROM orders WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

/** Zera o mundo do cupom entre os testes: sem pedidos, sem cupons. */
beforeEach(async () => {
  await q(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [orgId])
  await q(`DELETE FROM tickets WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [orgId])
  await q(`DELETE FROM orders WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM promo_codes WHERE event_id = $1`, [eventId])
  await q(`UPDATE lots SET sold = 0, reserved = 0, limit_by_document = false,
                           max_per_document = NULL WHERE id = $1`, [lotId])
  await q(`UPDATE ticket_types SET sold = 0, max_per_customer = NULL WHERE id = $1`, [tipoId])
  await q(`UPDATE events SET max_per_customer = NULL, max_per_order = NULL,
                             sales_end_at = NULL, sales_end_minutes_after = NULL,
                             starts_at = now() + interval '10 days',
                             ends_at = now() + interval '11 days' WHERE id = $1`, [eventId])
  await q(`UPDATE sectors SET max_per_customer = NULL WHERE id = $1`, [sectorId])
})

async function novoCupom(over: Record<string, any> = {}): Promise<string> {
  const c = {
    code: 'ZZ' + Math.floor(Math.random() * 1e6), kind: 'percentual', value: 1000,
    max_uses: null, max_per_customer: 1, starts_at: null, ends_at: null,
    active: true, lot_ids: [], max_discount_cents: null, ...over,
  }
  await q(
    `INSERT INTO promo_codes (event_id, code, kind, value, max_uses, max_per_customer,
                              starts_at, ends_at, active, lot_ids, max_discount_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [eventId, c.code, c.kind, c.value, c.max_uses, c.max_per_customer,
     c.starts_at, c.ends_at, c.active, c.lot_ids, c.max_discount_cents])
  return c.code
}

/**
 * Um pedido de verdade usando o cupom, do jeito que o checkout grava: cliente
 * com CPF, pedido com `promo_code_id`, item. É ele que a contagem enxerga.
 */
async function pedidoComCupom(
  codigo: string, documento: string, status = 'aguardando_pagamento',
): Promise<string> {
  const cupom = await q1<any>(
    `SELECT id FROM promo_codes WHERE event_id = $1 AND code = $2`, [eventId, codigo])
  const cliente = await q1<any>(
    `INSERT INTO customers (org_id, name, email, document)
     VALUES ($1, 'Fulano', 'f.' || gen_random_uuid() || '@exemplo.com', $2) RETURNING id`,
    [orgId, documento])
  const ped = await q1<any>(
    `INSERT INTO orders (org_id, event_id, customer_id, code, status, channel,
                         face_cents, fee_cents, platform_cents, discount_cents, total_cents,
                         promo_code_id, expires_at)
     VALUES ($1,$2,$3,'ZZ'||substr(gen_random_uuid()::text,1,10),$4,'online',
             10000, 1000, 1000, 1000, 10000, $5, now() + interval '20 minutes')
     RETURNING id`, [orgId, eventId, cliente!.id, status, cupom!.id])
  await q(`INSERT INTO order_items (order_id, lot_id, quantity,
                                    unit_face_cents, unit_fee_cents, unit_total_cents)
           VALUES ($1, $2, 1, 10000, 1000, 11000)`, [ped!.id, lotId])
  return ped!.id
}

const resgate = (over: Record<string, any> = {}) => ({
  eventId, codigo: '', documento: cpf(), lotIdsDoPedido: [lotId], ...over,
})

/* ====================================================================== */
/* 1. a régua do cupom, contra o banco                                    */
/* ====================================================================== */

describe('cupom — validade conferida no servidor', () => {
  it('cupom que não existe não passa (e o recado diz pra conferir as letras)', async () => {
    await expect(tx((c) => resgatarCupom(c, resgate({ codigo: 'NAOEXISTE' }))))
      .rejects.toThrow(/Não encontramos o cupom NAOEXISTE/)
  })

  it('cupom desligado não vale mesmo com o código certo', async () => {
    const codigo = await novoCupom({ active: false })
    await expect(tx((c) => resgatarCupom(c, resgate({ codigo }))))
      .rejects.toMatchObject({ motivo: 'inativo', status: 409 })
  })

  it('cupom vencido é recusado com a data do vencimento', async () => {
    const codigo = await novoCupom({ ends_at: new Date(Date.now() - 86_400_000) })
    const erro = await tx((c) => resgatarCupom(c, resgate({ codigo }))).catch((e) => e)
    expect(erro).toBeInstanceOf(CupomRecusado)
    expect(erro.motivo).toBe('vencido')
    expect(erro.recado).toMatch(/venceu em \d{2}\/\d{2}\/\d{4}/)
  })

  it('cupom que ainda não começou não vale (e diz a partir de quando)', async () => {
    const codigo = await novoCupom({ starts_at: new Date(Date.now() + 86_400_000) })
    const erro = await tx((c) => resgatarCupom(c, resgate({ codigo }))).catch((e) => e)
    expect(erro.motivo).toBe('cedo_demais')
    expect(erro.recado).toMatch(/só começa a valer em/)
  })

  it('cupom preso a outro lote não vale para estes ingressos', async () => {
    const outro = (await q1<any>(
      `INSERT INTO lots (sector_id, name, price_cents, quantity)
       VALUES ($1, 'Outro ' || gen_random_uuid(), 5000, 10) RETURNING id`, [sectorId]))!.id
    const codigo = await novoCupom({ lot_ids: [outro] })
    await expect(tx((c) => resgatarCupom(c, resgate({ codigo }))))
      .rejects.toMatchObject({ motivo: 'lote_de_fora', status: 422 })
    await q(`DELETE FROM lots WHERE id = $1`, [outro])
  })
})

describe('cupom — a contagem de uso sai do banco, não do contador', () => {
  it('limite de usos estourado recusa MESMO com promo_codes.uses zerado', async () => {
    const codigo = await novoCupom({ max_uses: 1, max_per_customer: 5 })
    await pedidoComCupom(codigo, cpf())

    // O contador da tabela é placar e anda pros dois lados por caminhos
    // diferentes (o cancelamento subtrai, a tela de edição regrava a linha).
    // Zerar ele na mão é exatamente o estado em que o cupom esgotado voltava
    // a valer. A trava tem que continuar de pé.
    await q(`UPDATE promo_codes SET uses = 0 WHERE event_id = $1 AND code = $2`, [eventId, codigo])

    const erro = await tx((c) => resgatarCupom(c, resgate({ codigo }))).catch((e) => e)
    expect(erro).toBeInstanceOf(CupomRecusado)
    expect(erro.motivo).toBe('esgotado')
    expect(erro.recado).toMatch(/limite de 1 usos/)
  })

  it('o mesmo CPF não usa o cupom duas vezes', async () => {
    const codigo = await novoCupom({ max_per_customer: 1 })
    const doc = cpf()
    await pedidoComCupom(codigo, doc)

    await expect(tx((c) => resgatarCupom(c, resgate({ codigo, documento: doc }))))
      .rejects.toMatchObject({ motivo: 'uma_vez_por_pessoa', status: 409 })

    // e outra pessoa continua podendo usar
    const outro = await tx((c) => resgatarCupom(c, resgate({ codigo, documento: cpf() })))
    expect(outro.codigo).toBe(codigo)
  })

  it('max_per_customer = 2 deixa a segunda compra passar e recusa a terceira', async () => {
    const codigo = await novoCupom({ max_per_customer: 2 })
    const doc = cpf()
    await pedidoComCupom(codigo, doc)
    await expect(tx((c) => resgatarCupom(c, resgate({ codigo, documento: doc }))))
      .resolves.toMatchObject({ codigo })

    await pedidoComCupom(codigo, doc)
    await expect(tx((c) => resgatarCupom(c, resgate({ codigo, documento: doc }))))
      .rejects.toMatchObject({ motivo: 'uma_vez_por_pessoa' })
  })

  it('carrinho que expirou devolve o uso do cupom', async () => {
    const codigo = await novoCupom({ max_uses: 1, max_per_customer: 5 })
    const pedido = await pedidoComCupom(codigo, cpf())
    await expect(tx((c) => resgatarCupom(c, resgate({ codigo })))).rejects.toThrow(/limite de 1 usos/)

    await q(`UPDATE orders SET status = 'expirado' WHERE id = $1`, [pedido])
    await expect(tx((c) => resgatarCupom(c, resgate({ codigo })))).resolves.toMatchObject({ codigo })
  })

  it('pedido pendente CONTA — senão o cambista abre trinta carrinhos', async () => {
    // A lista está aqui de propósito: se alguém tirar 'aguardando_pagamento'
    // dela, o cupom de 100% vira grátis pra quem nunca paga.
    expect(PEDIDO_EM_PE).toContain('aguardando_pagamento')
    expect(PEDIDO_EM_PE).toContain('estornado_parcial')
    expect(PEDIDO_EM_PE).not.toContain('expirado')
    expect(PEDIDO_EM_PE).not.toContain('cancelado')
  })
})

describe('CONCORRÊNCIA — a trava do cupom vem antes da contagem', () => {
  /**
   * Duas conexões do pool com a ordem forçada na mão. `Promise.all` com dois
   * `fetch` não serve: eles não chegam juntos no servidor de dev, o primeiro
   * já gravou quando o segundo lê, e o teste fica verde sem exercitar trava
   * nenhuma.
   */
  it('o segundo espera o primeiro gravar — e aí o cupom já acabou', async () => {
    const codigo = await novoCupom({ max_uses: 1, max_per_customer: 9 })
    const a = await db().connect()
    const b = await db().connect()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')

      // A trava a linha do cupom e conta: ninguém usou ainda.
      const primeiro = await resgatarCupom(a, resgate({ codigo }))
      expect(primeiro.codigo).toBe(codigo)

      // B tenta a MESMA linha e fica pendurado no FOR UPDATE.
      const segundo = b.query(SQL_TRAVA_CUPOM, [eventId, codigo])
      let passou = false
      segundo.then(() => { passou = true }).catch(() => {})
      await new Promise((r) => setTimeout(r, 250))
      expect(passou, 'a segunda conexão não devia passar da trava com a primeira aberta')
        .toBe(false)

      // A grava o pedido e confirma; só então B anda.
      const cliente = await a.query(
        `INSERT INTO customers (org_id, name, email, document)
         VALUES ($1,'Primeiro','p.'||gen_random_uuid()||'@exemplo.com',$2) RETURNING id`,
        [orgId, cpf()])
      const ped = await a.query(
        `INSERT INTO orders (org_id, event_id, customer_id, code, status, channel,
                             face_cents, fee_cents, platform_cents, discount_cents, total_cents,
                             promo_code_id, expires_at)
         VALUES ($1,$2,$3,'ZZ'||substr(gen_random_uuid()::text,1,10),'aguardando_pagamento',
                 'online',10000,1000,1000,1000,10000,
                 (SELECT id FROM promo_codes WHERE event_id = $2 AND code = $4),
                 now() + interval '20 minutes')
         RETURNING id`, [orgId, eventId, cliente.rows[0].id, codigo])
      expect(ped.rows[0].id).toBeTruthy()
      await a.query('COMMIT')
      await segundo

      // B agora refaz a conta COM o pedido do A já gravado.
      await expect(resgatarCupom(b, resgate({ codigo })))
        .rejects.toMatchObject({ motivo: 'esgotado' })
    } finally {
      // ROLLBACK no finally, sempre: `release()` não desfaz transação aberta,
      // e um FOR UPDATE preso na conexão devolvida trava o caso seguinte até
      // o timeout.
      await a.query('ROLLBACK').catch(() => {})
      await b.query('ROLLBACK').catch(() => {})
      a.release(); b.release()
    }
  })
})

/* ====================================================================== */
/* 2. o desconto nunca passa da face                                      */
/* ====================================================================== */

describe('desconto — o teto e a faixa', () => {
  const linhas = [{ quantidade: 10, faceUnitCents: 10_000 }] // R$ 1.000 de face

  it('cupom percentual respeita o teto de desconto em centavos', () => {
    const semTeto = aplicarCupom(linhas, 1000, 'repassar',
      { id: 'x', codigo: 'X', kind: 'percentual', value: 2000, maxDiscountCents: null })
    expect(semTeto.discountCents).toBe(20_000)   // 20% de R$ 1.000

    const comTeto = aplicarCupom(linhas, 1000, 'repassar',
      { id: 'x', codigo: 'X', kind: 'percentual', value: 2000, maxDiscountCents: 3_000 })
    expect(comTeto.discountCents).toBe(3_000)    // "20% até R$ 30"
    expect(comTeto.totalCents).toBe(comTeto.faceCents + comTeto.feeCents - 3_000)
  })

  it('teto maior que o desconto não mexe em nada', () => {
    const t = aplicarCupom(linhas, 1000, 'repassar',
      { id: 'x', codigo: 'X', kind: 'percentual', value: 500, maxDiscountCents: 90_000 })
    expect(t.discountCents).toBe(5_000)
  })

  it('cupom fixo maior que a face não deixa o total negativo', () => {
    const t = aplicarCupom([{ quantidade: 1, faceUnitCents: 3_000 }], 1000, 'repassar',
      { id: 'x', codigo: 'X', kind: 'fixo', value: 999_999, maxDiscountCents: null })
    expect(t.discountCents).toBe(3_000)          // no máximo a face inteira
    expect(t.discountCents).toBeLessThanOrEqual(t.faceCents)
    expect(t.totalCents).toBeGreaterThanOrEqual(0)
    expect(t.totalCents).toBe(t.feeCents)        // sobra só a taxa
  })

  it('cupom de 100% zera a face e o pedido não fica devendo', () => {
    const t = aplicarCupom([{ quantidade: 2, faceUnitCents: 5_000 }], 1000, 'absorver',
      { id: 'x', codigo: 'X', kind: 'percentual', value: 10_000, maxDiscountCents: null })
    expect(t.discountCents).toBe(t.faceCents)
    expect(t.totalCents).toBe(0)
  })
})

describe('a rede do banco (migração 014)', () => {
  it('o banco recusa pedido com desconto maior que a face', async () => {
    await expect(q(
      `INSERT INTO orders (org_id, event_id, code, status, channel,
                           face_cents, fee_cents, platform_cents, discount_cents, total_cents)
       VALUES ($1,$2,'ZZREDE1','rascunho','online', 1000, 0, 100, 5000, -4000)`,
      [orgId, eventId])).rejects.toThrow()
  })

  it('o banco recusa pedido com total negativo', async () => {
    // Passa no `total_fecha` (100 + 0 − 200 = −100) e mesmo assim não entra.
    await expect(q(
      `INSERT INTO orders (org_id, event_id, code, status, channel,
                           face_cents, fee_cents, platform_cents, discount_cents, total_cents)
       VALUES ($1,$2,'ZZREDE2','rascunho','online', 100, 0, 10, 200, -100)`,
      [orgId, eventId])).rejects.toThrow()
  })
})

/* ====================================================================== */
/* 3. a rota inteira, pela HTTP                                           */
/* ====================================================================== */

describe('checkout pela HTTP — o que ele recusa', () => {
  const pular = () => {
    if (!noAr) console.warn('  (pulado: servidor fora do ar em ' + BASE + ')')
    return !noAr
  }

  it('não deixa um pedido só levar o lote inteiro', async () => {
    if (pular()) return
    const r = await comprar({
      itens: [
        { lotId, quantidade: 15 },
        { lotId, quantidade: 15 },
      ],
    })
    expect(r.status).toBe(409)
    expect(r.recado).toMatch(new RegExp(`no máximo ${TETO_PADRAO_POR_PEDIDO} ingressos`))
    expect(r.recado).toMatch(/30/)               // diz quanto a pessoa pediu
    expect(r.corpo.data?.tipo).toBe('teto_por_pedido')
  })

  it('respeita o teto por pedido configurado no evento', async () => {
    if (pular()) return
    await q(`UPDATE events SET max_per_order = 4 WHERE id = $1`, [eventId])
    expect((await comprar({ itens: [{ lotId, quantidade: 5 }] })).status).toBe(409)
    expect((await comprar({ itens: [{ lotId, quantidade: 4 }] })).status).toBe(200)
  })

  it('teto por CPF no evento soma o que a pessoa JÁ tem — não só este pedido', async () => {
    if (pular()) return
    await q(`UPDATE events SET max_per_customer = 3 WHERE id = $1`, [eventId])
    const doc = cpf()
    const email = `mesmo.${Date.now()}@exemplo.com`

    const um = await comprar({ itens: [{ lotId, quantidade: 2 }],
      comprador: { nome: 'Mesma Pessoa', email, documento: doc, telefone: '73998260963' } })
    expect(um.status).toBe(200)

    const dois = await comprar({ itens: [{ lotId, quantidade: 2 }],
      comprador: { nome: 'Mesma Pessoa', email, documento: doc, telefone: '73998260963' } })
    expect(dois.status).toBe(409)
    expect(dois.recado).toMatch(/no máximo 3 ingressos neste evento/)
    expect(dois.recado).toMatch(/já tem 2/)
    expect(dois.recado).toMatch(/Ainda dá para levar 1/)
  })

  it('teto por CPF no LOTE (limit_by_document) finalmente recusa', async () => {
    if (pular()) return
    await q(`UPDATE lots SET limit_by_document = true, max_per_document = 2 WHERE id = $1`, [lotId])
    const doc = cpf()
    const email = `lote.${Date.now()}@exemplo.com`
    const comprador = { nome: 'Pessoa Do Lote', email, documento: doc, telefone: '73998260963' }

    expect((await comprar({ itens: [{ lotId, quantidade: 2 }], comprador })).status).toBe(200)
    const r = await comprar({ itens: [{ lotId, quantidade: 1 }], comprador })
    expect(r.status).toBe(409)
    expect(r.recado).toMatch(/no máximo 2 de "Lote Único"/)
  })

  it('teto por CPF no TIPO de ingresso deixa de ser decoração', async () => {
    if (pular()) return
    await q(`UPDATE ticket_types SET max_per_customer = 1 WHERE id = $1`, [tipoId])
    const doc = cpf()
    const email = `tipo.${Date.now()}@exemplo.com`
    const comprador = { nome: 'Pessoa Do Tipo', email, documento: doc, telefone: '73998260963' }

    expect((await comprar({ itens: [{ lotId, ticketTypeId: tipoId, quantidade: 1 }], comprador })).status)
      .toBe(200)
    const r = await comprar({ itens: [{ lotId, ticketTypeId: tipoId, quantidade: 1 }], comprador })
    expect(r.status).toBe(409)
    expect(r.recado).toMatch(/no máximo 1 de Inteira/)
  })

  /**
   * Que o teto por CPF recusa, os testes acima provam. Este prova a outra
   * metade: que ele é decidido COM A TRAVA NA MÃO, e não num `SELECT` solto
   * antes da transação — que é como ele estava, e que passa em teste
   * sequencial sem segurar nada.
   *
   * Dois `fetch` em `Promise.all` não serviriam: eles não chegam juntos no
   * servidor de dev, o primeiro já gravou quando o segundo lê e o teste fica
   * verde sem exercitar serialização nenhuma. Aqui o teste SEGURA a mesma
   * trava que a rota pega (mesmo par evento+CPF) e exige que a rota espere.
   * Tirar o `pg_advisory_xact_lock` da rota faz a compra responder na hora e
   * este teste ficar vermelho.
   */
  it('o teto por CPF é decidido com a trava na mão — a rota espera', async () => {
    if (pular()) return
    await q(`UPDATE events SET max_per_customer = 5 WHERE id = $1`, [eventId])
    const doc = cpf()
    const comprador = {
      nome: 'Pessoa Da Trava', email: `trava.${Date.now()}@exemplo.com`,
      documento: doc, telefone: '73998260963',
    }

    const trava = await db().connect()
    let respondeu = false
    let resposta: Promise<Response>
    try {
      await trava.query('BEGIN')
      await trava.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [eventId, doc])

      resposta = post('/api/checkout', {
        eventSlug: SLUG, itens: [{ lotId, quantidade: 1 }], comprador, forma: 'pix',
      })
      resposta.then(() => { respondeu = true }, () => { respondeu = true })

      await new Promise((r) => setTimeout(r, 700))
      expect(respondeu, 'a rota decidiu o teto por CPF sem pegar a trava do par evento+CPF')
        .toBe(false)
    } finally {
      // ROLLBACK no finally: `release()` não desfaz transação aberta, e a
      // trava presa na conexão devolvida travaria o caso seguinte até o
      // timeout.
      await trava.query('ROLLBACK').catch(() => {})
      trava.release()
    }
    const r = await resposta!
    expect(r.status).toBe(200)
  })

  it('evento que já terminou não vende ingresso', async () => {
    if (pular()) return
    await q(`UPDATE events SET starts_at = now() - interval '2 days',
                               ends_at = now() - interval '1 day' WHERE id = $1`, [eventId])
    const r = await comprar({ itens: [{ lotId, quantidade: 1 }] })
    expect(r.status).toBe(409)
    expect(r.recado).toMatch(/Este evento terminou em \d{2}\/\d{2}\/\d{4}/)
  })

  it('evento com "venda até X minutos depois do início" fecha na hora certa', async () => {
    if (pular()) return
    // Começou há 3 horas, vende até 60 minutos depois do início: fechado.
    // `sales_end_at` continua NULO — era exatamente este o caso que o checkout
    // não enxergava e vendia ingresso pra sessão que já tinha rolado.
    await q(`UPDATE events SET starts_at = now() - interval '3 hours',
                               ends_at = now() + interval '3 hours',
                               sales_end_at = NULL,
                               sales_end_minutes_after = 60 WHERE id = $1`, [eventId])
    const r = await comprar({ itens: [{ lotId, quantidade: 1 }] })
    expect(r.status).toBe(409)
    expect(r.recado).toMatch(/As vendas deste evento encerraram em/)
  })

  it('cupom bom desconta de verdade, e o teto do cupom segura o desconto', async () => {
    if (pular()) return
    const codigo = await novoCupom({ kind: 'percentual', value: 5000, max_discount_cents: 1500 })
    const r = await comprar({ itens: [{ lotId, quantidade: 2 }], cupom: codigo })
    expect(r.status).toBe(200)
    // face 2 × R$ 100 = R$ 200; 50% seriam R$ 100, mas o teto é R$ 15
    expect(r.corpo.faceCents).toBe(20_000)
    expect(r.corpo.descontoCents).toBe(1_500)
    expect(r.corpo.totalCents).toBe(20_000 + r.corpo.feeCents - 1_500)
  })

  it('o mesmo CPF não reusa o cupom pela rota (era o buraco do dinheiro)', async () => {
    if (pular()) return
    const codigo = await novoCupom({ max_per_customer: 1 })
    const doc = cpf()
    const comprador = {
      nome: 'Reusador', email: `reuso.${Date.now()}@exemplo.com`,
      documento: doc, telefone: '73998260963',
    }
    expect((await comprar({ itens: [{ lotId, quantidade: 1 }], cupom: codigo, comprador })).status)
      .toBe(200)

    // Outro e-mail, MESMO CPF: é a pessoa que tem limite, não o cadastro.
    const r = await comprar({
      itens: [{ lotId, quantidade: 1 }], cupom: codigo,
      comprador: { ...comprador, email: `reuso2.${Date.now()}@exemplo.com` },
    })
    expect(r.status).toBe(409)
    expect(r.recado).toMatch(/já usou o cupom/)
    expect(r.corpo.data?.tipo).toBe('cupom')
  })

  /**
   * O teto por CPF conta com um `JOIN customers`, e a linha do cliente é achada
   * pelo E-MAIL. Enquanto o upsert do checkout reescrevia `customers.document`
   * com o CPF de quem chegou por último, cada compra REESCREVIA O PASSADO: os
   * pedidos antigos daquele e-mail passavam a contar pro CPF novo e paravam de
   * contar pro antigo.
   *
   * Medido na rota, com `max_per_customer = 2`: alternar dois CPFs no mesmo
   * e-mail devolveu 200 em todas as rodadas e o CPF A levou 4 ingressos.
   * Alternando, não acabava nunca.
   */
  it('trocar o CPF no mesmo e-mail não zera o teto por CPF', async () => {
    if (pular()) return
    await q(`UPDATE events SET max_per_customer = 2 WHERE id = $1`, [eventId])
    const a = cpf(), b = cpf()
    const email = `mesma.caixa.${Date.now()}@exemplo.com`
    const como = (documento: string) =>
      ({ nome: 'Mesma Caixa De Entrada', email, documento, telefone: '73998260963' })

    expect((await comprar({ itens: [{ lotId, quantidade: 2 }], comprador: como(a) })).status).toBe(200)

    // CPF diferente num e-mail que já tem dono: para aqui, com recado.
    const trocado = await comprar({ itens: [{ lotId, quantidade: 2 }], comprador: como(b) })
    expect(trocado.status).toBe(409)
    expect(trocado.corpo.data?.tipo).toBe('email_de_outro_cpf')

    // e o CPF de verdade continua preso ao teto dele — a contagem não sumiu
    const volta = await comprar({ itens: [{ lotId, quantidade: 2 }], comprador: como(a) })
    expect(volta.status).toBe(409)
    expect(volta.recado).toMatch(/já tem 2/)

    // o documento gravado é o de quem abriu o cadastro, não o do último
    const cadastro = await q1<any>(
      `SELECT document FROM customers WHERE org_id = $1 AND email = $2`, [orgId, email])
    expect(cadastro!.document).toBe(a)
  })

  /**
   * A outra metade do mesmo defeito, e a pior de ler: `resgatarCupom` roda
   * DEPOIS do upsert do cliente. Com o documento sendo reescrito, o CPF novo
   * herdava na hora o uso do CPF antigo e o comprador lia "Este CPF já usou o
   * cupom" — sobre um CPF que nunca tinha usado nada. Recado falso é pior que
   * recusa: manda o comprador conferir uma coisa que está certa.
   */
  it('cupom não acusa de reuso um CPF que nunca usou', async () => {
    if (pular()) return
    const codigo = await novoCupom({ max_per_customer: 1 })
    const a = cpf(), b = cpf()
    const email = `familia.${Date.now()}@exemplo.com`
    const como = (documento: string) =>
      ({ nome: 'Familia Inteira', email, documento, telefone: '73998260963' })

    expect((await comprar({
      itens: [{ lotId, quantidade: 1 }], cupom: codigo, comprador: como(a) })).status).toBe(200)

    const r = await comprar({ itens: [{ lotId, quantidade: 1 }], cupom: codigo, comprador: como(b) })
    expect(r.status).toBe(409)
    expect(r.recado).not.toMatch(/já usou o cupom/)
    expect(r.corpo.data?.tipo).toBe('email_de_outro_cpf')
  })

  it('cupom recusado NÃO deixa estoque preso', async () => {
    if (pular()) return
    const codigo = await novoCupom({ active: false })
    const antes = await q1<any>(`SELECT sold, reserved FROM lots WHERE id = $1`, [lotId])
    const r = await comprar({ itens: [{ lotId, quantidade: 3 }], cupom: codigo })
    expect(r.status).toBe(409)
    const depois = await q1<any>(`SELECT sold, reserved FROM lots WHERE id = $1`, [lotId])
    expect(depois).toEqual(antes)
  })
})
