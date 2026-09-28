/**
 * Passaporte de vários dias — entra uma vez POR DIA, nos N dias que cobre (ADM-04, 27/09).
 *
 * A porta queimava o passaporte de 3 dias na primeira leitura (`status = 'usado'`) e no dia 2
 * respondia JÁ USADO pra quem pagou três. Aqui, contra as rotas de verdade:
 *
 *  • lote ligado a dias (`lot_sessions`): entra hoje; de novo hoje, não; o dia 1 "movido pra
 *    ontem" (o estado exato que a leitura do dia 1 deixou, só que no dia certo) e hoje entra
 *    de novo — é o 2º dia; no último dia o ingresso vira `usado`;
 *  • lote sem dias: o dia de uso é o do calendário no fuso do evento;
 *  • fora dos dias do lote: FORA DO HORÁRIO;
 *  • o ingresso de um dia só segue exatamente como antes;
 *  • a sincronização não chama de conflito a passagem de outro dia, e chama a do mesmo dia;
 *  • a lista offline desce com os dias cobertos, os usados e os dias do lote.
 *
 * O "dia anterior" é feito movendo a passagem que a própria rota gravou (sessão e hora) — o
 * servidor não viaja no tempo, e inventar a passagem inteira à mão provaria outra coisa.
 * Passagens antigas ficam a 24h e 48h de agora: dia exato do calendário pra trás, a qualquer
 * hora em que a suíte rodar (a Bahia não tem horário de verão).
 * Sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../scripts/test-setup'
import { chaveDoCodigo } from '../../utils/catraca'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/portaria/passaporte', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const SETOR_DIAS = id(4)      // passaporte de 3, lote ligado a 4 dias
const SETOR_CALENDARIO = id(5) // passaporte de 2, lote sem dias
const SETOR_UM_DIA = id(6)     // ingresso comum
const SETOR_AMANHA = id(7)     // passaporte de 2, lote que só vale amanhã
const LOTE_DIAS = id(8)
const LOTE_CALENDARIO = id(9)
const LOTE_UM_DIA = id(10)
const LOTE_AMANHA = id(11)
const S_ANTEONTEM = id(12)
const S_ONTEM = id(13)
const S_HOJE = id(14)
const S_AMANHA = id(15)
const P_DIA1 = id(21)          // o do "dia 1 → dia 2"
const P_ULTIMO = id(22)        // já usou 2 de 3: hoje é o último
const P_CALENDARIO = id(23)
const P_AMANHA = id(24)
const COMUM = id(25)
const P_QUEIMADO = id(26)      // queimado pela porta velha no 1º dia
const COMUM_USADO = id(27)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.passaporte.${MARCA}@teste.invalido`
const cod = (s: string) => `ZZPP-${MARCA_MAIUSCULA}-${s}`

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../utils/db')
  return q<any>(texto, par)
}

async function ler(codigo: string, extra: any = {}) {
  const r = await fetch(`${BASE}/api/checkin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: BASE },
    body: JSON.stringify({ qr: codigo, eventId: EVENTO, gate: 'NORTE', ...extra }),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({} as any)) }
}

async function sincronizar(fila: any[], comLista = false) {
  const r = await fetch(`${BASE}/api/portaria/sincronizar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: BASE },
    body: JSON.stringify({ eventId: EVENTO, deviceId: 'zz-tablet', fila, comLista }),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({} as any)) }
}

const status = async (t: string) => (await sql(`SELECT status FROM tickets WHERE id = $1`, [t]))[0].status

async function ingresso(tid: string, setor: string, lote: string, codigo: string) {
  await sql(
    `INSERT INTO tickets (id, org_id, event_id, sector_id, lot_id, code, qr_secret, status, holder_name)
     VALUES ($1,$2,$3,$4,$5,$6,'teste','valido','ZZPP Titular')`,
    [tid, ORG, EVENTO, setor, lote, codigo])
}

/** uma passagem de um dia que já passou, no formato que a porta grava */
async function passagemAntiga(tid: string, sessao: string | null, horasAtras: number) {
  await sql(
    `INSERT INTO entries (id, org_id, event_id, ticket_id, session_id, people, gate, offline, entered_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 1, 'NORTE', false, now() - make_interval(hours => $5))`,
    [ORG, EVENTO, tid, sessao, horasAtras])
  await sql(`UPDATE tickets SET checked_in_at = COALESCE(checked_in_at, now() - make_interval(hours => $2))
              WHERE id = $1`, [tid, horasAtras])
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/portaria/passaporte.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZPP PASSAPORTE ${MARCA_MAIUSCULA}`, `zzpp-passaporte-${MARCA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status, timezone)
     VALUES ($1,$2,$3,$4, now() - interval '3 days', now() + interval '3 days', 1000, 'ativo', 'America/Bahia')`,
    [EVENTO, ORG, `ZZPP PASSAPORTE ${MARCA_MAIUSCULA}`, `zzpp-passaporte-ev-${MARCA}`])
  // quatro dias de parque, das 9h às 17h "relativas": o de hoje está aberto AGORA
  await sql(
    `INSERT INTO event_sessions (id, event_id, starts_at, ends_at) VALUES
       ($1,$5, now() - interval '49 hours', now() - interval '41 hours'),
       ($2,$5, now() - interval '25 hours', now() - interval '17 hours'),
       ($3,$5, now() - interval '1 hour',   now() + interval '7 hours'),
       ($4,$5, now() + interval '23 hours', now() + interval '31 hours')`,
    [S_ANTEONTEM, S_ONTEM, S_HOJE, S_AMANHA, EVENTO])
  await sql(
    `INSERT INTO sectors (id, event_id, name, kind, sessions_covered) VALUES
       ($1,$5,'ZZPP PASSAPORTE 3 DIAS','passaporte',3),
       ($2,$5,'ZZPP PASSAPORTE CALENDARIO','passaporte',2),
       ($3,$5,'ZZPP ENTRADA','ingresso',NULL),
       ($4,$5,'ZZPP PASSAPORTE AMANHA','passaporte',2)`,
    [SETOR_DIAS, SETOR_CALENDARIO, SETOR_UM_DIA, SETOR_AMANHA, EVENTO])
  await sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity) VALUES
       ($1,$5,'ZZPP LOTE DIAS',10000,100), ($2,$6,'ZZPP LOTE CALENDARIO',10000,100),
       ($3,$7,'ZZPP LOTE UM DIA',3000,100), ($4,$8,'ZZPP LOTE AMANHA',10000,100)`,
    [LOTE_DIAS, LOTE_CALENDARIO, LOTE_UM_DIA, LOTE_AMANHA,
     SETOR_DIAS, SETOR_CALENDARIO, SETOR_UM_DIA, SETOR_AMANHA])
  await sql(
    `INSERT INTO lot_sessions (lot_id, session_id) VALUES
       ($1,$3), ($1,$4), ($1,$5), ($1,$6), ($2,$6)`,
    [LOTE_DIAS, LOTE_AMANHA, S_ANTEONTEM, S_ONTEM, S_HOJE, S_AMANHA])

  await ingresso(P_DIA1, SETOR_DIAS, LOTE_DIAS, cod('DIA1'))
  await ingresso(P_ULTIMO, SETOR_DIAS, LOTE_DIAS, cod('ULTI'))
  await ingresso(P_CALENDARIO, SETOR_CALENDARIO, LOTE_CALENDARIO, cod('CALE'))
  await ingresso(P_AMANHA, SETOR_AMANHA, LOTE_AMANHA, cod('AMAN'))
  await ingresso(COMUM, SETOR_UM_DIA, LOTE_UM_DIA, cod('COMU'))
  // o que já usou dois dos três dias (anteontem e ontem) e não veio buscar o terceiro ainda
  await passagemAntiga(P_ULTIMO, S_ANTEONTEM, 48)
  await passagemAntiga(P_ULTIMO, S_ONTEM, 24)
  // o do calendário entrou ontem
  await passagemAntiga(P_CALENDARIO, null, 24)
  // o que a porta VELHA queimou ontem (status 'usado' com um dia só de uso), e um comum usado
  await ingresso(P_QUEIMADO, SETOR_DIAS, LOTE_DIAS, cod('QUEI'))
  await passagemAntiga(P_QUEIMADO, S_ONTEM, 24)
  await ingresso(COMUM_USADO, SETOR_UM_DIA, LOTE_UM_DIA, cod('CUSA'))
  await passagemAntiga(COMUM_USADO, null, 24)
  await sql(`UPDATE tickets SET status = 'usado' WHERE id = ANY($1::uuid[])`, [[P_QUEIMADO, COMUM_USADO]])

  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZPP Dono Passaporte', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'`, [USUARIO, ORG, EMAIL])
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 240_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM checkins WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM entries WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM tickets WHERE org_id = $1`, [ORG])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('passaporte de vários dias na porta', () => {
  it('entrou (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie, 'login falhou').toBeTruthy()
  })

  it('dia 1: entra, o ingresso continua valendo, e de novo HOJE não passa', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await ler(cod('DIA1'))
    expect(r.corpo.resultado, JSON.stringify(r.corpo)).toBe('ok')
    expect(r.corpo.mensagem).toContain('1º de 3')
    expect(await status(P_DIA1), 'o passaporte de 3 dias foi queimado no 1º dia').toBe('valido')
    const [livro] = await sql(`SELECT session_id FROM entries WHERE ticket_id = $1`, [P_DIA1])
    expect(livro.session_id, 'a passagem não guardou o dia de uso').toBe(S_HOJE)

    const de = await ler(cod('DIA1'))
    expect(de.corpo.resultado, 'o mesmo passaporte passou duas vezes no mesmo dia').toBe('ja_usado')
    expect(de.corpo.mensagem).toBe('Este passaporte já entrou hoje')
  }, 120_000)

  it('dia 2: com o dia 1 no passado, o mesmo passaporte entra de novo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    // o estado exato que a leitura do dia 1 deixou — só que ONTEM
    await sql(`UPDATE entries SET session_id = $2, entered_at = now() - interval '24 hours'
                WHERE ticket_id = $1`, [P_DIA1, S_ONTEM])
    const r = await ler(cod('DIA1'))
    expect(r.corpo.resultado, `quem pagou 3 dias foi barrado no 2º: ${JSON.stringify(r.corpo)}`).toBe('ok')
    expect(r.corpo.mensagem).toContain('2º de 3')
    expect(await status(P_DIA1)).toBe('valido')
  }, 120_000)

  it('o último dia fecha o passaporte: vira usado, e não entra num 4º', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await ler(cod('ULTI'))
    expect(r.corpo.resultado, JSON.stringify(r.corpo)).toBe('ok')
    expect(r.corpo.mensagem).toContain('último dia')
    expect(await status(P_ULTIMO)).toBe('usado')
    const de = await ler(cod('ULTI'))
    expect(de.corpo.resultado).toBe('ja_usado')
  }, 120_000)

  it('lote sem dias: o dia de uso é o do calendário do parque', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await ler(cod('CALE'))
    expect(r.corpo.resultado, JSON.stringify(r.corpo)).toBe('ok')
    expect(await status(P_CALENDARIO), '2 de 2 dias: fecha').toBe('usado')
  }, 120_000)

  it('fora dos dias do lote: FORA DO HORÁRIO, e nada gravado no livro', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await ler(cod('AMAN'))
    expect(r.corpo.resultado).toBe('fora_da_sessao')
    expect((await sql(`SELECT count(*)::int AS n FROM entries WHERE ticket_id = $1`, [P_AMANHA]))[0].n).toBe(0)
    expect(await status(P_AMANHA)).toBe('valido')
  }, 120_000)

  it('o ingresso de UM dia segue como sempre: entra e vira usado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await ler(cod('COMU'))
    expect(r.corpo.resultado).toBe('ok')
    expect(await status(COMUM)).toBe('usado')
    expect((await ler(cod('COMU'))).corpo.resultado).toBe('ja_usado')
  }, 120_000)

  it('sincronização: outro dia não é conflito; o mesmo dia é', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const antes = await sincronizar([])
    const conflitou = (c: any) => c.ticketId === P_DIA1
    expect(antes.corpo.conflitos.some(conflitou), 'passagens em dois dias viraram "conflito"').toBe(false)

    // um tablet sem rede deixou o mesmo passaporte entrar de novo HOJE
    const { randomUUID } = await import('node:crypto')
    const s = await sincronizar([{ id: randomUUID(), qr: cod('DIA1'), gate: 'SUL', offline: true }])
    expect(s.status).toBe(200)
    expect(s.corpo.itens[0].resultado, JSON.stringify(s.corpo.itens)).toBe('conflito')
    expect(s.corpo.conflitos.some(conflitou), 'duas passagens no mesmo dia sumiram dos conflitos').toBe(true)
  }, 120_000)

  it('migração 032: reabre o passaporte que a porta velha queimou, e só ele', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { readFileSync } = await import('node:fs')
    const migracao = readFileSync(new URL('../../../db/032_passaporte_reaberto.sql', import.meta.url), 'utf8')
    await sql(migracao)
    expect(await status(P_QUEIMADO), 'o passaporte queimado no 1º dia continua barrado').toBe('valido')
    expect(await status(COMUM_USADO), 'a migração reabriu ingresso de um dia').toBe('usado')
    expect(await status(P_ULTIMO), 'reabriu passaporte que já usou todos os dias').toBe('usado')
    // e reaberto, ele entra hoje — o 2º dia dele
    const r = await ler(cod('QUEI'))
    expect(r.corpo.resultado, JSON.stringify(r.corpo)).toBe('ok')
    expect(r.corpo.mensagem).toContain('2º de 3')
  }, 120_000)

  it('a lista offline desce com os dias do passaporte', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const s = await sincronizar([], true)
    const naLista = (c: string) => s.corpo.lista.ingressos.find(
      (i: any) => i.chave === chaveDoCodigo(s.corpo.lista.sal, c))
    const item = naLista(cod('ULTI'))
    expect(item.diasCobertos).toBe(3)
    expect(item.diasUsados).toHaveLength(3)
    expect(item.sessoes).toHaveLength(4)
    const comum = naLista(cod('COMU'))
    expect(comum.diasCobertos, 'ingresso de um dia ganhou campo de passaporte').toBeUndefined()
  }, 120_000)
})
