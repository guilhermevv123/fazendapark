/**
 * auditoria-autor.test.ts — o que aparece (e com quem) na tela de Auditoria.
 *
 *   · AUD-03: "Empurrar a fila agora" (`POST /api/admin/financeiro/estornos` sem id) manda dinheiro
 *     sair da conta; cada devolução que o clique fez sair ganha a linha dela, com QUEM apertou —
 *     e a linha aparece na rota da tela de Auditoria filtrada por "Devolução".
 *   · AUD-01: o "Hoje" da Auditoria corta no fuso do PARQUE. Um ato às 23:30 (Bahia) de hoje entra
 *     no recorte de=ate=hoje; com a sessão do banco em UTC (o servidor de produção), ele caía fora —
 *     depois das 21h o dia do parque já é amanhã em UTC. O conserto é o do pool (`utils/db.ts`, que
 *     põe toda sessão em America/Bahia); este teste é a regressão do lado da tela.
 *
 * Fixture própria (organização `zz-aud-autor-*`) com cobrança SIMULADA (`sim_…`: a devolução não
 * sai do processo — ver `estornarNoAsaas`), apagada no `afterAll`; a auditoria é só-escrita por
 * gatilho, então a limpeza usa a licença na mesma transação.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'
import { db, q, q1 } from '../../utils/db'
import { hojeNoFuso } from '../../../app/composables/painelPeriodo'

const BASE = BASE_DE_TESTE
const ORG = randomUUID()
const SLUG = `zz-aud-autor-${ORG.slice(0, 8)}`
const EVT = randomUUID()
const SETOR = randomUUID()
const LOTE = randomUUID()
const PEDIDO = randomUUID()
const PAGAMENTO = `sim_zz_aud_${ORG.slice(0, 8)}`
const EMAIL = `aud.autor.${ORG.slice(0, 8)}@teste.invalido`

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''
let mestreId = ''
let filaId = ''

async function entrar(email: string) {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, senha: 'diamond123' }),
  })
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}

async function apagar() {
  const c = await db().connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL auditoria.expurgo = 'liberado'`)
    await c.query(`DELETE FROM audit_log WHERE org_id IN (SELECT id FROM organizations WHERE slug LIKE 'zz-aud-autor-%')`)
    await c.query(`DELETE FROM refund_jobs WHERE org_id IN (SELECT id FROM organizations WHERE slug LIKE 'zz-aud-autor-%')`)
    await c.query(`DELETE FROM orders WHERE org_id IN (SELECT id FROM organizations WHERE slug LIKE 'zz-aud-autor-%')`)
    await c.query(`DELETE FROM organizations WHERE slug LIKE 'zz-aud-autor-%'`)
    await c.query('COMMIT')
  } finally {
    try { await c.query('ROLLBACK') } catch { /* já fechou */ }
    c.release()
  }
}

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/auditoria-autor.test.ts', sonda)
  if (!sonda.noAr) return
  await apagar()
  await q(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'ZZ Auditoria Autor', $2)`, [ORG, SLUG])
  const u = await q1<{ id: string }>(
    `INSERT INTO users (org_id, name, email, password_hash, papel, role)
     SELECT $1, 'Mestre da Auditoria', $2, password_hash, 'master', 'master' FROM users WHERE email = 'dono@fazendapark.com.br'
     RETURNING id`, [ORG, EMAIL])
  mestreId = u!.id
  await q(`INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
           VALUES ($1, $2, 'ZZ Evento Auditoria', $3, now() + interval '30 days', now() + interval '31 days', 1000, 'cancelado')`,
    [EVT, ORG, `${SLUG}-evento`])
  await q(`INSERT INTO sectors (id, event_id, name) VALUES ($1, $2, 'ZZ Setor')`, [SETOR, EVT])
  await q(`INSERT INTO lots (id, sector_id, name, price_cents, quantity, sold) VALUES ($1, $2, 'ZZ Lote', 10000, 10, 1)`, [LOTE, SETOR])
  await q(`INSERT INTO orders (id, org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                               total_cents, refunded_cents, asaas_payment_id, paid_at, installments)
           VALUES ($1, $2, $3, $4, 'pago', 'online', 10000, 1000, 1000, 11000, 0, $5, now() - interval '1 day', 1)`,
    [PEDIDO, ORG, EVT, `ZZAUD-${ORG.slice(0, 6)}`, PAGAMENTO])
  const f = await q1<{ id: string }>(
    `INSERT INTO refund_jobs (org_id, event_id, order_id, reason, amount_cents, asaas_payment_id, status)
     VALUES ($1, $2, $3, 'evento_cancelado', 11000, $4, 'na_fila') RETURNING id`, [ORG, EVT, PEDIDO, PAGAMENTO])
  filaId = f!.id
  cookie = await entrar(EMAIL)
}, 60_000)

afterAll(async () => {
  if (sonda.noAr) await apagar()
  await db().end()
})

describe('AUD-03 — o empurrão na fila tem autor', () => {
  it('cada devolução que o clique fez sair vira uma linha com quem apertou', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE}/api/admin/financeiro/estornos`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: '{}',
    })
    const corpo = await r.json()
    expect(r.status, JSON.stringify(corpo)).toBe(200)
    expect(corpo.processados).toBe(1)
    expect(corpo.estornos[0]).toMatchObject({ id: filaId, pedidoId: PEDIDO, ok: true })

    const linhas = await q<any>(
      `SELECT user_id, entity, entity_id, action, before, after, actor_email, ip
         FROM audit_log WHERE org_id = $1 AND entity = 'estorno'`, [ORG])
    expect(linhas, 'o dinheiro saiu e a auditoria não sabe quem mandou').toHaveLength(1)
    expect(linhas[0]).toMatchObject({
      user_id: mestreId, entity: 'estorno', entity_id: filaId, action: 'empurrar_fila', actor_email: EMAIL,
      before: { status: 'na_fila', tentativas: 0, erro: null },
      after: { status: 'estornado', valorCents: 11000, erro: null },
    })
  })

  it('e a linha aparece na tela de Auditoria, filtrando por Devolução, com o nome de quem fez', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE}/api/admin/auditoria?entidade=estorno`, { headers: { cookie } })
    const corpo = await r.json()
    expect(r.status, JSON.stringify(corpo)).toBe(200)
    const linha = corpo.linhas.find((l: any) => l.entidadeId === filaId)
    expect(linha, 'a devolução não aparece na Auditoria').toBeTruthy()
    expect(linha.acao).toBe('empurrar_fila')
    expect(linha.autor?.nome).toBe('Mestre da Auditoria')
    expect(corpo.semAutor ?? 0).toBe(0)
  })
})

describe('AUD-01 — o "Hoje" da Auditoria é o dia do parque', () => {
  it('um ato às 23:30 (Bahia) de hoje entra no recorte de hoje', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const hoje = hojeNoFuso('America/Bahia')
    await q(`INSERT INTO audit_log (org_id, user_id, actor_email, entity, entity_id, action, after, created_at)
             VALUES ($1, $2, $3, 'evento', $4, 'editado', '{"nome":"ZZ noite"}'::jsonb, $5::timestamptz)`,
      [ORG, mestreId, EMAIL, EVT, `${hoje}T23:30:00-03:00`])
    const r = await fetch(`${BASE}/api/admin/auditoria?de=${hoje}&ate=${hoje}&entidade=evento`, { headers: { cookie } })
    const corpo = await r.json()
    expect(r.status, JSON.stringify(corpo)).toBe(200)
    expect(corpo.linhas.map((l: any) => l.depois?.nome),
      'o ato das 23:30 do parque caiu pro dia seguinte — o corte está em UTC').toContain('ZZ noite')
  })

  it('o atalho ?periodo=hoje (vocabulário do painel) resolve no calendário do parque', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const hoje = hojeNoFuso('America/Bahia')
    const r = await fetch(`${BASE}/api/admin/auditoria?periodo=hoje&entidade=evento`, { headers: { cookie } })
    const corpo = await r.json()
    expect(r.status, JSON.stringify(corpo)).toBe(200)
    expect(corpo.filtros).toMatchObject({ periodo: 'hoje', de: hoje, ate: hoje })
    expect(corpo.linhas.map((l: any) => l.depois?.nome)).toContain('ZZ noite')
  })

  it('atalho desconhecido e De depois de Até voltam 400 com frase', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const torto = await fetch(`${BASE}/api/admin/auditoria?periodo=semana-que-vem`, { headers: { cookie } })
    expect(torto.status).toBe(400)
    expect((await torto.json()).statusMessage).toContain('Período desconhecido')
    const trocado = await fetch(`${BASE}/api/admin/auditoria?de=2026-09-10&ate=2026-09-01`, { headers: { cookie } })
    expect(trocado.status).toBe(400)
    expect((await trocado.json()).statusMessage).toContain('vem depois')
  })
})
