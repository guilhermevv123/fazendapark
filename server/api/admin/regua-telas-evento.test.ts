/**
 * A mesma régua em todas as telas do evento — quatro defeitos, uma fixtura.
 *
 *  1. **Extrato somava estornado, chargeback e disputa no "cobrado".** Todas
 *     as outras telas recortam por `PEDIDO_VIVO()`; o extrato mostrava outro
 *     total da mesma venda. Agora os KPIs usam a régua e o que ficou de fora
 *     vem em `foraDoTotal`, rotulado.
 *  2. **Duas fórmulas de comparecimento.** Borderô e histórico contavam
 *     `tickets.status = 'usado'` (a trava do QR); leitor e painel contam o
 *     livro de entradas (`SQL_PUBLICO`). A fixtura tem um ingresso que ENTROU
 *     e depois foi cancelado — é aí que as duas contas se separam.
 *  3. **"Hoje" no fuso errado.** O filtro cortava o dia no fuso do Node e o
 *     card "hoje" no fuso do Postgres. Evento em `Pacific/Kiritimati` (UTC+14,
 *     17 h à frente da Bahia): em qualquer hora do dia, o corte antigo pega
 *     o pedido de "ontem" ou perde o de "hoje".
 *  4. **"Só conferir" gravava leitura** quando o ingresso já tinha entrado,
 *     estava cancelado ou nem existia.
 *
 * Vai às rotas, com sessão de verdade. Sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/regua-telas-evento', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const SETOR = id(4)
const LOTE = id(5)
const EVENTO_FUSO = id(6)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.regua-telas.${MARCA}@teste.invalido`
const FUSO = 'Pacific/Kiritimati'

const cod = (s: string) => `ZZQ-${MARCA_MAIUSCULA}-${s}`
const T = {
  valido: id(21), canceladoQueEntrou: id(22), usado: id(23), valido2: id(24),
  consulta: id(25), cancelado: id(26),
}

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../utils/db')
  return q<any>(texto, par)
}

async function get(rota: string) {
  const r = await fetch(`${BASE}${rota}`, { headers: { cookie, origin: BASE } })
  expect(r.status, `${rota} respondeu ${r.status}`).toBe(200)
  return r.json()
}

async function pedido(evento: string, sufixo: string, status: string, total: number,
                      estornado: number, pagoEm = `now() - interval '2 days'`) {
  await sql(
    `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method,
                         face_cents, fee_cents, platform_cents, discount_cents,
                         total_cents, refunded_cents, asaas_payment_id, paid_at)
     VALUES ($1,$2,$3,$4,'online','pix', $5, 0, 0, 0, $5, $6, NULL, ${pagoEm})`,
    [ORG, evento, `ZZQA-REGUA-${MARCA_MAIUSCULA}-${sufixo}`, status, total, estornado])
}

async function ingresso(tid: string, code: string, status: string) {
  await sql(
    `INSERT INTO tickets (id, org_id, event_id, sector_id, lot_id, code, qr_secret, status, holder_name)
     VALUES ($1,$2,$3,$4,$5,$6,'teste',$7,'ZZQA Titular')`,
    [tid, ORG, EVENTO, SETOR, LOTE, code, status])
}

async function entrada(tid: string) {
  await sql(
    `INSERT INTO entries (id, org_id, event_id, ticket_id, people, offline)
     VALUES (gen_random_uuid(), $1, $2, $3, 1, false)`, [ORG, EVENTO, tid])
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/regua-telas-evento.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZQA REGUA ${MARCA_MAIUSCULA}`, `zzqa-regua-${MARCA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,$3,$4, now() - interval '5 days', now() + interval '5 days', 1000, 'ativo')`,
    [EVENTO, ORG, `ZZQA REGUA ${MARCA_MAIUSCULA}`, `zzqa-regua-ev-${MARCA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status, timezone)
     VALUES ($1,$2,$3,$4, now() - interval '5 days', now() + interval '5 days', 1000, 'ativo', $5)`,
    [EVENTO_FUSO, ORG, `ZZQA FUSO ${MARCA_MAIUSCULA}`, `zzqa-regua-fuso-${MARCA}`, FUSO])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZQA SETOR')`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity)
             VALUES ($1,$2,'ZZQA LOTE', 1000, 100)`, [LOTE, SETOR])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZQA Dono Régua', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'`, [USUARIO, ORG, EMAIL])

  // ---- dinheiro do extrato: dois vivos, três fora da régua
  await pedido(EVENTO, 'A', 'pago', 10_000, 0)
  await pedido(EVENTO, 'B', 'estornado_parcial', 20_000, 5_000)
  await pedido(EVENTO, 'C', 'estornado', 30_000, 30_000)
  await pedido(EVENTO, 'D', 'chargeback', 40_000, 0)
  await pedido(EVENTO, 'E', 'disputa', 5_000, 0)

  // ---- público: um entrou e foi cancelado, um entrou normal
  await ingresso(T.valido, cod('VAL1'), 'valido')
  await ingresso(T.canceladoQueEntrou, cod('CANE'), 'cancelado')
  await ingresso(T.usado, cod('USAD'), 'usado')
  await ingresso(T.valido2, cod('VAL2'), 'valido')
  await ingresso(T.consulta, cod('CONS'), 'valido')
  await ingresso(T.cancelado, cod('CANC'), 'cancelado')
  await entrada(T.canceladoQueEntrou)
  await entrada(T.usado)

  // ---- "hoje" no fuso do evento: um minuto antes e um depois da meia-noite de lá
  const inicioDeHoje = `(date_trunc('day', now() AT TIME ZONE '${FUSO}') AT TIME ZONE '${FUSO}')`
  await pedido(EVENTO_FUSO, 'HOJE', 'pago', 7_000, 0, `${inicioDeHoje} + interval '1 minute'`)
  await pedido(EVENTO_FUSO, 'ONTEM', 'pago', 3_000, 0, `${inicioDeHoje} - interval '1 minute'`)

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 40_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM checkins WHERE event_id = ANY($1::uuid[])`, [[EVENTO, EVENTO_FUSO]])
  await sql(`DELETE FROM entries WHERE event_id = ANY($1::uuid[])`, [[EVENTO, EVENTO_FUSO]])
  await sql(`DELETE FROM tickets WHERE org_id = $1`, [ORG])
  await sql(`DELETE FROM orders WHERE org_id = $1`, [ORG])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('a régua das telas do evento', () => {
  it('entrou (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()
  })

  it('extrato: o cobrado é o mesmo do painel; estorno total e contestação vêm à parte', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ext = await get(`/api/admin/evento/${EVENTO}/extrato`)
    const painel = await get(`/api/admin/evento/${EVENTO}/dashboard`)
    const bor = await get(`/api/admin/evento/${EVENTO}/bordero`)

    expect(ext.totais.cobradoCents, 'extrato somou estornado/chargeback/disputa no cobrado')
      .toBe(30_000)
    expect(ext.totais.cobradoCents).toBe(painel.totais.cobradoCents)
    expect(ext.totais.liquidoCents).toBe(bor.totais.liquidoCents)
    // a devolução é a exceção da régua em TODAS as telas: estorno total dentro
    expect(ext.totais.estornadoCents).toBe(bor.totais.estornadoCents)
    expect(ext.totais.estornadoCents).toBe(35_000)
    expect(ext.totais.estornadoNoLiquidoCents).toBe(5_000)
    expect(ext.totais.pedidos).toBe(2)
    // as partes somam o todo
    expect(ext.porCanal.reduce((a: number, c: any) => a + c.cobradoCents, 0)).toBe(30_000)
    expect(ext.porForma.reduce((a: number, c: any) => a + c.cobradoCents, 0)).toBe(30_000)

    expect(ext.foraDoTotal.pedidos).toBe(3)
    expect(ext.foraDoTotal.cobradoCents).toBe(75_000)
    expect(ext.foraDoTotal.porStatus.map((f: any) => f.status).sort())
      .toEqual(['chargeback', 'disputa', 'estornado'])

    // a história continua inteira: as cinco linhas, as três marcadas
    expect(ext.linhas).toHaveLength(5)
    expect(ext.linhas.filter((l: any) => l.foraDoTotal)).toHaveLength(3)
  }, 30_000)

  it('comparecimento: borderô e histórico com a MESMA conta do leitor', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { SQL_PUBLICO, retratoDoPublico } = await import('../../utils/catraca')
    const [linha] = await sql(SQL_PUBLICO, [EVENTO])
    const livro = retratoDoPublico(linha)

    // a fixtura separa as duas fórmulas? (1 ingresso 'usado' contra 2 no livro)
    const [velha] = await sql(
      `SELECT count(*) FILTER (WHERE status = 'usado')::int AS usados FROM tickets WHERE event_id = $1`,
      [EVENTO])
    expect(velha.usados, 'a fixtura parou de separar trava e livro').not.toBe(livro.ingressos)

    const bor = await get(`/api/admin/evento/${EVENTO}/bordero`)
    const ck = await get(`/api/admin/evento/${EVENTO}/checkins`)

    expect(bor.totais.ingressosUsados, 'borderô contou a trava, não o livro').toBe(livro.ingressos)
    expect(bor.totais.comparecimentoPct).toBe(livro.comparecimentoPct)
    expect(ck.resumo.entraram, 'histórico contou a trava, não o livro').toBe(livro.ingressos)
    expect(ck.resumo.aptos).toBe(livro.aptos)
    expect(ck.resumo.comparecimentoPct).toBe(livro.comparecimentoPct)
  }, 30_000)

  it('"Hoje" corta o dia no fuso do EVENTO, igual no filtro e no card', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const hojeLa = new Intl.DateTimeFormat('en-CA', {
      timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())

    const tudo = await get(`/api/admin/evento/${EVENTO_FUSO}/dashboard`)
    expect(tudo.totais.hojeCents, 'o card "hoje" cortou o dia no fuso do banco').toBe(7_000)

    const porNome = await get(`/api/admin/evento/${EVENTO_FUSO}/dashboard?periodo=hoje`)
    expect(porNome.totais.cobradoCents, 'o filtro "Hoje" cortou o dia no fuso do servidor')
      .toBe(7_000)
    expect(porNome.periodo.fuso).toBe(FUSO)
    expect(porNome.periodo.hoje).toBe(hojeLa)

    const porData = await get(`/api/admin/evento/${EVENTO_FUSO}/dashboard?de=${hojeLa}&ate=${hojeLa}`)
    expect(porData.totais.cobradoCents).toBe(7_000)
  }, 30_000)

  it('"Só conferir" não grava leitura em NENHUM ramo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const contar = async () =>
      (await sql(`SELECT count(*)::int AS n FROM checkins WHERE event_id = $1`, [EVENTO]))[0].n
    const ler = (qr: string, apenasConsultar: boolean) => fetch(`${BASE}/api/checkin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: BASE },
      body: JSON.stringify({ qr, eventId: EVENTO, gate: 'ZZQA', apenasConsultar }),
    }).then(async (r) => ({ status: r.status, corpo: await r.json() }))

    const antes = await contar()
    const usado = await ler(cod('USAD'), true)
    const cancelado = await ler(cod('CANC'), true)
    const inexistente = await ler(cod('NADA'), true)
    expect(usado.status).toBe(200)
    expect(usado.corpo.resultado).toBe('ja_usado')
    expect(usado.corpo.consulta).toBe(true)
    expect(cancelado.corpo.resultado).toBe('cancelado')
    expect(inexistente.corpo.resultado).toBe('invalido')
    expect(await contar(), 'a consulta virou leitura no histórico').toBe(antes)

    // controle: sem "só conferir", a mesma recusa GRAVA — a contagem funciona
    await ler(cod('CANC'), false)
    expect(await contar()).toBe(antes + 1)
  }, 30_000)
})
