/**
 * Meia-entrada no BALCÃO — a mesma lei do site (ADM-02, 27/09).
 *
 * O guichê vendia meia sem conferir a cota de 40% do lote e sem perguntar o motivo: o checkout
 * recusava a 5ª meia de um lote de 10, o balcão vendia a 5ª, a 6ª, a 7ª. E o ingresso saía sem
 * `half_reason` — a portaria lia "meia" e não sabia se pedia carteira de estudante ou RG de 60+.
 *
 * Aqui: lote de 10 (cota 4), três meias já vendidas pelo site. O balcão vende a 4ª com motivo
 * gravado no item E no ingresso; a 5ª volta 409 com a frase pro operador, e nada fica gravado.
 *
 * Vai à rota com sessão de verdade; sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../../../../scripts/test-setup'
import { MOTIVOS } from '../../../../../utils/meia-entrada'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/evento/pdv/meia-balcao', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const SETOR = id(4)
const LOTE = id(5)
const MEIA = id(6)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.meia-balcao.${MARCA}@teste.invalido`
const CPF = '52998224725'

/** lote de 10: a lei deixa 4 meias (40%, arredondado pra baixo) */
const COTA = 4
/** as que o site já vendeu antes do guichê abrir */
const DO_SITE = 3

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''
let turnoId = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../../utils/db')
  return q<any>(texto, par)
}

async function chamar(rota: string, corpo?: any) {
  const r = await fetch(`${BASE}/api/admin/evento/${EVENTO}${rota}`, {
    method: corpo === undefined ? 'GET' : 'POST',
    headers: { cookie, origin: BASE, 'content-type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({} as any)) }
}

const vender = (itens: any[], extra: any = {}) => chamar('/pdv/venda', {
  turnoId, forma: 'dinheiro', itens, comprador: { nome: 'Cliente Meia', documento: CPF }, ...extra,
})

const meiasVendidas = async () =>
  Number((await sql(`SELECT sold FROM ticket_types WHERE id = $1`, [MEIA]))[0].sold)

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/evento/[id]/pdv/meia-balcao.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZM MEIA BALCAO ${MARCA_MAIUSCULA}`, `zzm-meia-balcao-${MARCA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, fee_mode_pos, status)
     VALUES ($1,$2,$3,$4, now() + interval '5 days', now() + interval '6 days', 1000, 'absorver', 'ativo')`,
    [EVENTO, ORG, `ZZM MEIA BALCAO ${MARCA_MAIUSCULA}`, `zzm-meia-balcao-ev-${MARCA}`])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZM SETOR')`, [SETOR, EVENTO])
  // o site já vendeu 3 meias: é o estado em que o guichê abre
  await sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity, sold, channels, visible)
     VALUES ($1,$2,'ZZM LOTE', 4000, 10, $3, '{online,bilheteria}', true)`, [LOTE, SETOR, DO_SITE])
  await sql(
    `INSERT INTO ticket_types (id, lot_id, name, quantity, sold, discount_bps, requires_document)
     VALUES ($1,$2,'Meia', 10, $3, 5000, true)`, [MEIA, LOTE, DO_SITE])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZM Dono Meia', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'`, [USUARIO, ORG, EMAIL])

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''

  const ponto = await chamar('/pdv', { nome: `ZZM GUICHE ${MARCA_MAIUSCULA}`, formas: ['dinheiro', 'debito'] })
  if (ponto.status !== 200) throw new Error(`ponto não criado: ${JSON.stringify(ponto.corpo)}`)
  const caixa = await chamar('/pdv/turno', { pontoId: ponto.corpo.id, fundoCents: 0 })
  if (caixa.status !== 200) throw new Error(`caixa não abriu: ${JSON.stringify(caixa.corpo)}`)
  turnoId = caixa.corpo.turnoId
}, 240_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('balcão: meia-entrada com motivo e dentro da cota', () => {
  it('entrou e abriu o caixa (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie, 'login falhou').toBeTruthy()
    expect(turnoId, 'o caixa não abriu').toBeTruthy()
  })

  it('meia sem motivo não sai do guichê', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await vender([{ lotId: LOTE, ticketTypeId: MEIA, quantidade: 1 }])
    expect(r.status, 'vendeu meia sem perguntar o motivo').toBe(422)
    expect(r.corpo.data?.tipo).toBe('meia_sem_motivo')
    expect(await meiasVendidas()).toBe(DO_SITE)
  }, 120_000)

  it('a 4ª meia sai com o motivo no item e no ingresso', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await vender([{ lotId: LOTE, ticketTypeId: MEIA, quantidade: 1, meia: { motivo: 'idoso' } }])
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)

    const [item] = await sql(
      `SELECT half_reason, half_document, half_document_required FROM order_items WHERE order_id = $1`,
      [r.corpo.pedidoId])
    expect(item.half_reason, 'o motivo da meia não foi gravado na venda').toBe('idoso')
    expect(item.half_document).toBe(CPF)
    expect(item.half_document_required).toBe(MOTIVOS.idoso.documento)

    const [ingresso] = await sql(
      `SELECT half_reason, half_document_required FROM tickets WHERE order_id = $1`, [r.corpo.pedidoId])
    expect(ingresso.half_reason, 'a portaria não vê o motivo no ingresso').toBe('idoso')
    expect(ingresso.half_document_required).toBe(MOTIVOS.idoso.documento)
    expect(await meiasVendidas()).toBe(COTA)
  }, 120_000)

  it('a 5ª meia passa da cota: 409 com a frase pro operador, nada gravado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const antes = Number((await sql(`SELECT count(*)::int AS n FROM orders WHERE event_id = $1`, [EVENTO]))[0].n)
    const r = await vender([{ lotId: LOTE, ticketTypeId: MEIA, quantidade: 1, meia: { motivo: 'estudante' } }])
    expect(r.status, 'o balcão vendeu meia além dos 40% do lote').toBe(409)
    expect(r.corpo.data?.tipo).toBe('cota_meia')
    expect(String(r.corpo.statusMessage ?? r.corpo.message)).toMatch(/Venda como inteira/)
    // rollback inteiro: nem pedido, nem estoque
    expect(await meiasVendidas()).toBe(COTA)
    const depois = Number((await sql(`SELECT count(*)::int AS n FROM orders WHERE event_id = $1`, [EVENTO]))[0].n)
    expect(depois).toBe(antes)
  }, 120_000)

  it('motivo em linha que não é meia é recusado (a portaria pediria documento de quem não precisa)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await vender([{ lotId: LOTE, quantidade: 1, meia: { motivo: 'idoso' } }])
    expect(r.status).toBe(422)
    expect(r.corpo.data?.tipo).toBe('meia_em_inteira')
  }, 120_000)
})
