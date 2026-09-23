/**
 * Três portas do checkout que a tela segurava sozinha (22/09):
 *
 *  1. **Parcelas.** O servidor aceitava `parcelas: 12` em pedido de R$ 13 (a
 *     tela limita pelo piso de R$ 5 por parcela do Asaas) e aceitava parcelas
 *     no PIX — que no Asaas vira CARNÊ, e o ingresso só sai na última parcela.
 *  2. **Lote com tipos, item sem tipo.** Passava pelo preço cheio do lote sem
 *     sair da cota de nenhuma variação.
 *  3. **E-mail de outro CPF.** A recusa dizia "final 42" do CPF de outra
 *     pessoa pra quem digitasse o e-mail dela.
 *
 * Mais a trava de paridade: o piso da tela (`pagamento.vue`) e o do servidor
 * são dois números no código, e este teste fica vermelho se um andar sem o
 * outro.
 *
 * Fixture própria (ZZQA), apagada no fim. Gateway simulado (a organização da
 * fixture não tem chave do Asaas).
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda,
} from '../../scripts/test-setup'

/**
 * A conta vem da ROTA, não de uma cópia: a rota chama `defineEventHandler` no
 * topo (global do Nitro), então o global é emprestado só pra importar.
 */
;(globalThis as any).defineEventHandler ??= (h: any) => h
const { maxParcelas, PARCELA_MINIMA_CENTS, parcelasDoPedido } = await import('./checkout.post')

const BASE = BASE_DE_TESTE
const ORG = '0000f0a3-0000-4000-8000-000000000001'
const EVENTO = '0000f0a3-0000-4000-8000-000000000002'
const SETOR = '0000f0a3-0000-4000-8000-000000000003'
/** setor próprio: com giro de lote, dois lotes no mesmo setor vendem um por vez */
const SETOR_TIPOS = '0000f0a3-0000-4000-8000-000000000007'
const LOTE_BARATO = '0000f0a3-0000-4000-8000-000000000004'
const LOTE_COM_TIPOS = '0000f0a3-0000-4000-8000-000000000005'
const TIPO_INTEIRA = '0000f0a3-0000-4000-8000-000000000006'
const SLUG = 'zzqa-evento-checkout'

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../utils/db')
  return q<any>(texto, par)
}

function cpf() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

const comprar = (corpo: any) =>
  fetch(`${BASE}/api/checkout`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventSlug: SLUG,
      comprador: { nome: 'ZZQA Comprador', email: `zzqa.${Date.now()}.${Math.random()}@teste.invalido`,
                   documento: cpf() },
      ...corpo,
    }),
  }).then(async (r) => ({ status: r.status, corpo: await r.json().catch(() => ({})) as any }))

async function limpar() {
  await sql(`DELETE FROM tickets WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM customers WHERE org_id = $1`, [ORG])
  await sql(`DELETE FROM events WHERE id = $1`, [EVENTO])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/checkout-parcelas.test.ts', sonda)
  if (!sonda.noAr) return
  await limpar()
  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,'ZZQA CHECKOUT','zzqa-checkout')`,
    [ORG])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, status)
     VALUES ($1,$2,'ZZQA EVENTO CHECKOUT',$3, now() + interval '10 days',
             now() + interval '11 days', 'ativo')`, [EVENTO, ORG, SLUG])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$3,'ZZQA Setor'),
                                                          ($2,$3,'ZZQA Setor Tipos')`,
    [SETOR, SETOR_TIPOS, EVENTO])
  // R$ 12,00 + taxa: dá 2 parcelas pelo piso de R$ 5
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity)
             VALUES ($1,$3,'ZZQA Barato',1200,100), ($2,$4,'ZZQA Com Tipos',4000,100)`,
    [LOTE_BARATO, LOTE_COM_TIPOS, SETOR, SETOR_TIPOS])
  await sql(`INSERT INTO ticket_types (id, lot_id, name, quantity) VALUES ($1,$2,'ZZQA Inteira',50)`,
    [TIPO_INTEIRA, LOTE_COM_TIPOS])
}, 60_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await limpar()
})

describe('parcelas · a mesma conta da tela', () => {
  it('o piso da tela é o piso da porta', () => {
    const tela = readFileSync(new URL('../../app/pages/e/[slug]/pagamento.vue', import.meta.url), 'utf8')
    const m = tela.match(/const PARCELA_MINIMA_CENTS = (\d+)/)
    expect(m, 'a tela parou de declarar o piso — a paridade não tem mais o que comparar').toBeTruthy()
    expect(Number(m![1])).toBe(PARCELA_MINIMA_CENTS)
    expect(tela, 'a tela mudou a conta do teto').toContain(
      'Math.max(1, Math.min(12, Math.floor(total / PARCELA_MINIMA_CENTS)))')
  })

  it('conta pura: piso, teto de 12 e PIX sempre à vista', () => {
    expect(maxParcelas(1320)).toBe(2)
    expect(maxParcelas(499)).toBe(1)
    expect(maxParcelas(1_000_000)).toBe(12)
    expect(parcelasDoPedido('credito', 12, 1320)).toBe(2)
    expect(parcelasDoPedido('credito', 1, 1320)).toBe(1)
    expect(parcelasDoPedido('pix', 6, 1_000_000)).toBe(1)
  })

  it('pedido de R$ 13 em 12× no cartão sai limitado ao teto', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await comprar({
      itens: [{ lotId: LOTE_BARATO, quantidade: 1 }], forma: 'credito', parcelas: 12,
    })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    const [o] = await sql(`SELECT installments, total_cents FROM orders WHERE id = $1`,
      [r.corpo.pedidoId])
    expect(o.installments).toBe(maxParcelas(Number(o.total_cents)))
    expect(o.installments).toBeLessThan(12)
    expect(r.corpo.parcelas).toBe(o.installments)
  }, 30_000)

  it('PIX com parcelas vira à vista (parcelado no PIX é carnê)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await comprar({
      itens: [{ lotId: LOTE_BARATO, quantidade: 4 }], forma: 'pix', parcelas: 3,
    })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    const [o] = await sql(`SELECT installments FROM orders WHERE id = $1`, [r.corpo.pedidoId])
    expect(o.installments).toBe(1)
  }, 30_000)
})

describe('lote com tipos exige o tipo', () => {
  it('item sem ticketTypeId é recusado com 400 claro', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await comprar({ itens: [{ lotId: LOTE_COM_TIPOS, quantidade: 1 }] })
    expect(r.status).toBe(400)
    expect(r.corpo.data?.tipo).toBe('tipo_obrigatorio')
    expect(r.corpo.statusMessage).toMatch(/Escolha o tipo de ingresso/)
  }, 30_000)

  it('com o tipo, passa', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await comprar({
      itens: [{ lotId: LOTE_COM_TIPOS, ticketTypeId: TIPO_INTEIRA, quantidade: 1 }],
    })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
  }, 30_000)
})

describe('e-mail de outro CPF', () => {
  it('recusa sem dizer nenhum dígito do CPF do dono do e-mail', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = `zzqa.dono.${Date.now()}@teste.invalido`
    const doDono = cpf()
    await sql(`INSERT INTO customers (org_id, name, email, document) VALUES ($1,'ZZQA Dono',$2,$3)`,
      [ORG, email, doDono])

    let outro = cpf()
    while (outro === doDono) outro = cpf()
    const r = await fetch(`${BASE}/api/checkout`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventSlug: SLUG, itens: [{ lotId: LOTE_BARATO, quantidade: 1 }],
        comprador: { nome: 'Outra Pessoa', email, documento: outro },
      }),
    }).then(async (x) => ({ status: x.status, corpo: await x.json() as any }))

    expect(r.status).toBe(409)
    expect(r.corpo.statusMessage).toBe(
      'Este e-mail já está cadastrado com outro CPF. Use o CPF do cadastro ou outro e-mail.')
    expect(r.corpo.statusMessage).not.toContain(doDono.slice(-2))
    expect(JSON.stringify(r.corpo)).not.toContain(doDono.slice(-4))
  }, 30_000)
})
