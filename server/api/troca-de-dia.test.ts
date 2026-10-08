/**
 * Troca de dia na portaria (049), por HTTP — do jeito que o leitor do tablet usa.
 *
 * Dono, 08/10: "e se aparecer alguém com ingresso de sábado pra entrar domingo? ... bloquear, mas se a
 * pessoa quiser entrar, ela faz o pagamento lá na hora, o valor da diferença"; "a internet pode cair".
 * O que este arquivo prova:
 *
 *  1. o ingresso de outro dia segue BARRADO, e a resposta já traz a troca (o tipo irmão de hoje, o que
 *     a pessoa pagou e a diferença) — e o ingresso continua `valido`;
 *  2. a troca com valor errado é recusada com a conta nova; com o valor certo, numa transação só:
 *     ingresso usado, passagem no livro, leitura no log e a troca registrada (valor, forma, porteiro);
 *  3. o toque repetido (mesmo id) não cobra nem conta duas vezes;
 *  4. o combo de 10 troca por combo de 10 e entra contando 10 pessoas;
 *  5. ingresso que vale hoje não troca; quem não está logado não troca;
 *  6. SEM REDE: a troca sobe na fila da sincronização, é gravada com o id da passagem, o reenvio não
 *     duplica, e o valor cobrado que diverge do preço atual fica registrado ao lado do esperado;
 *  7. a lista do tablet leva os preços (sem eles o apagão não sabe cobrar);
 *  8. o dashboard soma as trocas por forma.
 *
 * Fixtura desta corrida (marca de `scripts/test-setup.ts`), apagada no fim. Sem servidor, PULA.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor, uuidDaCorrida, type Sonda,
} from '../../scripts/test-setup'
import { diaDeUsoDe } from '../utils/dias-de-uso'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/troca-de-dia', n)
const ORG = id(1)
const USER_PORTEIRO = id(2)
const USER_DONO = id(3)
const EVENTO = id(4)
const SETOR = id(5)
const LOTE = id(6)
const T_IND_OUTRO = id(7)
const T_IND_HOJE = id(8)
const T_COMBO_OUTRO = id(9)
const T_COMBO_HOJE = id(10)
const PASSAGEM_1 = id(20)
const PASSAGEM_COMBO = id(21)
const PASSAGEM_FILA = id(22)
const PASSAGEM_DIVERGE = id(23)

const MARCA_MINUSCULA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL_PORTEIRO = `porteiro.troca.${MARCA_MINUSCULA}@troca.invalido`
const EMAIL_DONO = `dono.troca.${MARCA_MINUSCULA}@troca.invalido`
const SENHA = 'diamond123'
const cod = (s: string) => `ZZT-${MARCA_MAIUSCULA}-${s}`
const COD_IND = cod('IND')
const COD_COMBO = cod('COMBO')
const COD_HOJE = cod('HOJE')
const COD_FILA = cod('FILA')
const COD_SEM_PEDIDO = cod('SEMPED')

const HOJE = diaDeUsoDe(new Date(), 'America/Bahia')
const AMANHA = new Date(new Date(`${HOJE}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10)

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
async function post(rota: string, corpo: any, cookie = cookiePorteiro) {
  const r = await fetch(`${BASE}${rota}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: BASE }, body: JSON.stringify(corpo),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any }
}
const ler = (qr: string) => post('/api/checkin', { qr, eventId: EVENTO, gate: 'PORTAO-TROCA' })
const trocar = (passagem: string, qr: string, tipoId: string, forma: string, cobradoCents: number, cookie?: string) =>
  post('/api/portaria/troca-de-dia', { id: passagem, qr, eventId: EVENTO, tipoId, forma, cobradoCents,
    gate: 'PORTAO-TROCA', deviceId: 'tablet-troca' }, cookie)
const um = async (texto: string, par: any[]) => (await sql(texto, par))[0]

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/troca-de-dia.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
    [ORG, `ZZ TROCA ${MARCA_MAIUSCULA}`, `zz-troca-${MARCA_MINUSCULA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, status, timezone)
     VALUES ($1,$2,$3,$4, now() - interval '1 day', now() + interval '2 days', 'ativo', 'America/Bahia')
     ON CONFLICT (id) DO NOTHING`,
    [EVENTO, ORG, `ZZ TROCA EVENTO ${MARCA_MAIUSCULA}`, `zz-troca-evento-${MARCA_MINUSCULA}`])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZ GERAL') ON CONFLICT (id) DO NOTHING`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity, sort_order)
             VALUES ($1,$2,'ZZ 1º LOTE',2000,1000,1) ON CONFLICT (id) DO NOTHING`, [LOTE, SETOR])
  // os nomes seguem os do parque: o "irmão" de hoje é o mesmo nome com outro dia da semana
  const tipo = (tid: string, nome: string, dia: string, preco: number, pessoas: number | null) => sql(
    `INSERT INTO ticket_types (id, lot_id, name, quantity, valid_dates, price_cents, admits)
     VALUES ($1,$2,$3,1000,$4::date[],$5,$6) ON CONFLICT (id) DO NOTHING`, [tid, LOTE, nome, [dia], preco, pessoas])
  await tipo(T_IND_OUTRO, 'ZZ ENTRADA INDIVIDUAL SABADO', AMANHA, 2000, null)
  await tipo(T_IND_HOJE, 'ZZ ENTRADA INDIVIDUAL DOMINGO', HOJE, 3000, null)
  await tipo(T_COMBO_OUTRO, 'ZZ COMBO SABADO - COMBO 10 PESSOAS', AMANHA, 16000, 10)
  await tipo(T_COMBO_HOJE, 'ZZ COMBO DOMINGO - COMBO 10 PESSOAS', HOJE, 25000, 10)

  // um pedido pago: 3 entradas de "sábado" (R$ 20) e 1 combo de "sábado" (R$ 160)
  const [o] = await sql(
    `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                         discount_cents, total_cents, refunded_cents, paid_at, payment_method)
     VALUES ($1,$2,$3,'pago','online',22000,0,0,0,22000,0, now() - interval '1 hour','pix') RETURNING id`,
    [ORG, EVENTO, `PED-ZZT-${MARCA_MAIUSCULA}`.slice(0, 40)])
  await sql(`INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents)
             VALUES ($1,$2,$3,3,2000,0,2000), ($1,$2,$4,1,16000,0,16000)`, [o.id, LOTE, T_IND_OUTRO, T_COMBO_OUTRO])
  const ingresso = (code: string, tid: string, pedido: string | null) => sql(
    `INSERT INTO tickets (org_id, event_id, sector_id, lot_id, ticket_type_id, order_id, code, qr_secret, status, holder_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'teste','valido','Fulano da Troca') ON CONFLICT (code) DO NOTHING`,
    [ORG, EVENTO, SETOR, LOTE, tid, pedido, code])
  await ingresso(COD_IND, T_IND_OUTRO, o.id)
  await ingresso(COD_FILA, T_IND_OUTRO, o.id)
  await ingresso(COD_COMBO, T_COMBO_OUTRO, o.id)
  await ingresso(COD_HOJE, T_IND_HOJE, null)
  await ingresso(COD_SEM_PEDIDO, T_IND_OUTRO, null)

  const usuario = (uid: string, email: string, role: string, nome: string) => sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, $3, $4, password_hash, $5 FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [uid, ORG, nome, email, role])
  await usuario(USER_PORTEIRO, EMAIL_PORTEIRO, 'portaria', 'Porteiro da Troca')
  await usuario(USER_DONO, EMAIL_DONO, 'admin', 'Dono da Troca')
  cookiePorteiro = await entrar(EMAIL_PORTEIRO)
  cookieDono = await entrar(EMAIL_DONO)
}, 40_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('troca de dia na portaria (049)', () => {
  it('as sessões de teste entraram de verdade', (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookiePorteiro).not.toBe('')
    expect(cookieDono).not.toBe('')
  })

  it('o ingresso de outro dia segue barrado e a porta já recebe a troca com a diferença', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await ler(COD_IND)
    expect(r.status).toBe(200)
    expect(r.corpo).toMatchObject({ ok: false, foraDoDia: true })
    expect(r.corpo.troca).toMatchObject({ hoje: HOJE, pagoCents: 2000, pessoas: 1 })
    expect(r.corpo.troca.opcoes[0]).toMatchObject({
      tipoId: T_IND_HOJE, precoCents: 3000, diferencaCents: 1000, sugerida: true })
    expect(r.corpo.troca.opcoes.map((o: any) => o.tipoId), 'combo de 10 oferecido pra entrada individual')
      .not.toContain(T_COMBO_HOJE)
    expect((await um(`SELECT status FROM tickets WHERE code = $1`, [COD_IND])).status).toBe('valido')
  })

  it('valor errado: recusa com a conta nova, e nada é gravado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await trocar(PASSAGEM_1, COD_IND, T_IND_HOJE, 'dinheiro', 500)
    expect(r.status).toBe(409)
    expect(String(r.corpo.statusMessage ?? r.corpo.message)).toContain('R$')
    expect(r.corpo.data?.troca?.opcoes?.[0]?.diferencaCents).toBe(1000)
    const sem = await trocar(PASSAGEM_1, COD_IND, T_IND_HOJE, 'sem_diferenca', 1000)
    expect(sem.status, 'liberou "sem diferença" com R$ 10 a cobrar').toBe(409)
    expect((await um(`SELECT count(*)::int n FROM day_changes WHERE id = $1`, [PASSAGEM_1])).n).toBe(0)
    expect((await um(`SELECT status FROM tickets WHERE code = $1`, [COD_IND])).status).toBe('valido')
  })

  it('valor certo: usado, livro, log e a troca registrada — numa transação', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await trocar(PASSAGEM_1, COD_IND, T_IND_HOJE, 'dinheiro', 1000)
    expect(r.status, JSON.stringify(r.corpo).slice(0, 300)).toBe(200)
    expect(r.corpo).toMatchObject({ ok: true, pessoas: 1,
      trocaFeita: { tipo: 'ZZ ENTRADA INDIVIDUAL DOMINGO', cobradoCents: 1000, forma: 'dinheiro' } })
    const t = await um(`SELECT id, status FROM tickets WHERE code = $1`, [COD_IND])
    expect(t.status).toBe('usado')
    const e = await um(`SELECT people, gate, device_id FROM entries WHERE id = $1`, [PASSAGEM_1])
    expect(e).toMatchObject({ people: 1, gate: 'PORTAO-TROCA', device_id: 'tablet-troca' })
    const dc = await um(`SELECT * FROM day_changes WHERE id = $1`, [PASSAGEM_1])
    expect(dc).toMatchObject({ ticket_id: t.id, from_type_id: T_IND_OUTRO, to_type_id: T_IND_HOJE, forma: 'dinheiro',
      offline: false, people: 1, operator_id: USER_PORTEIRO })
    expect(Number(dc.cobrado_cents)).toBe(1000)
    expect(Number(dc.esperado_cents)).toBe(1000)
    expect(Number(dc.pago_cents)).toBe(2000)
    const log = await um(`SELECT count(*)::int n FROM checkins WHERE ticket_id = $1 AND resultado = 'ok'`, [t.id])
    expect(log.n).toBe(1)
  })

  it('o toque repetido (mesmo id) não cobra nem conta de novo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await trocar(PASSAGEM_1, COD_IND, T_IND_HOJE, 'dinheiro', 1000)
    expect(r.status).toBe(200)
    expect(r.corpo.trocaFeita).toMatchObject({ cobradoCents: 1000 })
    const t = await um(`SELECT id FROM tickets WHERE code = $1`, [COD_IND])
    expect((await um(`SELECT count(*)::int n FROM day_changes WHERE ticket_id = $1`, [t.id])).n).toBe(1)
    expect((await um(`SELECT count(*)::int n FROM entries WHERE ticket_id = $1`, [t.id])).n).toBe(1)
  })

  it('depois da troca, ler o ingresso de novo diz "já usado"', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await ler(COD_IND)
    expect(r.corpo).toMatchObject({ ok: false, resultado: 'ja_usado' })
  })

  it('o combo de 10 troca por combo de 10 e entra contando 10 pessoas', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const l = await ler(COD_COMBO)
    expect(l.corpo.troca.opcoes).toHaveLength(1)
    expect(l.corpo.troca.opcoes[0]).toMatchObject({ tipoId: T_COMBO_HOJE, diferencaCents: 9000, pessoas: 10 })
    const r = await trocar(PASSAGEM_COMBO, COD_COMBO, T_COMBO_HOJE, 'pix', 9000)
    expect(r.status).toBe(200)
    expect(r.corpo.pessoas).toBe(10)
    expect((await um(`SELECT people FROM entries WHERE id = $1`, [PASSAGEM_COMBO])).people).toBe(10)
  })

  it('ingresso que vale hoje não troca (entra normal, sem cobrar)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await trocar(id(30), COD_HOJE, T_IND_HOJE, 'sem_diferenca', 0)
    expect(r.status).toBe(409)
    expect(String(r.corpo.statusMessage)).toContain('vale hoje')
    expect((await um(`SELECT status FROM tickets WHERE code = $1`, [COD_HOJE])).status).toBe('valido')
  })

  it('sem login não troca', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await trocar(id(31), COD_SEM_PEDIDO, T_IND_HOJE, 'dinheiro', 1000, '')
    expect(r.status).toBe(401)
  })

  it('ingresso sem item de pedido: o "pagou" é o preço do tipo comprado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await ler(COD_SEM_PEDIDO)
    expect(r.corpo.troca).toMatchObject({ pagoCents: 2000 })
    expect(r.corpo.troca.opcoes[0].diferencaCents).toBe(1000)
  })

  it('a lista do tablet leva os preços e, no ingresso com dia, o tipo e o que custou', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await post('/api/portaria/sincronizar', { eventId: EVENTO, deviceId: 'tablet-troca', fila: [], comLista: true })
    expect(r.status).toBe(200)
    const tipos = r.corpo.lista.tiposDaTroca
    expect(tipos.find((t: any) => t.id === T_IND_HOJE)).toMatchObject({ faceCents: 3000, pessoas: 1, dias: [HOJE] })
    expect(tipos.find((t: any) => t.id === T_COMBO_HOJE)).toMatchObject({ faceCents: 25000, pessoas: 10 })
    const comDia = r.corpo.lista.ingressos.filter((i: any) => i.tipoId === T_IND_OUTRO)
    expect(comDia.length).toBeGreaterThan(0)
    expect(comDia.every((i: any) => i.pagoCents === 2000)).toBe(true)
  })

  it('SEM REDE: a troca sobe na fila, é gravada com o id da passagem e o reenvio não duplica', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const item = { id: PASSAGEM_FILA, qr: COD_FILA, gate: 'PORTAO-TROCA', em: new Date().toISOString(), offline: true,
      troca: { tipoId: T_IND_HOJE, forma: 'dinheiro', cobradoCents: 1000, tipoNome: 'ZZ ENTRADA INDIVIDUAL DOMINGO' } }
    const r = await post('/api/portaria/sincronizar', { eventId: EVENTO, deviceId: 'tablet-troca', fila: [item], comLista: false })
    expect(r.status, JSON.stringify(r.corpo).slice(0, 300)).toBe(200)
    expect(r.corpo.itens[0].resultado).toBe('aplicada')
    const dc = await um(`SELECT * FROM day_changes WHERE id = $1`, [PASSAGEM_FILA])
    expect(dc).toMatchObject({ offline: true, forma: 'dinheiro', to_type_id: T_IND_HOJE })
    expect(Number(dc.cobrado_cents)).toBe(1000)
    expect(Number(dc.esperado_cents)).toBe(1000)
    const de_novo = await post('/api/portaria/sincronizar', { eventId: EVENTO, deviceId: 'tablet-troca', fila: [item], comLista: false })
    expect(de_novo.corpo.itens[0].resultado).toBe('repetida')
    expect((await um(`SELECT count(*)::int n FROM day_changes WHERE id = $1`, [PASSAGEM_FILA])).n).toBe(1)
    const t = await um(`SELECT id, status FROM tickets WHERE code = $1`, [COD_FILA])
    expect(t.status).toBe('usado')
    expect((await um(`SELECT count(*)::int n FROM entries WHERE ticket_id = $1`, [t.id])).n).toBe(1)
  })

  it('SEM REDE com preço velho: grava o que foi cobrado E o esperado, lado a lado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const item = { id: PASSAGEM_DIVERGE, qr: COD_SEM_PEDIDO, em: new Date().toISOString(), offline: true,
      troca: { tipoId: T_IND_HOJE, forma: 'pix', cobradoCents: 700 } }
    const r = await post('/api/portaria/sincronizar', { eventId: EVENTO, deviceId: 'tablet-troca', fila: [item], comLista: false })
    expect(r.corpo.itens[0].resultado).toBe('aplicada')
    const dc = await um(`SELECT * FROM day_changes WHERE id = $1`, [PASSAGEM_DIVERGE])
    expect(Number(dc.cobrado_cents)).toBe(700)
    expect(Number(dc.esperado_cents)).toBe(1000)
  })

  it('o dashboard soma as trocas por forma e aponta a divergente', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE}/api/admin/evento/${EVENTO}/dashboard`, { headers: { cookie: cookieDono } })
    const corpo = await r.json() as any
    expect(r.status, JSON.stringify(corpo).slice(0, 300)).toBe(200)
    expect(corpo.trocasDeDia).toMatchObject({ trocas: 4, pessoas: 13, cobradoCents: 1000 + 9000 + 1000 + 700, divergentes: 1 })
    expect(corpo.trocasDeDia.porForma.dinheiro).toEqual({ trocas: 2, cents: 2000 })
    expect(corpo.trocasDeDia.porForma.pix).toEqual({ trocas: 2, cents: 9700 })
    expect(corpo.trocasDeDia.lista[0].operador).toBe('Porteiro da Troca')
  })
})
