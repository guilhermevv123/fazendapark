/**
 * Dia de uso do tipo (047), por HTTP — a catraca, a lista do tablet e o painel.
 *
 * Dono, 07/10: "o ingresso que o cara tem de sexta, ele tenta passar domingo". O que este arquivo
 * prova, do jeito que o leitor e o painel usam:
 *
 *  1. o tipo marcado só pra OUTRO dia é barrado na porta, com a frase do dia certo e `foraDoDia`
 *     — e o ingresso continua `valido` (nada foi queimado);
 *  2. o tipo marcado pra HOJE passa; o tipo sem dia passa (tudo o que já foi vendido segue igual);
 *  3. o "só conferir" responde o mesmo veredito, sem gravar leitura;
 *  4. os dias descem na lista do tablet (é no apagão que a porta precisa deles);
 *  5. no painel, marcar os dias de um tipo marca também o de MESMO NOME em outro lote
 *     ("independente dos lotes"), e dia fora do evento é recusado com a frase.
 *
 * Fixtura desta corrida (ids e códigos com a marca de `scripts/test-setup.ts`), apagada no fim.
 * Sem o servidor de teste no ar, PULA com `ctx.skip()`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor, uuidDaCorrida, type Sonda,
} from '../../scripts/test-setup'
import { diaDeUsoDe } from '../utils/dias-de-uso'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/dia-de-uso', n)
const ORG = id(1)
const USER_PORTEIRO = id(2)
const USER_DONO = id(3)
const EVENTO = id(4)
const SETOR = id(5)
const LOTE_1 = id(6)
const LOTE_2 = id(7)
const TIPO_HOJE = id(8)
const TIPO_OUTRO_DIA = id(9)
const TIPO_LIVRE = id(10)
const TIPO_OUTRO_DIA_LOTE_2 = id(11)

const MARCA_MINUSCULA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL_PORTEIRO = `porteiro.dia.${MARCA_MINUSCULA}@dia-de-uso.invalido`
const EMAIL_DONO = `dono.dia.${MARCA_MINUSCULA}@dia-de-uso.invalido`
const SENHA = 'diamond123'
const cod = (sufixo: string) => `ZZD-${MARCA_MAIUSCULA}-${sufixo}`
const COD_HOJE = cod('HOJE')
const COD_OUTRO_DIA = cod('OUTRO')
const COD_LIVRE = cod('LIVRE')

/** hoje, ontem e amanhã no fuso do evento — o evento cobre os três */
const HOJE = diaDeUsoDe(new Date(), 'America/Bahia')
const somaDias = (dia: string, n: number) =>
  new Date(new Date(`${dia}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10)
const AMANHA = somaDias(HOJE, 1)

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookiePorteiro = ''
let cookieDono = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../utils/db')
  return q<any>(texto, par)
}

async function entrar(email: string) {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha: SENHA }),
  })
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c!.startsWith('dt_sessao=')) ?? ''
}

async function ler(qr: string, apenasConsultar = false) {
  const r = await fetch(`${BASE}/api/checkin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookiePorteiro, origin: BASE },
    body: JSON.stringify({ qr, eventId: EVENTO, gate: 'PORTAO-DIA', apenasConsultar }),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any }
}

async function painel(metodo: 'PATCH' | 'POST', corpo: any) {
  const r = await fetch(`${BASE}/api/admin/evento/${EVENTO}/ingressos`, {
    method: metodo,
    headers: { 'content-type': 'application/json', cookie: cookieDono, origin: BASE },
    body: JSON.stringify(corpo),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any }
}

const diasDoTipo = async (tipo: string) =>
  (await sql(`SELECT valid_dates::text[] AS d FROM ticket_types WHERE id = $1`, [tipo]))[0]?.d ?? null

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/dia-de-uso.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
    [ORG, `ZZ DIA DE USO ${MARCA_MAIUSCULA}`, `zz-dia-de-uso-${MARCA_MINUSCULA}`])
  // o evento cobre ontem, hoje e amanhã (no fuso da Bahia), sem sessão: só o dia de uso decide
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, status, timezone)
     VALUES ($1,$2,$3,$4, now() - interval '1 day', now() + interval '1 day', 'ativo', 'America/Bahia')
     ON CONFLICT (id) DO NOTHING`,
    [EVENTO, ORG, `ZZ DIA DE USO EVENTO ${MARCA_MAIUSCULA}`, `zz-dia-de-uso-evento-${MARCA_MINUSCULA}`])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZ SETOR DIA') ON CONFLICT (id) DO NOTHING`,
    [SETOR, EVENTO])
  for (const [lote, nome, ordem] of [[LOTE_1, 'ZZ 1º LOTE', 1], [LOTE_2, 'ZZ 2º LOTE', 2]] as const) {
    await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity, sort_order)
               VALUES ($1,$2,$3,1000,100,$4) ON CONFLICT (id) DO NOTHING`, [lote, SETOR, nome, ordem])
  }
  const tipo = (tid: string, lote: string, nome: string, dias: string[] | null) => sql(
    `INSERT INTO ticket_types (id, lot_id, name, quantity, valid_dates)
     VALUES ($1,$2,$3,100,$4::date[]) ON CONFLICT (id) DO NOTHING`, [tid, lote, nome, dias])
  await tipo(TIPO_HOJE, LOTE_1, 'ZZ ENTRADA HOJE', [HOJE])
  await tipo(TIPO_OUTRO_DIA, LOTE_1, 'ZZ ENTRADA AMANHA', [AMANHA])
  await tipo(TIPO_LIVRE, LOTE_1, 'ZZ ENTRADA LIVRE', null)
  // o MESMO tipo noutro lote: o painel tem que levar os dias junto
  await tipo(TIPO_OUTRO_DIA_LOTE_2, LOTE_2, 'zz entrada amanha', null)

  const ingresso = (code: string, tid: string) => sql(
    `INSERT INTO tickets (org_id, event_id, sector_id, lot_id, ticket_type_id, code, qr_secret, status, holder_name)
     VALUES ($1,$2,$3,$4,$5,$6,'teste','valido','Fulano do Dia') ON CONFLICT (code) DO NOTHING`,
    [ORG, EVENTO, SETOR, LOTE_1, tid, code])
  await ingresso(COD_HOJE, TIPO_HOJE)
  await ingresso(COD_OUTRO_DIA, TIPO_OUTRO_DIA)
  await ingresso(COD_LIVRE, TIPO_LIVRE)

  const usuario = (uid: string, email: string, role: string, nome: string) => sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, $3, $4, password_hash, $5 FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [uid, ORG, nome, email, role])
  await usuario(USER_PORTEIRO, EMAIL_PORTEIRO, 'portaria', 'Porteiro do Dia')
  await usuario(USER_DONO, EMAIL_DONO, 'admin', 'Dono do Dia')
  cookiePorteiro = await entrar(EMAIL_PORTEIRO)
  cookieDono = await entrar(EMAIL_DONO)
}, 40_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('dia de uso do tipo na catraca (047)', () => {
  it('a sessão de teste entrou de verdade (sem cookie o resto mentiria)', (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookiePorteiro, 'porteiro sem sessão').not.toBe('')
    expect(cookieDono, 'dono sem sessão').not.toBe('')
  })

  it('"só conferir" do ingresso de outro dia: NÃO VALE HOJE, com o dia certo, sem gravar leitura', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const antes = (await sql(`SELECT count(*)::int n FROM checkins WHERE event_id = $1`, [EVENTO]))[0].n
    const r = await ler(COD_OUTRO_DIA, true)
    expect(r.status).toBe(200)
    expect(r.corpo).toMatchObject({ ok: false, resultado: 'fora_da_sessao', foraDoDia: true, consulta: true })
    expect(r.corpo.mensagem).toContain('Este ingresso não vale hoje — vale só')
    expect(r.corpo.diasDeUso).toEqual([AMANHA])
    expect((await sql(`SELECT count(*)::int n FROM checkins WHERE event_id = $1`, [EVENTO]))[0].n).toBe(antes)
  })

  it('o ingresso de outro dia é BARRADO e continua válido (nada queimado)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await ler(COD_OUTRO_DIA)
    expect(r.corpo).toMatchObject({ ok: false, resultado: 'fora_da_sessao', foraDoDia: true })
    expect(r.corpo.ingresso?.titular).toBe('Fulano do Dia')
    const [t] = await sql(`SELECT status FROM tickets WHERE code = $1`, [COD_OUTRO_DIA])
    expect(t.status).toBe('valido')
    const [l] = await sql(`SELECT resultado FROM checkins WHERE code_lido = $1 ORDER BY created_at DESC LIMIT 1`, [COD_OUTRO_DIA])
    expect(l?.resultado).toBe('fora_da_sessao')
  })

  it('o ingresso de hoje passa; o tipo sem dia marcado passa (o vendido segue igual)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect((await ler(COD_HOJE)).corpo).toMatchObject({ ok: true, resultado: 'ok' })
    expect((await ler(COD_LIVRE)).corpo).toMatchObject({ ok: true, resultado: 'ok' })
  })

  it('os dias descem na lista do tablet — só pro tipo que tem', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE}/api/portaria/sincronizar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookiePorteiro, origin: BASE },
      body: JSON.stringify({ eventId: EVENTO, deviceId: 'tablet-dia', fila: [], comLista: true }),
    })
    const corpo: any = await r.json()
    expect(r.status).toBe(200)
    const tipos = corpo.lista.ingressos.map((i: any) => [i.tipo, i.diasDeUso ?? null])
    expect(tipos).toContainEqual(['ZZ ENTRADA AMANHA', [AMANHA]])
    expect(tipos).toContainEqual(['ZZ ENTRADA HOJE', [HOJE]])
    expect(tipos).toContainEqual(['ZZ ENTRADA LIVRE', null])
  })
})

describe('dias de uso no painel (047)', () => {
  it('a lista de ingressos traz os dias do evento e os de cada tipo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE}/api/admin/evento/${EVENTO}/ingressos`, { headers: { cookie: cookieDono } })
    const corpo: any = await r.json()
    expect(r.status).toBe(200)
    expect(corpo.evento.dias.map((d: any) => d.dia)).toContain(HOJE)
    const tipos = corpo.setores[0].lotes.flatMap((l: any) => l.tipos)
    expect(tipos.find((t: any) => t.id === TIPO_OUTRO_DIA).diasDeUso).toEqual([AMANHA])
    expect(tipos.find((t: any) => t.id === TIPO_LIVRE).diasDeUso).toBeNull()
  })

  it('marcar os dias de um tipo marca o de mesmo nome no outro lote', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await painel('PATCH', { o: 'tipo', id: TIPO_OUTRO_DIA, campos: { diasDeUso: [HOJE, AMANHA] } })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(r.corpo).toMatchObject({ ok: true, diasDeUso: [HOJE, AMANHA], tiposDeMesmoNome: 1 })
    expect(await diasDoTipo(TIPO_OUTRO_DIA)).toEqual([HOJE, AMANHA])
    expect(await diasDoTipo(TIPO_OUTRO_DIA_LOTE_2)).toEqual([HOJE, AMANHA])
    // e quem não tem o nome não muda
    expect(await diasDoTipo(TIPO_LIVRE)).toBeNull()
    // agora vale hoje também: passa
    expect((await ler(COD_OUTRO_DIA)).corpo).toMatchObject({ ok: true })
  })

  it('editar o preço sem mandar os dias não mexe neles', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await painel('PATCH', { o: 'tipo', id: TIPO_OUTRO_DIA_LOTE_2, campos: { descontoBps: 1000 } })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(await diasDoTipo(TIPO_OUTRO_DIA_LOTE_2)).toEqual([HOJE, AMANHA])
  })

  it('dia fora do evento é recusado com a frase, e nada muda', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const longe = somaDias(HOJE, 20)
    const r = await painel('PATCH', { o: 'tipo', id: TIPO_LIVRE, campos: { diasDeUso: [longe] } })
    expect(r.status).toBe(422)
    expect(String(r.corpo.statusMessage ?? r.corpo.message)).toContain('não é dia deste evento')
    expect(await diasDoTipo(TIPO_LIVRE)).toBeNull()
  })

  it('tipo novo com o nome de um que já tem dias herda os dias', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await painel('POST', { o: 'tipo', loteId: LOTE_2, nome: 'ZZ ENTRADA HOJE' })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(r.corpo.diasDeUso).toEqual([HOJE])
    expect(await diasDoTipo(r.corpo.id)).toEqual([HOJE])
  })

  it('desmarcar tudo volta a passar em qualquer dia', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await painel('PATCH', { o: 'tipo', id: TIPO_HOJE, campos: { diasDeUso: [] } })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(await diasDoTipo(TIPO_HOJE)).toBeNull()
  })
})
