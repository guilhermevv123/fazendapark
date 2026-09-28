/**
 * O painel redesenhado conta com as MESMAS réguas das outras telas (27/09).
 *
 * O redesenho acrescentou blocos ao painel: a série de dias contínua (ADM-20), hoje por hora,
 * tipo de ingresso e cota de meia, os próximos dias, a portaria de hoje (ADM-19), as duas metades
 * do líquido e a comparação com o período anterior. Cada um promete "o mesmo número de outra
 * tela" — e é isso que este arquivo cobra, rota contra rota:
 *
 *   - a série soma o total do topo, e dia sem venda é zero (não some);
 *   - por tipo soma os ingressos vendidos do topo; a cota de meia é a conta da trava da venda;
 *   - a ocupação do dia é a da tela de Sessões; o público é o retrato do leitor da portaria;
 *   - na plataforma + direto = líquido, e em "todo o período" batem com o Financeiro e o Borderô;
 *   - a janela atual da comparação é a do topo; a anterior é a do mesmo painel aberto naquele dia.
 *
 * O fuso do evento é a Bahia (UTC−3, sem horário de verão): "hoje" começa às 03:00Z. Os pedidos
 * de hoje são pagos 1 segundo depois da meia-noite, então nunca estão no futuro, qualquer que
 * seja a hora em que a suíte rode. Sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/evento/dashboard-redesenho', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const SETOR = id(4)
const LOTE = id(5)
const INTEIRA = id(6)
const MEIA = id(7)
const SESSAO = id(8)
const SETOR_DO_DIA = id(9)
const LOTE_DO_DIA = id(10)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.painel.${MARCA}@teste.invalido`

const FUSO = 'America/Bahia'
const HOJE = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date())
const dia = (n: number) => {
  const d = new Date(`${HOJE}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
/** meia-noite de um dia na Bahia, como instante */
const meiaNoite = (d: string) => new Date(`${d}T03:00:00.000Z`)
const mais = (base: Date, ms: number) => new Date(base.getTime() + ms)
const HORA = 3_600_000

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../utils/db')
  return q<any>(texto, par)
}

async function get(rota: string) {
  const r = await fetch(`${BASE}${rota}`, { headers: { cookie, origin: BASE } })
  const texto = await r.text()
  expect(r.status, `${rota}: ${texto.slice(0, 300)}`).toBe(200)
  return JSON.parse(texto)
}
const painel = (q = '') => get(`/api/admin/evento/${EVENTO}/dashboard${q}`)

/**
 * Um pedido com o item. `asaas` marca o dinheiro que passou pela plataforma (a régua de
 * `SQL_LIQUIDO_GATEWAY`); sem ele, o dinheiro é "recebido direto".
 */
async function pedido(p: {
  codigo: string; status?: string; canal?: string; forma?: string | null; total: number; plataforma?: number
  devolvido?: number; asaas?: string | null; pagoEm: Date | null; criadoEm?: Date
  lote?: string; tipo?: string | null; qtd: number; unitario: number
}) {
  const [o] = await sql(
    `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method,
                         face_cents, fee_cents, platform_cents, discount_cents, total_cents, refunded_cents,
                         asaas_payment_id, paid_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,0,$7,$9,$10,$11,$12) RETURNING id`,
    [ORG, EVENTO, `ZZP-${MARCA_MAIUSCULA}-${p.codigo}`, p.status ?? 'pago', p.canal ?? 'online', p.forma ?? null,
     p.total, p.plataforma ?? 0, p.devolvido ?? 0, p.asaas ?? null, p.pagoEm, p.criadoEm ?? p.pagoEm ?? new Date()])
  await sql(
    `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents)
     VALUES ($1,$2,$3,$4,$5,0,$5)`, [o.id, p.lote ?? LOTE, p.tipo ?? null, p.qtd, p.unitario])
  return o.id as string
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/evento/[id]/dashboard-redesenho.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZP PAINEL ${MARCA_MAIUSCULA}`, `zzp-painel-${MARCA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status, timezone)
     VALUES ($1,$2,$3,$4, now() + interval '5 days', now() + interval '6 days', 1000, 'ativo', $5)`,
    [EVENTO, ORG, `ZZP PAINEL ${MARCA_MAIUSCULA}`, `zzp-painel-ev-${MARCA}`, FUSO])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZP SETOR')`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity, half_quota_bps, channels, visible)
             VALUES ($1,$2,'ZZP LOTE',5000,100,4000,'{online,bilheteria}',true)`, [LOTE, SETOR])
  // meia com 36 vendidas num lote de 100 com cota de 40%: "perto da cota" (35 de 40)
  await sql(`INSERT INTO ticket_types (id, lot_id, name, quantity, sold, discount_bps, requires_document)
             VALUES ($1,$3,'ZZP Inteira',100,0,0,false), ($2,$3,'ZZP Meia',100,36,5000,true)`, [INTEIRA, MEIA, LOTE])
  // o dia com capacidade, e um setor preso a ele: a venda nesse setor ocupa o dia (sessao_ocupacao)
  await sql(`INSERT INTO event_sessions (id, event_id, title, starts_at, ends_at, capacity)
             VALUES ($1,$2,'ZZP Sábado', now() + interval '5 days', now() + interval '5 days 8 hours', 50)`, [SESSAO, EVENTO])
  await sql(`INSERT INTO sectors (id, event_id, session_id, name) VALUES ($1,$2,$3,'ZZP SETOR DO DIA')`,
    [SETOR_DO_DIA, EVENTO, SESSAO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity, channels, visible)
             VALUES ($1,$2,'ZZP LOTE DO DIA',4000,50,'{online,bilheteria}',true)`, [LOTE_DO_DIA, SETOR_DO_DIA])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZP Dono', $3, password_hash, 'master' FROM users WHERE email = 'dono@fazendapark.com.br'`,
    [USUARIO, ORG, EMAIL])

  const hoje0 = meiaNoite(HOJE)
  // hoje: site R$ 100 pela plataforma (2 inteiras) e site R$ 80 no dia do sábado (2 ingressos)
  const deHoje = await pedido({ codigo: 'HOJE', forma: 'pix', total: 10_000, plataforma: 1_000, asaas: `sim_zzp_${MARCA}_1`,
    pagoEm: mais(hoje0, 1_000), tipo: INTEIRA, qtd: 2, unitario: 5_000 })
  await pedido({ codigo: 'DIA', forma: 'pix', total: 8_000, plataforma: 800, asaas: `sim_zzp_${MARCA}_2`,
    pagoEm: mais(hoje0, 2_000), lote: LOTE_DO_DIA, qtd: 2, unitario: 4_000 })
  // ontem ao meio-dia: balcão em dinheiro, 2 meias — dinheiro que NÃO passou pela plataforma
  await pedido({ codigo: 'ONTEM', canal: 'bilheteria', forma: 'dinheiro', total: 6_000,
    pagoEm: mais(meiaNoite(dia(-1)), 12 * HORA), tipo: MEIA, qtd: 2, unitario: 3_000 })
  // três dias atrás: crédito R$ 200 (4 inteiras) e 3 cortesias
  await pedido({ codigo: 'TRES', forma: 'credito', total: 20_000, plataforma: 2_000, asaas: `sim_zzp_${MARCA}_3`,
    pagoEm: mais(meiaNoite(dia(-3)), 10 * HORA), tipo: INTEIRA, qtd: 4, unitario: 5_000 })
  await pedido({ codigo: 'CORTESIA', canal: 'cortesia', forma: 'cortesia', total: 0,
    pagoEm: mais(meiaNoite(dia(-3)), 11 * HORA), tipo: INTEIRA, qtd: 3, unitario: 0 })
  // dez dias atrás: R$ 80 com R$ 10 devolvidos (estorno parcial)
  await pedido({ codigo: 'DEZ', status: 'estornado_parcial', forma: 'pix', total: 8_000, plataforma: 800, devolvido: 1_000,
    asaas: `sim_zzp_${MARCA}_4`, pagoEm: mais(meiaNoite(dia(-10)), 15 * HORA), tipo: INTEIRA, qtd: 1, unitario: 8_000 })
  // o carrinho de hoje que expirou: entra no funil do site, não no dinheiro
  await pedido({ codigo: 'EXPIROU', status: 'expirado', forma: 'pix', total: 5_000, pagoEm: null,
    criadoEm: mais(hoje0, 3_000), tipo: INTEIRA, qtd: 1, unitario: 5_000 })

  // a portaria de hoje: 3 passagens (1 + 4 + 1 pessoas), dois portões, e três recusas
  const tickets: string[] = []
  for (let n = 1; n <= 3; n++) {
    const [t] = await sql(
      `INSERT INTO tickets (org_id, event_id, sector_id, lot_id, order_id, code, qr_secret, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'usado') RETURNING id`,
      [ORG, EVENTO, SETOR, LOTE, deHoje, `ZZP-${MARCA_MAIUSCULA}-T${n}`, `zzp-segredo-${MARCA}-${n}`])
    tickets.push(t.id)
  }
  const passagens: [string, number, string, Date][] = [
    [tickets[0], 1, 'Norte', mais(hoje0, 60_000)],
    [tickets[1], 4, 'Norte', mais(hoje0, 20 * 60_000)],
    [tickets[2], 1, '', mais(hoje0, 21 * 60_000)],
  ]
  for (const [n, [ticket, pessoas, portao, quando]] of passagens.entries()) {
    await sql(
      `INSERT INTO entries (id, org_id, event_id, ticket_id, people, gate, device_id, offline, entered_at)
       VALUES ($1,$2,$3,$4,$5,$6,'zzp-tablet',false,$7)`,
      [id(20 + n), ORG, EVENTO, ticket, pessoas, portao, quando])
  }
  for (const resultado of ['ja_usado', 'ja_usado', 'invalido', 'ok']) {
    await sql(`INSERT INTO checkins (event_id, code_lido, resultado, gate, created_at) VALUES ($1,'ZZP',$2,'Norte',$3)`,
      [EVENTO, resultado, mais(hoje0, 30 * 60_000)])
  }

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 240_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM entries WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM checkins WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM tickets WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('o painel redesenhado conta pelas réguas das outras telas', () => {
  it('entrou (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie).toBeTruthy()
  })

  it('a série é contínua: 11 dias, zero onde não vendeu, e soma o total do topo (ADM-20)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await painel(`?de=${dia(-10)}&ate=${HOJE}`)
    expect(d.periodo.nome).toBe('personalizado')
    expect(d.serie.map((s: any) => s.dia), 'dia sem venda sumiu da série').toEqual(
      Array.from({ length: 11 }, (_, i) => dia(i - 10)))
    const porDia = Object.fromEntries(d.serie.map((s: any) => [s.dia, s.cobradoCents]))
    expect(porDia[dia(-10)]).toBe(8_000)
    expect(porDia[dia(-5)], 'o dia sem venda não é zero').toBe(0)
    expect(porDia[dia(-3)]).toBe(20_000)
    expect(porDia[HOJE]).toBe(18_000)
    expect(d.serie.reduce((s: number, x: any) => s + x.cobradoCents, 0), 'a série não soma o total do topo')
      .toBe(d.totais.cobradoCents)
    // `ritmo` continua só com os dias que venderam (é o que o extrato e os testes de fuso comparam)
    expect(d.ritmo.map((r: any) => r.dia)).toEqual([dia(-10), dia(-3), dia(-1), HOJE])
  }, 120_000)

  it('por tipo soma os ingressos vendidos do topo; a cortesia fica fora; a cota é a da trava', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await painel()
    const tipos = Object.fromEntries(d.porTipo.map((t: any) => [t.especie, t.ingressos]))
    // 2 + 2 (lote do dia, sem tipo = inteira) + 4 + 1 inteiras; 2 meias; as 3 cortesias à parte
    expect(tipos).toEqual({ inteira: 9, meia: 2, gratuito: 0 })
    expect(tipos.inteira + tipos.meia + tipos.gratuito, 'por tipo não fecha com "ingressos vendidos"')
      .toBe(d.totais.pagos)
    expect(d.totais.cortesiasEmitidas).toBe(3)
    const cota = d.cotaDeMeia.find((c: any) => c.loteId === LOTE)
    expect(cota, 'o lote com meia sumiu da cota').toBeTruthy()
    expect({ cota: cota.cota, meias: cota.meias }).toEqual({ cota: 40, meias: 36 })
  }, 120_000)

  it('o dia do evento: a mesma ocupação da tela de Sessões', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const [d, sessoes] = await Promise.all([painel(), get(`/api/admin/evento/${EVENTO}/sessoes`)])
    const noPainel = d.proximosDias.find((s: any) => s.id === SESSAO)
    const naTela = sessoes.sessoes.find((s: any) => s.id === SESSAO)
    expect(noPainel.ocupadas, 'a fixture não ocupou o dia e a igualdade não prova nada').toBe(2)
    expect(noPainel.ocupadas).toBe(naTela.ocupadas)
    expect({ capacidade: noPainel.capacidade, vagas: noPainel.vagas, lotado: noPainel.lotado })
      .toEqual({ capacidade: naTela.capacidade, vagas: naTela.vagas, lotado: naTela.lotado })
  }, 120_000)

  it('a portaria é o retrato do leitor; hoje por portão a cada 15 min; os barrados de hoje (ADM-19)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await painel()
    const r = await fetch(`${BASE}/api/portaria/sincronizar`, {
      method: 'POST', headers: { cookie, origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: EVENTO, fila: [], comLista: false }),
    })
    expect(r.status).toBe(200)
    const leitor = (await r.json()).publico
    for (const campo of ['pessoas', 'entradas', 'ingressos', 'aptos', 'faltam', 'comparecimentoPct']) {
      expect(d.portaria[campo], `painel e leitor discordam em "${campo}"`).toBe(leitor[campo])
    }
    expect(d.portaria.pessoas).toBe(6)
    expect(d.portaria.hoje).toEqual({ pessoas: 6, passagens: 3 })
    expect(d.portaria.portoes).toEqual(['Norte', 'Sem portão'])
    expect(d.portaria.quartos.map((q: any) => [q.rotulo, q.pessoas])).toEqual([['00:00', 1], ['00:15', 5]])
    expect(d.portaria.quartos[1].porPortao).toEqual({ Norte: 4, 'Sem portão': 1 })
    expect(d.portaria.barradosHoje).toEqual([{ resultado: 'ja_usado', n: 2 }, { resultado: 'invalido', n: 1 }])
  }, 120_000)

  it('hoje por hora: 24 posições, hoje e ontem na hora do evento', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await painel()
    expect(d.porHoraHoje).toHaveLength(24)
    expect(d.porHoraHoje[0].hojeCents).toBe(18_000)
    expect(d.porHoraHoje[12].ontemCents, 'a venda do meio-dia de ontem caiu em outra hora').toBe(6_000)
    expect(d.porHoraHoje.reduce((s: number, h: any) => s + h.hojeCents, 0)).toBe(d.totais.hojeCents)
  }, 120_000)

  it('as duas metades do líquido fecham com ele e batem com Financeiro e Borderô', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const [d, fin, bor] = await Promise.all([
      painel(), get(`/api/admin/evento/${EVENTO}/financeiro`), get(`/api/admin/evento/${EVENTO}/bordero`)])
    expect(d.totais.liquidoNaPlataformaCents + d.totais.liquidoDiretoCents).toBe(d.totais.liquidoCents)
    // direto: só o balcão em dinheiro (R$ 60); o resto passou pela plataforma
    expect(d.totais.liquidoDiretoCents).toBe(6_000)
    expect(d.totais.liquidoNaPlataformaCents).toBe(fin.resumo.naPlataformaCents)
    expect(d.totais.liquidoDiretoCents).toBe(fin.resumo.recebidoDiretoCents)
    expect(d.totais.liquidoNaPlataformaCents).toBe(bor.totais.naPlataformaCents)
    expect(d.totais.liquidoDiretoCents).toBe(bor.totais.recebidoDiretoCents)
    expect(d.totais.liquidoCents).toBe(fin.resumo.liquidoCents)
  }, 120_000)

  it('a comparação: a janela atual é a do topo; a anterior é o painel daquele dia', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ontem = await painel('?periodo=ontem')
    expect(ontem.periodo).toMatchObject({ nome: 'ontem', diaDe: dia(-1), diaAte: dia(-1) })
    const c = ontem.comparacao
    expect(c, '"ontem" tem anterior (anteontem)').toBeTruthy()
    expect(c.ateAMesmaHora, 'ontem já acabou: compara o dia inteiro').toBe(false)
    expect({ cobrado: c.atual.cobradoCents, liquido: c.atual.liquidoCents, vendidos: c.atual.ingressosVendidos,
             ticket: c.atual.ticketMedioPorPedidoCents })
      .toEqual({ cobrado: ontem.totais.cobradoCents, liquido: ontem.totais.liquidoCents, vendidos: ontem.totais.pagos,
                 ticket: ontem.totais.ticketMedioPorPedidoCents })
    const anteontem = await painel(`?de=${dia(-2)}&ate=${dia(-2)}`)
    expect(c.anterior.cobradoCents).toBe(anteontem.totais.cobradoCents)
    expect(c.anterior.liquidoCents).toBe(anteontem.totais.liquidoCents)

    // 7 dias contra os 7 anteriores: o pedido de 10 dias atrás está no anterior
    const sete = await painel('?periodo=7d')
    expect(sete.comparacao.duracaoEmDias).toBe(7)
    expect(sete.comparacao.anterior.cobradoCents).toBe(8_000)
    expect(sete.comparacao.variacao.cobrado).toBe(Math.round(((sete.totais.cobradoCents - 8_000) / 8_000) * 100))
    // "todo o período" não tem anterior
    expect((await painel()).comparacao).toBeNull()
  }, 120_000)

  it('o funil do site conta o carrinho expirado; o balcão e a cortesia não entram', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await painel(`?de=${HOJE}&ate=${HOJE}`)
    expect({ criados: d.funil.criados, finalizados: d.funil.finalizados, abandonados: d.funil.abandonados })
      .toEqual({ criados: 3, finalizados: 2, abandonados: 1 })
  }, 120_000)
})
