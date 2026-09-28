/**
 * financeiro-painel.test.ts — o que o redesenho do Financeiro (27/09) acrescentou à rota.
 *
 * O que já existia segue travado em outros arquivos (a linha da organização = financeiro do evento
 * = borderô: `saldo-tres-telas.test.ts`; face, por mês e por forma pela régua do pedido vivo:
 * `evento/[id]/relatorios.test.ts`). Aqui, contra números escritos à mão ao lado da fixture:
 *
 *   · FIN-01 (metade do navegador): o mês e o dia saem como TEXTO do calendário do parque;
 *   · FIN-02: os saques esperando, separados pelo que o botão envia (PIX solicitado), o manual
 *     (conta bancária) e o que já está no banco (processando);
 *   · FIN-03: o saldo devedor aparece com nome em vez de sumir num zero — e as partes do líquido
 *     fecham com ele;
 *   · FIN-05: o período vale pro FLUXO (mês, dia, forma, transferências, "entrou no período") e o
 *     "entrou" é o MESMO número da Visão geral no mesmo recorte; o saldo não muda com o período;
 *   · FIN-07: o histórico de transferências tem páginas e diz o total.
 *
 * Fixture própria (ids sorteados), apagada no `afterAll`. Sem servidor, PULA.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'
import { db, q, q1 } from '../../utils/db'
import { roleLegado, type Papel } from '../../utils/papeis'
import { somarDiasNoCalendario } from '../../../app/composables/painelPeriodo'

const BASE = BASE_DE_TESTE
const ORG = randomUUID()
const EV_A = randomUUID()
const EV_B = randomUUID()
const SLUG = `zz-finpainel-${ORG.slice(0, 8)}`
const EMAILS: Partial<Record<Papel, string>> = {
  master: 'financeiro.painel.master@teste.invalido',
  operacao: 'financeiro.painel.operacao@teste.invalido',
}
const cookies: Partial<Record<Papel, string>> = {}
let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let hoje = ''

async function entrarCom(email: string) {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha: 'diamond123' }),
  })
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}
const abrir = (rota: string, papel: Papel = 'master') =>
  fetch(`${BASE}${rota}`, { headers: { cookie: cookies[papel] ?? '', origin: BASE } })
async function json(rota: string, papel: Papel = 'master') {
  const r = await abrir(rota, papel)
  const corpo = await r.json().catch(() => ({}))
  if (r.status !== 200) throw new Error(`${rota} respondeu ${r.status}: ${corpo.statusMessage ?? ''}`)
  return corpo
}

let n = 0
async function pedido(ev: string, c: { status?: string; canal?: string; forma: string; total: number; plataforma: number; estornado?: number; gateway: boolean; pagoEm: string }) {
  n++
  await q(
    `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents, discount_cents,
                         total_cents, refunded_cents, asaas_payment_id, paid_at, payment_method)
     VALUES ($1,$2,$3,$4,$5,$6,0,$7,0,$6,$8,$9, ${c.pagoEm}, $10)`,
    [ORG, ev, `ZZFP-${n}-${Date.now()}`, c.status ?? 'pago', c.canal ?? 'online', c.total, c.plataforma,
     c.estornado ?? 0, c.gateway ? `pay_zzfp_${n}_${Date.now()}` : null, c.forma])
}
async function saque(ev: string, c: { valor: number; status: string; destino?: 'pix' | 'conta'; pedidoEm: string }) {
  n++
  await q(
    `INSERT INTO payouts (org_id, event_id, code, beneficiary_name, destination_kind, destination, amount_cents, status, requested_at, processed_at)
     VALUES ($1,$2,$3,'ZZ Beneficiário',$4,'destino-de-teste',$5,$6, ${c.pedidoEm}, CASE WHEN $6 = 'concluida' THEN now() END)`,
    [ORG, ev, `ZZFP-P${n}-${Date.now()}`, c.destino ?? 'pix', c.valor, c.status])
}

async function apagar() {
  const orgs = `SELECT id FROM organizations WHERE slug LIKE 'zz-finpainel-%'`
  await q(`DELETE FROM payouts WHERE org_id IN (${orgs})`)
  await q(`DELETE FROM orders WHERE org_id IN (${orgs})`)
  await q(`DELETE FROM organizations WHERE id IN (${orgs})`)
}

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/financeiro-painel.test.ts', sonda)
  if (!sonda.noAr) return
  await apagar()
  hoje = (await q1<any>(`SELECT current_date::text AS d`))!.d

  await q(`INSERT INTO organizations (id, name, slug) VALUES ($1,'ZZ Financeiro Painel',$2)`, [ORG, SLUG])
  // os dois eventos terminaram há 10 dias: passaram da retenção, todo saldo é "disponível"
  for (const [id, nome] of [[EV_A, 'ZZ Fin A'], [EV_B, 'ZZ Fin B']]) {
    await q(`INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
             VALUES ($1,$2,$3,$4, now() - interval '11 days', now() - interval '10 days', 1000, 'encerrado')`,
      [id, ORG, nome, `${SLUG}-${String(id).slice(0, 6)}`])
  }
  for (const papel of Object.keys(EMAILS) as Papel[]) {
    await q(`INSERT INTO users (org_id, name, email, password_hash, papel, role)
             SELECT $1, $2, $3, password_hash, $4, $5 FROM users WHERE email = 'dono@fazendapark.com.br'`,
      [ORG, `Teste ${papel}`, EMAILS[papel], papel, roleLegado(papel)])
    cookies[papel] = await entrarCom(EMAILS[papel]!)
  }

  // ---- evento A: site 500 (plataforma 50) + site 300 (30), balcão 100 (10) ------------------
  //   na plataforma = 450 + 270 = 720; recebido direto = 90; líquido = 810
  await pedido(EV_A, { forma: 'pix', total: 50_000, plataforma: 5_000, gateway: true, pagoEm: `now() - interval '40 days'` })
  await pedido(EV_A, { forma: 'credito', total: 30_000, plataforma: 3_000, gateway: true, pagoEm: `now() - interval '3 days'` })
  await pedido(EV_A, { canal: 'bilheteria', forma: 'dinheiro', total: 10_000, plataforma: 1_000, gateway: false, pagoEm: `now() - interval '2 days'` })
  //   saques: 300 concluído, 100 PIX pedido, 80 conta pedido, 50 processando → disponível 720 − 530 = 190
  await saque(EV_A, { valor: 30_000, status: 'concluida', pedidoEm: `now() - interval '35 days'` })
  await saque(EV_A, { valor: 10_000, status: 'solicitada', pedidoEm: `now() - interval '1 day'` })
  await saque(EV_A, { valor: 8_000, status: 'solicitada', destino: 'conta', pedidoEm: `now() - interval '1 day'` })
  await saque(EV_A, { valor: 5_000, status: 'processando', pedidoEm: `now() - interval '2 days'` })

  // ---- evento B: site 200 (20) transferido INTEIRO, e depois 40 devolvidos ---------------------
  //   na plataforma = 200 − 20 − 40 = 140; transferido 180 → deve 40
  await pedido(EV_B, { status: 'estornado_parcial', forma: 'pix', total: 20_000, plataforma: 2_000, estornado: 4_000, gateway: true, pagoEm: `now() - interval '5 days'` })
  await saque(EV_B, { valor: 18_000, status: 'concluida', pedidoEm: `now() - interval '4 days'` })
  // mais 25 saques antigos já cancelados, pro histórico passar de uma página (4 + 1 + 25 = 30)
  for (let i = 0; i < 25; i++) await saque(EV_B, { valor: 100 + i, status: 'cancelada', pedidoEm: `now() - interval '${50 + i} days'` })
}, 120_000)

afterAll(async () => {
  if (sonda.noAr) await apagar()
  await db().end()
})

describe('saldo: as partes fecham com o líquido, e o devedor tem nome (FIN-03)', () => {
  it('evento B deve 40: retido e disponível ficam em zero e a dívida aparece', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/financeiro')
    const b = d.eventos.find((e: any) => e.id === EV_B)
    expect(b).toMatchObject({ liquidoCents: 14_000, transferidoCents: 18_000, retidoCents: 0, disponivelCents: 0, saldoDevedorCents: 4_000 })
    const a = d.eventos.find((e: any) => e.id === EV_A)
    expect(a).toMatchObject({ liquidoCents: 81_000, naPlataformaCents: 72_000, recebidoDiretoCents: 9_000, disponivelCents: 19_000, saldoDevedorCents: 0 })
    expect(d.totais.saldoDevedorCents).toBe(4_000)
  })

  it('transferido + em curso + retido + disponível + recebido direto − devedor = total líquido', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const t = (await json('/api/admin/financeiro')).totais
    expect(t.liquidoCents).toBe(95_000)
    expect(t.transferidoCents + t.emCursoCents + t.retidoCents + t.disponivelCents + t.recebidoDiretoCents - t.saldoDevedorCents)
      .toBe(t.liquidoCents)
  })
})

describe('os saques esperando, pelo que o botão faz (FIN-02)', () => {
  it('PIX pedido é o que sai; conta bancária é manual; processando já está no banco', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { saques } = await json('/api/admin/financeiro')
    expect(saques).toEqual({
      enviaveis: { pedidos: 1, valorCents: 10_000 },
      manuais: { pedidos: 1, valorCents: 8_000 },
      emVoo: { pedidos: 1, valorCents: 5_000 },
    })
  })
})

describe('o mês e o dia são do calendário do parque (FIN-01)', () => {
  it('porMes[].mes e porDia[].dia saem como texto AAAA-MM-DD', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/financeiro')
    expect(d.porMes.length).toBeGreaterThan(0)
    for (const m of d.porMes) expect(m.mes, 'o navegador leria um instante no fuso dele').toMatch(/^\d{4}-\d{2}-01$/)
    for (const x of d.porDia) expect(x.dia).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // e a decomposição que já era conferida continua: a soma do mês é a soma do dia
    const soma = (l: any[], k: string) => l.reduce((s, x) => s + x[k], 0)
    expect(soma(d.porMes, 'liquidoCents')).toBe(soma(d.porDia, 'liquidoCents'))
    expect(soma(d.porMes, 'liquidoCents')).toBe(95_000)
  })
})

describe('o período vale pro fluxo, não pro saldo (FIN-05)', () => {
  it('30 dias: fica de fora a venda de 40 dias atrás e o saque de 35; o saldo não muda', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const tudo = await json('/api/admin/financeiro')
    const d = await json('/api/admin/financeiro?periodo=30d')
    expect(d.filtro).toMatchObject({ periodo: '30d', de: somarDiasNoCalendario(hoje, -29), ate: hoje })
    // entrou nos 30 dias: A 300 (270), A balcão 100 (90), B 200 (140)
    expect(d.noPeriodo).toEqual({ cobradoCents: 60_000, liquidoCents: 50_000, pedidos: 3 })
    expect(d.porForma.reduce((s: number, f: any) => s + f.cobradoCents, 0)).toBe(60_000)
    expect(d.porDia.reduce((s: number, x: any) => s + x.liquidoCents, 0)).toBe(50_000)
    // transferências pedidas nos 30 dias: 100, 80, 50 (A) e 180 (B)
    expect(d.transferenciasTotal).toBe(4)
    // o saldo é de agora
    expect(d.totais).toEqual(tudo.totais)
    expect(d.saques).toEqual(tudo.saques)
  })

  it('"entrou no período" é o MESMO número da Visão geral no mesmo recorte', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    for (const recorte of ['periodo=30d', 'periodo=7d', `de=${somarDiasNoCalendario(hoje, -45)}&ate=${somarDiasNoCalendario(hoje, -30)}`]) {
      const fin = (await json(`/api/admin/financeiro?${recorte}`)).noPeriodo
      const rel = (await json(`/api/admin/relatorios?${recorte}`)).resumo
      expect(fin, recorte).toEqual({ cobradoCents: rel.cobradoCents, liquidoCents: rel.liquidoCents, pedidos: rel.pedidos })
    }
  })

  it('período errado é recusado com a frase', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await abrir('/api/admin/financeiro?de=2026-09-30&ate=2026-09-01')
    expect(r.status).toBe(400)
    expect((await r.json()).statusMessage).toBe('A data inicial vem depois da final.')
  })
})

describe('o histórico de transferências tem páginas (FIN-07)', () => {
  it('30 transferências: 25 na primeira página, 5 na segunda, e o total sempre certo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const p1 = await json('/api/admin/financeiro')
    expect(p1).toMatchObject({ transferenciasTotal: 30, pagina: 1, porPagina: 25 })
    expect(p1.transferencias).toHaveLength(25)
    const p2 = await json('/api/admin/financeiro?pagina=2')
    expect(p2.transferencias).toHaveLength(5)
    const ids = new Set([...p1.transferencias, ...p2.transferencias].map((t: any) => t.id))
    expect(ids.size).toBe(30)
    // além da última página: lista vazia, mas o total não vira zero
    const p9 = await json('/api/admin/financeiro?pagina=9')
    expect(p9).toMatchObject({ transferenciasTotal: 30, transferencias: [] })
  })
})

describe('quem abre', () => {
  it('operação recebe 403 — o caixa não é da área dela', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect((await abrir('/api/admin/financeiro', 'operacao')).status).toBe(403)
  })
})
