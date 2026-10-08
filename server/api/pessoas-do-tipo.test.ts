/**
 * Pessoas por ingresso do TIPO (048), por HTTP — o combo que "conta como 10".
 *
 * Dono, 08/10: o combo é um ingresso que conta como 10, 15 — "pra contagem ficar certa". O que este
 * arquivo prova:
 *
 *  1. o ingresso do COMBO 10 entra na catraca contando 10 pessoas (resposta e livro `entries`);
 *  2. a entrada individual do MESMO setor segue contando 1 (o setor não muda);
 *  3. a lista do tablet leva as 10 (sem rede a porta conta igual);
 *  4. o painel grava as pessoas no tipo e no de mesmo nome do outro lote, e volta a 1 com `null`;
 *  5. o dashboard soma pessoas vendidas (o combo vendido conta 10), sem mexer em "ingressos vendidos".
 *
 * Fixtura desta corrida (marca de `scripts/test-setup.ts`), apagada no fim. Sem servidor, PULA.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor, uuidDaCorrida, type Sonda,
} from '../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/pessoas-do-tipo', n)
const ORG = id(1)
const USER_PORTEIRO = id(2)
const USER_DONO = id(3)
const EVENTO = id(4)
const SETOR = id(5)
const LOTE_1 = id(6)
const LOTE_2 = id(7)
const TIPO_COMBO = id(8)
const TIPO_INDIVIDUAL = id(9)
const TIPO_COMBO_LOTE_2 = id(10)

const MARCA_MINUSCULA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL_PORTEIRO = `porteiro.pessoas.${MARCA_MINUSCULA}@pessoas.invalido`
const EMAIL_DONO = `dono.pessoas.${MARCA_MINUSCULA}@pessoas.invalido`
const SENHA = 'diamond123'
const cod = (sufixo: string) => `ZZP-${MARCA_MAIUSCULA}-${sufixo}`
const COD_COMBO = cod('COMBO')
const COD_INDIVIDUAL = cod('INDIV')
const NOME_COMBO = 'ZZ COMBO DOMINGO - COMBO 10 PESSOAS'

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookiePorteiro = ''
let cookieDono = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../utils/db')
  return q<any>(texto, par)
}
async function entrar(email: string) {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, senha: SENHA }),
  })
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c!.startsWith('dt_sessao=')) ?? ''
}
async function ler(qr: string) {
  const r = await fetch(`${BASE}/api/checkin`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookiePorteiro, origin: BASE },
    body: JSON.stringify({ qr, eventId: EVENTO, gate: 'PORTAO-COMBO' }),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any }
}
async function painel(metodo: 'PATCH' | 'GET', corpo?: any, rota = '/ingressos') {
  const r = await fetch(`${BASE}/api/admin/evento/${EVENTO}${rota}`, {
    method: metodo, headers: { 'content-type': 'application/json', cookie: cookieDono, origin: BASE },
    body: corpo ? JSON.stringify(corpo) : undefined,
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any }
}
const pessoasDoTipo = async (tipo: string) =>
  (await sql(`SELECT admits FROM ticket_types WHERE id = $1`, [tipo]))[0]?.admits ?? null

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/pessoas-do-tipo.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
    [ORG, `ZZ PESSOAS ${MARCA_MAIUSCULA}`, `zz-pessoas-${MARCA_MINUSCULA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, status, timezone)
     VALUES ($1,$2,$3,$4, now() - interval '2 hours', now() + interval '6 hours', 'ativo', 'America/Bahia')
     ON CONFLICT (id) DO NOTHING`,
    [EVENTO, ORG, `ZZ PESSOAS EVENTO ${MARCA_MAIUSCULA}`, `zz-pessoas-evento-${MARCA_MINUSCULA}`])
  // o setor é o "Geral" do parque: 1 pessoa por unidade, com combo e individual juntos
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZ GERAL') ON CONFLICT (id) DO NOTHING`, [SETOR, EVENTO])
  for (const [lote, nome, ordem] of [[LOTE_1, 'ZZ 1º LOTE', 1], [LOTE_2, 'ZZ 2º LOTE', 2]] as const) {
    await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity, sort_order)
               VALUES ($1,$2,$3,1000,100,$4) ON CONFLICT (id) DO NOTHING`, [lote, SETOR, nome, ordem])
  }
  const tipo = (tid: string, lote: string, nome: string, pessoas: number | null) => sql(
    `INSERT INTO ticket_types (id, lot_id, name, quantity, admits) VALUES ($1,$2,$3,100,$4) ON CONFLICT (id) DO NOTHING`,
    [tid, lote, nome, pessoas])
  await tipo(TIPO_COMBO, LOTE_1, NOME_COMBO, 10)
  await tipo(TIPO_INDIVIDUAL, LOTE_1, 'ZZ ENTRADA INDIVIDUAL DOMINGO', null)
  await tipo(TIPO_COMBO_LOTE_2, LOTE_2, NOME_COMBO.toLowerCase(), null)

  // um pedido pago com 1 combo e 2 individuais: 3 ingressos, 12 pessoas
  const [o] = await sql(
    `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                         discount_cents, total_cents, refunded_cents, paid_at, payment_method)
     VALUES ($1,$2,$3,'pago','online',18000,0,0,0,18000,0, now() - interval '1 hour','pix') RETURNING id`,
    [ORG, EVENTO, `PED-ZZP-${MARCA_MAIUSCULA}`.slice(0, 40)])
  await sql(`INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents)
             VALUES ($1,$2,$3,1,16000,0,16000), ($1,$2,$4,2,1000,0,1000)`, [o.id, LOTE_1, TIPO_COMBO, TIPO_INDIVIDUAL])
  const ingresso = (code: string, tid: string) => sql(
    `INSERT INTO tickets (org_id, event_id, sector_id, lot_id, ticket_type_id, order_id, code, qr_secret, status, holder_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'teste','valido','Fulano do Combo') ON CONFLICT (code) DO NOTHING`,
    [ORG, EVENTO, SETOR, LOTE_1, tid, o.id, code])
  await ingresso(COD_COMBO, TIPO_COMBO)
  await ingresso(COD_INDIVIDUAL, TIPO_INDIVIDUAL)

  const usuario = (uid: string, email: string, role: string, nome: string) => sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, $3, $4, password_hash, $5 FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [uid, ORG, nome, email, role])
  await usuario(USER_PORTEIRO, EMAIL_PORTEIRO, 'portaria', 'Porteiro do Combo')
  await usuario(USER_DONO, EMAIL_DONO, 'admin', 'Dono do Combo')
  cookiePorteiro = await entrar(EMAIL_PORTEIRO)
  cookieDono = await entrar(EMAIL_DONO)
}, 40_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('combo que conta como N pessoas (048)', () => {
  it('as sessões de teste entraram de verdade', (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookiePorteiro).not.toBe('')
    expect(cookieDono).not.toBe('')
  })

  it('a lista do tablet leva 10 pessoas pro combo e 1 pra individual', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE}/api/portaria/sincronizar`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookiePorteiro, origin: BASE },
      body: JSON.stringify({ eventId: EVENTO, deviceId: 'tablet-combo', fila: [], comLista: true }),
    })
    const corpo: any = await r.json()
    expect(r.status).toBe(200)
    const porTipo = Object.fromEntries(corpo.lista.ingressos.map((i: any) => [i.tipo, i.pessoas]))
    expect(porTipo[NOME_COMBO]).toBe(10)
    expect(porTipo['ZZ ENTRADA INDIVIDUAL DOMINGO']).toBe(1)
  })

  it('o combo entra contando 10 pessoas (resposta e livro); a individual conta 1', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const combo = await ler(COD_COMBO)
    expect(combo.corpo).toMatchObject({ ok: true, pessoas: 10 })
    const indiv = await ler(COD_INDIVIDUAL)
    expect(indiv.corpo).toMatchObject({ ok: true, pessoas: 1 })
    const [livro] = await sql(`SELECT COALESCE(sum(people),0)::int AS p FROM entries WHERE event_id = $1`, [EVENTO])
    expect(livro.p, 'o público dentro não somou as 10 do combo').toBe(11)
  })

  it('o dashboard soma as pessoas vendidas sem mexer em "ingressos vendidos"', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await painel('GET', undefined, '/dashboard')
    expect(r.status, JSON.stringify(r.corpo).slice(0, 300)).toBe(200)
    expect(r.corpo.totais.pagos).toBe(3)
    expect(r.corpo.totais.pessoasPagantes).toBe(12)
    expect(r.corpo.publico.pessoas).toBe(11)
  })

  it('a lista do painel mostra as pessoas do tipo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await painel('GET')
    expect(r.status).toBe(200)
    const tipos = r.corpo.setores[0].lotes.flatMap((l: any) => l.tipos)
    expect(tipos.find((t: any) => t.id === TIPO_COMBO).pessoas).toBe(10)
    expect(tipos.find((t: any) => t.id === TIPO_INDIVIDUAL).pessoas).toBeNull()
  })

  it('gravar as pessoas no combo grava no de mesmo nome do outro lote; null volta a 1', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    let r = await painel('PATCH', { o: 'tipo', id: TIPO_COMBO, campos: { pessoas: 15 } })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(await pessoasDoTipo(TIPO_COMBO)).toBe(15)
    expect(await pessoasDoTipo(TIPO_COMBO_LOTE_2)).toBe(15)
    expect(await pessoasDoTipo(TIPO_INDIVIDUAL)).toBeNull()
    r = await painel('PATCH', { o: 'tipo', id: TIPO_COMBO, campos: { pessoas: null } })
    expect(r.status).toBe(200)
    expect(await pessoasDoTipo(TIPO_COMBO)).toBeNull()
    expect(await pessoasDoTipo(TIPO_COMBO_LOTE_2)).toBeNull()
  })

  it('mais de 100 pessoas é recusado com a frase', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await painel('PATCH', { o: 'tipo', id: TIPO_COMBO, campos: { pessoas: 500 } })
    expect(r.status).toBe(400)
    expect(String(r.corpo.statusMessage ?? r.corpo.message)).toContain('no máximo 100 pessoas')
  })
})
