/**
 * eventos-papel.test.ts — a lista de eventos e a criação de evento, papel por papel.
 *
 *   · EVT-02 (P1): a lista (`GET /api/admin/eventos`, área `evento_ver`) entregava cobrado, líquido
 *     e pedidos de cada evento à OPERAÇÃO, que por regra não vê o caixa. Agora o campo nem existe
 *     na resposta dela. Mutação: `veDinheiro = true` → o caso da operação fica vermelho.
 *   · EVT-13 (P3): "vendidos" somava cortesia (a rota de cortesia baixa `lots.sold`). A lista
 *     devolve `cortesias` e `pagos` à parte. Mutação: `cortesias` fixo em 0 → vermelho.
 *   · EVT-01 (P1): a operação tinha o botão "Criar evento" e o assistente travava no passo 1 — o
 *     `orgId` era obrigatório e o select vinha de uma rota só do master. A organização agora vem
 *     da sessão. Mutação: `orgId` obrigatório de novo no schema → 400 e o caso fica vermelho.
 *   · AUD-02 (P2): criar evento gravava a auditoria sem org, sem autor e sem IP — a tela de
 *     Auditoria nunca mostrava. Mutação: voltar o INSERT cru → o caso do autor fica vermelho.
 *
 * Fixture própria (organização, evento, lote, pedidos), e-mails deste arquivo, apagada no
 * `afterAll`. Sem servidor no ar, PULA.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'
import { db, q, q1 } from '../../utils/db'
import { roleLegado, type Papel } from '../../utils/papeis'

const BASE = BASE_DE_TESTE
const ORG = randomUUID()
const OUTRA = randomUUID()
const EV = randomUUID()
const PREFIXO = 'zz-evpapel'
const EMAILS: Record<Papel, string> = {
  master: 'eventos.papel.master@teste.invalido',
  financeiro: 'eventos.papel.financeiro@teste.invalido',
  operacao: 'eventos.papel.operacao@teste.invalido',
  portaria: 'eventos.papel.portaria@teste.invalido',
}
const cookies: Partial<Record<Papel, string>> = {}
let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }

async function chamar(papel: Papel, rota: string, init: { method?: string; body?: unknown } = {}) {
  const r = await fetch(`${BASE}${rota}`, {
    method: init.method ?? 'GET',
    headers: { cookie: cookies[papel] ?? '', 'content-type': 'application/json', origin: BASE },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any }
}

async function apagarOrganizacoes(onde: string, par: any[] = []) {
  const c = await db().connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL auditoria.expurgo = 'liberado'`)
    const orgs = `SELECT id FROM organizations WHERE ${onde}`
    await c.query(`DELETE FROM audit_log WHERE org_id IN (${orgs})`, par)
    await c.query(`DELETE FROM tickets WHERE org_id IN (${orgs})`, par)
    await c.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE org_id IN (${orgs}))`, par)
    await c.query(`DELETE FROM orders WHERE org_id IN (${orgs})`, par)
    await c.query(`DELETE FROM organizations WHERE ${onde}`, par)
    await c.query('COMMIT')
  } finally {
    try { await c.query('ROLLBACK') } catch { /* já fechou */ }
    c.release()
  }
}

/** o corpo mínimo que o assistente manda — SEM orgId, como a tela manda agora */
const corpoDeEvento = (nome: string) => ({
  nome,
  inicio: '2031-03-10T20:00:00.000Z',
  fim: '2031-03-11T04:00:00.000Z',
  local: { cidade: 'Ubatã', estado: 'BA' },
  setores: [{ nome: 'Geral', lotes: [{ nome: '1º lote', faceCents: 3000, quantidade: 50 }] }],
})

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/eventos-papel.test.ts', sonda)
  if (!sonda.noAr) return
  await apagarOrganizacoes(`slug LIKE '${PREFIXO}-%'`)

  await q(`INSERT INTO organizations (id, name, slug) VALUES ($1,'ZZ Eventos Papel',$2), ($3,'ZZ Outra',$4)`,
    [ORG, `${PREFIXO}-${ORG.slice(0, 8)}`, OUTRA, `${PREFIXO}-o-${OUTRA.slice(0, 8)}`])
  await q(`INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
           VALUES ($1,$2,'ZZ Evento Papel',$3, now() + interval '5 days', now() + interval '6 days', 0, 'ativo')`,
    [EV, ORG, `${PREFIXO}-ev-${EV.slice(0, 8)}`])
  const setor = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1,'Geral') RETURNING id`, [EV]))!.id
  // 10 no lote: 3 pagos + 2 cortesias de pé + 1 cortesia cancelada (que devolveu o lugar)
  const lote = (await q1<any>(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, sold, max_per_order, channels)
     VALUES ($1,'Único',5000,10,5,10,'{online}') RETURNING id`, [setor]))!.id

  for (const papel of Object.keys(EMAILS) as Papel[]) {
    await q(
      `INSERT INTO users (org_id, name, email, password_hash, papel, role)
       SELECT $1, $2, $3, password_hash, $4, $5 FROM users WHERE email = 'dono@fazendapark.com.br'`,
      [ORG, `Teste ${papel}`, EMAILS[papel], papel, roleLegado(papel)])
    const r = await fetch(`${BASE}/api/auth/entrar`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAILS[papel], senha: 'diamond123' }),
    })
    cookies[papel] = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0])
      .find((c) => c.startsWith('dt_sessao=')) ?? ''
  }

  // venda: 3 ingressos, R$ 150,00 (plataforma R$ 15,00)
  const venda = (await q1<any>(
    `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method, face_cents, fee_cents,
                         platform_cents, discount_cents, total_cents, refunded_cents, paid_at)
     VALUES ($1,$2,$3,'pago','online','pix',15000,0,1500,0,15000,0, now()) RETURNING id`,
    [ORG, EV, `ZZEVP-V-${Date.now()}`]))!.id
  await q(`INSERT INTO order_items (order_id, lot_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents)
           VALUES ($1,$2,3,5000,0,5000)`, [venda, lote])
  // cortesia: 3 emitidas, 1 cancelada depois
  const cortesia = (await q1<any>(
    `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method, face_cents, fee_cents,
                         platform_cents, discount_cents, total_cents, paid_at)
     VALUES ($1,$2,$3,'pago','cortesia','cortesia',0,0,0,0,0, now()) RETURNING id`,
    [ORG, EV, `ZZEVP-C-${Date.now()}`]))!.id
  for (const [i, status] of ['valido', 'usado', 'cancelado'].entries()) {
    await q(`INSERT INTO tickets (org_id, event_id, order_id, sector_id, lot_id, code, qr_secret, status, is_courtesy)
             VALUES ($1,$2,$3,$4,$5,$6,'x',$7,true)`,
      [ORG, EV, cortesia, setor, lote, `ZZEVP-T${i}-${Date.now()}`, status])
  }
}, 90_000)

afterAll(async () => {
  if (sonda.noAr) await apagarOrganizacoes('id = ANY($1::uuid[])', [[ORG, OUTRA]])
  await db().end()
})

describe('EVT-02 — a lista de eventos só leva dinheiro pra quem vê o caixa', () => {
  it('operação recebe o evento, o estoque e NENHUM campo de dinheiro', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar('operacao', '/api/admin/eventos')
    expect(r.status).toBe(200)
    const ev = r.corpo.find((e: any) => e.id === EV)
    expect(ev, 'o evento da organização sumiu da lista da operação').toBeTruthy()
    for (const campo of ['cobradoCents', 'liquidoCents', 'pedidos', 'ingressos']) {
      expect(ev, `a operação recebeu ${campo}`).not.toHaveProperty(campo)
    }
    expect(JSON.stringify(r.corpo)).not.toMatch(/liquido|cobrado/i)
  })

  it('master e financeiro recebem o caixa, com o líquido da conta única', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    for (const papel of ['master', 'financeiro'] as const) {
      const ev = (await chamar(papel, '/api/admin/eventos')).corpo.find((e: any) => e.id === EV)
      // a cortesia (pedido pago de R$ 0,00) conta como pedido vivo, como no relatório do evento
      expect(ev, papel).toMatchObject({ cobradoCents: 15000, liquidoCents: 13500, pedidos: 2, ingressos: 3 })
    }
  })

  it('a portaria segue sem a lista (403), como antes', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect((await chamar('portaria', '/api/admin/eventos')).status).toBe(403)
  })
})

describe('EVT-13 — vendidos e cortesias separados', () => {
  it('lots.sold = 5 vira 3 pagos + 2 cortesias de pé (a cancelada devolveu o lugar)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    for (const papel of ['master', 'operacao'] as const) {
      const ev = (await chamar(papel, '/api/admin/eventos')).corpo.find((e: any) => e.id === EV)
      expect(ev.estoque, papel).toEqual({ total: 10, vendidos: 5, cortesias: 2, pagos: 3 })
    }
  })
})

describe('EVT-01 — quem é de operação cria evento; a organização vem da sessão', () => {
  it('operação publica um evento sem mandar orgId, e ele nasce na organização dela', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar('operacao', '/api/admin/evento', {
      method: 'POST', body: { ...corpoDeEvento('ZZ Criado pela Operacao'), publicar: true },
    })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    const criado = await q1<any>(`SELECT org_id, status FROM events WHERE id = $1`, [r.corpo.id])
    expect(criado).toMatchObject({ org_id: ORG, status: 'ativo' })
  })

  it('orgId de outra organização no corpo continua recusado (403)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar('operacao', '/api/admin/evento', {
      method: 'POST', body: { ...corpoDeEvento('ZZ Na Casa do Vizinho'), orgId: OUTRA },
    })
    expect(r.status).toBe(403)
    expect(await q1<any>(`SELECT 1 FROM events WHERE org_id = $1`, [OUTRA])).toBeNull()
  })

  it('"cancelamento" é endereço reservado (a página pública nova)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar('master', '/api/admin/evento', {
      method: 'POST', body: { ...corpoDeEvento('Cancelamento') },
    })
    expect(r.status).toBe(200)
    expect(r.corpo.slug).not.toBe('cancelamento')
  })
})

describe('AUD-02 — criar evento aparece na Auditoria, com quem e de onde', () => {
  it('a linha tem organização, autor, e-mail e ação "criado" — e sai na rota da Auditoria', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar('master', '/api/admin/evento', {
      method: 'POST', body: corpoDeEvento('ZZ Auditado na Criacao'),
    })
    expect(r.status).toBe(200)
    const linha = await q1<any>(
      `SELECT org_id, user_id, actor_email, entity, action FROM audit_log
        WHERE entity_id = $1 AND action = 'criado'`, [r.corpo.id])
    expect(linha).toMatchObject({ org_id: ORG, actor_email: EMAILS.master, entity: 'evento', action: 'criado' })
    expect(linha!.user_id).toBeTruthy()

    const tela = await chamar('master', `/api/admin/auditoria?entidade=evento&busca=${r.corpo.id}`)
    expect(tela.status).toBe(200)
    expect(tela.corpo.linhas.map((l: any) => l.entidadeId)).toContain(r.corpo.id)
  })
})

describe('Excluir evento (06/10) — some da lista e do link, o caixa fica', () => {
  it('à venda é recusado; cancelado sai da lista, o link dá 404, os pedidos ficam; desfazer traz de volta', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const slug = `${PREFIXO}-ev-${EV.slice(0, 8)}`
    const naLista = async () => !!(await chamar('master', '/api/admin/eventos')).corpo.find((e: any) => e.id === EV)

    const aVenda = await chamar('master', `/api/admin/evento/${EV}/excluir`, { method: 'POST', body: {} })
    expect(aVenda.status, 'excluiu evento à venda').toBe(409)
    expect(await naLista()).toBe(true)

    // a portaria não tem a área `evento`
    expect((await chamar('portaria', `/api/admin/evento/${EV}/excluir`, { method: 'POST', body: {} })).status).toBe(403)

    await q(`UPDATE events SET status = 'cancelado' WHERE id = $1`, [EV])
    try {
      const pedidosAntes = (await q1<any>(`SELECT count(*)::int n FROM orders WHERE event_id = $1`, [EV]))!.n
      const ok = await chamar('master', `/api/admin/evento/${EV}/excluir`, { method: 'POST', body: {} })
      expect(ok.status, ok.corpo.statusMessage).toBe(200)
      expect(await naLista(), 'o evento excluído continua na lista').toBe(false)
      expect((await fetch(`${BASE}/api/e/${slug}`)).status, 'o link público ainda abre').toBe(404)
      const pedidosDepois = (await q1<any>(`SELECT count(*)::int n FROM orders WHERE event_id = $1`, [EV]))!.n
      expect(pedidosDepois, 'excluir apagou pedido').toBe(pedidosAntes)
      const aud = await q1<any>(
        `SELECT user_id FROM audit_log WHERE entity_id = $1 AND action = 'excluido' ORDER BY id DESC LIMIT 1`, [EV])
      expect(aud?.user_id, 'a exclusão não ficou na auditoria').toBeTruthy()

      const volta = await chamar('master', `/api/admin/evento/${EV}/excluir`, { method: 'POST', body: { desfazer: true } })
      expect(volta.status).toBe(200)
      expect(await naLista()).toBe(true)
    } finally {
      await q(`UPDATE events SET status = 'ativo', excluido_em = NULL, excluido_por = NULL WHERE id = $1`, [EV])
    }
  }, 60_000)
})
