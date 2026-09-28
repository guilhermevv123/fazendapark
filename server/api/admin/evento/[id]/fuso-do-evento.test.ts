/**
 * Dia, dia da semana e hora no calendário DO EVENTO, em todas as telas do evento (ADM-10, 27/09).
 *
 * `date_trunc('day', paid_at)`, `EXTRACT(HOUR …)` e `$x::date` cortam no fuso da SESSÃO do banco.
 * Com o Postgres em UTC (a imagem oficial do EasyPanel), a venda das 22h caía no dia seguinte, a
 * das 10h aparecia às 13h, o "Hoje" do extrato ia das 21h de ontem às 21h de hoje e o "Hoje" do
 * balcão zerava às 21h. O painel já cortava no fuso do evento; Relatórios, Extrato, Pontos de
 * venda e Público não.
 *
 * A sessão do banco agora nasce em America/Bahia (`db.ts`), então o defeito só aparece de novo
 * com um evento em OUTRO fuso — e é assim que este arquivo o pega: evento em America/Manaus
 * (UTC−4, uma hora atrás da Bahia). A venda das 03:30Z de 10/03 é 00:30 do dia 10 na Bahia e
 * 23:30 do dia 9 em Manaus: a tela do evento de Manaus tem que dizer dia 9, segunda, 23h.
 *
 * E o dia sai como TEXTO `AAAA-MM-DD`: `Date` à meia-noite do fuso do servidor era lido pelo
 * navegador em outro fuso como o dia anterior.
 *
 * Vai às rotas com sessão de verdade; sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/evento/fuso-do-evento', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const PONTO = id(4)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.fuso-evento.${MARCA}@teste.invalido`

const FUSO = 'America/Manaus'
/** 00:30 do dia 10 na Bahia; 23:30 do dia 9 em Manaus */
const PAGO_EM = '2026-03-10T03:30:00Z'
const DIA_EM_MANAUS = '2026-03-09'
const DIA_NA_BAHIA = '2026-03-10'
/** 08:00 do dia 15 em Manaus (09:00 na Bahia): 6 dias de antecedência lá, 5 cá */
const COMECA = '2026-03-15T12:00:00Z'
const VALOR = 5_000

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../utils/db')
  return q<any>(texto, par)
}

async function get(rota: string) {
  const r = await fetch(`${BASE}/api/admin/evento/${EVENTO}${rota}`, {
    headers: { cookie, origin: BASE },
  })
  const texto = await r.text()
  let corpo: any = {}
  try { corpo = JSON.parse(texto) } catch { /* corpo vazio */ }
  return { status: r.status, corpo, texto }
}

async function venda(codigo: string, pagoEm: string, extra: { ponto?: string } = {}) {
  await sql(
    `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents,
                         platform_cents, discount_cents, total_cents, refunded_cents, paid_at,
                         payment_method, pos_terminal_id)
     VALUES ($1,$2,$3,'pago',$4,$5,0,0,0,$5,0,$6::timestamptz,'dinheiro',$7)`,
    [ORG, EVENTO, codigo, extra.ponto ? 'bilheteria' : 'online', VALOR, pagoEm, extra.ponto ?? null])
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/evento/[id]/fuso-do-evento.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZF FUSO ${MARCA_MAIUSCULA}`, `zzf-fuso-${MARCA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status, timezone)
     VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + interval '8 hours',1000,'ativo',$6)`,
    [EVENTO, ORG, `ZZF FUSO ${MARCA_MAIUSCULA}`, `zzf-fuso-ev-${MARCA}`, COMECA, FUSO])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZF Dono Fuso', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'`, [USUARIO, ORG, EMAIL])
  await sql(`INSERT INTO pos_terminals (id, org_id, event_id, name) VALUES ($1,$2,$3,'ZZF GUICHÊ')`,
    [PONTO, ORG, EVENTO])

  await venda(`ZZF-${MARCA_MAIUSCULA}-NOITE`, PAGO_EM)

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 240_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('o relógio das telas do evento é o fuso do evento', () => {
  it('entrou (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie, 'login falhou').toBeTruthy()
  })

  it('Relatórios: dia, dia da semana, hora e antecedência cortados em Manaus', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await get('/relatorios')
    expect(r.status, r.texto).toBe(200)
    const { porDia, porDiaSemana, porHoraDoDia, antecedencia } = r.corpo

    expect(porDia.map((d: any) => d.dia), 'o dia da venda saiu no fuso do banco').toEqual([DIA_EM_MANAUS])
    const segunda = new Date(`${DIA_EM_MANAUS}T12:00:00Z`).getUTCDay()
    expect(porDiaSemana.map((d: any) => d.dow), 'o dia da semana saiu no fuso do banco').toEqual([segunda])
    expect(porHoraDoDia.map((h: any) => h.hora), 'a hora andou: 23h lá, 0h na Bahia').toEqual([23])
    expect(antecedencia.map((a: any) => a.dias), 'antecedência contada em dias de outro fuso').toEqual([6])
    expect(r.corpo.evento.fuso).toBe(FUSO)
  }, 120_000)

  it('Extrato: o filtro do dia 9 pega a venda das 23h30 de Manaus, o do dia 10 não', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const dia9 = await get(`/extrato?de=${DIA_EM_MANAUS}&ate=${DIA_EM_MANAUS}`)
    expect(dia9.status, dia9.texto).toBe(200)
    expect(dia9.corpo.totais.pedidos, 'o "dia 9" do extrato cortou à meia-noite da Bahia').toBe(1)
    expect(dia9.corpo.porDia.map((d: any) => d.dia)).toEqual([DIA_EM_MANAUS])

    const dia10 = await get(`/extrato?de=${DIA_NA_BAHIA}&ate=${DIA_NA_BAHIA}`)
    expect(dia10.corpo.totais.pedidos, 'a venda da noite do dia 9 caiu no dia 10').toBe(0)
  }, 120_000)

  it('Extrato: data impossível na URL é 400 com recado, não 500', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    for (const ruim of ['2026-02-31', 'ontem', '2026-13-01']) {
      const r = await get(`/extrato?de=${ruim}`)
      expect(r.status, `${ruim}: ${r.texto.slice(0, 200)}`).toBe(400)
    }
  }, 120_000)

  it('Painel: o ponto da curva é o dia 9, escrito como dia de calendário', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await get('/dashboard')
    expect(r.status, r.texto).toBe(200)
    expect(r.corpo.ritmo.map((p: any) => p.dia),
      'o dia saiu como instante (meia-noite do servidor) e o navegador em outro fuso lê o dia anterior')
      .toEqual([DIA_EM_MANAUS])
  }, 120_000)

  it('Público: a hora da compra é a de Manaus', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await get('/publico')
    expect(r.status, r.texto).toBe(200)
    expect(r.corpo.horaDaCompra.map((h: any) => h.hora), 'a hora da compra estava presa na Bahia').toEqual([23])
  }, 120_000)

  it('Pontos de venda: o "Hoje" do guichê começa à meia-noite de Manaus', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    // uma venda agora (hoje nos dois fusos) e outra 30 min antes da meia-noite de Manaus — que já
    // é "hoje" na Bahia, onde o dia começou uma hora antes
    const [{ meia_noite }] = await sql(
      `SELECT (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) AS meia_noite`, [FUSO])
    const vespera = new Date(new Date(meia_noite).getTime() - 30 * 60_000).toISOString()
    await venda(`ZZF-${MARCA_MAIUSCULA}-AGORA`, new Date().toISOString(), { ponto: PONTO })
    await venda(`ZZF-${MARCA_MAIUSCULA}-VESPERA`, vespera, { ponto: PONTO })

    const r = await get('/pdv')
    expect(r.status, r.texto).toBe(200)
    const ponto = r.corpo.pontos.find((p: any) => p.id === PONTO)
    expect(ponto.hoje.pedidos, 'o "Hoje" do balcão começou à meia-noite de outro fuso').toBe(1)
    expect(ponto.hoje.totalCents).toBe(VALOR)
  }, 120_000)
})
