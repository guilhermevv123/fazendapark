/**
 * PIX pago DEPOIS do prazo da reserva — o P0 de 22/09.
 *
 * O defeito, reproduzido antes do conserto: pedido expirado pela varredura,
 * webhook PAYMENT_RECEIVED com o externalReference dele → 200
 * `{"emitiu":false}`, pedido seguia 'expirado', a entrega era marcada como
 * processada ("não emitiu: pedido em expirado") e saía da fila. Dinheiro na
 * conta, ingresso nenhum, painel mudo.
 *
 * O que este arquivo tranca, sempre pela porta HTTP de verdade (webhook e
 * gateway simulado) e com a expiração rodando a MESMA `liberarExpirados` da
 * tarefa de fundo:
 *
 *  1. com lugar sobrando, o pagamento atrasado REFAZ a reserva e emite — pelo
 *     webhook e pelo `POST /api/dev/pagar`, sem vender a mais;
 *  2. sem lugar, NÃO dá baixa em silêncio: a entrega fica pendurada (visível
 *     no painel), a trilha do pedido ganha `pago_sem_lugar`, o lote não passa
 *     do total e a consulta do pedido diz `pagoSemIngresso` (a tela não manda
 *     a pessoa pagar de novo);
 *  3. a cobrança do pedido expirado é cancelada no gateway, uma vez só, e a
 *     falha do gateway fica escrita em vez de travar a expiração.
 *
 * Fixture própria (prefixo ZZQA), ids fixos, apagada no fim.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda,
} from '../../scripts/test-setup'

const BASE = BASE_DE_TESTE

const ORG = '0000f0a1-0000-4000-8000-000000000001'
const EVENTO = '0000f0a1-0000-4000-8000-000000000002'
const SETOR = '0000f0a1-0000-4000-8000-000000000003'
/** lote folgado: o lugar volta */
const LOTE_FOLGA = '0000f0a1-0000-4000-8000-000000000004'
/** lote de UM lugar: o lugar do atrasado vai pra outra pessoa */
const LOTE_UNICO = '0000f0a1-0000-4000-8000-000000000005'

const PED_WEBHOOK = '0000f0a1-0000-4000-8000-0000000000a1'
const PED_SIMULADO = '0000f0a1-0000-4000-8000-0000000000a2'
const PED_ATRASADO = '0000f0a1-0000-4000-8000-0000000000a3'
const PED_QUE_LEVOU = '0000f0a1-0000-4000-8000-0000000000a4'
const PED_CANCELAR = '0000f0a1-0000-4000-8000-0000000000a5'
const PED_CANCELAR_FALHA = '0000f0a1-0000-4000-8000-0000000000a6'
const PED_SIM_NAO_CANCELA = '0000f0a1-0000-4000-8000-0000000000a7'
const PED_SIMULADO_SEM_LUGAR = '0000f0a1-0000-4000-8000-0000000000a8'

const PREFIXO = 'evt_zzqa_atraso_'

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let segredoLigado = false

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../utils/db')
  return q<any>(texto, par)
}

const lote = async (id: string) =>
  (await sql(`SELECT quantity, sold, reserved FROM lots WHERE id = $1`, [id]))[0]
const pedido = async (id: string) =>
  (await sql(`SELECT status, canceled_at, paid_at FROM orders WHERE id = $1`, [id]))[0]
const ingressos = async (id: string) =>
  Number((await sql(`SELECT count(*)::int AS n FROM tickets WHERE order_id = $1`, [id]))[0].n)
const trilha = async (id: string, acao: string) =>
  await sql(`SELECT after FROM audit_log WHERE entity = 'order' AND entity_id = $1 AND action = $2`,
    [id, acao])

/** pedido pendente com a reserva em pé, como o checkout deixaria */
async function semearPendente(o: {
  id: string; codigo: string; lotId: string; quantidade: number; cobranca: string
}) {
  const face = 10_000 * o.quantidade
  await sql(
    `INSERT INTO orders (id, org_id, event_id, code, status, channel,
                         face_cents, fee_cents, platform_cents, discount_cents, total_cents,
                         asaas_payment_id, payment_method, expires_at)
     VALUES ($1,$2,$3,$4,'aguardando_pagamento','online',$5,0,0,0,$5,$6,'pix',
             now() + interval '10 minutes')`,
    [o.id, ORG, EVENTO, o.codigo, face, o.cobranca])
  await sql(
    `INSERT INTO order_items (order_id, lot_id, quantity, unit_face_cents, unit_fee_cents,
                              unit_total_cents)
     VALUES ($1,$2,$3,10000,0,10000)`, [o.id, o.lotId, o.quantidade])
  await sql(`UPDATE lots SET reserved = reserved + $2 WHERE id = $1`, [o.lotId, o.quantidade])
}

/** o prazo acaba e a varredura da tarefa de fundo passa — a função de verdade */
async function expirar(id: string) {
  await sql(`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id])
  const { tx } = await import('../utils/db')
  const { liberarExpirados } = await import('../utils/estoque')
  await tx((c) => liberarExpirados(c))
  // a tarefa do servidor pode ter chegado antes: o que importa é o estado
  expect((await pedido(id)).status, 'o pedido não expirou').toBe('expirado')
}

function corpoAsaas(idEvento: string, pedidoId: string, cobranca: string, reais: number) {
  return {
    id: idEvento,
    event: 'PAYMENT_RECEIVED',
    dateCreated: '2026-09-22 10:00:00',
    payment: {
      object: 'payment', id: cobranca, customer: 'cus_zzqa', value: reais, netValue: reais,
      billingType: 'PIX', status: 'RECEIVED', externalReference: pedidoId,
    },
  }
}

async function entregar(corpo: any, token?: string) {
  const r = await fetch(`${BASE}/api/webhooks/asaas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json',
               ...(token ? { 'asaas-access-token': token } : {}) },
    body: JSON.stringify(corpo),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any }
}

const pagarSimulado = (id: string) =>
  fetch(`${BASE}/api/dev/pagar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pedido: id }),
  })

async function limpar() {
  await sql(`DELETE FROM payment_events WHERE gateway_event_id LIKE $1`, [PREFIXO + '%'])
  // A auditoria é só-de-acrescentar (db/019 e 024): apagar exige declarar o
  // expurgo. Aqui é o banco de TESTE e os ids são fixos — sem apagar, a
  // corrida seguinte acharia a trilha da anterior.
  const { tx } = await import('../utils/db')
  await tx(async (c) => {
    await c.query(`SET LOCAL auditoria.expurgo = 'liberado'`)
    await c.query(`DELETE FROM audit_log WHERE entity = 'order' AND entity_id IN (
                     SELECT id::text FROM orders WHERE event_id = $1)`, [EVENTO])
  })
  await sql(`DELETE FROM tickets WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM events WHERE id = $1`, [EVENTO])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/pagamento-atrasado.test.ts', sonda)
  if (!sonda.noAr) return

  await limpar()
  // Organização SEM chave do Asaas: a varredura de cobranças do servidor
  // passa por estes pedidos sem falar com gateway nenhum.
  await sql(`INSERT INTO organizations (id, name, slug)
             VALUES ($1,'ZZQA PAGAMENTO ATRASADO','zzqa-pagamento-atrasado')`, [ORG])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, status, hold_minutes)
     VALUES ($1,$2,'ZZQA EVENTO ATRASO','zzqa-evento-atraso',
             now() + interval '10 days', now() + interval '11 days', 'ativo', 5)`, [EVENTO, ORG])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZQA Setor')`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity, max_per_order)
             VALUES ($1,$3,'ZZQA Folga',10000,20,10), ($2,$3,'ZZQA Unico',10000,1,1)`,
    [LOTE_FOLGA, LOTE_UNICO, SETOR])

  const ping = await entregar({ id: PREFIXO + 'ping', event: 'PAYMENT_ZZ_PING', payment: {} },
    'token-que-nao-e-o-certo')
  segredoLigado = ping.status === 401
}, 60_000)

afterAll(async () => {
  if (!sonda.noAr) return
  const { usarCancelador } = await import('../utils/asaas')
  usarCancelador(null)
  await limpar()
})

describe('PIX pago depois do prazo · ainda tem lugar', () => {
  it('webhook refaz a reserva e emite, sem vender a mais', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    if (segredoLigado) ctx.skip('servidor com ASAAS_WEBHOOK_TOKEN: o teste não sabe o valor')

    await semearPendente({ id: PED_WEBHOOK, codigo: 'ZZQA-ATR-1', lotId: LOTE_FOLGA,
                           quantidade: 2, cobranca: 'pay_zzqa_atraso_1' })
    const antes = await lote(LOTE_FOLGA)
    await expirar(PED_WEBHOOK)
    expect((await lote(LOTE_FOLGA)).reserved, 'a expiração não devolveu a reserva')
      .toBe(antes.reserved - 2)

    const r = await entregar(corpoAsaas(PREFIXO + '1', PED_WEBHOOK, 'pay_zzqa_atraso_1', 200))
    expect(r.status).toBe(200)
    expect(r.corpo.emitiu, `pagou e não emitiu: ${JSON.stringify(r.corpo)}`).toBe(true)

    const p = await pedido(PED_WEBHOOK)
    expect(p.status).toBe('pago')
    expect(p.canceled_at, 'pedido pago continuou com data de cancelamento').toBeNull()
    expect(await ingressos(PED_WEBHOOK)).toBe(2)
    const depois = await lote(LOTE_FOLGA)
    expect(depois.sold).toBe(antes.sold + 2)
    expect(depois.reserved, 'a reserva refeita ficou pendurada').toBe(antes.reserved - 2)

    const [ev] = await sql(`SELECT processed_at FROM payment_events WHERE gateway_event_id = $1`,
      [PREFIXO + '1'])
    expect(ev.processed_at, 'emitiu e não deu baixa na entrega').not.toBeNull()

    // a reentrega (CONFIRMED depois do RECEIVED) não emite de novo
    const de_novo = await entregar(corpoAsaas(PREFIXO + '1b', PED_WEBHOOK, 'pay_zzqa_atraso_1', 200))
    expect(de_novo.corpo.emitiu).toBe(false)
    expect(await ingressos(PED_WEBHOOK)).toBe(2)
  }, 30_000)

  it('gateway simulado (POST /api/dev/pagar) faz o mesmo e a tela vê os ingressos', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    await semearPendente({ id: PED_SIMULADO, codigo: 'ZZQA-ATR-2', lotId: LOTE_FOLGA,
                           quantidade: 1, cobranca: 'sim_zzqa_atraso_2' })
    await expirar(PED_SIMULADO)

    const r = await pagarSimulado(PED_SIMULADO)
    expect(r.status).toBe(200)
    expect((await r.json()).emitiu).toBe(true)

    const vista = await fetch(`${BASE}/api/pedido/ZZQA-ATR-2`).then((x) => x.json())
    expect(vista.status).toBe('pago')
    expect(vista.ingressos).toHaveLength(1)
    expect(vista.ingressos[0].qr).toMatch(/^DT1:/)
    expect(vista.pagoSemIngresso).toBe(false)
  }, 30_000)
})

describe('PIX pago depois do prazo · o lugar já foi de outra pessoa', () => {
  it('não dá baixa em silêncio, não vende a mais e a tela não pede pra pagar de novo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    if (segredoLigado) ctx.skip('servidor com ASAAS_WEBHOOK_TOKEN: o teste não sabe o valor')

    await semearPendente({ id: PED_ATRASADO, codigo: 'ZZQA-ATR-3', lotId: LOTE_UNICO,
                           quantidade: 1, cobranca: 'pay_zzqa_atraso_3' })
    await expirar(PED_ATRASADO)
    // o lugar que voltou é vendido pra outra pessoa, que paga dentro do prazo
    await semearPendente({ id: PED_QUE_LEVOU, codigo: 'ZZQA-ATR-4', lotId: LOTE_UNICO,
                           quantidade: 1, cobranca: 'sim_zzqa_atraso_4' })
    expect((await (await pagarSimulado(PED_QUE_LEVOU)).json()).emitiu).toBe(true)

    const r = await entregar(corpoAsaas(PREFIXO + '3', PED_ATRASADO, 'pay_zzqa_atraso_3', 100))
    expect(r.status).toBe(200)
    expect(r.corpo.emitiu).toBe(false)
    expect(r.corpo.pagoSemLugar).toBe(true)

    // 1. a entrega NÃO saiu da fila — é o que o painel lista como pendurada
    const [ev] = await sql(
      `SELECT id, processed_at, error, attempts FROM payment_events WHERE gateway_event_id = $1`,
      [PREFIXO + '3'])
    expect(ev.processed_at, 'deu baixa em pagamento sem ingresso (o P0)').toBeNull()
    expect(ev.error).toMatch(/sem lugar/)
    expect(ev.attempts).toBeGreaterThanOrEqual(1)

    // 2. a trilha do pedido diz que entrou dinheiro
    expect(await trilha(PED_ATRASADO, 'pago_sem_lugar')).toHaveLength(1)

    // 3. nada de venda a mais: o lote de 1 lugar segue com 1 vendido
    const l = await lote(LOTE_UNICO)
    expect(l.sold + l.reserved, 'vendeu lugar que não existe').toBeLessThanOrEqual(l.quantity)
    expect(await ingressos(PED_ATRASADO)).toBe(0)
    expect((await pedido(PED_ATRASADO)).status).toBe('expirado')

    // 4. a consulta que a tela de pagamento faz não diz só "expirou"
    const vista = await fetch(`${BASE}/api/pedido/${PED_ATRASADO}`).then((x) => x.json())
    expect(vista.status).toBe('expirado')
    expect(vista.pagoSemIngresso).toBe(true)
    // e a tela do pedido (SSR) não diz "ainda não foi pago" pra quem pagou
    const tela = await fetch(`${BASE}/ingressos/ZZQA-ATR-3`).then((x) => x.text())
    expect(tela).toContain('Recebemos o seu pagamento')
    expect(tela).not.toContain('Este pedido ainda não foi pago')

    // 5. o reprocessador tenta de novo sem duplicar a trilha nem dar baixa
    const { reprocessarEntregasPendentes } = await import('../utils/asaas')
    // (por id: não mexe nas entregas penduradas de outros arquivos)
    const feitos = await reprocessarEntregasPendentes({ id: ev.id })
    expect(feitos).toHaveLength(1)
    expect(feitos[0].ok).toBe(true)
    expect(feitos[0].resolvido, 'o reprocessador deu baixa sem ingresso').toBe(false)
    expect(await trilha(PED_ATRASADO, 'pago_sem_lugar')).toHaveLength(1)
  }, 40_000)

  it('pelo gateway simulado: responde sem emitir e deixa a marca', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    await semearPendente({ id: PED_SIMULADO_SEM_LUGAR, codigo: 'ZZQA-ATR-8', lotId: LOTE_FOLGA,
                           quantidade: 1, cobranca: 'sim_zzqa_atraso_8' })
    await expirar(PED_SIMULADO_SEM_LUGAR)
    // o lote folgado lota enquanto isso
    await sql(`UPDATE lots SET quantity = sold + reserved WHERE id = $1`, [LOTE_FOLGA])
    try {
      const r = await pagarSimulado(PED_SIMULADO_SEM_LUGAR).then((x) => x.json())
      expect(r.emitiu).toBe(false)
      expect(r.pagoSemLugar).toBe(true)
      expect(await trilha(PED_SIMULADO_SEM_LUGAR, 'pago_sem_lugar')).toHaveLength(1)
      const l = await lote(LOTE_FOLGA)
      expect(l.sold + l.reserved).toBeLessThanOrEqual(l.quantity)
    } finally {
      await sql(`UPDATE lots SET quantity = 20 WHERE id = $1`, [LOTE_FOLGA])
    }
  }, 30_000)
})

describe('a cobrança do pedido que expirou é cancelada no gateway', () => {
  /** A varredura do servidor roda no segundo 0 de cada minuto: foge dela. */
  async function longeDaVirada() {
    const s = new Date().getSeconds()
    if (s >= 54) await new Promise((r) => setTimeout(r, (61 - s) * 1000))
  }

  it('cancela uma vez, registra, e não cancela cobrança do simulador', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { cancelarCobrancasDeExpirados, usarCancelador } = await import('../utils/asaas')
    const chamadas: string[] = []
    usarCancelador(async (_cfg, id) => { chamadas.push(id); return { deleted: true } })

    await longeDaVirada()
    await semearPendente({ id: PED_CANCELAR, codigo: 'ZZQA-ATR-5', lotId: LOTE_FOLGA,
                           quantidade: 1, cobranca: 'pay_zzqa_atraso_5' })
    await semearPendente({ id: PED_SIM_NAO_CANCELA, codigo: 'ZZQA-ATR-7', lotId: LOTE_FOLGA,
                           quantidade: 1, cobranca: 'sim_zzqa_atraso_7' })
    await expirar(PED_CANCELAR)
    await expirar(PED_SIM_NAO_CANCELA)

    const r = await cancelarCobrancasDeExpirados()
    expect(chamadas).toContain('pay_zzqa_atraso_5')
    expect(chamadas, 'tentou cancelar cobrança do gateway simulado').not.toContain('sim_zzqa_atraso_7')
    expect(r.find((x) => x.pedidoId === PED_CANCELAR)?.ok).toBe(true)
    expect(await trilha(PED_CANCELAR, 'cobranca_cancelada')).toHaveLength(1)

    // segunda passada: nada a fazer com quem já foi cancelado
    chamadas.length = 0
    await cancelarCobrancasDeExpirados()
    expect(chamadas).not.toContain('pay_zzqa_atraso_5')
  }, 90_000)

  it('gateway recusando não trava nada e fica escrito na trilha', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { cancelarCobrancasDeExpirados, usarCancelador } = await import('../utils/asaas')
    usarCancelador(async () => { throw new Error('Asaas: cobrança já recebida') })

    await longeDaVirada()
    await semearPendente({ id: PED_CANCELAR_FALHA, codigo: 'ZZQA-ATR-6', lotId: LOTE_FOLGA,
                           quantidade: 1, cobranca: 'pay_zzqa_atraso_6' })
    await expirar(PED_CANCELAR_FALHA)

    const r = await cancelarCobrancasDeExpirados()
    const meu = r.find((x) => x.pedidoId === PED_CANCELAR_FALHA)
    expect(meu?.ok).toBe(false)
    expect(meu?.erro).toMatch(/já recebida/)
    const falhas = await trilha(PED_CANCELAR_FALHA, 'cobranca_cancelar_falhou')
    expect(falhas).toHaveLength(1)
    expect(falhas[0].after.erro).toMatch(/já recebida/)
    // a expiração ficou de pé: o estoque voltou mesmo com o gateway recusando
    expect((await pedido(PED_CANCELAR_FALHA)).status).toBe('expirado')

    // espera entre tentativas: a passada seguinte, logo em seguida, não bate de novo
    const r2 = await cancelarCobrancasDeExpirados()
    expect(r2.find((x) => x.pedidoId === PED_CANCELAR_FALHA)).toBeUndefined()
  }, 90_000)
})
