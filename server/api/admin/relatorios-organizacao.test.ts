/**
 * relatorios-organizacao.test.ts — o relatório da ORGANIZAÇÃO fecha com o dos eventos.
 *
 * `GET /api/admin/relatorios` soma todos os eventos. A pergunta que este arquivo
 * responde não é "a tela abre", é "o número dela é o MESMO que o produtor já lê
 * dentro de cada evento": uma segunda conta de "quanto vendeu" é o jeito de duas
 * telas discordarem sem nenhum erro. Por isso:
 *
 *   · o total da organização é a soma campo a campo dos relatórios dos eventos,
 *     e filtrado por UM evento é idêntico ao relatório dele;
 *   · o pedido com estorno PARCIAL entra (o defeito clássico é recortar por
 *     `status = 'pago'` e derrubar o pedido inteiro por causa de uma devolução);
 *   · venda sem cliente (balcão) conta no dinheiro e NÃO some por causa de um JOIN;
 *   · o filtro por evento de outra organização devolve zero, nunca os dados dela;
 *   · financeiro abre (é dinheiro), operação e portaria não.
 *
 * Os valores esperados estão escritos à mão, do lado da fixture: o teste não
 * repete a fórmula do servidor, ele a confere.
 *
 * Fixture própria (ids sorteados, e-mails deste arquivo), apagada no `afterAll`.
 * Sem servidor de dev no ar, PULA.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'
import { db, q, q1 } from '../../utils/db'
import { roleLegado, type Papel } from '../../utils/papeis'

const BASE = BASE_DE_TESTE

const ORG = randomUUID()
const OUTRA_ORG = randomUUID()
const EV1 = randomUUID()
const EV2 = randomUUID()
const EV_DE_FORA = randomUUID()

const EMAILS: Record<Papel, string> = {
  master: 'relatorios.org.master@teste.invalido',
  financeiro: 'relatorios.org.financeiro@teste.invalido',
  operacao: 'relatorios.org.operacao@teste.invalido',
  portaria: 'relatorios.org.portaria@teste.invalido',
}
const cookies: Partial<Record<Papel, string>> = {}

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }

async function entrarCom(email: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha: 'diamond123' }),
  })
  return (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}

const abrir = (rota: string, papel: Papel = 'master') =>
  fetch(`${BASE}${rota}`, { headers: { cookie: cookies[papel] ?? '', origin: BASE } })

async function json(rota: string, papel: Papel = 'master') {
  const r = await abrir(rota, papel)
  const corpo = await r.json().catch(() => ({}))
  if (r.status !== 200) {
    throw new Error(`${rota} respondeu ${r.status}: ${corpo.statusMessage ?? corpo.message ?? ''}`)
  }
  return corpo
}

let contador = 0
/** um pedido com os valores que o checkout gravaria (total = face + taxa − desconto) */
async function pedido(c: {
  evento: string; org?: string; cliente: string | null; status?: string
  canal?: string; forma: string | null
  face: number; taxa: number; plataforma: number; estornado?: number
  /** quantos dias atrás foi pago; `null` = nunca pago */
  pagoHa: number | null
  ingressos?: number; lote?: string
}) {
  const n = ++contador
  const total = c.face + c.taxa
  const ped = await q1<any>(
    `INSERT INTO orders (org_id, event_id, customer_id, code, status, channel,
                         face_cents, fee_cents, platform_cents, discount_cents, total_cents,
                         refunded_cents, asaas_payment_id, paid_at, payment_method)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12,
             CASE WHEN $13::int IS NULL THEN NULL ELSE now() - make_interval(days => $13::int) END, $14)
     RETURNING id`,
    [c.org ?? ORG, c.evento, c.cliente, `ZZREL-${n}-${Date.now()}`, c.status ?? 'pago',
     c.canal ?? 'online', c.face, c.taxa, c.plataforma, total, c.estornado ?? 0,
     c.canal === 'bilheteria' ? null : `pay_zzrel_${n}_${Date.now()}`, c.pagoHa, c.forma])
  if (c.ingressos && c.lote) {
    await q(`INSERT INTO order_items (order_id, lot_id, quantity, unit_face_cents,
                                      unit_fee_cents, unit_total_cents)
             VALUES ($1,$2,$3,$4,$5,$6)`,
      [ped!.id, c.lote, c.ingressos, Math.round(c.face / c.ingressos),
       Math.round(c.taxa / c.ingressos), Math.round(total / c.ingressos)])
  }
  return ped!.id as string
}

async function cliente(org: string, nome: string, extra: {
  anos?: number; cidade?: string; uf?: string; cadastrado?: boolean; novidades?: boolean
} = {}) {
  return (await q1<any>(
    `INSERT INTO customers (org_id, name, email, document, birth_date, city, state,
                            registered_at, marketing_opt_in)
     VALUES ($1,$2,$3,$4,
             CASE WHEN $5::int IS NULL THEN NULL
                  ELSE (current_date - make_interval(years => $5::int, days => 10))::date END,
             $6,$7, CASE WHEN $8 THEN now() ELSE NULL END, $9)
     RETURNING id`,
    [org, nome, `${nome.toLowerCase().replace(/\W/g, '')}.${ORG.slice(0, 6)}@teste.invalido`,
     String(Math.floor(Math.random() * 1e11)).padStart(11, '1'),
     extra.anos ?? null, extra.cidade ?? null, extra.uf ?? null,
     extra.cadastrado ?? false, extra.novidades ?? false]))!.id as string
}

let lote1 = '', lote2 = ''

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/relatorios-organizacao.test.ts', sonda)
  if (!sonda.noAr) return

  // Restos de uma rodada que caiu no meio (ver o mesmo cuidado em clientes.test.ts):
  // e-mail fixo em duas organizações faz o login recusar e tudo volta 401.
  const restos = `SELECT id FROM organizations WHERE slug LIKE 'zz-relorg-%' OR slug LIKE 'zz-outra-%'`
  await q(`DELETE FROM orders WHERE org_id IN (${restos})`)
  await q(`DELETE FROM organizations WHERE id IN (${restos})`)

  await q(`INSERT INTO organizations (id, name, slug) VALUES ($1,'ZZ Relatorios Org',$2), ($3,'ZZ Outra Org',$4)`,
    [ORG, `zz-relorg-${ORG.slice(0, 8)}`, OUTRA_ORG, `zz-outra-${OUTRA_ORG.slice(0, 8)}`])
  for (const [id, org, nome] of [[EV1, ORG, 'ZZ Edição 1'], [EV2, ORG, 'ZZ Edição 2'], [EV_DE_FORA, OUTRA_ORG, 'ZZ De Fora']]) {
    await q(`INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
             VALUES ($1,$2,$3,$4, now() - interval '30 days', now() - interval '29 days', 1000, 'ativo')`,
      [id, org, nome, `zz-relorg-${String(id).slice(0, 8)}`])
  }
  const lotes: string[] = []
  for (const ev of [EV1, EV2]) {
    const s = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1,'Pista') RETURNING id`, [ev]))!.id
    lotes.push((await q1<any>(
      `INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
       VALUES ($1,'Único',10000,1000,50,'{online}') RETURNING id`, [s]))!.id)
  }
  ;[lote1, lote2] = lotes

  for (const papel of Object.keys(EMAILS) as Papel[]) {
    await q(
      `INSERT INTO users (org_id, name, email, password_hash, papel, role)
       SELECT $1, $2, $3, password_hash, $4, $5 FROM users WHERE email = 'dono@fazendapark.com.br'`,
      [ORG, `Teste ${papel}`, EMAILS[papel], papel, roleLegado(papel)])
    cookies[papel] = await entrarCom(EMAILS[papel])
  }

  const ana = await cliente(ORG, 'Ana', { anos: 30, cidade: 'Salvador', uf: 'BA', cadastrado: true, novidades: true })
  const bia = await cliente(ORG, 'Bia', { anos: 20, cidade: 'Salvador', uf: 'BA', cadastrado: true })
  const caio = await cliente(ORG, 'Caio', { cidade: 'Feira de Santana', uf: 'BA' })
  const duda = await cliente(ORG, 'Duda')
  const fora = await cliente(OUTRA_ORG, 'Fora', { anos: 40, cidade: 'Recife', uf: 'PE', cadastrado: true })

  // ---- Edição 1 -------------------------------------------------------------
  await pedido({ evento: EV1, cliente: ana, forma: 'pix', face: 10_000, taxa: 1_000, plataforma: 1_000, pagoHa: 5, ingressos: 2, lote: lote1 })
  await pedido({ evento: EV1, cliente: ana, forma: 'credito', face: 20_000, taxa: 2_000, plataforma: 2_000, pagoHa: 1, ingressos: 3, lote: lote1 })
  // o ESTORNO PARCIAL: o defeito clássico derruba este pedido inteiro
  await pedido({ evento: EV1, cliente: bia, status: 'estornado_parcial', forma: 'pix', face: 10_000, taxa: 1_000, plataforma: 1_000, estornado: 3_000, pagoHa: 1, ingressos: 1, lote: lote1 })
  // expirou sem pagar: não é venda, nem os ingressos dele
  await pedido({ evento: EV1, cliente: caio, status: 'expirado', forma: 'pix', face: 10_000, taxa: 1_000, plataforma: 1_000, pagoHa: null, ingressos: 5, lote: lote1 })
  // balcão SEM cliente: conta no dinheiro, não em "clientes"
  await pedido({ evento: EV1, cliente: null, canal: 'bilheteria', forma: 'dinheiro', face: 5_000, taxa: 0, plataforma: 500, pagoHa: 1, ingressos: 1, lote: lote1 })
  // ---- Edição 2 -------------------------------------------------------------
  await pedido({ evento: EV2, cliente: bia, forma: 'pix', face: 30_000, taxa: 3_000, plataforma: 3_000, pagoHa: 40, ingressos: 4, lote: lote2 })
  await pedido({ evento: EV2, cliente: duda, canal: 'bilheteria', forma: 'debito', face: 8_000, taxa: 0, plataforma: 800, pagoHa: 2, ingressos: 2, lote: lote2 })
  // ---- de OUTRA organização: nunca pode aparecer -----------------------------
  await pedido({ evento: EV_DE_FORA, org: OUTRA_ORG, cliente: fora, forma: 'pix', face: 90_000, taxa: 9_000, plataforma: 9_000, pagoHa: 3 })
}, 90_000)

afterAll(async () => {
  if (sonda.noAr) {
    await q(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE org_id = ANY($1::uuid[]))`, [[ORG, OUTRA_ORG]])
    await q(`DELETE FROM orders WHERE org_id = ANY($1::uuid[])`, [[ORG, OUTRA_ORG]])
    await q(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OUTRA_ORG]])
  }
  await db().end()
})

/** o que a fixture vende, à mão: 6 pedidos vivos e o estorno parcial dentro */
const TOTAL = {
  pedidos: 6, ingressos: 13, cobradoCents: 90_000, faceCents: 83_000, taxaCents: 7_000,
  estornadoNoLiquidoCents: 3_000,
  // (11000−1000) + (22000−2000) + (11000−1000−3000) + (5000−500) + (33000−3000) + (8000−800)
  liquidoCents: 78_700,
}

describe('o total da organização é a soma dos eventos', () => {
  it('bate com os números escritos à mão — inclusive o estorno parcial e o balcão sem cliente', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/relatorios')
    expect(d.resumo).toMatchObject(TOTAL)
    expect(d.resumo.ticketMedioPorPedidoCents).toBe(15_000)
  })

  it('campo a campo: organização = evento 1 + evento 2 (a MESMA conta do relatório do evento)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const org = (await json('/api/admin/relatorios')).resumo
    const e1 = (await json(`/api/admin/evento/${EV1}/relatorios`)).resumo
    const e2 = (await json(`/api/admin/evento/${EV2}/relatorios`)).resumo
    for (const k of ['pedidos', 'ingressos', 'cobradoCents', 'faceCents', 'taxaCents',
                     'descontoCents', 'estornadoNoLiquidoCents', 'liquidoCents']) {
      expect(org[k], `campo ${k}`).toBe(e1[k] + e2[k])
    }
  })

  it('filtrado por UM evento, é idêntico ao relatório dele', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    for (const ev of [EV1, EV2]) {
      const org = (await json(`/api/admin/relatorios?evento=${ev}`)).resumo
      const dele = (await json(`/api/admin/evento/${ev}/relatorios`)).resumo
      for (const k of ['pedidos', 'ingressos', 'cobradoCents', 'faceCents', 'taxaCents',
                       'descontoCents', 'estornadoNoLiquidoCents', 'liquidoCents',
                       'ticketMedioPorPedidoCents', 'ticketMedioPorIngressoCents']) {
        expect(org[k], `evento ${ev.slice(0, 4)} campo ${k}`).toBe(dele[k])
      }
    }
  })

  it('as quebras fecham com o resumo: por evento, forma, canal e dia', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/relatorios')
    const soma = (l: any[], k: string) => l.reduce((s, x) => s + x[k], 0)
    for (const quebra of ['porEvento', 'porForma', 'porCanal', 'porDia']) {
      expect(soma(d[quebra], 'cobradoCents'), `${quebra}: cobrado`).toBe(d.resumo.cobradoCents)
      expect(soma(d[quebra], 'liquidoCents'), `${quebra}: líquido`).toBe(d.resumo.liquidoCents)
      expect(soma(d[quebra], 'pedidos'), `${quebra}: pedidos`).toBe(d.resumo.pedidos)
    }
    expect(soma(d.porEvento, 'ingressos')).toBe(d.resumo.ingressos)
  })

  it('cada quebra tem o valor escrito à mão', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/relatorios')
    const por = (l: any[], k: string) => Object.fromEntries(l.map((x) => [x[k], [x.pedidos, x.cobradoCents]]))
    expect(por(d.porForma, 'forma')).toEqual({
      pix: [3, 55_000], credito: [1, 22_000], dinheiro: [1, 5_000], debito: [1, 8_000],
    })
    expect(por(d.porCanal, 'canal')).toEqual({ online: [4, 77_000], bilheteria: [2, 13_000] })
    expect(por(d.porEvento, 'nome')).toEqual({ 'ZZ Edição 1': [4, 49_000], 'ZZ Edição 2': [2, 41_000] })
  })
})

describe('quem compra', () => {
  it('conta cada cliente UMA vez e diz quantas vendas ficaram sem cliente identificado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/relatorios')
    // Ana (2 pedidos), Bia (2) e Duda (1) = 3 pessoas. Caio só tem pedido expirado;
    // o balcão sem cliente não vira "cliente", mas segue no dinheiro (pedidos = 6).
    expect(d.resumo.clientes).toBe(3)
    expect(d.resumo.pedidosSemCliente).toBe(1)
    expect(d.clientes).toMatchObject({ total: 3, comCadastro: 2, aceitamNovidades: 1, semIdade: 1, semCidade: 1 })
  })

  it('de onde vêm e que idade têm (a faixa é a que o Postgres cortou)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/relatorios')
    expect(d.clientes.porCidade).toEqual([{ cidade: 'Salvador', estado: 'BA', clientes: 2 }])
    // sempre as seis faixas, na ordem, com zero onde não há ninguém
    expect(d.clientes.porFaixa.map((f: any) => f.chave))
      .toEqual(['ate17', '18a24', '25a34', '35a44', '45a59', '60mais'])
    expect(Object.fromEntries(d.clientes.porFaixa.map((f: any) => [f.chave, f.clientes])))
      .toEqual({ ate17: 0, '18a24': 1, '25a34': 1, '35a44': 0, '45a59': 0, '60mais': 0 })
  })

  it('o top de compradores usa o que a PESSOA pagou (cobrado − devolvido)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/relatorios')
    // Bia: 11000 − 3000 (estorno parcial) + 33000 = 41000; Ana: 11000 + 22000 = 33000
    expect(d.topCompradores.map((c: any) => [c.nome, c.gastoCents])).toEqual([
      ['Bia', 41_000], ['Ana', 33_000], ['Duda', 8_000],
    ])
  })
})

describe('o recorte', () => {
  const dia = async (deslocamento: number) =>
    (await q1<any>(`SELECT (current_date + $1::int)::text AS d`, [deslocamento]))!.d as string

  it('"de" corta o que foi pago antes (o dia do PAGAMENTO, não o da criação)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    // últimos 3 dias: pagos há 1 dia (3 pedidos) e há 2 dias (1) — fica de fora o de 5 e o de 40
    const d = await json(`/api/admin/relatorios?de=${await dia(-3)}`)
    expect(d.resumo).toMatchObject({ pedidos: 4, cobradoCents: 46_000 })
  })

  it('"ate" corta o que foi pago depois', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json(`/api/admin/relatorios?ate=${await dia(-10)}`)
    expect(d.resumo).toMatchObject({ pedidos: 1, cobradoCents: 33_000 })
  })

  it('período sem venda devolve zero com a forma completa, não erro', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json(`/api/admin/relatorios?de=${await dia(-20)}&ate=${await dia(-15)}`)
    expect(d.resumo).toMatchObject({ pedidos: 0, cobradoCents: 0, liquidoCents: 0, clientes: 0 })
    expect(d.clientes.porFaixa).toHaveLength(6)
    expect(d.porEvento).toEqual([])
  })

  it('recusa data que não existe, período invertido e evento que não é id', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    for (const q of ['de=2026-02-31', 'ate=2026-13-01', 'de=2026-05-02&ate=2026-05-01', 'evento=nao-e-uuid']) {
      expect((await abrir(`/api/admin/relatorios?${q}`)).status, q).toBe(400)
    }
  })

  it('evento de OUTRA organização devolve zero — nunca os dados dela', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json(`/api/admin/relatorios?evento=${EV_DE_FORA}`)
    expect(d.resumo.pedidos).toBe(0)
    expect(d.resumo.cobradoCents).toBe(0)
    // e sem filtro nenhum, o pedido de R$ 900 da outra organização não entra no total
    expect((await json('/api/admin/relatorios')).resumo.cobradoCents).toBe(TOTAL.cobradoCents)
  })
})

describe('quem abre', () => {
  it('master e financeiro abrem (é dinheiro); operação e portaria recebem 403', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect((await abrir('/api/admin/relatorios', 'master')).status).toBe(200)
    expect((await abrir('/api/admin/relatorios', 'financeiro')).status).toBe(200)
    expect((await abrir('/api/admin/relatorios', 'operacao')).status).toBe(403)
    expect((await abrir('/api/admin/relatorios', 'portaria')).status).toBe(403)
  })
})
