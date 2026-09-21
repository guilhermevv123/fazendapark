/**
 * Teste da bilheteria física.
 *
 * O que dá errado na bilheteria não é a venda — é o DINHEIRO e o ingresso
 * ficarem em estados diferentes. As situações que este arquivo tranca:
 *
 *  1. venda entrando em caixa já fechado (a diferença aparece de manhã e
 *     ninguém sabe de onde veio);
 *  2. o mesmo caixa fechando duas vezes, com duas contagens por cima;
 *  3. dois operadores abrindo caixa no mesmo guichê — a diferença do fim da
 *     noite não tem dono;
 *  4. venda que grava e não emite (dinheiro na gaveta, cliente sem ingresso);
 *  5. o preço do site cobrado no guichê;
 *  6. meia-entrada vendida sem documento, que a portaria vai barrar no portão;
 *  7. caixa de outra produtora alcançado pelo id no corpo.
 *
 * As duas travas de concorrência são testadas com DUAS CONEXÕES e ordem
 * forçada à mão, rodando a MESMA instrução que a rota roda (importada de
 * `utils/caixa.ts`). Teste sequencial pelo HTTP não serve: a rota conferiria
 * o estado antes e o segundo pedido morreria na checagem, deixando o teste
 * verde mesmo com a condição do UPDATE arrancada. Já aconteceu duas vezes
 * neste sistema — catraca e aceite de transferência.
 *
 * Fixture própria com id fixo, apagada no fim. Precisa do servidor de dev no
 * ar; sem ele, PULA em vez de falhar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SQL_FECHA_TURNO, SQL_TRAVA_TURNO_ABERTO } from '../utils/caixa'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

const ORG = '0000d001-0000-4000-8000-000000000001'
const USUARIO = '0000d001-0000-4000-8000-000000000002'
const EVENTO = '0000d001-0000-4000-8000-000000000003'
const SETOR = '0000d001-0000-4000-8000-000000000004'
const LOTE = '0000d001-0000-4000-8000-000000000005'
const MEIA = '0000d001-0000-4000-8000-000000000006'

/** a produtora vizinha, que não pode ser alcançada por id no corpo */
const ORG_VIZINHA = '0000d002-0000-4000-8000-000000000001'
const EVENTO_VIZINHO = '0000d002-0000-4000-8000-000000000003'
const PONTO_VIZINHO = '0000d002-0000-4000-8000-000000000004'
const TURNO_VIZINHO = '0000d002-0000-4000-8000-000000000005'

const EMAIL = 'dono.pdv@teste.invalido'
const FACE = 3000 // R$ 30,00 redondo, pra a conta do balcão ser conferível de cabeça

let noAr = false
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../utils/db')
  return q<any>(texto, par)
}

const comSessao = (rota: string, init: RequestInit = {}) =>
  fetch(`${BASE}${rota}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, origin: BASE, ...(init.headers ?? {}) },
  })

const pdv = (sufixo = '', init: RequestInit = {}) =>
  comSessao(`/api/admin/evento/${EVENTO}/pdv${sufixo}`, init)

async function json(r: Response) {
  return { status: r.status, corpo: await r.json().catch(() => ({} as any)) }
}

/** ponto novo a cada teste: o índice de caixa aberto é POR ponto */
async function novoPonto(nome: string, formas = ['dinheiro', 'debito', 'pix']) {
  const r = await json(await pdv('', {
    method: 'POST', body: JSON.stringify({ nome, formas }),
  }))
  if (r.status !== 200) throw new Error(`ponto não criado: ${JSON.stringify(r.corpo)}`)
  return r.corpo.id as string
}

async function abrirCaixa(pontoId: string, fundoCents = 0) {
  const r = await json(await pdv('/turno', {
    method: 'POST', body: JSON.stringify({ pontoId, fundoCents }),
  }))
  if (r.status !== 200) throw new Error(`caixa não abriu: ${JSON.stringify(r.corpo)}`)
  return r.corpo.turnoId as string
}

const vender = async (corpo: any) =>
  json(await pdv('/venda', { method: 'POST', body: JSON.stringify(corpo) }))

async function conexao() {
  const { db } = await import('../utils/db')
  return db().connect()
}

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).status < 500
  } catch { noAr = false }
  if (!noAr) return

  for (const [org, slug] of [[ORG, 'zz-pdv-teste'], [ORG_VIZINHA, 'zz-pdv-vizinha']]) {
    await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$2)
               ON CONFLICT (id) DO NOTHING`, [org, slug])
  }
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, status, fee_bps, fee_mode_pos)
     VALUES ($1,$2,'ZZ EVENTO PDV','zz-evento-pdv',
             now() + interval '10 days', now() + interval '11 days', 'ativo', 1000, 'absorver')
     ON CONFLICT (id) DO UPDATE SET status = 'ativo', fee_mode_pos = 'absorver'`, [EVENTO, ORG])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, status)
     VALUES ($1,$2,'ZZ EVENTO VIZINHO','zz-evento-pdv-vizinho',
             now() + interval '10 days', now() + interval '11 days', 'ativo')
     ON CONFLICT (id) DO NOTHING`, [EVENTO_VIZINHO, ORG_VIZINHA])

  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZ SETOR PDV')
             ON CONFLICT (id) DO NOTHING`, [SETOR, EVENTO])
  await sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity, channels, visible)
     VALUES ($1,$2,'ZZ LOTE PDV',$3,200,'{online,bilheteria}',true)
     ON CONFLICT (id) DO UPDATE SET quantity = 200, sold = 0, reserved = 0,
       channels = '{online,bilheteria}', price_cents = EXCLUDED.price_cents`,
    [LOTE, SETOR, FACE])
  await sql(
    `INSERT INTO ticket_types (id, lot_id, name, discount_bps, quantity, requires_document)
     VALUES ($1,$2,'ZZ MEIA', 5000, 100, true)
     ON CONFLICT (id) DO UPDATE SET sold = 0, requires_document = true`, [MEIA, LOTE])

  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'Dono PDV Teste', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [USUARIO, ORG, EMAIL])

  // caixa da vizinha, aberto, pra provar que o id no corpo não atravessa
  await sql(
    `INSERT INTO pos_terminals (id, org_id, event_id, name)
     VALUES ($1,$2,$3,'ZZ GUICHE VIZINHO') ON CONFLICT (id) DO NOTHING`,
    [PONTO_VIZINHO, ORG_VIZINHA, EVENTO_VIZINHO])
  await sql(
    `INSERT INTO pos_shifts (id, org_id, event_id, terminal_id, operator_id, opening_float_cents)
     SELECT $1,$2,$3,$4, u.id, 0 FROM users u WHERE u.email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`,
    [TURNO_VIZINHO, ORG_VIZINHA, EVENTO_VIZINHO, PONTO_VIZINHO])

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 40_000)

afterAll(async () => {
  if (!noAr) return
  await sql(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, ORG_VIZINHA]])
})

describe('bilheteria física', () => {
  it('a sessão do teste existe (senão nada abaixo prova nada)', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()
  }, 20_000)

  /* ------------------------------------------------------------- travas */

  it('duas conexões fechando o mesmo caixa: só uma fecha', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const turno = await abrirCaixa(await novoPonto('ZZ FECHA DUPLO'), 10_000)

    // Duas conexões de verdade, uma depois da outra, rodando a MESMA
    // instrução da rota. Arrancar `AND status = 'aberto'` de SQL_FECHA_TURNO
    // faz esta soma virar 2.
    const c1 = await conexao()
    const c2 = await conexao()
    try {
      const r1 = await c1.query(SQL_FECHA_TURNO, [turno, USUARIO, 10_000, 10_000, null])
      const r2 = await c2.query(SQL_FECHA_TURNO, [turno, USUARIO, 99_900, 10_000, null])
      expect(r1.rowCount! + r2.rowCount!,
        'o mesmo caixa fechou duas vezes — a segunda contagem gravou por cima da primeira')
        .toBe(1)
    } finally { c1.release(); c2.release() }

    const [t] = await sql(`SELECT closing_counted_cents FROM pos_shifts WHERE id = $1`, [turno])
    expect(Number(t.closing_counted_cents),
      'a contagem gravada não é a do primeiro fechamento').toBe(10_000)
  }, 30_000)

  it('caixa fechado não devolve linha pra trava da venda', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const ponto = await novoPonto('ZZ TRAVA VENDA')
    const turno = await abrirCaixa(ponto, 0)

    const c = await conexao()
    try {
      const antes = await c.query(SQL_TRAVA_TURNO_ABERTO, [turno])
      expect(antes.rowCount, 'a trava não achou um caixa que está aberto').toBe(1)

      await sql(`UPDATE pos_shifts SET status = 'fechado', closed_at = now() WHERE id = $1`, [turno])

      // esta é a linha inteira: sem `AND status = 'aberto'` a venda entraria
      // numa gaveta já contada
      const depois = await c.query(SQL_TRAVA_TURNO_ABERTO, [turno])
      expect(depois.rowCount,
        'a trava devolveu um caixa FECHADO — dinheiro entraria em gaveta já conferida').toBe(0)
    } finally { c.release() }
  }, 30_000)

  it('o banco recusa dois caixas abertos no mesmo ponto', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const ponto = await novoPonto('ZZ DOIS CAIXAS')
    await abrirCaixa(ponto, 0)

    // direto no banco: prova que a garantia é o índice parcial, não a rota
    let recusou = false
    try {
      await sql(
        `INSERT INTO pos_shifts (org_id, event_id, terminal_id, operator_id)
         VALUES ($1,$2,$3,$4)`, [ORG, EVENTO, ponto, USUARIO])
    } catch { recusou = true }
    expect(recusou,
      'o banco aceitou dois caixas abertos no mesmo guichê — a diferença da noite não teria dono')
      .toBe(true)
  }, 30_000)

  /* -------------------------------------------------------------- venda */

  it('venda no balcão grava o dinheiro e emite o ingresso no mesmo commit', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const turno = await abrirCaixa(await novoPonto('ZZ VENDA OK'), 5_000)

    const [antes] = await sql(`SELECT sold, reserved FROM lots WHERE id = $1`, [LOTE])
    const r = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, quantidade: 3 }],
      forma: 'dinheiro', recebidoCents: 10_000,
    })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(r.corpo.ingressos).toHaveLength(3)

    const [pedido] = await sql(
      `SELECT status, paid_at, channel, pos_shift_id, sold_by FROM orders WHERE code = $1`,
      [r.corpo.pedido])
    expect(pedido.status, 'o pedido do balcão não nasceu pago').toBe('pago')
    expect(pedido.paid_at).toBeTruthy()
    expect(pedido.channel).toBe('bilheteria')

    // o estoque tem que ter VIRADO vendido, não ficado reservado: reserva que
    // ninguém confirma volta pra prateleira sozinha e o ingresso impresso
    // deixa de ter lastro
    const [depois] = await sql(`SELECT sold, reserved FROM lots WHERE id = $1`, [LOTE])
    expect(Number(depois.sold) - Number(antes.sold)).toBe(3)
    expect(Number(depois.reserved)).toBe(Number(antes.reserved))

    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM tickets t JOIN orders o ON o.id = t.order_id
        WHERE o.code = $1 AND t.status = 'valido'`, [r.corpo.pedido])
    expect(n, 'o pedido do balcão ficou sem ingresso válido').toBe(3)
  }, 30_000)

  it('o guichê cobra o preço de balcão, não o do site', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const turno = await abrirCaixa(await novoPonto('ZZ PRECO'), 0)

    // o evento está em `fee_mode_pos = absorver`: a pessoa paga a face
    // redonda e a taxa sai do produtor. No site, o mesmo lote sairia por
    // 3300 (face + 10%).
    const r = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, quantidade: 1 }], forma: 'pix',
    })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(r.corpo.totalCents, 'o balcão cobrou o preço do site').toBe(FACE)
    expect(r.corpo.taxaCents, 'a taxa foi repassada ao comprador no balcão').toBe(0)

    const [o] = await sql(`SELECT platform_cents FROM orders WHERE code = $1`, [r.corpo.pedido])
    expect(Number(o.platform_cents),
      'a taxa absorvida sumiu do pedido — a plataforma não fatura nada dessa venda')
      .toBe(Math.round(FACE * 0.1))
  }, 30_000)

  it('troco: recebido menor que o total não vende', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const turno = await abrirCaixa(await novoPonto('ZZ TROCO'), 0)

    const r = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, quantidade: 2 }],
      forma: 'dinheiro', recebidoCents: 1_000,
    })
    expect(r.status).toBe(422)

    const ok = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, quantidade: 2 }],
      forma: 'dinheiro', recebidoCents: 10_000,
    })
    expect(ok.status, JSON.stringify(ok.corpo)).toBe(200)
    expect(ok.corpo.trocoCents, 'o troco saiu errado').toBe(10_000 - 2 * FACE)
  }, 30_000)

  it('o ponto só aceita as formas que ele tem', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const ponto = await novoPonto('ZZ SEM MAQUININHA', ['dinheiro'])
    const turno = await abrirCaixa(ponto, 0)

    const r = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, quantidade: 1 }], forma: 'credito',
    })
    expect(r.status, 'vendeu no crédito num guichê que não tem maquininha').toBe(422)
  }, 30_000)

  it('meia-entrada sem documento não sai do guichê', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const turno = await abrirCaixa(await novoPonto('ZZ MEIA'), 0)

    const sem = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, ticketTypeId: MEIA, quantidade: 1 }],
      forma: 'dinheiro',
    })
    expect(sem.status, 'vendeu meia sem documento — a portaria barra no portão').toBe(422)

    const com = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, ticketTypeId: MEIA, quantidade: 1 }],
      forma: 'dinheiro',
      comprador: { nome: 'Estudante Teste', documento: '86946240871' },
    })
    expect(com.status, JSON.stringify(com.corpo)).toBe(200)
    expect(com.corpo.totalCents, 'a meia não saiu pela metade').toBe(FACE / 2)
  }, 30_000)

  it('caixa fechado não recebe venda nem sangria', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const turno = await abrirCaixa(await novoPonto('ZZ FECHADO'), 0)

    const f = await json(await pdv('/turno', {
      method: 'PATCH', body: JSON.stringify({ turnoId: turno, contadoCents: 0 }),
    }))
    expect(f.status, JSON.stringify(f.corpo)).toBe(200)

    const v = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, quantidade: 1 }], forma: 'dinheiro',
    })
    expect(v.status, 'a venda entrou num caixa já conferido').toBe(409)

    const g = await json(await pdv('/gaveta', {
      method: 'POST', body: JSON.stringify({ turnoId: turno, tipo: 'sangria', valorCents: 100 }),
    }))
    expect(g.status, 'mexeram na gaveta de um caixa já fechado').toBe(409)
  }, 30_000)

  /* ----------------------------------------------------------- conferência */

  it('a conferência soma o que está na gaveta, não o que passou no cartão', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const turno = await abrirCaixa(await novoPonto('ZZ CONFERE'), 20_000)

    await vender({ turnoId: turno, itens: [{ lotId: LOTE, quantidade: 3 }], forma: 'dinheiro' })
    await vender({ turnoId: turno, itens: [{ lotId: LOTE, quantidade: 2 }], forma: 'pix' })
    await json(await pdv('/gaveta', {
      method: 'POST',
      body: JSON.stringify({ turnoId: turno, tipo: 'sangria', valorCents: 5_000 }),
    }))
    await json(await pdv('/gaveta', {
      method: 'POST',
      body: JSON.stringify({ turnoId: turno, tipo: 'suprimento', valorCents: 1_000 }),
    }))

    const r = await json(await pdv(`/turno?turno=${turno}`))
    const c = r.corpo.contagem
    expect(c.dinheiroCents).toBe(3 * FACE)
    expect(c.eletronicoCents).toBe(2 * FACE)
    // 200 de fundo + 90 em espécie − 50 de sangria + 10 de suprimento = 250
    expect(c.esperadoCents,
      'a conta da gaveta está misturando cartão com dinheiro')
      .toBe(20_000 + 3 * FACE - 5_000 + 1_000)

    const f = await json(await pdv('/turno', {
      method: 'PATCH', body: JSON.stringify({ turnoId: turno, contadoCents: c.esperadoCents - 500 }),
    }))
    expect(f.corpo.situacao).toBe('falta')
    expect(f.corpo.diferencaCents).toBe(-500)
  }, 40_000)

  it('o fechamento congela o esperado — estorno de amanhã não muda o caixa de hoje', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const turno = await abrirCaixa(await novoPonto('ZZ CONGELA'), 0)
    const v = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, quantidade: 2 }], forma: 'dinheiro',
    })
    expect(v.status, JSON.stringify(v.corpo)).toBe(200)

    const f = await json(await pdv('/turno', {
      method: 'PATCH', body: JSON.stringify({ turnoId: turno, contadoCents: 2 * FACE }),
    }))
    expect(f.corpo.situacao).toBe('bate')

    // o pedido é cancelado depois — como aconteceria num estorno
    await sql(`UPDATE orders SET status = 'cancelado' WHERE code = $1`, [v.corpo.pedido])

    const [t] = await sql(
      `SELECT closing_expected_cents FROM pos_shifts WHERE id = $1`, [turno])
    expect(Number(t.closing_expected_cents),
      'o fechamento de ontem mudou sozinho quando o pedido foi cancelado hoje')
      .toBe(2 * FACE)
  }, 30_000)

  /* ------------------------------------------------------------ isolamento */

  it('caixa de outra produtora não é alcançado pelo id no corpo', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    // O middleware cerca pelo id da URL; o turno vem no CORPO. Esta é a
    // forma exata do furo que um dia abriu o check-in entre produtoras.
    const v = await vender({
      turnoId: TURNO_VIZINHO, itens: [{ lotId: LOTE, quantidade: 1 }], forma: 'dinheiro',
    })
    expect(v.status, 'vendeu no caixa de outra produtora').toBe(404)

    const g = await json(await pdv('/gaveta', {
      method: 'POST',
      body: JSON.stringify({ turnoId: TURNO_VIZINHO, tipo: 'sangria', valorCents: 100 }),
    }))
    expect(g.status, 'fez sangria na gaveta de outra produtora').toBe(404)

    const f = await json(await pdv('/turno', {
      method: 'PATCH', body: JSON.stringify({ turnoId: TURNO_VIZINHO, contadoCents: 0 }),
    }))
    expect(f.status, 'fechou o caixa de outra produtora').toBe(404)

    const [t] = await sql(`SELECT status FROM pos_shifts WHERE id = $1`, [TURNO_VIZINHO])
    expect(t.status, 'o caixa da vizinha foi mexido').toBe('aberto')
  }, 30_000)

  it('ponto com caixa aberto não é desativado por baixo do operador', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const ponto = await novoPonto('ZZ DESATIVA')
    await abrirCaixa(ponto, 0)

    const r = await json(await pdv('', {
      method: 'PATCH', body: JSON.stringify({ id: ponto, ativo: false }),
    }))
    expect(r.status, 'desativaram o guichê com venda acontecendo nele').toBe(409)

    const [p] = await sql(`SELECT active FROM pos_terminals WHERE id = $1`, [ponto])
    expect(p.active).toBe(true)
  }, 30_000)
})
