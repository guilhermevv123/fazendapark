/**
 * Correções do balcão antes da produção — um caso por defeito achado no QA.
 *
 *  1. venda de balcão com caixa FECHADO tinha ninguém que cancelasse (o guichê
 *     recusava o caixa fechado, a desistência recusava o canal bilheteria);
 *     venda online também não tinha caminho de tela → cancelamento
 *     administrativo por pedido (`cancelar.post.ts`, escopo
 *     'pedido_administrativo'), só pra quem tem a área `dinheiro`;
 *  2. CPF da meia e nome digitados no guichê eram jogados fora sem e-mail;
 *  3. dia lotado devolvia "Server Error";
 *  4. balcão vendia ingresso de dia que já passou;
 *  8. preço da meia no catálogo 1 centavo diferente do cobrado;
 *  9. sangria maior que a gaveta, e lançamento errado sem desfazer;
 * 10. "Vender" repetido pela rede virava duas vendas;
 * 12. esgotado com texto de log; portador aceitando documento "123" e sem
 *     auditoria;
 * 13. remarcar parava a venda do evento.
 *
 * Fixture própria (ids fixos `0000d0b7-…`, e-mail com o nome do arquivo),
 * apagada no fim. Sem servidor de teste no ar, PULA de verdade.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

const ID = (n: number) => `0000d0b7-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = ID(1)
const USUARIO = ID(2)
const OPERADOR = ID(3)
const EVENTO = ID(10)
const EVENTO_REMARCAR = ID(11)
const SETOR = ID(20)
const SETOR_LOTADO = ID(21)
const SETOR_ONTEM = ID(22)
const SETOR_REMARCAR = ID(23)
const SESSAO_LOTADA = ID(30)
const SESSAO_ONTEM = ID(31)
const LOTE = ID(40)          // R$ 25,01: face ímpar pra meia arredondar
const LOTE_LOTADO = ID(41)
const LOTE_ONTEM = ID(42)
const LOTE_ESCASSO = ID(43)
const LOTE_REMARCAR = ID(44)
const MEIA = ID(50)

const EMAIL = 'dono.correcoes.balcao@teste.invalido'
const EMAIL_OPERACAO = 'zzqa.operacao.correcoes.balcao@teste.invalido'
const FACE = 2501
const CPF = '52998224725'

let noAr = false
let cookie = ''
let cookieOperacao = ''

const PORQUE_PULOU = 'servidor de teste fora do ar ou respondendo 500'
function seForaDoArPula(ctx: { skip: (motivo?: string) => void }) {
  if (!noAr) ctx.skip(PORQUE_PULOU)
}

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../../utils/db')
  return q<any>(texto, par)
}

const chamar = (rota: string, init: RequestInit = {}, ck = cookie) =>
  fetch(`${BASE}${rota}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie: ck, origin: BASE, ...(init.headers ?? {}) },
  })

async function json(r: Response) {
  return { status: r.status, corpo: await r.json().catch(() => ({} as any)) }
}
const mensagem = (c: any) => String(c?.message ?? c?.statusMessage ?? '')

const pdv = (sufixo = '', init: RequestInit = {}, ev = EVENTO) =>
  chamar(`/api/admin/evento/${ev}/pdv${sufixo}`, init)

async function novoPonto(nome: string) {
  const r = await json(await pdv('', {
    method: 'POST', body: JSON.stringify({ nome, formas: ['dinheiro', 'debito', 'pix'] }),
  }))
  if (r.status !== 200) throw new Error(`ponto não criado: ${JSON.stringify(r.corpo)}`)
  return r.corpo.id as string
}

async function abrirCaixa(nome: string, fundoCents = 0) {
  const pontoId = await novoPonto(nome)
  const r = await json(await pdv('/turno', {
    method: 'POST', body: JSON.stringify({ pontoId, fundoCents }),
  }))
  if (r.status !== 200) throw new Error(`caixa não abriu: ${JSON.stringify(r.corpo)}`)
  return r.corpo.turnoId as string
}

const vender = async (corpo: any) =>
  json(await pdv('/venda', { method: 'POST', body: JSON.stringify(corpo) }))

const vendidos = async (lote: string) =>
  Number((await sql(`SELECT sold FROM lots WHERE id = $1`, [lote]))[0].sold)

async function entrar(email: string) {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha: 'diamond123' }),
  })
  return (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}

const TRAVA_DESTE_ARQUIVO = 902_3107
let travaDono: PoolClient | null = null

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).status < 500
  } catch { noAr = false }
  if (!noAr) return

  const { db } = await import('../../../../../utils/db')
  travaDono = await db().connect()
  const prazo = Date.now() + 25_000
  while (!(await travaDono.query(
    'SELECT pg_try_advisory_lock($1) AS ok', [TRAVA_DESTE_ARQUIVO])).rows[0].ok) {
    if (Date.now() > prazo) throw new Error('outra corrida deste arquivo ainda está de pé')
    await new Promise((r) => setTimeout(r, 100))
  }

  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,'zz-correcoes-balcao','zz-correcoes-balcao')`, [ORG])

  for (const [ev, slug] of [[EVENTO, 'zz-correcoes-balcao'], [EVENTO_REMARCAR, 'zz-correcoes-balcao-remarcar']]) {
    await sql(
      `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, status, fee_bps, fee_mode_pos)
       VALUES ($1,$2,$3,$3, now() + interval '20 days', now() + interval '21 days',
               'ativo', 1000, 'absorver')`, [ev, ORG, slug])
  }

  // um dia com lugar pra 1 pessoa (amanhã) e um dia que já terminou (ontem)
  await sql(`INSERT INTO event_sessions (id, event_id, starts_at, ends_at, capacity)
             VALUES ($1,$2, now() + interval '1 day', now() + interval '1 day 8 hours', 1)`,
  [SESSAO_LOTADA, EVENTO])
  await sql(`INSERT INTO event_sessions (id, event_id, starts_at, ends_at)
             VALUES ($1,$2, now() - interval '2 days', now() - interval '1 day')`,
  [SESSAO_ONTEM, EVENTO])

  for (const [setor, ev, sessao, nome] of [
    [SETOR, EVENTO, null, 'ZZ SETOR CORRECOES'],
    [SETOR_LOTADO, EVENTO, SESSAO_LOTADA, 'ZZ SETOR DIA LOTADO'],
    [SETOR_ONTEM, EVENTO, SESSAO_ONTEM, 'ZZ SETOR ONTEM'],
    [SETOR_REMARCAR, EVENTO_REMARCAR, null, 'ZZ SETOR REMARCAR'],
  ]) {
    await sql(`INSERT INTO sectors (id, event_id, session_id, name) VALUES ($1,$2,$3,$4)`,
      [setor, ev, sessao, nome])
  }
  for (const [lote, setor, qtd, nome] of [
    [LOTE, SETOR, 100, 'ZZ LOTE CORRECOES'],
    [LOTE_LOTADO, SETOR_LOTADO, 100, 'ZZ LOTE DIA LOTADO'],
    [LOTE_ONTEM, SETOR_ONTEM, 100, 'ZZ LOTE ONTEM'],
    [LOTE_ESCASSO, SETOR, 1, 'ZZ LOTE ESCASSO'],
    [LOTE_REMARCAR, SETOR_REMARCAR, 100, 'ZZ LOTE REMARCAR'],
  ] as const) {
    await sql(
      `INSERT INTO lots (id, sector_id, name, price_cents, quantity, channels, visible)
       VALUES ($1,$2,$3,$4,$5,'{online,bilheteria}',true)`, [lote, setor, nome, FACE, qtd])
  }
  await sql(
    `INSERT INTO ticket_types (id, lot_id, name, quantity, discount_bps, requires_document)
     VALUES ($1,$2,'Meia estudante',50,5000,true)`, [MEIA, LOTE])

  for (const [id, email, papel, role] of [
    [USUARIO, EMAIL, 'master', 'master'],
    [OPERADOR, EMAIL_OPERACAO, 'operacao', 'operacional'],
  ]) {
    await sql(
      `INSERT INTO users (id, org_id, name, email, password_hash, role, papel)
       SELECT $1, $2, 'ZZQA Correções Balcão', $3, password_hash, $5, $4
         FROM users WHERE email = 'dono@fazendapark.com.br' LIMIT 1`,
      [id, ORG, email, papel, role])
  }

  cookie = await entrar(EMAIL)
  cookieOperacao = await entrar(EMAIL_OPERACAO)
}, 40_000)

afterAll(async () => {
  if (!noAr) return
  try {
    await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
  } finally {
    if (travaDono) {
      try { await travaDono.query('SELECT pg_advisory_unlock($1)', [TRAVA_DESTE_ARQUIVO]) } catch { /* já morreu */ }
      travaDono.release()
      travaDono = null
    }
  }
})

describe('balcão: o que o guichê digita e o que ele cobra', () => {
  it('a sessão do teste existe (senão nada abaixo prova nada)', (ctx) => {
    seForaDoArPula(ctx)
    expect(cookie, 'login do dono falhou').toBeTruthy()
    expect(cookieOperacao, 'login da operação falhou').toBeTruthy()
  })

  it('CPF da meia e nome digitados sem e-mail chegam no ingresso', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa('ZZ GUICHE MEIA')
    const r = await vender({
      turnoId: turno, forma: 'dinheiro',
      itens: [{ lotId: LOTE, ticketTypeId: MEIA, quantidade: 2 }],
      comprador: { nome: 'Maria Estudante', documento: '529.982.247-25' },
    })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)

    const [item] = await sql(`SELECT half_document FROM order_items WHERE order_id = $1`, [r.corpo.pedidoId])
    expect(item.half_document, 'o CPF da meia não foi gravado na linha da venda').toBe(CPF)

    const ingressos = await sql(
      `SELECT holder_name, holder_document, half_document FROM tickets
        WHERE order_id = $1 ORDER BY holder_name NULLS LAST`, [r.corpo.pedidoId])
    expect(ingressos).toHaveLength(2)
    expect(ingressos.every((t: any) => t.half_document === CPF),
      'a portaria não vê o CPF da meia no ingresso').toBe(true)
    expect(ingressos[0].holder_name, 'o nome digitado no guichê se perdeu').toBe('Maria Estudante')
    expect(ingressos[0].holder_document).toBe(CPF)
    // mesma regra da emissão: só o 1º de cada linha leva o nome
    expect(ingressos[1].holder_name).toBeNull()
  })

  it('o preço da meia no catálogo é o mesmo que a venda cobra (centavo a centavo)', async (ctx) => {
    seForaDoArPula(ctx)
    const cat = (await json(await pdv('/catalogo'))).corpo
    const lote = cat.lotes.find((l: any) => l.id === LOTE)
    const meia = lote.tipos.find((t: any) => t.id === MEIA)

    const turno = await abrirCaixa('ZZ GUICHE PRECO')
    const r = await vender({
      turnoId: turno, forma: 'dinheiro', itens: [{ lotId: LOTE, ticketTypeId: MEIA, quantidade: 1 }],
      comprador: { documento: CPF },
    })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    // 2501 com 50%: o servidor cobra 2501 − arredonda(1250,5) = 1250; o
    // `Math.round(2501 × 0,5)` antigo da tela dava 1251.
    expect(meia.balcaoCents, 'a tela anuncia um valor e o recibo sai com outro').toBe(r.corpo.totalCents)
  })

  it('dia lotado responde 409 com a frase do banco, não "Server Error"', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa('ZZ GUICHE LOTADO')
    const antes = await vendidos(LOTE_LOTADO)
    const r = await vender({ turnoId: turno, forma: 'dinheiro', itens: [{ lotId: LOTE_LOTADO, quantidade: 2 }] })
    expect(r.status, JSON.stringify(r.corpo)).toBe(409)
    expect(mensagem(r.corpo)).not.toMatch(/Server Error/i)
    expect(mensagem(r.corpo)).toMatch(/não comporta|restam/i)
    expect(await vendidos(LOTE_LOTADO), 'a venda recusada mexeu no estoque').toBe(antes)
  })

  it('ingresso de dia que já passou sai do catálogo e a venda é recusada', async (ctx) => {
    seForaDoArPula(ctx)
    const cat = (await json(await pdv('/catalogo'))).corpo
    expect(cat.lotes.some((l: any) => l.id === LOTE_ONTEM), 'o catálogo ainda oferece o dia de ontem').toBe(false)
    const bloq = cat.bloqueados.find((b: any) => b.id === LOTE_ONTEM)
    expect(bloq?.motivo).toMatch(/já terminou/i)

    const turno = await abrirCaixa('ZZ GUICHE ONTEM')
    const antes = await vendidos(LOTE_ONTEM)
    const r = await vender({ turnoId: turno, forma: 'dinheiro', itens: [{ lotId: LOTE_ONTEM, quantidade: 1 }] })
    expect(r.status, JSON.stringify(r.corpo)).toBe(409)
    expect(r.corpo.data?.tipo).toBe('dia_passou')
    expect(await vendidos(LOTE_ONTEM)).toBe(antes)
  })

  it('esgotado fala com o operador, não com o log', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa('ZZ GUICHE ESCASSO')
    const r = await vender({ turnoId: turno, forma: 'dinheiro', itens: [{ lotId: LOTE_ESCASSO, quantidade: 2 }] })
    expect(r.status).toBe(409)
    expect(mensagem(r.corpo)).not.toMatch(/pedido \d+, disponível/)
    expect(mensagem(r.corpo)).toMatch(/Resta só 1/)
  })

  it('a mesma venda mandada duas vezes (rede) grava UMA venda só', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa('ZZ GUICHE REPETE', 0)
    const antes = await vendidos(LOTE)
    const chave = '0000d0b7-aaaa-4aaa-8aaa-000000000001'
    const corpo = { turnoId: turno, forma: 'dinheiro', recebidoCents: 5000, chave,
                    itens: [{ lotId: LOTE, quantidade: 1 }] }
    const um = await vender(corpo)
    const dois = await vender(corpo)
    expect(um.status, JSON.stringify(um.corpo)).toBe(200)
    expect(dois.status, JSON.stringify(dois.corpo)).toBe(200)
    expect(dois.corpo.pedidoId, 'a repetição virou outra venda').toBe(um.corpo.pedidoId)
    expect(dois.corpo.repetida).toBe(true)
    expect(dois.corpo.trocoCents).toBe(um.corpo.trocoCents)
    expect(await vendidos(LOTE), 'o estoque saiu duas vezes').toBe(antes + 1)
    const [{ n }] = await sql(`SELECT count(*)::int AS n FROM orders WHERE pos_shift_id = $1`, [turno])
    expect(n, 'duas vendas na gaveta com um só dinheiro').toBe(1)
  })
})

describe('gaveta: sangria com teto e lançamento que se anula', () => {
  it('sangria acima do que a gaveta tem é recusada com o saldo', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa('ZZ GUICHE SANGRIA', 10_000)
    const r = await json(await pdv('/gaveta', {
      method: 'POST', body: JSON.stringify({ turnoId: turno, tipo: 'sangria', valorCents: 50_000 }),
    }))
    expect(r.status, JSON.stringify(r.corpo)).toBe(409)
    expect(r.corpo.data?.saldoCents).toBe(10_000)
    const [{ n }] = await sql(`SELECT count(*)::int AS n FROM pos_cash_movements WHERE shift_id = $1`, [turno])
    expect(n, 'a sangria recusada ficou gravada').toBe(0)
  })

  it('anular devolve o esperado, guarda o original e não anula duas vezes', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa('ZZ GUICHE ANULA', 10_000)
    const lanc = await json(await pdv('/gaveta', {
      method: 'POST', body: JSON.stringify({ turnoId: turno, tipo: 'sangria', valorCents: 8_000, motivo: 'era 800' }),
    }))
    expect(lanc.status, JSON.stringify(lanc.corpo)).toBe(200)
    const conta = async () => (await json(await pdv(`/turno?turno=${turno}`))).corpo
    expect((await conta()).contagem.esperadoCents).toBe(2_000)

    const semMotivo = await json(await pdv('/gaveta', {
      method: 'POST', body: JSON.stringify({ turnoId: turno, anular: lanc.corpo.id, motivo: '' }),
    }))
    expect(semMotivo.status).toBe(400)

    const anula = await json(await pdv('/gaveta', {
      method: 'POST', body: JSON.stringify({ turnoId: turno, anular: lanc.corpo.id, motivo: 'digitei errado' }),
    }))
    expect(anula.status, JSON.stringify(anula.corpo)).toBe(200)
    const depois = await conta()
    expect(depois.contagem.esperadoCents, 'a anulação não devolveu o esperado').toBe(10_000)
    expect(depois.movimentos, 'o lançamento original sumiu — anular não é apagar').toHaveLength(2)
    const original = depois.movimentos.find((m: any) => m.id === lanc.corpo.id)
    expect(original.anuladoPor).toBe(anula.corpo.id)

    const deNovo = await json(await pdv('/gaveta', {
      method: 'POST', body: JSON.stringify({ turnoId: turno, anular: lanc.corpo.id, motivo: 'de novo' }),
    }))
    expect(deNovo.status, 'anulou duas vezes: o valor voltou em dobro').toBe(409)
  })
})

describe('cancelamento administrativo: nenhum pedido fica sem quem cancele', () => {
  const cancelarAdmin = (pedidoId: string, motivo = 'cliente pediu o dinheiro de volta', ck = cookie) =>
    chamar(`/api/admin/evento/${EVENTO}/cancelar`, {
      method: 'POST', body: JSON.stringify({ escopo: 'pedido_administrativo', pedidoId, motivo }),
    }, ck).then(json)

  it('venda de balcão com caixa fechado: o financeiro cancela, e o caixa fechado não muda', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa('ZZ GUICHE FECHADO', 0)
    const v = await vender({ turnoId: turno, forma: 'dinheiro', itens: [{ lotId: LOTE, quantidade: 2 }] })
    expect(v.status, JSON.stringify(v.corpo)).toBe(200)

    // caixa aberto: aqui não, é o guichê que tira da gaveta
    const cedo = await cancelarAdmin(v.corpo.pedidoId)
    expect(cedo.status).toBe(409)
    expect(mensagem(cedo.corpo)).toMatch(/ainda está aberto/i)

    const fechou = await json(await pdv('/turno', {
      method: 'PATCH', body: JSON.stringify({ turnoId: turno, contadoCents: 2 * FACE }),
    }))
    expect(fechou.status, JSON.stringify(fechou.corpo)).toBe(200)
    const antesDoCancelamento = (await json(await pdv(`/turno?turno=${turno}`))).corpo

    // o guichê continua recusando — e agora diz quem cancela
    const guiche = await json(await pdv('/cancelamento', {
      method: 'POST', body: JSON.stringify({ pedidoId: v.corpo.pedidoId, motivo: 'tentativa' }),
    }))
    expect(guiche.status).toBe(409)
    expect(mensagem(guiche.corpo)).toMatch(/já foi fechado/i)

    // a ficha diz antes do clique
    const ficha = (await json(await chamar(`/api/admin/pedido/${v.corpo.pedidoId}`))).corpo
    expect(ficha.acoes.cancelar, ficha.acoes.impedimento).toBe(true)
    expect(ficha.acoes.arrependimento, 'balcão não é compra a distância').toBe(false)

    // operação não tem a área do dinheiro
    const semArea = await cancelarAdmin(v.corpo.pedidoId, 'operador tentando', cookieOperacao)
    expect(semArea.status).toBe(403)

    const semMotivo = await cancelarAdmin(v.corpo.pedidoId, '')
    expect(semMotivo.status).toBe(400)

    const antes = await vendidos(LOTE)
    const r = await cancelarAdmin(v.corpo.pedidoId)
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(r.corpo.estorno).toBe('na_mao')
    expect(r.corpo.aviso).toMatch(/devolva/i)

    const [o] = await sql(`SELECT status, refunded_cents, total_cents FROM orders WHERE id = $1`, [v.corpo.pedidoId])
    expect(o.status).toBe('estornado')
    expect(Number(o.refunded_cents)).toBe(Number(o.total_cents))
    const [{ vivos }] = await sql(
      `SELECT count(*)::int AS vivos FROM tickets WHERE order_id = $1 AND status = 'valido'`, [v.corpo.pedidoId])
    expect(vivos, 'ingresso de venda cancelada continua passando na portaria').toBe(0)
    expect(await vendidos(LOTE), 'o lugar não voltou pra prateleira').toBe(antes - 2)

    // o caixa fechado é conferência assinada: a devolução foi por fora
    const depois = (await json(await pdv(`/turno?turno=${turno}`))).corpo
    expect(depois.contagem.dinheiroCents).toBe(antesDoCancelamento.contagem.dinheiroCents)
    expect(depois.contagem.ingressos).toBe(antesDoCancelamento.contagem.ingressos)
    expect(depois.vendas.reduce((s: number, x: any) => s + x.naGavetaCents, 0))
      .toBe(depois.contagem.dinheiroCents)

    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity = 'order' AND entity_id = $1
          AND action = 'pedido_cancelado_admin'`, [v.corpo.pedidoId])
    expect(n, 'cancelamento sem rastro').toBe(1)

    const outraVez = await cancelarAdmin(v.corpo.pedidoId)
    expect(outraVez.status).toBe(409)
    expect(mensagem(outraVez.corpo)).toMatch(/já foi cancelado/i)
  })

  it('venda online fora do art. 49 também cancela, com estorno pelo gateway', async (ctx) => {
    seForaDoArPula(ctx)
    const pedidoId = ID(900)
    await sql(
      `INSERT INTO orders (id, org_id, event_id, code, status, channel, face_cents, platform_cents,
                           total_cents, payment_method, asaas_payment_id, paid_at, created_at)
       VALUES ($1,$2,$3,'ZZQA-ONLINE-1','pago','online',$4,0,$4,'pix','sim_zzqa_correcoes',
               now() - interval '10 days', now() - interval '10 days')`,
      [pedidoId, ORG, EVENTO, FACE])
    await sql(
      `INSERT INTO tickets (org_id, event_id, order_id, sector_id, lot_id, code, qr_secret, status)
       VALUES ($1,$2,$3,$4,$5,'ZZQA-ONL-0001','x','valido')`, [ORG, EVENTO, pedidoId, SETOR, LOTE])

    const desistencia = await json(await chamar(`/api/admin/evento/${EVENTO}/cancelar`, {
      method: 'POST', body: JSON.stringify({ escopo: 'pedido', pedidoId }),
    }))
    expect(desistencia.status, 'fora dos 7 dias o art. 49 continua recusando').toBe(409)

    const r = await cancelarAdmin(pedidoId, 'evento trocado a pedido do cliente')
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(r.corpo.estorno).toBe('simulado')
    const [o] = await sql(`SELECT status, refunded_cents FROM orders WHERE id = $1`, [pedidoId])
    expect(o.status).toBe('estornado')
    expect(Number(o.refunded_cents)).toBe(FACE)
  })
})

describe('participantes: portador conferido e auditado', () => {
  it('documento "123" é recusado; CPF válido grava e deixa rastro', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa('ZZ GUICHE PORTADOR')
    const v = await vender({ turnoId: turno, forma: 'dinheiro', itens: [{ lotId: LOTE, quantidade: 1 }] })
    const [t] = await sql(`SELECT id FROM tickets WHERE order_id = $1`, [v.corpo.pedidoId])
    const patch = (documento: string) => chamar(`/api/admin/evento/${EVENTO}/participantes`, {
      method: 'PATCH', body: JSON.stringify({ id: t.id, nome: 'Fulano Portador', documento }),
    }).then(json)

    const ruim = await patch('123')
    expect(ruim.status).toBe(400)
    expect(mensagem(ruim.corpo)).toMatch(/curto|CPF/i)
    const cpfErrado = await patch('529.982.247-24')
    expect(cpfErrado.status).toBe(400)

    const bom = await patch('529.982.247-25')
    expect(bom.status, JSON.stringify(bom.corpo)).toBe(200)
    const [ing] = await sql(`SELECT holder_name, holder_document FROM tickets WHERE id = $1`, [t.id])
    expect(ing.holder_document).toBe(CPF)
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity = 'ingresso' AND entity_id = $1
          AND action = 'portador_alterado'`, [t.id])
    expect(n, 'troca de portador sem auditoria').toBe(1)
  })
})

describe('remarcar não fecha a bilheteria', () => {
  it('evento remarcado para data nova continua ativo e vendendo', async (ctx) => {
    seForaDoArPula(ctx)
    const inicio = new Date(Date.now() + 40 * 86_400_000)
    const fim = new Date(inicio.getTime() + 8 * 3_600_000)
    const r = await json(await chamar(`/api/admin/evento/${EVENTO_REMARCAR}/remarcar`, {
      method: 'POST',
      body: JSON.stringify({ escopo: 'evento', comecaEm: inicio.toISOString(),
                             terminaEm: fim.toISOString(), motivo: 'chuva forte' }),
    }))
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    const [ev] = await sql(`SELECT status, postponed_from FROM events WHERE id = $1`, [EVENTO_REMARCAR])
    expect(ev.status, 'remarcar parou a venda do evento').toBe('ativo')
    expect(ev.postponed_from, 'o adiamento não ficou registrado').not.toBeNull()
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM event_cancellations WHERE event_id = $1 AND kind = 'adiado'`,
      [EVENTO_REMARCAR])
    expect(n).toBe(1)

    // a porta de venda do balcão segue aberta
    const turno = await abrirCaixaNoEvento(EVENTO_REMARCAR, 'ZZ GUICHE REMARCADO')
    const v = await json(await pdv('/venda', {
      method: 'POST',
      body: JSON.stringify({ turnoId: turno, forma: 'dinheiro', itens: [{ lotId: LOTE_REMARCAR, quantidade: 1 }] }),
    }, EVENTO_REMARCAR))
    expect(v.status, JSON.stringify(v.corpo)).toBe(200)
  })
})

async function abrirCaixaNoEvento(ev: string, nome: string) {
  const p = await json(await pdv('', {
    method: 'POST', body: JSON.stringify({ nome, formas: ['dinheiro'] }),
  }, ev))
  const t = await json(await pdv('/turno', {
    method: 'POST', body: JSON.stringify({ pontoId: p.corpo.id, fundoCents: 0 }),
  }, ev))
  return t.corpo.turnoId as string
}
