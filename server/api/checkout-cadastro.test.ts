/**
 * checkout-cadastro.test.ts — o cadastro do cliente, do formulário ao banco.
 *
 * O que está travado aqui não é "gravou": é o que o segundo cliente NÃO consegue
 * fazer com a linha do primeiro.
 *
 *   · a senha já gravada não é trocada por quem compra de novo com o mesmo e-mail
 *     (o formulário não prova que o e-mail é de quem digitou);
 *   · comprar de novo só com nome e CPF não apaga o endereço nem a idade;
 *   · o endereço é um bloco: o novo substitui o velho INTEIRO;
 *   · o consentimento de novidades só muda quando a pessoa se manifesta, e o
 *     carimbo só anda quando o valor muda;
 *   · cadastro inválido recusa ANTES de tocar no banco: nada de cliente pela
 *     metade nem pedido órfão.
 *
 * Vai pela HTTP, que é onde o comprador está. Sem servidor de dev no ar PULA.
 */
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1 } from '../utils/db'
import { anunciarPulo, seForaDoArPula, sondarServidor, type Sonda } from '../../scripts/test-setup'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
const SLUG = 'zz-checkout-cadastro'

let orgId: string, eventId: string, lotId: string, tipoId: string
let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let contador = 0

function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

/** e-mail deste arquivo: nunca colide com o de outra suíte */
const novoEmail = () => `cadastro.checkout.${Date.now()}.${++contador}@teste.invalido`

/** Um comprador; `extra` entra dentro de `comprador` (é onde o formulário manda o cadastro). */
async function comprar(base: { email: string; documento: string }, extra: Record<string, any> = {}) {
  const r = await fetch(`${BASE}/api/checkout`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventSlug: SLUG,
      itens: [{ lotId, ticketTypeId: tipoId, quantidade: 1 }],
      comprador: { nome: 'Maria de Teste', telefone: '73998260963', ...base, ...extra },
      forma: 'pix',
    }),
  })
  const corpo = await r.json().catch(() => ({}))
  return { status: r.status, recado: corpo.statusMessage ?? '', corpo }
}

const cliente = (email: string) => q1<any>(
  `SELECT birth_date::text AS birth_date, instagram, zip_code, street, address_number,
          neighborhood, city, state, address_complement, password_hash, registered_at,
          marketing_opt_in, marketing_opt_in_at::text AS marketing_opt_in_at
     FROM customers WHERE org_id = $1 AND email = $2`, [orgId, email])

const CADASTRO = {
  nascimento: '1990-12-25',
  instagram: '@Maria.Souza',
  endereco: {
    cep: '45000-000', rua: 'Rua das Flores', numero: '120', bairro: 'Centro',
    cidade: 'VITÓRIA DA CONQUISTA', estado: 'ba', complemento: 'Apto 3',
  },
  senha: 'cachoeira2026',
  aceitaNovidades: true,
}

beforeAll(async () => {
  orgId = (await q1<any>(
    `INSERT INTO organizations (name, slug) VALUES ('ZZ Checkout Cadastro', 'zz-cadastro-' || gen_random_uuid())
     RETURNING id`))!.id
  eventId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online)
     VALUES ($1, 'ZZ Cadastro do Checkout', $2, 'ativo',
             now() + interval '10 days', now() + interval '11 days', 1000, 'repassar')
     RETURNING id`, [orgId, SLUG]))!.id
  const setor = (await q1<any>(
    `INSERT INTO sectors (event_id, name) VALUES ($1, 'Pista') RETURNING id`, [eventId]))!.id
  lotId = (await q1<any>(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
     VALUES ($1, 'Lote Único', 10000, 500, 50, '{online}') RETURNING id`, [setor]))!.id
  tipoId = (await q1<any>(`INSERT INTO ticket_types (lot_id, name, quantity, discount_bps)
            VALUES ($1, 'Inteira', 500, 0) RETURNING id`, [lotId]))!.id
  sonda = await sondarServidor(`/api/e/${SLUG}`)
  anunciarPulo('server/api/checkout-cadastro.test.ts', sonda)
})

afterAll(async () => {
  await q(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [orgId])
  await q(`DELETE FROM tickets WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [orgId])
  await q(`DELETE FROM orders WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM customers WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

describe('checkout — o cadastro grava certo', () => {
  it('grava tudo padronizado e guarda a senha só como hash', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail()
    const r = await comprar({ email, documento: cpf() }, CADASTRO)
    expect(r.status, r.recado).toBe(200)

    const c = await cliente(email)
    expect(c.birth_date).toBe('1990-12-25')
    expect(c.instagram).toBe('maria.souza')
    expect(c.zip_code).toBe('45000000')
    expect(c.state).toBe('BA')
    expect(c.city).toBe('Vitória da Conquista')
    expect(c.street).toBe('Rua das Flores')
    expect(c.address_number).toBe('120')
    expect(c.neighborhood).toBe('Centro')
    expect(c.address_complement).toBe('Apto 3')
    expect(c.registered_at).not.toBeNull()
    expect(c.marketing_opt_in).toBe(true)
    expect(c.marketing_opt_in_at).not.toBeNull()

    // a senha nunca fica em texto, e o hash confere com a que foi digitada
    expect(c.password_hash).not.toContain('cachoeira2026')
    expect(await bcrypt.compare('cachoeira2026', c.password_hash)).toBe(true)
    expect(await bcrypt.compare('outra-senha-qualquer', c.password_hash)).toBe(false)
  })

  it('comprar sem cadastro continua funcionando e não inventa nada', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail()
    const r = await comprar({ email, documento: cpf() })
    expect(r.status, r.recado).toBe(200)
    const c = await cliente(email)
    expect(c).toMatchObject({
      birth_date: null, instagram: null, zip_code: null, city: null, state: null,
      password_hash: null, registered_at: null, marketing_opt_in: false, marketing_opt_in_at: null,
    })
  })
})

describe('checkout — quem compra de novo não estraga o cadastro', () => {
  it('a senha já gravada NÃO é trocada por outra compra com o mesmo e-mail', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail(), documento = cpf()
    expect((await comprar({ email, documento }, CADASTRO)).status).toBe(200)
    const antes = (await cliente(email)).password_hash

    const r = await comprar({ email, documento }, { ...CADASTRO, senha: 'outra-senha-2026' })
    expect(r.status, r.recado).toBe(200)

    const depois = (await cliente(email)).password_hash
    expect(depois).toBe(antes)
    expect(await bcrypt.compare('cachoeira2026', depois)).toBe(true)
    expect(await bcrypt.compare('outra-senha-2026', depois)).toBe(false)
  })

  it('compra só com nome e CPF não apaga endereço, idade nem Instagram', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail(), documento = cpf()
    await comprar({ email, documento }, CADASTRO)
    expect((await comprar({ email, documento })).status).toBe(200)

    const c = await cliente(email)
    expect(c.birth_date).toBe('1990-12-25')
    expect(c.instagram).toBe('maria.souza')
    expect(c.city).toBe('Vitória da Conquista')
    expect(c.street).toBe('Rua das Flores')
    expect(c.password_hash).not.toBeNull()
  })

  it('o endereço novo substitui o velho INTEIRO — nada de rua de uma cidade em outra', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail(), documento = cpf()
    await comprar({ email, documento }, CADASTRO)
    // só cidade e UF: rua, número, bairro e CEP do endereço velho têm que sumir
    const r = await comprar({ email, documento }, { endereco: { cidade: 'Salvador', estado: 'BA' } })
    expect(r.status, r.recado).toBe(200)

    const c = await cliente(email)
    expect(c.city).toBe('Salvador')
    expect(c.street).toBeNull()
    expect(c.address_number).toBeNull()
    expect(c.neighborhood).toBeNull()
    expect(c.zip_code).toBeNull()
    expect(c.address_complement).toBeNull()
  })
})

describe('checkout — consentimento de novidades (LGPD)', () => {
  it('só muda quando a pessoa se manifesta, e o carimbo só anda quando o valor muda', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail(), documento = cpf()

    await comprar({ email, documento }, { aceitaNovidades: true })
    const dito = await cliente(email)
    expect(dito.marketing_opt_in).toBe(true)
    const carimbo = dito.marketing_opt_in_at
    expect(carimbo).not.toBeNull()

    // não se manifestou: nada muda
    await comprar({ email, documento })
    const calado = await cliente(email)
    expect(calado.marketing_opt_in).toBe(true)
    expect(calado.marketing_opt_in_at).toBe(carimbo)

    // repetiu o "sim": o carimbo NÃO anda (a data do consentimento é a primeira)
    await comprar({ email, documento }, { aceitaNovidades: true })
    expect((await cliente(email)).marketing_opt_in_at).toBe(carimbo)

    // disse não: muda e o carimbo anda
    await comprar({ email, documento }, { aceitaNovidades: false })
    const nao = await cliente(email)
    expect(nao.marketing_opt_in).toBe(false)
    expect(nao.marketing_opt_in_at).not.toBe(carimbo)
  })

  it('quem nunca se manifestou fica sem consentimento e sem carimbo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail()
    await comprar({ email, documento: cpf() }, { nascimento: '1990-12-25' })
    expect(await cliente(email)).toMatchObject({ marketing_opt_in: false, marketing_opt_in_at: null })
  })
})

describe('checkout — cadastro inválido recusa antes de gravar qualquer coisa', () => {
  async function recusa(extra: Record<string, any>, campo: string, ctx: any) {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail()
    const antes = (await q1<any>(`SELECT count(*)::int AS n FROM orders WHERE org_id = $1`, [orgId]))!.n
    const r = await comprar({ email, documento: cpf() }, extra)
    expect(r.status, r.recado).toBe(400)
    expect(r.corpo.data).toMatchObject({ tipo: 'cadastro', campo })
    // nem cliente pela metade, nem pedido órfão
    expect(await cliente(email)).toBeNull()
    expect((await q1<any>(`SELECT count(*)::int AS n FROM orders WHERE org_id = $1`, [orgId]))!.n).toBe(antes)
  }

  it('nascimento no futuro', async (ctx) => recusa({ nascimento: '2999-01-01' }, 'nascimento', ctx))
  it('data que não existe', async (ctx) => recusa({ nascimento: '2001-02-31' }, 'nascimento', ctx))
  it('senha curta', async (ctx) => recusa({ senha: '123' }, 'senha', ctx))
  it('Instagram com espaço', async (ctx) => recusa({ instagram: 'meu nome' }, 'instagram', ctx))
  it('endereço sem UF', async (ctx) => recusa({ endereco: { cidade: 'Salvador' } }, 'estado', ctx))
  it('UF que não existe', async (ctx) =>
    recusa({ endereco: { cidade: 'Salvador', estado: 'XX' } }, 'estado', ctx))
  it('CEP torto', async (ctx) =>
    recusa({ endereco: { cep: '123', cidade: 'Salvador', estado: 'BA' } }, 'cep', ctx))
})
