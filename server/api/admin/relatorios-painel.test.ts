/**
 * relatorios-painel.test.ts — o que o redesenho da Visão geral (27/09) acrescentou à rota.
 *
 * `relatorios-organizacao.test.ts` segue travando o que já existia (a organização é a soma dos
 * eventos, o estorno parcial entra, o balcão sem cliente não some). Este arquivo trava o que é
 * NOVO, sempre contra números escritos à mão ao lado da fixture:
 *
 *   · REL-01, a metade do navegador: o dia da curva sai como TEXTO `AAAA-MM-DD` (o calendário do
 *     parque), nunca como instante que o navegador lê no fuso dele;
 *   · o período por CHAVE (`?periodo=30d`), resolvido no calendário do parque, e o período
 *     anterior de mesmo tamanho (a base do selo de variação);
 *   · REL-02: a conta do líquido FECHA (cobrado − taxa da plataforma − devolvido em parte) e a do
 *     cobrado também (ingressos − descontos + taxa);
 *   · REL-06: a cortesia sai do ticket médio e ganha número próprio;
 *   · proposta 6: quebra por tipo de ingresso, com "Sem tipo" pro lote sem variação;
 *   · REL-05: o e-mail dos maiores compradores só vai inteiro pra quem abre a base de clientes.
 *
 * Fixture própria (ids sorteados, e-mails deste arquivo), apagada no `afterAll`. Sem servidor, PULA.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'
import { db, q, q1 } from '../../utils/db'
import { roleLegado, type Papel } from '../../utils/papeis'
import { somarDiasNoCalendario } from '../../../app/composables/painelPeriodo'

const BASE = BASE_DE_TESTE
const ORG = randomUUID()
const EV = randomUUID()
const SLUG = `zz-relpainel-${ORG.slice(0, 8)}`

const EMAILS: Partial<Record<Papel, string>> = {
  master: 'relatorios.painel.master@teste.invalido',
  financeiro: 'relatorios.painel.financeiro@teste.invalido',
}
const cookies: Partial<Record<Papel, string>> = {}
let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let hoje = ''

async function entrarCom(email: string): Promise<string> {
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

let contador = 0
async function pedido(c: {
  cliente: string | null; status?: string; canal?: string; forma: string
  face: number; taxa: number; desconto?: number; plataforma: number; estornado?: number
  /** SQL do instante do pagamento (na sessão do banco, America/Bahia) */
  pagoEm: string
  itens: { lote: string; tipo?: string | null; qtd: number; unitTotal: number }[]
}) {
  const n = ++contador
  const total = c.face + c.taxa - (c.desconto ?? 0)
  const ped = await q1<any>(
    `INSERT INTO orders (org_id, event_id, customer_id, code, status, channel, face_cents, fee_cents,
                         platform_cents, discount_cents, total_cents, refunded_cents, paid_at, payment_method)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, ${c.pagoEm}, $13) RETURNING id`,
    [ORG, EV, c.cliente, `ZZRP-${n}-${Date.now()}`, c.status ?? 'pago', c.canal ?? 'online',
     c.face, c.taxa, c.plataforma, c.desconto ?? 0, total, c.estornado ?? 0, c.forma])
  for (const i of c.itens) {
    await q(`INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents)
             VALUES ($1,$2,$3,$4,$5,0,$5)`, [ped!.id, i.lote, i.tipo ?? null, i.qtd, i.unitTotal])
  }
}

async function cliente(nome: string) {
  return (await q1<any>(
    `INSERT INTO customers (org_id, name, email, document) VALUES ($1,$2,$3,$4) RETURNING id`,
    [ORG, nome, `${nome.toLowerCase()}.${ORG.slice(0, 6)}@teste.invalido`, String(Math.floor(Math.random() * 1e11)).padStart(11, '2')],
  ))!.id as string
}

async function apagar() {
  const orgs = `SELECT id FROM organizations WHERE slug LIKE 'zz-relpainel-%'`
  await q(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE org_id IN (${orgs}))`)
  await q(`DELETE FROM orders WHERE org_id IN (${orgs})`)
  await q(`DELETE FROM organizations WHERE id IN (${orgs})`)
}

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/relatorios-painel.test.ts', sonda)
  if (!sonda.noAr) return
  await apagar()

  hoje = (await q1<any>(`SELECT current_date::text AS d`))!.d
  await q(`INSERT INTO organizations (id, name, slug) VALUES ($1,'ZZ Relatorios Painel',$2)`, [ORG, SLUG])
  await q(`INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
           VALUES ($1,$2,'ZZ Painel',$3, now() + interval '5 days', now() + interval '6 days', 1000, 'ativo')`, [EV, ORG, SLUG])
  const setor = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1,'Geral') RETURNING id`, [EV]))!.id
  const comTipos = (await q1<any>(`INSERT INTO lots (sector_id, name, price_cents, quantity) VALUES ($1,'1º lote',10000,500) RETURNING id`, [setor]))!.id
  const semTipo = (await q1<any>(`INSERT INTO lots (sector_id, name, price_cents, quantity, channels) VALUES ($1,'Balcão',4000,500,'{bilheteria}') RETURNING id`, [setor]))!.id
  const inteira = (await q1<any>(`INSERT INTO ticket_types (lot_id, name, quantity) VALUES ($1,'Inteira',300) RETURNING id`, [comTipos]))!.id
  const meia = (await q1<any>(`INSERT INTO ticket_types (lot_id, name, quantity, discount_bps, requires_document)
                               VALUES ($1,'Meia',200,5000,true) RETURNING id`, [comTipos]))!.id

  for (const papel of Object.keys(EMAILS) as Papel[]) {
    await q(`INSERT INTO users (org_id, name, email, password_hash, papel, role)
             SELECT $1, $2, $3, password_hash, $4, $5 FROM users WHERE email = 'dono@fazendapark.com.br'`,
      [ORG, `Teste ${papel}`, EMAILS[papel], papel, roleLegado(papel)])
    cookies[papel] = await entrarCom(EMAILS[papel]!)
  }

  const ana = await cliente('Ana')
  const bia = await cliente('Bia')
  const duda = await cliente('Duda')

  // A — venda com CUPOM: 2 inteiras, face 200 + taxa 20 − cupom 30 = 190 cobrados
  await pedido({ cliente: ana, forma: 'pix', face: 20_000, taxa: 2_000, desconto: 3_000, plataforma: 1_900,
    pagoEm: `now() - interval '1 day'`, itens: [{ lote: comTipos, tipo: inteira, qtd: 2, unitTotal: 11_000 }] })
  // B — estorno PARCIAL: continua valendo, devolveu 40
  await pedido({ cliente: bia, status: 'estornado_parcial', forma: 'credito', face: 10_000, taxa: 1_000, plataforma: 1_100,
    estornado: 4_000, pagoEm: `now() - interval '2 days'`, itens: [{ lote: comTipos, tipo: meia, qtd: 2, unitTotal: 5_500 }] })
  // C — estorno TOTAL: fora do cobrado, dentro do "devolvido ao comprador"
  await pedido({ cliente: bia, status: 'estornado', forma: 'pix', face: 5_000, taxa: 500, plataforma: 550,
    estornado: 5_500, pagoEm: `now() - interval '3 days'`, itens: [{ lote: comTipos, tipo: inteira, qtd: 1, unitTotal: 5_500 }] })
  // D — CORTESIA: pedido de R$ 0,00 com 3 ingressos, do lote sem tipo
  await pedido({ cliente: duda, canal: 'cortesia', forma: 'cortesia', face: 0, taxa: 0, plataforma: 0,
    pagoEm: `now() - interval '1 day'`, itens: [{ lote: semTipo, qtd: 3, unitTotal: 0 }] })
  // E — balcão sem cliente, pago às 23h30 de HOJE no relógio do parque (a venda noturna do REL-01)
  await pedido({ cliente: null, canal: 'bilheteria', forma: 'dinheiro', face: 8_000, taxa: 0, plataforma: 800,
    pagoEm: `(current_date + time '23:30')`, itens: [{ lote: semTipo, qtd: 2, unitTotal: 4_000 }] })
  // F — 40 dias atrás: fora dos 30 dias, DENTRO do período anterior (31 a 60 dias atrás)
  await pedido({ cliente: bia, forma: 'pix', face: 30_000, taxa: 3_000, plataforma: 3_300,
    pagoEm: `now() - interval '40 days'`, itens: [{ lote: comTipos, tipo: inteira, qtd: 3, unitTotal: 11_000 }] })
}, 90_000)

afterAll(async () => {
  if (sonda.noAr) await apagar()
  await db().end()
})

describe('o dia da curva é o do calendário do parque (REL-01, metade do navegador)', () => {
  it('porDia[].dia sai como texto AAAA-MM-DD, não como instante', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/relatorios?periodo=30d')
    expect(d.porDia.length).toBeGreaterThan(0)
    for (const p of d.porDia) expect(p.dia, 'o navegador leria um instante no fuso dele').toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // e o dia é o do pagamento no relógio do parque: a venda das 23h30 de hoje está em HOJE
    expect(d.porDia.find((p: any) => p.dia === hoje)).toMatchObject({ pedidos: 1, cobradoCents: 8_000 })
  })

  it('"Hoje" pega a venda das 23h30 (o corte do dia é no fuso do parque)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/relatorios?periodo=hoje')
    expect(d.filtro).toMatchObject({ periodo: 'hoje', de: hoje, ate: hoje, hoje })
    expect(d.resumo).toMatchObject({ pedidos: 1, cobradoCents: 8_000 })
  })
})

describe('o período por chave e o anterior de mesmo tamanho', () => {
  it('30 dias = hoje − 29 até hoje; o anterior é o bloco de 30 dias logo antes', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/relatorios?periodo=30d')
    expect(d.filtro).toMatchObject({ periodo: '30d', de: somarDiasNoCalendario(hoje, -29), ate: hoje })
    expect(d.anterior).toMatchObject({ de: somarDiasNoCalendario(hoje, -59), ate: somarDiasNoCalendario(hoje, -30) })
    // F (40 dias atrás) fica fora do período e dentro do anterior
    expect(d.resumo.pedidos).toBe(4)
    expect(d.anterior.resumo).toMatchObject({ pedidos: 1, cobradoCents: 33_000, liquidoCents: 29_700 })
    expect(d.anterior.porDia.map((p: any) => p.dia)).toEqual([somarDiasNoCalendario(hoje, -40)])
  })

  it('"Tudo" não tem anterior (não há base pra comparar) e cobre a vida inteira', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/relatorios?periodo=tudo')
    expect(d.anterior).toBeNull()
    expect(d.filtro).toMatchObject({ periodo: 'tudo', de: null, ate: null, primeiroDia: somarDiasNoCalendario(hoje, -40) })
    expect(d.resumo.pedidos).toBe(5)
  })

  it('data digitada ganha do atalho; atalho desconhecido é recusado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json(`/api/admin/relatorios?periodo=7d&de=${somarDiasNoCalendario(hoje, -2)}`)
    expect(d.filtro).toMatchObject({ periodo: null, de: somarDiasNoCalendario(hoje, -2), ate: null })
    expect((await abrir('/api/admin/relatorios?periodo=semana-que-vem')).status).toBe(400)
  })
})

describe('as contas que fecham (REL-02) e a cortesia à parte (REL-06)', () => {
  it('cobrado = ingressos − descontos + taxa; líquido = cobrado − taxa da plataforma − devolvido em parte', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { resumo: r } = await json('/api/admin/relatorios?periodo=30d')
    // A 190 + B 110 + D 0 + E 80 (C é estorno total: fora)
    expect(r).toMatchObject({
      cobradoCents: 38_000, faceCents: 38_000, descontoCents: 3_000, taxaCents: 3_000,
      taxaPlataformaCents: 3_800, estornadoNoLiquidoCents: 4_000, liquidoCents: 30_200,
    })
    expect(r.faceCents - r.descontoCents + r.taxaCents).toBe(r.cobradoCents)
    expect(r.cobradoCents - r.taxaPlataformaCents - r.estornadoNoLiquidoCents).toBe(r.liquidoCents)
    // devolvido ao comprador em QUALQUER status: B (40) + C (55, o estorno total)
    expect(r.devolvidoTotalCents).toBe(9_500)
  })

  it('cortesia tem número próprio e sai do ticket médio de venda', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { resumo: r } = await json('/api/admin/relatorios?periodo=30d')
    expect(r).toMatchObject({
      pedidos: 4, ingressos: 9, pedidosCortesia: 1, ingressosCortesia: 3, pedidosVenda: 3, ingressosVenda: 6,
      pedidosPagantes: 3, ingressosPagantes: 6,
      ticketMedioVendaCents: Math.round(38_000 / 3),
      // desde a F3 (ADM-12) o relatório do evento divide por quem PAGOU; a Visão geral acompanha
      // (28/09) — antes ela contava a cortesia aqui e dava R$ 95,00 pro mesmo evento de R$ 126,67
      ticketMedioPorPedidoCents: Math.round(38_000 / 3),
      ticketMedioPorIngressoCents: Math.round(38_000 / 6),
    })
  })

  it('filtrada pelo evento, a Visão geral dá o MESMO ticket médio que o painel e o relatório dele', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const org = (await json(`/api/admin/relatorios?periodo=tudo&evento=${EV}`)).resumo
    const rel = (await json(`/api/admin/evento/${EV}/relatorios`)).resumo
    for (const k of ['ticketMedioPorPedidoCents', 'ticketMedioPorIngressoCents', 'pedidosPagantes']) {
      expect(org[k], `Visão geral × relatório do evento: ${k}`).toBe(rel[k])
    }
    // o painel na MESMA janela que a Visão geral resolveu (o "Tudo" dele corta em agora, e o
    // pedido E deste arquivo está pago hoje às 23h30 — no futuro de madrugada)
    const vg = await json(`/api/admin/relatorios?periodo=30d&evento=${EV}`)
    const painel = (await json(`/api/admin/evento/${EV}/dashboard?de=${vg.filtro.de}&ate=${vg.filtro.ate}`)).totais
    for (const k of ['ticketMedioPorPedidoCents', 'ticketMedioPorIngressoCents', 'pedidosPagantes']) {
      expect(vg.resumo[k], `Visão geral × painel do evento: ${k}`).toBe(painel[k])
    }
    expect(vg.resumo.pedidosPagantes, 'a janela ficou vazia: a comparação não provaria nada').toBeGreaterThan(0)
  })

  it('por tipo de ingresso: Inteira, Meia e "Sem tipo", sem a cortesia', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/relatorios?periodo=30d')
    expect(d.porTipo).toEqual([
      { tipo: 'Inteira', ingressos: 2, valorCents: 22_000 },
      { tipo: 'Meia', ingressos: 2, valorCents: 11_000 },
      { tipo: 'Sem tipo', ingressos: 2, valorCents: 8_000 },
    ])
  })

  it('canal traz os ingressos, e a soma dos canais continua fechando com o resumo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/relatorios?periodo=30d')
    const por = Object.fromEntries(d.porCanal.map((c: any) => [c.canal, [c.pedidos, c.ingressos, c.cobradoCents]]))
    expect(por).toEqual({ online: [2, 4, 30_000], bilheteria: [1, 2, 8_000], cortesia: [1, 3, 0] })
  })
})

describe('o e-mail dos maiores compradores (REL-05)', () => {
  it('inteiro pro master; mascarado pro financeiro, que não abre a base de clientes', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const doMaster = (await json('/api/admin/relatorios?periodo=30d', 'master')).topCompradores
    const doFinanceiro = (await json('/api/admin/relatorios?periodo=30d', 'financeiro')).topCompradores
    const ana = `ana.${ORG.slice(0, 6)}@teste.invalido`
    expect(doMaster.find((c: any) => c.nome === 'Ana').email).toBe(ana)
    expect(doFinanceiro.find((c: any) => c.nome === 'Ana').email).toBe('an***@teste.invalido')
    expect(JSON.stringify(doFinanceiro)).not.toContain(`.${ORG.slice(0, 6)}@`)
    // o resto da linha é igual: só o contato muda
    expect(doFinanceiro.map((c: any) => [c.nome, c.gastoCents])).toEqual(doMaster.map((c: any) => [c.nome, c.gastoCents]))
  })
})
