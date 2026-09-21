/**
 * A conta do líquido — o número que diz quanto o produtor pode sacar.
 *
 * Este teste existe porque a conta estava errada em CINCO lugares ao mesmo
 * tempo, todos escrevendo `face - estornado`, e um deles era o teto do saque.
 * Nenhum teste ficou vermelho enquanto isso: a face bate com o líquido
 * sempre que a taxa é repassada e ninguém usa cupom, que é exatamente o caso
 * do seed. O defeito só aparece com taxa absorvida ou desconto — e o balcão
 * nasce absorvendo.
 *
 * Por isso os casos abaixo são os quatro que o seed não cobria, e por isso o
 * teste vai ao BANCO em vez de conferir aritmética em memória: o que precisa
 * ficar travado é a expressão SQL que as cinco rotas compartilham, não uma
 * cópia dela em TypeScript.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { q, q1 } from './db'
import { SQL_LIQUIDO, SQL_LIQUIDO_DIRETO, SQL_LIQUIDO_GATEWAY } from './liquido'

/** ids fixos: o teste apaga exatamente o que criou */
const ORG = '00000000-0000-4000-8000-0000000019a1'
const EVENTO = '00000000-0000-4000-8000-0000000019a2'

/** insere um pedido pago já com os valores que o checkout gravaria */
async function pedido(campos: {
  codigo: string
  canal?: string
  face: number
  /** o que o COMPRADOR pagou de taxa: igual à taxa quando repassa, 0 quando absorve */
  feeComprador: number
  /** o que a plataforma retém, sempre */
  plataforma: number
  desconto?: number
  estornado?: number
  status?: string
  /** cobrança no gateway. Sem isso o dinheiro entrou DIRETO no bolso do produtor */
  asaas?: string | null
}) {
  const desconto = campos.desconto ?? 0
  await q(
    `INSERT INTO orders (org_id, event_id, code, status, channel,
                         face_cents, fee_cents, platform_cents, discount_cents,
                         total_cents, refunded_cents, asaas_payment_id, paid_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())`,
    [ORG, EVENTO, campos.codigo, campos.status ?? 'pago', campos.canal ?? 'online',
     campos.face, campos.feeComprador, campos.plataforma, desconto,
     // o banco exige total = face + fee − desconto; escrever a conta aqui
     // garante que o teste usa pedidos que o checkout conseguiria gravar
     campos.face + campos.feeComprador - desconto,
     campos.estornado ?? 0,
     // o padrão é COM cobrança: é o caminho de 99% das vendas. Os casos que
     // provam o dinheiro direto passam `asaas: null` explicitamente.
     campos.asaas === undefined ? `pay_${campos.codigo}` : campos.asaas])
}

/** roda a MESMA expressão que as rotas usam, sobre o evento do teste */
async function liquidoDoEvento(): Promise<number> {
  const r = await q1<any>(
    `SELECT ${SQL_LIQUIDO()} AS liquido FROM orders WHERE event_id = $1`, [EVENTO])
  return Number(r.liquido)
}

/** o mesmo líquido, partido em "está na plataforma" e "já está com o produtor" */
async function metades(): Promise<{ gateway: number; direto: number }> {
  const r = await q1<any>(
    `SELECT ${SQL_LIQUIDO_GATEWAY()} AS gateway, ${SQL_LIQUIDO_DIRETO()} AS direto
       FROM orders WHERE event_id = $1`, [EVENTO])
  return { gateway: Number(r.gateway), direto: Number(r.direto) }
}

beforeAll(async () => {
  await q(`INSERT INTO organizations (id, name, slug)
           VALUES ($1,'ZZ LIQUIDO TESTE','zz-liquido-teste')
           ON CONFLICT (id) DO NOTHING`, [ORG])
  await q(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,'ZZ LIQUIDO TESTE','zz-liquido-teste',
             now() + interval '30 days', now() + interval '31 days', 1000, 'ativo')
     ON CONFLICT (id) DO NOTHING`, [EVENTO, ORG])
  await q(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
}, 20_000)

afterAll(async () => {
  await q(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('quanto do dinheiro é do produtor', () => {
  it('taxa repassada: o produtor recebe a face inteira', async () => {
    await q(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
    // face R$ 100, taxa 10% cobrada POR FORA: comprador paga R$ 110
    await pedido({ codigo: 'ZZ-REP-1', face: 10_000, feeComprador: 1_000, plataforma: 1_000 })

    expect(await liquidoDoEvento(),
      'com a taxa por fora o produtor recebe a face cheia').toBe(10_000)
  })

  it('taxa absorvida: a taxa sai de dentro da face', async () => {
    await q(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
    // face R$ 100 redonda no balcão: comprador paga R$ 100, produtor come os 10%
    await pedido({ codigo: 'ZZ-ABS-1', canal: 'bilheteria',
                   face: 10_000, feeComprador: 0, plataforma: 1_000 })

    // ← é AQUI que `face - estornado` errava: devolvia 10.000 e liberava
    //   pra saque R$ 10,00 que a plataforma já tinha retido
    expect(await liquidoDoEvento(),
      'com a taxa absorvida o produtor NÃO recebe a face cheia').toBe(9_000)
  })

  it('os dois modos no mesmo evento somam cada um pela sua regra', async () => {
    await q(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
    await pedido({ codigo: 'ZZ-MIX-1', face: 10_000, feeComprador: 1_000, plataforma: 1_000 })
    await pedido({ codigo: 'ZZ-MIX-2', canal: 'bilheteria',
                   face: 10_000, feeComprador: 0, plataforma: 1_000 })

    // O modo de taxa muda com o tempo e vale só dali pra frente, então o
    // MESMO evento — e até o mesmo canal — tem pedidos dos dois jeitos. Olhar
    // `fee_mode_*` pra decidir erraria um dos dois, sempre.
    expect(await liquidoDoEvento(),
      'um evento com os dois modos não tem um modo só pra somar').toBe(19_000)
  })

  it('cupom de desconto sai do bolso do produtor', async () => {
    await q(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
    // face R$ 100, taxa por fora, R$ 20 de cupom: comprador paga R$ 90
    await pedido({ codigo: 'ZZ-CUP-1', face: 10_000, feeComprador: 1_000,
                   plataforma: 1_000, desconto: 2_000 })

    expect(await liquidoDoEvento(),
      'a face continua cheia com cupom; quem paga o desconto é o produtor').toBe(8_000)
  })

  it('estorno abate do líquido', async () => {
    await q(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
    await pedido({ codigo: 'ZZ-EST-1', face: 10_000, feeComprador: 1_000,
                   plataforma: 1_000, estornado: 11_000 })

    expect(await liquidoDoEvento(),
      'devolveu tudo ao comprador e ainda sobrou saldo pro produtor').toBe(-1_000)
  })

  it('estorno PARCIAL continua na conta, já descontado', async () => {
    await q(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
    // Face R$ 850 com taxa de 10% por fora: o comprador pagou R$ 935, a
    // plataforma retém R$ 85. Devolveram R$ 20 — o webhook do gateway grava
    // o pedido como 'estornado_parcial' e os R$ 20 em `refunded_cents`.
    await pedido({ codigo: 'ZZ-PAR-1', status: 'estornado_parcial',
                   face: 85_000, feeComprador: 8_500, plataforma: 8_500,
                   estornado: 2_000 })

    // ← o filtro antigo era `status = 'pago'` e só. Um estorno de R$ 20
    //   apagava o pedido INTEIRO do saldo: sumiam R$ 830 por causa de uma
    //   devolução de vinte reais.
    expect(await liquidoDoEvento(),
      'um estorno parcial apagou o pedido inteiro do saldo').toBe(83_000)
  })

  it('estorno TOTAL sai da conta inteiro', async () => {
    await q(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
    await pedido({ codigo: 'ZZ-TOT-1', status: 'estornado',
                   face: 10_000, feeComprador: 1_000, plataforma: 1_000,
                   estornado: 11_000 })

    // Aqui não sobra nada pra apurar: o comprador recebeu tudo de volta. Se
    // o status entrasse na conta o resultado seria o mesmo por aritmética
    // (11.000 − 1.000 − 11.000 = −1.000) e o produtor ficaria devendo uma
    // taxa que a plataforma já devolveu junto.
    expect(await liquidoDoEvento(),
      'pedido estornado por inteiro ainda mexia no saldo').toBe(0)
  })

  it('pedido que não virou dinheiro não entra na conta', async () => {
    await q(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
    await pedido({ codigo: 'ZZ-PEND-1', status: 'aguardando_pagamento',
                   face: 10_000, feeComprador: 1_000, plataforma: 1_000 })
    await pedido({ codigo: 'ZZ-EXP-1', status: 'expirado',
                   face: 50_000, feeComprador: 5_000, plataforma: 5_000 })

    expect(await liquidoDoEvento(),
      'pix não pago e pedido expirado contaram como saldo').toBe(0)
  })

  it('a conta é a mesma com e sem alias de tabela', async () => {
    await q(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
    await pedido({ codigo: 'ZZ-ALIAS-1', canal: 'bilheteria',
                   face: 10_000, feeComprador: 0, plataforma: 1_000 })

    // as cinco rotas usam as duas formas — uma com JOIN, outra sem. Se as
    // duas não derem o mesmo número, a tela do dinheiro volta a discordar
    // de si mesma, que é exatamente o defeito que este arquivo fecha.
    const comAlias = await q1<any>(
      `SELECT ${SQL_LIQUIDO('o.')} AS liquido FROM orders o WHERE o.event_id = $1`, [EVENTO])
    expect(Number(comAlias.liquido)).toBe(await liquidoDoEvento())
  })
})

/**
 * "Quanto é do produtor" e "quanto dá pra transferir" são perguntas
 * diferentes, e confundi-las é o jeito de a plataforma pagar do próprio bolso.
 *
 * Dinheiro que nunca passou pelo gateway — nota no caixa do guichê, pix na
 * chave do próprio produtor — já está com ele. Continua sendo dele (entra no
 * líquido), mas não existe conta nenhuma da plataforma de onde tirar pra
 * mandar de novo.
 *
 * A régua é `asaas_payment_id`, e não o canal nem a forma de pagamento: o
 * banco tem `bilheteria + pix` dos DOIS jeitos — QR da plataforma (com
 * cobrança) e QR do produtor (sem). Decidir por canal erraria os dois casos.
 */
describe('o que dá pra transferir de verdade', () => {
  it('venda com cobrança no gateway fica na plataforma', async () => {
    await q(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
    await pedido({ codigo: 'ZZ-GW-1', canal: 'bilheteria', asaas: 'pay_zz_gw',
                   face: 10_000, feeComprador: 0, plataforma: 1_000 })

    expect(await metades()).toEqual({ gateway: 9_000, direto: 0 })
  })

  it('dinheiro no balcão já está com o produtor', async () => {
    await q(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
    await pedido({ codigo: 'ZZ-DIR-1', canal: 'bilheteria', asaas: null,
                   face: 10_000, feeComprador: 0, plataforma: 1_000 })

    // ← o teto do saque somava isto. Num evento medido, R$ 1.997,11 de
    //   dinheiro de balcão viravam saldo transferível: a plataforma mandaria
    //   pro produtor um dinheiro que ele já tinha recebido na mão.
    expect(await metades()).toEqual({ gateway: 0, direto: 9_000 })
  })

  it('as duas metades somam exatamente o líquido', async () => {
    await q(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
    await pedido({ codigo: 'ZZ-MET-1', asaas: 'pay_zz_met',
                   face: 10_000, feeComprador: 1_000, plataforma: 1_000 })
    await pedido({ codigo: 'ZZ-MET-2', canal: 'bilheteria', asaas: null,
                   face: 5_000, feeComprador: 0, plataforma: 500 })
    await pedido({ codigo: 'ZZ-MET-3', status: 'estornado_parcial', asaas: 'pay_zz_met3',
                   face: 20_000, feeComprador: 2_000, plataforma: 2_000,
                   estornado: 3_000 })

    const { gateway, direto } = await metades()
    // Se as metades não fecharem com o total, existe um pedido que sumiu das
    // duas telas — ou que aparece nas duas.
    expect(gateway + direto,
      'a soma das metades não bate com o líquido: tem pedido fora das duas').toBe(
      await liquidoDoEvento())
    expect({ gateway, direto }).toEqual({ gateway: 10_000 + 17_000, direto: 4_500 })
  })
})
