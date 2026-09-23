/**
 * Teste da transferência de ingresso.
 *
 * O que dá errado aqui não é a tela, é o estado ficar pela metade: o
 * ingresso sai de um titular e não chega no outro, ou chega nos dois. As
 * cinco situações que este teste tranca:
 *
 *  1. a casa desligou a transferência e alguém envia assim mesmo;
 *  2. o mesmo ingresso sai pra duas pessoas — as duas pagam a quem vendeu e
 *     só uma entra;
 *  3. dois cliques no botão de aceitar reabrem a troca;
 *  4. cancelar devolve o nome e esquece o e-mail — a segunda via vai pro
 *     endereço de quem já não é dono;
 *  5. transferir ingresso que já entrou no evento, que é vender a entrada de
 *     novo.
 *
 * Fixture própria com id fixo, apagada no fim. Nenhum ingresso de verdade é
 * movido: trocar titular no seed deixaria o painel mentindo pro dono.
 *
 * Precisa do servidor de dev no ar. Sem ele, PULA em vez de falhar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

const ORG = '0000c001-0000-4000-8000-000000000001'
const USUARIO = '0000c001-0000-4000-8000-000000000002'
const EVENTO = '0000c001-0000-4000-8000-000000000003'
const SETOR = '0000c001-0000-4000-8000-000000000006'
const LOTE = '0000c001-0000-4000-8000-000000000007'
const EMAIL = 'dono.transf@teste.invalido'

const DONO = { nome: 'Dona Original', email: 'dona.original@teste.invalido', doc: '11122233344' }

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

const aberto = (rota: string, init: RequestInit = {}) =>
  fetch(`${BASE}${rota}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

/** cria um ingresso novo com titular conhecido e devolve o código */
async function novoIngresso(sufixo: string, status = 'valido') {
  const code = `ZZT-TRAN-${sufixo}`
  await sql(
    `INSERT INTO tickets (org_id, event_id, sector_id, lot_id, code, qr_secret, status,
                          holder_name, holder_email, holder_document)
     VALUES ($1,$2,$3,$4,$5,'teste',$6,$7,$8,$9)
     ON CONFLICT (code) DO UPDATE SET status = EXCLUDED.status,
       holder_name = EXCLUDED.holder_name, holder_email = EXCLUDED.holder_email,
       holder_document = EXCLUDED.holder_document`,
    [ORG, EVENTO, SETOR, LOTE, code, status, DONO.nome, DONO.email, DONO.doc])
  return code
}

async function titular(code: string) {
  const [t] = await sql(
    `SELECT holder_name, holder_email, holder_document, status FROM tickets WHERE code = $1`, [code])
  return t
}

/** O aceite troca o código (QR novo — o print do antigo dono deixa de valer),
 *  então depois dele o ingresso só se acha pelo id, nunca pelo código antigo. */
async function idDoIngresso(code: string): Promise<string> {
  const [t] = await sql(`SELECT id FROM tickets WHERE code = $1`, [code])
  return t.id
}

async function titularPorId(id: string) {
  const [t] = await sql(
    `SELECT code, holder_name, holder_email, holder_document, status FROM tickets WHERE id = $1`, [id])
  return t
}

async function enviar(corpo: any) {
  const r = await comSessao(`/api/admin/evento/${EVENTO}/transferencias`,
    { method: 'POST', body: JSON.stringify(corpo) })
  return { status: r.status, corpo: await r.json().catch(() => ({})) }
}

async function permitir(v: boolean) {
  await comSessao(`/api/admin/evento/${EVENTO}/transferencias`,
    { method: 'PATCH', body: JSON.stringify({ permitir: v }) })
}

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).status < 500
  } catch { noAr = false }
  if (!noAr) return

  await sql(`INSERT INTO organizations (id, name, slug)
             VALUES ($1,'ZZ TRANSFERENCIA TESTE','zz-transferencia-teste')
             ON CONFLICT (id) DO NOTHING`, [ORG])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, status, allow_transfer)
     VALUES ($1,$2,'ZZ EVENTO TRANSFERENCIA','zz-evento-transferencia',
             now() + interval '10 days', now() + interval '11 days', 'ativo', true)
     ON CONFLICT (id) DO UPDATE SET allow_transfer = true`, [EVENTO, ORG])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZ SETOR')
             ON CONFLICT (id) DO NOTHING`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity)
             VALUES ($1,$2,'ZZ LOTE', 5000, 50) ON CONFLICT (id) DO NOTHING`, [LOTE, SETOR])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'Dono Transf Teste', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [USUARIO, ORG, EMAIL])

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
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('transferência de ingresso', () => {
  it('a sessão do teste existe (senão nada abaixo prova nada)', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()
  }, 20_000)

  it('com a permissão desligada, ninguém transfere', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const code = await novoIngresso('DESL')
    await permitir(false)
    try {
      const r = await enviar({ codigo: code, paraNome: 'Alguem', paraEmail: 'a@teste.invalido' })
      expect(r.status).toBe(409)
      const [{ n }] = await sql(
        `SELECT count(*)::int AS n FROM ticket_transfers tr
           JOIN tickets t ON t.id = tr.ticket_id WHERE t.code = $1`, [code])
      expect(n, 'gravou transferência com a chave desligada').toBe(0)
    } finally { await permitir(true) }
  }, 25_000)

  it('só uma pendente por ingresso', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const code = await novoIngresso('UNIC')

    const a = await enviar({ codigo: code, paraNome: 'Primeira', paraEmail: 'p1@teste.invalido' })
    expect(a.status).toBe(200)
    const b = await enviar({ codigo: code, paraNome: 'Segunda', paraEmail: 'p2@teste.invalido' })
    expect(b.status, 'o mesmo ingresso saiu pra duas pessoas').toBe(409)

    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM ticket_transfers tr
         JOIN tickets t ON t.id = tr.ticket_id
        WHERE t.code = $1 AND tr.status = 'aguardando'`, [code])
    expect(n).toBe(1)
  }, 25_000)

  it('enquanto está pendente, o titular não muda', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const code = await novoIngresso('PEND')
    await enviar({ codigo: code, paraNome: 'Futuro Dono', paraEmail: 'futuro@teste.invalido' })

    // Se o envio já trocasse o titular, quem comprou perderia o ingresso na
    // hora e o destinatário poderia nunca abrir o link: ninguém entraria.
    const t = await titular(code)
    expect(t.holder_email).toBe(DONO.email)
    expect(t.holder_name).toBe(DONO.nome)
  }, 25_000)

  it('o link público não entrega o código do ingresso antes do aceite', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const code = await novoIngresso('LINK')
    const env = await enviar({ codigo: code, paraNome: 'Quem Recebe', paraEmail: 'qr@teste.invalido' })
    const token = env.corpo.transferencia.link.split('/').pop()

    const vista = await aberto(`/api/transferencia/${token}`).then((r) => r.json())
    expect(vista.podeAceitar).toBe(true)
    expect(vista.ingresso.codigo, 'o código saiu antes de a pessoa aceitar').toBeNull()
    // e-mail de quem mandou vai coberto: reconhecer, sim; endereço, não
    expect(vista.de.email).not.toContain(DONO.email)
    expect(vista.de.email).toContain('•')
  }, 25_000)

  it('aceitar muda o titular, e aceitar de novo não reabre nada', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const code = await novoIngresso('ACEI')
    const ingressoId = await idDoIngresso(code)
    const env = await enviar({
      codigo: code, paraNome: 'Novo Dono', paraEmail: 'novo@teste.invalido',
    })
    const token = env.corpo.transferencia.link.split('/').pop()

    const um = await aberto(`/api/transferencia/${token}`, { method: 'POST', body: '{}' })
    expect(um.status).toBe(200)

    const t = await titularPorId(ingressoId)
    expect(t.holder_email).toBe('novo@teste.invalido')
    expect(t.holder_name).toBe('Novo Dono')
    // QR novo no aceite: o código que o antigo dono tem no celular morre.
    expect(t.code, 'o aceite manteve o código antigo — o print do ex-dono ainda entra')
      .not.toBe(code)

    const dois = await aberto(`/api/transferencia/${token}`, { method: 'POST', body: '{}' })
    expect(dois.status, 'o segundo clique reabriu a transferência').toBe(409)

    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM ticket_transfers WHERE code = $1 AND status = 'concluido'`,
      [token])
    expect(n).toBe(1)
  }, 25_000)

  it('dois aceites no mesmo instante: só um grava', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    // A checagem prévia da rota ("já está concluída?") resolve o caso em fila
    // e ESCONDE a trava: com a condição arrancada do UPDATE, o teste de dois
    // cliques em sequência continua verde. Aqui a ordem é forçada à mão — as
    // duas conexões leem a transferência ainda aguardando e só então gravam.
    const code = await novoIngresso('RACE')
    const env = await enviar({ codigo: code, paraNome: 'Corrida', paraEmail: 'corrida@teste.invalido' })
    const token = env.corpo.transferencia.link.split('/').pop()
    const [tr] = await sql(`SELECT id FROM ticket_transfers WHERE code = $1`, [token])

    const { db } = await import('../utils/db')
    const { SQL_ACEITA_TRANSFERENCIA } = await import('../utils/transferencia')
    const c1 = await db().connect()
    const c2 = await db().connect()
    try {
      const l1 = await c1.query(`SELECT status FROM ticket_transfers WHERE id = $1`, [tr.id])
      const l2 = await c2.query(`SELECT status FROM ticket_transfers WHERE id = $1`, [tr.id])
      expect(l1.rows[0].status).toBe('aguardando')
      expect(l2.rows[0].status).toBe('aguardando')

      const r1 = await c1.query(SQL_ACEITA_TRANSFERENCIA, [tr.id])
      const r2 = await c2.query(SQL_ACEITA_TRANSFERENCIA, [tr.id])
      expect(r1.rowCount + r2.rowCount,
        'os dois aceites gravaram — a troca de titular rodou duas vezes').toBe(1)
    } finally { c1.release(); c2.release() }
  }, 30_000)

  it('o banco recusa a segunda pendente, não só a rota', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    // Mesma história: a rota confere antes e esconde o índice único. Se a
    // trava do banco cair, duas requisições no mesmo milissegundo passam as
    // duas pela checagem e gravam as duas.
    const code = await novoIngresso('IDX')
    await enviar({ codigo: code, paraNome: 'Um', paraEmail: 'um@teste.invalido' })
    const [t] = await sql(`SELECT id, org_id FROM tickets WHERE code = $1`, [code])

    let recusou = false
    try {
      await sql(
        `INSERT INTO ticket_transfers (org_id, event_id, ticket_id, para_nome, para_email, code)
         VALUES ($1,$2,$3,'Dois','dois@teste.invalido',$4)`,
        [t.org_id, EVENTO, t.id, 'tr_forcado_' + Date.now()])
    } catch { recusou = true }
    expect(recusou, 'o banco aceitou duas transferências pendentes no mesmo ingresso').toBe(true)
  }, 25_000)

  it('cancelar devolve os TRÊS campos do titular, não só o nome', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const code = await novoIngresso('CANC')
    const ingressoId = await idDoIngresso(code)
    const env = await enviar({
      codigo: code, paraNome: 'Passageiro', paraEmail: 'passageiro@teste.invalido',
    })
    const token = env.corpo.transferencia.link.split('/').pop()
    await aberto(`/api/transferencia/${token}`, {
      method: 'POST', body: JSON.stringify({ documento: '99988877766' }),
    })

    const [tr] = await sql(`SELECT id FROM ticket_transfers WHERE code = $1`, [token])
    const r = await comSessao(`/api/admin/evento/${EVENTO}/transferencias`, {
      method: 'PATCH',
      body: JSON.stringify({ transferenciaId: tr.id, acao: 'cancelar' }),
    })
    expect(r.status).toBe(200)

    // Devolver só o nome deixaria o e-mail e o documento da outra pessoa
    // colados no ingresso — e é pro e-mail que a segunda via vai.
    const t = await titularPorId(ingressoId)
    expect(t.holder_name).toBe(DONO.nome)
    expect(t.holder_email).toBe(DONO.email)
    expect(t.holder_document).toBe(DONO.doc)
  }, 25_000)

  it('ingresso que já entrou não passa adiante', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const code = await novoIngresso('USAD', 'usado')
    const r = await enviar({ codigo: code, paraNome: 'Tarde', paraEmail: 'tarde@teste.invalido' })
    expect(r.status).toBe(409)
    expect(r.corpo.message ?? r.corpo.statusMessage).toMatch(/já entrou/i)
  }, 25_000)

  it('ingresso cancelado não passa adiante', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const code = await novoIngresso('CNCL', 'cancelado')
    const r = await enviar({ codigo: code, paraNome: 'Nada', paraEmail: 'nada@teste.invalido' })
    expect(r.status).toBe(409)
  }, 25_000)

  it('pendente vencida vira expirada e destrava o ingresso', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const code = await novoIngresso('VENC')
    await enviar({ codigo: code, paraNome: 'Sumiu', paraEmail: 'sumiu@teste.invalido' })
    await sql(
      `UPDATE ticket_transfers SET expires_at = now() - interval '1 day'
        WHERE ticket_id = (SELECT id FROM tickets WHERE code = $1) AND status = 'aguardando'`,
      [code])

    const { tx } = await import('../utils/db')
    const { expirarTransferencias } = await import('../utils/transferencia')
    const n = await tx((c) => expirarTransferencias(c))
    expect(n).toBeGreaterThanOrEqual(1)

    // o ponto da varredura: com a antiga vencida, o dono consegue mandar de novo
    const r = await enviar({ codigo: code, paraNome: 'Segunda Vez', paraEmail: 'seg@teste.invalido' })
    expect(r.status, 'a pendente vencida continuou trancando o ingresso').toBe(200)
  }, 30_000)
})
