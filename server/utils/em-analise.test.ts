/**
 * B09 · cartão em análise de risco segurava estoque SEM PRAZO.
 *
 * O pedido em 'em_analise' não tem prazo (o gatilho da 011 só carimba prazo em
 * 'aguardando_pagamento') e `liberarExpirados` não o enxerga: a reprovação
 * cujo webhook se perdeu segurava o lugar pra sempre. A varredura pergunta ao
 * GATEWAY e só solta o que ele disser que não foi pago — nunca o que ele diz
 * pago ou aprovado.
 *
 * `decidirEmAnalise` é pura; `varrerEmAnalise` vai ao banco de teste, com a
 * consulta ao gateway trocada por um dublê (`usarConsultaDeCobranca`).
 * Fixture própria, apagada no fim.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1 } from './db'
import { decidirEmAnalise, usarConsultaDeCobranca, varrerEmAnalise } from './asaas'
import { esquecerCadastrosPendentes } from './cadastro'

describe('B09 · decidirEmAnalise (puro)', () => {
  it('pago ou aprovado NUNCA solta', () => {
    for (const status of ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']) {
      expect(decidirEmAnalise({ status }).soltar, status).toBe(false)
    }
  })
  it('ainda em análise, consulta vazia ou status desconhecido: mantém', () => {
    expect(decidirEmAnalise({ status: 'AWAITING_RISK_ANALYSIS' }).soltar).toBe(false)
    expect(decidirEmAnalise(null).soltar).toBe(false)
    expect(decidirEmAnalise({ status: 'ALGO_NOVO' }).soltar).toBe(false)
    expect(decidirEmAnalise({ status: 'CHARGEBACK_REQUESTED' }).soltar).toBe(false)
  })
  it('reprovada (voltou a esperar pagamento) solta como expirado', () => {
    expect(decidirEmAnalise({ status: 'PENDING' })).toMatchObject({ soltar: true, para: 'expirado' })
    expect(decidirEmAnalise({ status: 'OVERDUE' })).toMatchObject({ soltar: true, para: 'expirado' })
  })
  it('apagada ou devolvida solta como cancelado — mesmo com status PENDING no apagado', () => {
    expect(decidirEmAnalise({ status: 'PENDING', deleted: true })).toMatchObject({ soltar: true, para: 'cancelado' })
    expect(decidirEmAnalise({ status: 'REFUNDED' })).toMatchObject({ soltar: true, para: 'cancelado' })
  })
  it('pago e apagado ao mesmo tempo: vale o pago (não solta)', () => {
    expect(decidirEmAnalise({ status: 'CONFIRMED', deleted: true }).soltar).toBe(false)
  })
})

let orgId: string, lotId: string
const pedidos: Record<string, string> = {}

async function emAnalise(nome: string, horas: number) {
  const o = (await q1<any>(
    `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                         discount_cents, total_cents, payment_method, asaas_payment_id, created_at)
     SELECT $1, e.id, 'PED-ZZEA-' || upper(substr(md5(random()::text), 1, 4)), 'em_analise', 'online',
            5000, 500, 500, 0, 5500, 'credito', $2, now() - make_interval(hours => $3)
       FROM events e WHERE e.org_id = $1 RETURNING id`,
    [orgId, `pay_zz_ea_${nome}`, horas]))!
  await q(`INSERT INTO order_items (order_id, lot_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents)
           VALUES ($1,$2,1,5000,500,5500)`, [o.id, lotId])
  await q(`UPDATE lots SET reserved = reserved + 1 WHERE id = $1`, [lotId])
  pedidos[nome] = o.id
  return o.id as string
}
const reservado = async () => Number((await q1<any>(`SELECT reserved FROM lots WHERE id = $1`, [lotId]))!.reserved)
const status = async (id: string) => (await q1<any>(`SELECT status FROM orders WHERE id = $1`, [id]))!.status

beforeAll(async () => {
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug)
    VALUES ('ZZ Em Análise', 'zz-em-analise-' || gen_random_uuid()) RETURNING id`))!.id
  const ev = (await q1<any>(`INSERT INTO events (org_id, name, slug, status, starts_at, ends_at)
    VALUES ($1,'ZZ Em Análise','zz-em-analise-' || gen_random_uuid(),'ativo',
            now() + interval '10 days', now() + interval '11 days') RETURNING id`, [orgId]))!.id
  const setor = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1,'Pista') RETURNING id`, [ev]))!.id
  lotId = (await q1<any>(`INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order)
    VALUES ($1,'Lote',5000,100,10) RETURNING id`, [setor]))!.id
})

afterAll(async () => {
  usarConsultaDeCobranca(null)
  // o pago aplicado pela varredura deixa a linha `poll:` da entrega
  await q(`DELETE FROM payment_events WHERE gateway_event_id LIKE 'poll:pay_zz_ea_%'`)
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

describe('B09 · varrerEmAnalise pergunta ao gateway antes de soltar', () => {
  it('solta só o que o gateway diz que não foi pago; o resto fica, com a pergunta na trilha', async () => {
    // O dublê responde por cobrança; "falha" simula o gateway fora.
    const respostas: Record<string, any> = {
      pay_zz_ea_reprovado: { status: 'PENDING' },
      pay_zz_ea_pago: { status: 'CONFIRMED' },
      pay_zz_ea_analisando: { status: 'AWAITING_RISK_ANALYSIS' },
      pay_zz_ea_apagado: { status: 'PENDING', deleted: true },
    }
    const perguntados: string[] = []
    usarConsultaDeCobranca(async ({ paymentId }) => {
      perguntados.push(paymentId)
      if (paymentId === 'pay_zz_ea_falha') throw new Error('gateway fora do ar')
      return respostas[paymentId] ?? null
    })

    for (const n of ['reprovado', 'pago', 'analisando', 'apagado', 'falha']) await emAnalise(n, 3)
    await emAnalise('recente', 0)
    const antes = await reservado()

    const r = await varrerEmAnalise(50)
    const meus = r.filter((d) => Object.values(pedidos).includes(d.pedidoId))

    expect(perguntados.filter((p) => p.startsWith('pay_zz_ea_')).sort()).toEqual(
      ['pay_zz_ea_analisando', 'pay_zz_ea_apagado', 'pay_zz_ea_falha', 'pay_zz_ea_pago', 'pay_zz_ea_reprovado'])
    expect(meus.filter((d) => d.desfecho === 'solto').map((d) => d.pedidoId).sort())
      .toEqual([pedidos.reprovado, pedidos.apagado].sort())

    expect(await status(pedidos.reprovado)).toBe('expirado')
    expect(await status(pedidos.apagado)).toBe('cancelado')
    // PAGO no gateway e o webhook não baixou: era só um console.warn e o comprador seguia sem
    // ingresso. Agora a varredura aplica pelo caminho do webhook (P0-2, 05/10)
    expect(await status(pedidos.pago), 'pago no gateway e a varredura não aplicou').toBe('pago')
    expect(Number((await q1<any>(`SELECT count(*)::int AS n FROM tickets WHERE order_id = $1`, [pedidos.pago]))!.n))
      .toBe(1)
    expect(await status(pedidos.analisando)).toBe('em_analise')
    expect(await status(pedidos.falha)).toBe('em_analise')
    expect(await status(pedidos.recente)).toBe('em_analise')
    // os dois soltos devolvem o lugar, e o pago virou venda (a reserva dele também sai)
    expect(await reservado(), 'os dois soltos devolvem o lugar, e só eles (mais o pago, que vendeu)').toBe(antes - 3)

    const trilha = await q<any>(
      `SELECT entity_id, after FROM audit_log WHERE action = 'em_analise_consulta' AND entity_id = ANY($1::text[])`,
      [Object.values(pedidos)])
    expect(trilha).toHaveLength(5)
    expect(trilha.find((t) => t.entity_id === pedidos.falha)!.after.motivo).toMatch(/gateway fora do ar/)

    // na rodada seguinte, ninguém é perguntado de novo antes de uma hora
    perguntados.length = 0
    await varrerEmAnalise(50)
    expect(perguntados.filter((p) => p.startsWith('pay_zz_ea_'))).toEqual([])
  })
})

describe('LGPD · o formulário do pedido que morreu sem pagar não fica guardado', () => {
  it('apaga o cadastro pendente de pedido morto há mais de 3 dias; o recente e o vivo ficam', async () => {
    const ev = (await q1<any>(`SELECT id FROM events WHERE org_id = $1`, [orgId]))!.id
    const novo = async (situacao: string, diasAtras: number) => (await q1<any>(
      `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                           discount_cents, total_cents, canceled_at, expires_at, cadastro_pendente)
       VALUES ($1,$2,'PED-ZZCP-' || upper(substr(md5(random()::text),1,4)),$3,'online',100,0,0,0,100,
               CASE WHEN $3 IN ('expirado','falhou','cancelado') THEN now() - make_interval(days => $4) END,
               now() + interval '20 minutes',
               '{"documento":"52998224725","nome":"Zz"}'::jsonb) RETURNING id`,
      [orgId, ev, situacao, diasAtras]))!.id as string
    const velho = await novo('expirado', 4)
    const recente = await novo('expirado', 1)
    const falhouVelho = await novo('falhou', 5)
    const vivo = await novo('aguardando_pagamento', 0)

    await esquecerCadastrosPendentes(db())
    const pendente = async (id: string) =>
      (await q1<any>(`SELECT cadastro_pendente FROM orders WHERE id = $1`, [id]))!.cadastro_pendente
    expect(await pendente(velho)).toBeNull()
    expect(await pendente(falhouVelho)).toBeNull()
    expect(await pendente(recente), 'o PIX pago no vão ainda pode chegar: o cadastro dele precisa estar lá')
      .not.toBeNull()
    expect(await pendente(vivo)).not.toBeNull()
  })
})
