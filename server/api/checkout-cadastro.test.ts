/**
 * checkout-cadastro.test.ts — o cadastro do cliente, do formulário ao banco.
 *
 * O que está travado aqui não é "gravou": é o que o segundo cliente NÃO consegue
 * fazer com a linha do primeiro.
 *
 *   · o cadastro só passa pro cliente quando o pedido é PAGO (B14, db/028): até
 *     lá ele mora no pedido (`cadastro_pendente`). O formulário não prova que o
 *     e-mail é de quem digitou; o pagamento custa dinheiro no nome de alguém;
 *   · o e-mail usado por um desconhecido sem pagar volta pro dono (B14);
 *   · senha nenhuma é gravada — não existe login de cliente (B17);
 *   · comprar de novo só com nome e CPF não apaga o endereço nem a idade;
 *   · o endereço é um bloco: o novo substitui o velho INTEIRO;
 *   · o consentimento de novidades só muda quando a pessoa se manifesta — e só
 *     com a compra paga —, e o carimbo só anda quando o valor muda;
 *   · cadastro inválido recusa ANTES de tocar no banco: nada de cliente pela
 *     metade nem pedido órfão.
 *
 * Vai pela HTTP, que é onde o comprador está, e paga pelo gateway simulado
 * (`/api/dev/pagar`, a mesma emissão do webhook). Sem servidor de dev no ar PULA.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db, q, q1 } from '../utils/db'
import { anunciarPulo, seForaDoArPula, sondarServidor, type Sonda } from '../../scripts/test-setup'

// Casos de até dez idas ao servidor de dev (compra + pagamento, cinco vezes):
// com a máquina dividida com outras suítes, os 5 s padrão cortam no meio.
vi.setConfig({ testTimeout: 30_000 })

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
  return { status: r.status, recado: corpo.statusMessage ?? '', corpo, pedido: corpo.pedido as string }
}

/** "O PIX caiu": a mesma emissão que o webhook do Asaas chama. */
async function pagar(pedido: string) {
  const r = await fetch(`${BASE}/api/dev/pagar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pedido }),
  })
  expect(r.status, `o pagamento simulado de ${pedido} falhou`).toBe(200)
}

/** Compra e paga; devolve o código do pedido. */
async function comprarEPagar(base: { email: string; documento: string }, extra: Record<string, any> = {}) {
  const r = await comprar(base, extra)
  expect(r.status, r.recado).toBe(200)
  await pagar(r.pedido)
  return r.pedido
}

const cliente = (email: string) => q1<any>(
  `SELECT name, document, phone, asaas_customer_id,
          birth_date::text AS birth_date, instagram, zip_code, street, address_number,
          neighborhood, city, state, address_complement, password_hash, registered_at,
          marketing_opt_in, marketing_opt_in_at::text AS marketing_opt_in_at
     FROM customers WHERE org_id = $1 AND email = $2`, [orgId, email])

const pendente = (codigo: string) => q1<any>(
  `SELECT cadastro_pendente FROM orders WHERE code = $1`, [codigo]).then((o) => o!.cadastro_pendente)

/** O perfil que ninguém provou: o que o cliente tem antes de pagar a primeira vez. */
const SEM_PERFIL = {
  birth_date: null, instagram: null, zip_code: null, street: null, address_number: null,
  neighborhood: null, city: null, state: null, address_complement: null,
  password_hash: null, registered_at: null, marketing_opt_in: false, marketing_opt_in_at: null,
}

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

describe('checkout — o cadastro entra no PAGAMENTO, padronizado', () => {
  it('antes de pagar mora no pedido; pago, vai pro cliente — sem senha nenhuma', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail(), documento = cpf()
    const r = await comprar({ email, documento }, CADASTRO)
    expect(r.status, r.recado).toBe(200)

    // o pedido existe e tem dono, mas o perfil ainda não foi escrito
    expect(await cliente(email)).toMatchObject({ name: 'Maria de Teste', document: documento, ...SEM_PERFIL })
    expect(await pendente(r.pedido)).toMatchObject({
      documento, nome: 'Maria de Teste', nascimento: '1990-12-25', instagram: 'maria.souza',
      aceitaNovidades: true, cadastroDoSite: true,
      endereco: { cep: '45000000', cidade: 'Vitória da Conquista', estado: 'BA' },
    })

    await pagar(r.pedido)
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
    // B17: a senha digitada numa página antiga não é gravada nem em hash
    expect(c.password_hash).toBeNull()
    // aplicado, o dado pessoal não fica duplicado no pedido
    expect(await pendente(r.pedido)).toBeNull()
  })

  it('comprar sem cadastro continua funcionando e não inventa nada', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail()
    await comprarEPagar({ email, documento: cpf() })
    expect(await cliente(email)).toMatchObject(SEM_PERFIL)
  })

  it('B17 · senha curta (ou qualquer senha) não recusa mais a compra', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail()
    const r = await comprar({ email, documento: cpf() }, { senha: '123' })
    expect(r.status, 'a senha, que não serve pra nada, derrubou a compra').toBe(200)
    await pagar(r.pedido)
    expect((await cliente(email)).password_hash).toBeNull()
  })
})

describe('checkout — quem compra de novo não estraga o cadastro', () => {
  it('compra só com nome e CPF não apaga endereço, idade nem Instagram', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail(), documento = cpf()
    await comprarEPagar({ email, documento }, CADASTRO)
    await comprarEPagar({ email, documento })

    const c = await cliente(email)
    expect(c.birth_date).toBe('1990-12-25')
    expect(c.instagram).toBe('maria.souza')
    expect(c.city).toBe('Vitória da Conquista')
    expect(c.street).toBe('Rua das Flores')
  })

  it('o endereço novo substitui o velho INTEIRO — nada de rua de uma cidade em outra', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail(), documento = cpf()
    await comprarEPagar({ email, documento }, CADASTRO)
    // só cidade e UF: rua, número, bairro e CEP do endereço velho têm que sumir
    await comprarEPagar({ email, documento }, { endereco: { cidade: 'Salvador', estado: 'BA' } })

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
  it('só vale com a compra paga, só muda quando a pessoa se manifesta, e o carimbo só anda quando o valor muda', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail(), documento = cpf()

    // marcou "sim" mas não pagou: consentimento nenhum (B14 — qualquer um
    // digita o e-mail de outra pessoa)
    const r = await comprar({ email, documento }, { aceitaNovidades: true })
    expect(r.status, r.recado).toBe(200)
    expect(await cliente(email)).toMatchObject({ marketing_opt_in: false, marketing_opt_in_at: null })

    await pagar(r.pedido)
    const dito = await cliente(email)
    expect(dito.marketing_opt_in).toBe(true)
    const carimbo = dito.marketing_opt_in_at
    expect(carimbo).not.toBeNull()

    // não se manifestou: nada muda
    await comprarEPagar({ email, documento })
    const calado = await cliente(email)
    expect(calado.marketing_opt_in).toBe(true)
    expect(calado.marketing_opt_in_at).toBe(carimbo)

    // repetiu o "sim": o carimbo NÃO anda (a data do consentimento é a primeira)
    await comprarEPagar({ email, documento }, { aceitaNovidades: true })
    expect((await cliente(email)).marketing_opt_in_at).toBe(carimbo)

    // disse não: muda e o carimbo anda
    await comprarEPagar({ email, documento }, { aceitaNovidades: false })
    const nao = await cliente(email)
    expect(nao.marketing_opt_in).toBe(false)
    expect(nao.marketing_opt_in_at).not.toBe(carimbo)
  })

  it('quem nunca se manifestou fica sem consentimento e sem carimbo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail()
    await comprarEPagar({ email, documento: cpf() }, { nascimento: '1990-12-25' })
    expect(await cliente(email)).toMatchObject({ marketing_opt_in: false, marketing_opt_in_at: null })
  })
})

describe('B14 · e-mail sequestrado e cadastro reescrito sem pagar', () => {
  it('quem sabe e-mail + CPF de um cliente NÃO reescreve o cadastro dele sem pagar', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail(), documento = cpf()
    await comprarEPagar({ email, documento }, { ...CADASTRO, aceitaNovidades: false })
    const antes = await cliente(email)

    // o desconhecido: mesmo e-mail, mesmo CPF, outro perfil, "aceito novidades" — e não paga
    const r = await comprar({ email, documento }, {
      nome: 'Outra Pessoa', telefone: '11912345678', nascimento: '2001-01-01',
      instagram: '@outra', endereco: { cidade: 'São Paulo', estado: 'SP' }, aceitaNovidades: true,
    })
    expect(r.status, r.recado).toBe(200)
    expect(await cliente(email), 'o formulário não pago reescreveu o cadastro de outra pessoa')
      .toEqual(antes)
  })

  it('e-mail usado por um desconhecido sem pagar volta pro dono quando o pedido morre', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail(), cpfDoOutro = cpf(), cpfDoDono = cpf()
    const doOutro = await comprar({ email, documento: cpfDoOutro },
      { nome: 'Desconhecido', aceitaNovidades: true })
    expect(doOutro.status, doOutro.recado).toBe(200)
    // o cliente do Asaas daquele CPF não pode ir junto pro dono do e-mail
    await q(`UPDATE customers SET asaas_customer_id = 'cus_zz_do_outro', marketing_opt_in = true
              WHERE org_id = $1 AND email = $2`, [orgId, email])
    // a reserva vence sem pagamento (o que a varredura de expirados faz)
    await q(`UPDATE orders SET status = 'expirado' WHERE code = $1`, [doOutro.pedido])

    const doDono = await comprar({ email, documento: cpfDoDono }, { nome: 'Dona Do Email' })
    expect(doDono.status, `o dono do e-mail ficou preso ao CPF de quem não pagou: ${doDono.recado}`)
      .toBe(200)
    expect(await cliente(email)).toMatchObject({
      name: 'Dona Do Email', document: cpfDoDono, asaas_customer_id: null, ...SEM_PERFIL,
    })
    const log = await q1<any>(
      `SELECT count(*)::int AS n FROM audit_log a JOIN customers c ON c.id::text = a.entity_id::text
        WHERE c.org_id = $1 AND c.email = $2 AND a.action = 'email_reassumido'`, [orgId, email])
    expect(log!.n).toBe(1)
  })

  it('enquanto o pedido do outro CPF está de pé, o e-mail não troca de dono (409)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail(), cpfA = cpf()
    expect((await comprar({ email, documento: cpfA })).status).toBe(200)
    const r = await comprar({ email, documento: cpf() })
    expect(r.status, r.recado).toBe(409)
    expect(r.corpo.data).toMatchObject({ tipo: 'email_de_outro_cpf' })
    // e sem nenhum pedaço do CPF de ninguém no recado
    expect(r.recado).not.toMatch(/\d{2,}/)
    expect((await cliente(email)).document).toBe(cpfA)
  })

  it('e-mail que já PAGOU com um CPF recusa outro CPF, como antes', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail(), cpfA = cpf()
    const pago = await comprarEPagar({ email, documento: cpfA })
    // mesmo com o pedido estornado depois: o pagamento provou quem é o dono
    await q(`UPDATE orders SET status = 'estornado', refunded_cents = total_cents WHERE code = $1`, [pago])
    const r = await comprar({ email, documento: cpf() })
    expect(r.status, r.recado).toBe(409)
    expect((await cliente(email)).document).toBe(cpfA)
  })

  it('cliente do balcão sem CPF ganha o CPF da compra (é ele que conta o teto por CPF)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail(), documento = cpf()
    await q(`INSERT INTO customers (org_id, name, email) VALUES ($1, 'Cliente do balcão', $2)`, [orgId, email])
    const r = await comprar({ email, documento })
    expect(r.status, r.recado).toBe(200)
    expect((await cliente(email)).document).toBe(documento)
  })

  it('a rede do gatilho: se o CPF do cliente mudou até o pagamento, o cadastro não é aplicado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const email = novoEmail()
    const r = await comprar({ email, documento: cpf() }, CADASTRO)
    expect(r.status, r.recado).toBe(200)
    await q(`UPDATE customers SET document = '52998224725' WHERE org_id = $1 AND email = $2`, [orgId, email])
    await pagar(r.pedido)
    expect(await cliente(email)).toMatchObject({ birth_date: null, city: null, marketing_opt_in: false })
    expect(await pendente(r.pedido)).toBeNull()
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
  it('Instagram com espaço', async (ctx) => recusa({ instagram: 'meu nome' }, 'instagram', ctx))
  it('endereço sem UF', async (ctx) => recusa({ endereco: { cidade: 'Salvador' } }, 'estado', ctx))
  it('UF que não existe', async (ctx) =>
    recusa({ endereco: { cidade: 'Salvador', estado: 'XX' } }, 'estado', ctx))
  it('CEP torto', async (ctx) =>
    recusa({ endereco: { cep: '123', cidade: 'Salvador', estado: 'BA' } }, 'cep', ctx))
})
