/**
 * Combo vira N ingressos, um por pessoa (050), por HTTP — do jeito que o leitor do tablet usa.
 *
 * Dono, 08/10: "os combos, quando o cara compra, não é pra aparecer o ingresso só ... tem que aparecer
 * os 10, porque ele vai invalidando, ingresso por ingresso ... saber esse combo aqui, 9 pessoas
 * foram, 1 não foi". O que este arquivo prova:
 *
 *  1. a emissão de 2 combos de 10 + 1 entrada solta dá 21 ingressos: 2 grupos de 10 partes
 *     (pessoa 1..10, `people = 1`) e a entrada sem grupo — e o estoque anda por UNIDADE (3);
 *  2. a porta lê uma parte: entra 1 pessoa, e a resposta diz quem do combo já entrou;
 *  3. "a pessoa k deste combo" (`parteDoCombo`) libera a irmã — uma vez só; fora de combo, não acha;
 *  4. SEM REDE a fila sobe as partes pelo QR lido + `parte`, cada uma com 1 pessoa no livro;
 *  5. a lista do tablet leva o grupo, a parte e as pessoas do tipo;
 *  6. a parte de combo de outro dia troca pagando a FRAÇÃO (1/10 do combo de hoje − 1/10 do pago).
 *
 * Fixtura desta corrida (marca de `scripts/test-setup.ts`), apagada no fim. Sem servidor, PULA.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor, uuidDaCorrida, type Sonda,
} from '../../scripts/test-setup'
import { diaDeUsoDe } from '../utils/dias-de-uso'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/combo-partes', n)
const ORG = id(1)
const USER_PORTEIRO = id(2)
const EVENTO = id(4)
const SETOR = id(5)
const LOTE = id(6)
const T_COMBO_HOJE = id(7)
const T_IND_HOJE = id(8)
const T_COMBO_OUTRO = id(9)

const MARCA_MINUSCULA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL_PORTEIRO = `porteiro.combo.${MARCA_MINUSCULA}@combo.invalido`
const SENHA = 'diamond123'

const HOJE = diaDeUsoDe(new Date(), 'America/Bahia')
const AMANHA = new Date(new Date(`${HOJE}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10)

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''
let pedidoId = ''
let pedidoOutroId = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../utils/db')
  return q<any>(texto, par)
}
const um = async (texto: string, par: any[] = []) => (await sql(texto, par))[0]
async function entrar(email: string) {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, senha: SENHA }),
  })
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c!.startsWith('dt_sessao=')) ?? ''
}
async function post(rota: string, corpo: any) {
  const r = await fetch(`${BASE}${rota}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: BASE }, body: JSON.stringify(corpo),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any }
}
const ler = (qr: string, extra: any = {}) => post('/api/checkin', { qr, eventId: EVENTO, gate: 'PORTAO-COMBO', ...extra })
const partes = (pedido: string) => sql(
  `SELECT t.id, t.code, t.status, t.people, t.combo_group, t.combo_seq, t.combo_size, t.ticket_type_id, t.holder_name
     FROM tickets t WHERE t.order_id = $1 ORDER BY t.combo_group NULLS LAST, t.combo_seq`, [pedido])

/** um pedido aguardando pagamento, com a reserva feita — `emitirIngressos` faz o resto */
async function pedido(codigo: string, itens: { tipo: string; qtd: number; face: number }[]) {
  const { tx } = await import('../utils/db')
  const { reservar } = await import('../utils/estoque')
  const total = itens.reduce((s, i) => s + i.qtd * i.face, 0)
  const [o] = await sql(
    `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                         discount_cents, total_cents, refunded_cents, payment_method, expires_at)
     VALUES ($1,$2,$3,'aguardando_pagamento','online',$4,0,0,0,$4,0,'pix', now() + interval '20 minutes')
     RETURNING id`, [ORG, EVENTO, codigo.slice(0, 40), total])
  for (const i of itens) {
    await sql(`INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity, unit_face_cents, unit_fee_cents,
                                        unit_total_cents) VALUES ($1,$2,$3,$4,$5,0,$5)`,
      [o.id, LOTE, i.tipo, i.qtd, i.face])
  }
  await tx((c) => reservar(c, itens.map((i) => ({ lotId: LOTE, ticketTypeId: i.tipo, quantidade: i.qtd }))))
  return o.id as string
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/combo-partes.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
    [ORG, `ZZ COMBO ${MARCA_MAIUSCULA}`, `zz-combo-${MARCA_MINUSCULA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, status, timezone)
     VALUES ($1,$2,$3,$4, now() - interval '1 day', now() + interval '2 days', 'ativo', 'America/Bahia')
     ON CONFLICT (id) DO NOTHING`,
    [EVENTO, ORG, `ZZ COMBO EVENTO ${MARCA_MAIUSCULA}`, `zz-combo-evento-${MARCA_MINUSCULA}`])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZ GERAL') ON CONFLICT (id) DO NOTHING`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity, sort_order, max_per_order)
             VALUES ($1,$2,'ZZ 1º LOTE',2000,1000,1,20) ON CONFLICT (id) DO NOTHING`, [LOTE, SETOR])
  const tipo = (tid: string, nome: string, dia: string, preco: number, pessoas: number | null) => sql(
    `INSERT INTO ticket_types (id, lot_id, name, quantity, valid_dates, price_cents, admits)
     VALUES ($1,$2,$3,1000,$4::date[],$5,$6) ON CONFLICT (id) DO NOTHING`, [tid, LOTE, nome, [dia], preco, pessoas])
  await tipo(T_COMBO_HOJE, 'ZZ COMBO DOMINGO - COMBO 10 PESSOAS', HOJE, 25000, 10)
  await tipo(T_IND_HOJE, 'ZZ ENTRADA INDIVIDUAL DOMINGO', HOJE, 3000, null)
  await tipo(T_COMBO_OUTRO, 'ZZ COMBO SABADO - COMBO 10 PESSOAS', AMANHA, 16000, 10)

  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'Porteiro do Combo', $3, password_hash, 'portaria' FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [USER_PORTEIRO, ORG, EMAIL_PORTEIRO])
  cookie = await entrar(EMAIL_PORTEIRO)

  const { emitirIngressos } = await import('../utils/emissao')
  pedidoId = await pedido(`PED-ZZC-${MARCA_MAIUSCULA}`, [
    { tipo: T_COMBO_HOJE, qtd: 2, face: 25000 }, { tipo: T_IND_HOJE, qtd: 1, face: 3000 }])
  expect((await emitirIngressos(pedidoId)).emitiu).toBe(true)
  pedidoOutroId = await pedido(`PED-ZZO-${MARCA_MAIUSCULA}`, [{ tipo: T_COMBO_OUTRO, qtd: 1, face: 16000 }])
  expect((await emitirIngressos(pedidoOutroId)).emitiu).toBe(true)
}, 60_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('combo vira um ingresso por pessoa (050)', () => {
  it('a emissão: 2 combos de 10 + 1 entrada = 21 ingressos; o estoque anda por unidade', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ts = await partes(pedidoId)
    expect(ts).toHaveLength(21)
    const doCombo = ts.filter((t: any) => t.combo_group)
    expect(doCombo).toHaveLength(20)
    expect(new Set(doCombo.map((t: any) => t.combo_group)).size, 'cada unidade é um grupo').toBe(2)
    for (const t of doCombo) {
      expect(t.people).toBe(1)
      expect(t.combo_size).toBe(10)
      expect(t.ticket_type_id).toBe(T_COMBO_HOJE)
    }
    const seqs = doCombo.filter((t: any) => t.combo_group === doCombo[0].combo_group).map((t: any) => t.combo_seq)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const solta = ts.find((t: any) => !t.combo_group)
    expect(solta).toMatchObject({ people: null, combo_seq: null, ticket_type_id: T_IND_HOJE })
    expect(new Set(ts.map((t: any) => t.code)).size, 'código repetido').toBe(21)
    const lote = await um(`SELECT sold, reserved FROM lots WHERE id = $1`, [LOTE])
    expect(Number(lote.sold), 'o lote conta UNIDADES: 2 combos + 1 entrada + 1 combo de amanhã').toBe(4)
    expect(Number(lote.reserved)).toBe(0)
    const tipo = await um(`SELECT sold FROM ticket_types WHERE id = $1`, [T_COMBO_HOJE])
    expect(Number(tipo.sold)).toBe(2)
  })

  it('a porta lê uma parte: entra 1 pessoa e a resposta diz quem do combo já entrou', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ts = (await partes(pedidoId)).filter((t: any) => t.combo_group)
    const p1 = ts[0]
    const r = await ler(p1.code)
    expect(r.status).toBe(200)
    expect(r.corpo).toMatchObject({ ok: true, resultado: 'ok', pessoas: 1 })
    expect(r.corpo.combo).toMatchObject({ seq: 1, tamanho: 10 })
    expect(r.corpo.combo.partes.filter((p: any) => p.status === 'usado')).toHaveLength(1)
    const livro = await um(`SELECT sum(people)::int AS p, count(*)::int AS n FROM entries WHERE ticket_id = $1`, [p1.id])
    expect(livro).toEqual({ p: 1, n: 1 })
    // a outra metade do pedido (o outro combo) não foi tocada
    expect((await partes(pedidoId)).filter((t: any) => t.status === 'usado')).toHaveLength(1)
  })

  it('"a pessoa k deste combo" libera a irmã — uma vez só; fora de combo, não acha', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ts = (await partes(pedidoId)).filter((t: any) => t.combo_group)
    const p1 = ts[0]
    const r = await ler(p1.code, { parteDoCombo: 2 })
    expect(r.corpo).toMatchObject({ ok: true, resultado: 'ok', pessoas: 1 })
    expect(r.corpo.combo).toMatchObject({ seq: 2, tamanho: 10 })
    expect(r.corpo.combo.partes.filter((p: any) => p.status === 'usado')).toHaveLength(2)
    expect((await um(`SELECT status FROM tickets WHERE id = $1`, [ts[1].id])).status).toBe('usado')
    const log = await um(`SELECT code_lido FROM checkins WHERE ticket_id = $1 AND resultado = 'ok'`, [ts[1].id])
    expect(log.code_lido, 'o log leva o código da parte liberada').toBe(ts[1].code)

    const de2 = await ler(p1.code, { parteDoCombo: 2 })
    expect(de2.corpo).toMatchObject({ ok: false, resultado: 'ja_usado' })
    const solta = (await partes(pedidoId)).find((t: any) => !t.combo_group)
    const fora = await ler(solta.code, { parteDoCombo: 2 })
    expect(fora.corpo).toMatchObject({ ok: false, resultado: 'invalido' })
    expect((await um(`SELECT status FROM tickets WHERE id = $1`, [solta.id])).status).toBe('valido')
  })

  it('SEM REDE: a fila sobe as partes pelo QR lido + parte, 1 pessoa cada, e o reenvio não duplica', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ts = (await partes(pedidoId)).filter((t: any) => t.combo_group)
    const p1 = ts[0]
    const fila = [3, 4, 5].map((k) => ({ id: id(30 + k), qr: p1.code, gate: 'PORTAO-COMBO', offline: true, parte: k }))
    const r = await post('/api/portaria/sincronizar', { eventId: EVENTO, deviceId: 'tablet-combo', comLista: false, fila })
    expect(r.status).toBe(200)
    const usadas = (await partes(pedidoId)).filter((t: any) => t.status === 'usado').map((t: any) => t.combo_seq)
    expect(usadas.sort()).toEqual([1, 2, 3, 4, 5])
    const livro = await sql(`SELECT people FROM entries WHERE id = ANY($1::uuid[])`, [fila.map((f) => f.id)])
    expect(livro.map((l: any) => l.people)).toEqual([1, 1, 1])
    await post('/api/portaria/sincronizar', { eventId: EVENTO, deviceId: 'tablet-combo', comLista: false, fila })
    const n = await um(`SELECT count(*)::int AS n FROM entries e JOIN tickets t ON t.id = e.ticket_id WHERE t.order_id = $1`, [pedidoId])
    expect(n.n, 'o reenvio da mesma fila contou de novo').toBe(5)
  })

  it('a lista do tablet leva o grupo, a parte e as pessoas do tipo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await post('/api/portaria/sincronizar', { eventId: EVENTO, deviceId: 'tablet-combo', comLista: true, fila: [] })
    const itens = r.corpo.lista.ingressos as any[]
    const doCombo = itens.filter((i) => i.combo)
    expect(doCombo).toHaveLength(30)
    expect(doCombo[0]).toMatchObject({ pessoas: 1, combo: { tamanho: 10 } })
    expect(doCombo.find((i) => i.tipoId === T_COMBO_OUTRO)).toMatchObject({ pessoasDoTipo: 10, pagoCents: 1600 })
    expect(itens.filter((i) => !i.combo)).toHaveLength(1)
  })

  it('parte de combo de outro dia troca pagando a FRAÇÃO: R$ 250/10 − R$ 160/10 = R$ 9,00', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ts = await partes(pedidoOutroId)
    expect(ts).toHaveLength(10)
    const r = await ler(ts[0].code)
    expect(r.corpo).toMatchObject({ ok: false, foraDoDia: true })
    expect(r.corpo.troca).toMatchObject({ pagoCents: 1600, pessoas: 1 })
    expect(r.corpo.troca.opcoes).toEqual([expect.objectContaining({
      tipoId: T_COMBO_HOJE, pessoas: 1, precoCents: 2500, diferencaCents: 900, sugerida: true })])
    expect(r.corpo.combo).toMatchObject({ seq: 1, tamanho: 10 })

    // a parte 2, pelo QR da parte 1: cobra R$ 9,00, 1 pessoa no livro, a troca registrada
    const t = await post('/api/portaria/troca-de-dia', { id: id(40), qr: ts[0].code, eventId: EVENTO,
      tipoId: T_COMBO_HOJE, forma: 'dinheiro', cobradoCents: 900, gate: 'PORTAO-COMBO', deviceId: 'tablet-combo',
      parteDoCombo: 2 })
    expect(t.status).toBe(200)
    expect(t.corpo).toMatchObject({ ok: true, pessoas: 1, trocaFeita: { cobradoCents: 900, forma: 'dinheiro' } })
    const dc = await um(`SELECT ticket_id, people, cobrado_cents, pago_cents, preco_cents FROM day_changes WHERE id = $1`, [id(40)])
    expect(dc).toMatchObject({ ticket_id: ts[1].id, people: 1, cobrado_cents: 900, pago_cents: 1600, preco_cents: 2500 })
    expect((await um(`SELECT status FROM tickets WHERE id = $1`, [ts[0].id])).status, 'a parte 1 ficou intacta').toBe('valido')
    expect((await um(`SELECT people FROM entries WHERE id = $1`, [id(40)])).people).toBe(1)
  })
})
