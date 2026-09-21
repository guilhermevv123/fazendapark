/**
 * Teste da catraca — a porta do evento, por HTTP, do jeito que o leitor usa.
 *
 * O resto da suíte prova o UPDATE condicional no SQL. Isso não é a mesma
 * coisa: entre o SQL e a porta existem o porteiro de sessão, a leitura da
 * assinatura, a janela da sessão e a ordem das decisões. Um erro em qualquer
 * um deles deixa o mesmo QR entrar duas vezes com o banco intacto.
 *
 * As quatro coisas que este teste existe pra impedir:
 *
 *  1. o mesmo ingresso entrar duas vezes (dois portões lendo junto);
 *  2. o segundo carimbo apagar a hora do primeiro — a pergunta "que horas ele
 *     entrou?" só tem resposta se o carimbo for do primeiro;
 *  3. QR fabricado passar;
 *  4. **a portaria de uma produtora queimar ingresso de outra.** A busca do
 *     código é por `code`, sem organização: quem tem login em qualquer casa
 *     e o código de um ingresso alheio derruba a entrada de outra empresa.
 *
 * Fixture própria, de ponta a ponta: duas organizações criadas por id fixo e
 * apagadas no fim. Nenhum ingresso do seed é queimado — um teste que gasta
 * dado de verdade só pode rodar uma vez.
 *
 * Precisa do servidor de dev no ar. Sem ele, PULA em vez de falhar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { montarQr } from '../utils/ingresso'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

/** ids fixos: o teste limpa exatamente o que criou */
const ORG_CASA = '0000ca01-0000-4000-8000-000000000001'
const USER_PORTEIRO = '0000ca01-0000-4000-8000-000000000002'
const EVENTO_CASA = '0000ca01-0000-4000-8000-000000000003'
const SESSAO_ABERTA = '0000ca01-0000-4000-8000-000000000004'
const SESSAO_PASSADA = '0000ca01-0000-4000-8000-000000000005'
const SETOR_CASA = '0000ca01-0000-4000-8000-000000000006'
const LOTE_CASA = '0000ca01-0000-4000-8000-000000000007'

const ORG_VIZINHA = '0000ca02-0000-4000-8000-000000000001'
const EVENTO_VIZINHO = '0000ca02-0000-4000-8000-000000000003'
const SESSAO_VIZINHA = '0000ca02-0000-4000-8000-000000000004'
const SETOR_VIZINHO = '0000ca02-0000-4000-8000-000000000006'
const LOTE_VIZINHO = '0000ca02-0000-4000-8000-000000000007'

const EMAIL_PORTEIRO = 'porteiro.teste@catraca.invalido'
const SENHA = 'diamond123'

const COD_OK = 'ZZT-CATR-AAAA'
const COD_CANCELADO = 'ZZT-CATR-BBBB'
const COD_PASSADO = 'ZZT-CATR-CCCC'
const COD_VIZINHO = 'ZZT-CATR-DDDD'

let noAr = false
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../utils/db')
  return q<any>(texto, par)
}

/** lê o QR na porta, como o leitor faz */
async function ler(qr: string, eventId = EVENTO_CASA, gate = 'PORTAO-1') {
  const r = await fetch(`${BASE}/api/checkin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: BASE },
    body: JSON.stringify({ qr, eventId, gate }),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) }
}

async function ingresso(code: string) {
  const [t] = await sql(
    `SELECT status, checked_in_at, checked_in_by FROM tickets WHERE code = $1`, [code])
  return t
}

async function semearCasa(org: string, evento: string, setor: string, lote: string,
                          nome: string, slug: string) {
  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)
             ON CONFLICT (id) DO NOTHING`, [org, nome, slug])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, status)
     VALUES ($1,$2,$3,$4, now() + interval '1 hour', now() + interval '6 hours', 'ativo')
     ON CONFLICT (id) DO NOTHING`, [evento, org, nome + ' EVENTO', slug + '-evento'])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZ SETOR TESTE')
             ON CONFLICT (id) DO NOTHING`, [setor, evento])
  await sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity)
     VALUES ($1,$2,'ZZ LOTE TESTE', 1000, 100) ON CONFLICT (id) DO NOTHING`, [lote, setor])
}

async function semearIngresso(code: string, org: string, evento: string, sessao: string | null,
                              setor: string, lote: string, status = 'valido') {
  await sql(
    `INSERT INTO tickets (org_id, event_id, session_id, sector_id, lot_id,
                          code, qr_secret, status, holder_name)
     VALUES ($1,$2,$3,$4,$5,$6,'teste',$7,'Fulano de Teste')
     ON CONFLICT (code) DO NOTHING`, [org, evento, sessao, setor, lote, code, status])
}

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).status < 500
  } catch { noAr = false }
  if (!noAr) return

  await semearCasa(ORG_CASA, EVENTO_CASA, SETOR_CASA, LOTE_CASA, 'ZZ CATRACA CASA', 'zz-catraca-casa')
  await semearCasa(ORG_VIZINHA, EVENTO_VIZINHO, SETOR_VIZINHO, LOTE_VIZINHO,
                   'ZZ CATRACA VIZINHA', 'zz-catraca-vizinha')

  // Sessão ABERTA agora: sem isso o evento inteiro cai em "fora do horário" e
  // o teste ficaria verde sem nunca chegar na trava.
  await sql(
    `INSERT INTO event_sessions (id, event_id, starts_at, ends_at, title)
     VALUES ($1,$2, now() - interval '30 minutes', now() + interval '4 hours', 'Aberta')
     ON CONFLICT (id) DO NOTHING`, [SESSAO_ABERTA, EVENTO_CASA])
  await sql(
    `INSERT INTO event_sessions (id, event_id, starts_at, ends_at, title)
     VALUES ($1,$2, now() - interval '30 days', now() - interval '29 days', 'Passada')
     ON CONFLICT (id) DO NOTHING`, [SESSAO_PASSADA, EVENTO_CASA])
  await sql(
    `INSERT INTO event_sessions (id, event_id, starts_at, ends_at, title)
     VALUES ($1,$2, now() - interval '30 minutes', now() + interval '4 hours', 'Aberta')
     ON CONFLICT (id) DO NOTHING`, [SESSAO_VIZINHA, EVENTO_VIZINHO])

  await semearIngresso(COD_OK, ORG_CASA, EVENTO_CASA, SESSAO_ABERTA, SETOR_CASA, LOTE_CASA)
  await semearIngresso(COD_CANCELADO, ORG_CASA, EVENTO_CASA, SESSAO_ABERTA, SETOR_CASA,
                       LOTE_CASA, 'cancelado')
  await semearIngresso(COD_PASSADO, ORG_CASA, EVENTO_CASA, SESSAO_PASSADA, SETOR_CASA, LOTE_CASA)
  await semearIngresso(COD_VIZINHO, ORG_VIZINHA, EVENTO_VIZINHO, SESSAO_VIZINHA,
                       SETOR_VIZINHO, LOTE_VIZINHO)

  // Porteiro de verdade, com o papel de portaria — o mesmo caminho do tablet
  // na porta. A senha vem do hash já semeado, pra o teste não gerar hash.
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'Porteiro Teste', $3, password_hash, 'portaria'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [USER_PORTEIRO, ORG_CASA, EMAIL_PORTEIRO])

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL_PORTEIRO, senha: SENHA }),
  })
  const bruto = r.headers.getSetCookie?.() ?? []
  cookie = bruto.map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 40_000)

afterAll(async () => {
  if (!noAr) return
  await sql(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG_CASA, ORG_VIZINHA]])
})

describe('catraca', () => {
  it('o porteiro entrou (senão nada abaixo prova nada)', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect(cookie, 'login do porteiro falhou — o teste ficaria verde à toa').toBeTruthy()
  }, 20_000)

  it('QR assinado entra, e o carimbo diz quem liberou', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const { corpo } = await ler(montarQr(COD_OK, EVENTO_CASA))
    expect(corpo.resultado, `a porta respondeu ${corpo.resultado}`).toBe('ok')

    // read-back: a resposta pode dizer ok e o banco não ter mudado nada.
    const t = await ingresso(COD_OK)
    expect(t.status).toBe('usado')
    expect(t.checked_in_at, 'entrou sem hora de entrada').toBeTruthy()
    expect(t.checked_in_by, 'leitura sem dono: ninguém sabe quem liberou').toBe(USER_PORTEIRO)
  }, 20_000)

  it('o mesmo QR não entra de novo — nem por outro portão', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const antes = await ingresso(COD_OK)
    const { corpo } = await ler(montarQr(COD_OK, EVENTO_CASA), EVENTO_CASA, 'PORTAO-2')
    expect(corpo.resultado).toBe('ja_usado')
    expect(corpo.ok).toBe(false)

    // A hora tem que continuar sendo a da PRIMEIRA entrada: se a segunda
    // leitura recarimbasse, a pergunta "que horas ele entrou?" perderia a
    // resposta bem no caso em que alguém precisa dela.
    const depois = await ingresso(COD_OK)
    expect(depois.checked_in_at?.toISOString?.() ?? depois.checked_in_at)
      .toBe(antes.checked_in_at?.toISOString?.() ?? antes.checked_in_at)
  }, 20_000)

  it('dois leitores que leram juntos: só um consegue marcar', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    // A checagem prévia da rota ("já está usado?") esconde a trava quando os
    // pedidos chegam em fila — foi assim que a versão anterior deste teste
    // ficou verde com a trava arrancada. Aqui a ordem é forçada à mão: as
    // DUAS conexões leem o ingresso ainda válido e só depois tentam marcar,
    // que é exatamente o instante que a trava existe pra resolver.
    const codigo = 'ZZT-CATR-RACE'
    await semearIngresso(codigo, ORG_CASA, EVENTO_CASA, SESSAO_ABERTA, SETOR_CASA, LOTE_CASA)
    const [alvo] = await sql(`SELECT id FROM tickets WHERE code = $1`, [codigo])

    const { db } = await import('../utils/db')
    const { SQL_MARCA_ENTRADA } = await import('../utils/catraca')
    const c1 = await db().connect()
    const c2 = await db().connect()
    try {
      // os dois leram, os dois acham que o ingresso está livre
      const l1 = await c1.query(`SELECT status FROM tickets WHERE id = $1`, [alvo.id])
      const l2 = await c2.query(`SELECT status FROM tickets WHERE id = $1`, [alvo.id])
      expect(l1.rows[0].status).toBe('valido')
      expect(l2.rows[0].status).toBe('valido')

      const r1 = await c1.query(SQL_MARCA_ENTRADA, [alvo.id, USER_PORTEIRO])
      const r2 = await c2.query(SQL_MARCA_ENTRADA, [alvo.id, USER_PORTEIRO])
      expect(r1.rowCount + r2.rowCount,
        'os dois leitores marcaram entrada — o mesmo QR passa duas vezes').toBe(1)
    } finally {
      c1.release(); c2.release()
    }
  }, 20_000)

  it('24 leitores na mesma porta, um único ok', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    // A prova de ponta a ponta, com o servidor no meio. Volume alto de
    // propósito: com poucos leitores os pedidos são atendidos em fila e o
    // caminho difícil nunca é exercitado (com a trava arrancada, 10 leitores
    // devolviam 1 ok e 20 devolviam 10).
    const codigo = 'ZZT-CATR-TROPA'
    await semearIngresso(codigo, ORG_CASA, EVENTO_CASA, SESSAO_ABERTA, SETOR_CASA, LOTE_CASA)
    const qr = montarQr(codigo, EVENTO_CASA)

    const rs = await Promise.all(
      Array.from({ length: 24 }, (_, i) => ler(qr, EVENTO_CASA, `PORTAO-${i}`)))
    const entraram = rs.filter((r) => r.corpo.resultado === 'ok').length
    expect(entraram, `${entraram} leitores deixaram a mesma pessoa entrar`).toBe(1)
  }, 30_000)

  it('QR fabricado não passa, e o ingresso continua intacto', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const forjado = `DT1:${EVENTO_CASA}:${COD_PASSADO}:AAAAAAAAAA`
    const { corpo } = await ler(forjado)
    expect(corpo.resultado).toBe('invalido')

    const t = await ingresso(COD_PASSADO)
    expect(t.status, 'o QR fabricado mexeu no ingresso').toBe('valido')
  }, 20_000)

  it('ingresso cancelado é barrado', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const { corpo } = await ler(montarQr(COD_CANCELADO, EVENTO_CASA))
    expect(corpo.resultado).toBe('cancelado')
  }, 20_000)

  it('ingresso de outro dia não entra hoje', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const { corpo } = await ler(montarQr(COD_PASSADO, EVENTO_CASA))
    expect(corpo.resultado).toBe('fora_da_sessao')
  }, 20_000)

  it('a portaria de uma produtora não queima ingresso de outra', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    // O porteiro da CASA lê um ingresso legítimo da VIZINHA, com a assinatura
    // certa do evento dela. Se a porta aceitar, uma empresa derruba a entrada
    // de outra só com o código na mão.
    const { corpo } = await ler(montarQr(COD_VIZINHO, EVENTO_VIZINHO), EVENTO_VIZINHO)
    expect(corpo.resultado, 'a porta aceitou ingresso de outra organização').not.toBe('ok')

    const t = await ingresso(COD_VIZINHO)
    expect(t.status, 'o ingresso da vizinha foi queimado por quem não é dono').toBe('valido')
    expect(corpo.titular, 'o nome do comprador da vizinha vazou na resposta').toBeUndefined()
  }, 20_000)

  it('nem apontando o leitor para o próprio evento', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    // A segunda forma do mesmo ataque: o porteiro digita o código alheio no
    // leitor do evento DELE. Passa pela cerca do evento (o evento é mesmo
    // dele) e vai morrer na busca do código, que é escopada por organização.
    const { corpo } = await ler(COD_VIZINHO, EVENTO_CASA)
    expect(corpo.resultado, 'o código de outra empresa foi encontrado').toBe('invalido')

    const t = await ingresso(COD_VIZINHO)
    expect(t.status).toBe('valido')
  }, 20_000)
})
