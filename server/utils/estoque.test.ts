/**
 * estoque.test.ts — testes de integração contra Postgres de verdade.
 *
 * Mock não serve aqui. O que está sendo testado É o banco: lock de linha,
 * condição de corrida e o CHECK como rede. Um fake de pg passaria verde e
 * mentiria exatamente no ponto que custa dinheiro.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db, q, q1, tx } from './db'
import {
  confirmar, disponivel, EstoqueInsuficiente, liberar,
  liberarExpirados, LoteIndisponivel, reservar,
} from './estoque'

let orgId: string, eventId: string, sectorId: string

beforeAll(async () => {
  orgId = (await q1<any>(
    `INSERT INTO organizations (name, slug) VALUES ('Teste', 'teste-' || gen_random_uuid())
     RETURNING id`))!.id
  eventId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at)
     VALUES ($1, 'Evento Teste', 'ev-' || gen_random_uuid(), 'ativo',
             now() + interval '7 days', now() + interval '8 days')
     RETURNING id`, [orgId]))!.id
  sectorId = (await q1<any>(
    `INSERT INTO sectors (event_id, name) VALUES ($1, 'Pista') RETURNING id`,
    [eventId]))!.id
})

afterAll(async () => {
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

async function novoLote(over: Record<string, any> = {}): Promise<string> {
  const cfg = {
    quantity: 10, price_cents: 3000, min_per_order: 1, max_per_order: 10,
    channels: ['online'], visible: true, expires_at: null, starts_at: null, ...over,
  }
  const r = await q1<any>(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, min_per_order,
                       max_per_order, channels, visible, expires_at, starts_at)
     VALUES ($1, 'Lote ' || gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [sectorId, cfg.price_cents, cfg.quantity, cfg.min_per_order, cfg.max_per_order,
     cfg.channels, cfg.visible, cfg.expires_at, cfg.starts_at],
  )
  return r!.id
}

const saldo = (id: string) =>
  q1<any>(`SELECT quantity, sold, reserved FROM lots WHERE id = $1`, [id])

describe('reserva simples', () => {
  it('reserva o que cabe', async () => {
    const lot = await novoLote({ quantity: 10 })
    await tx((c) => reservar(c, [{ lotId: lot, quantidade: 3 }]))
    const s = await saldo(lot)
    expect(s).toMatchObject({ sold: 0, reserved: 3 })
    expect(disponivel(s)).toBe(7)
  })

  it('recusa acima do disponível e não deixa rastro', async () => {
    const lot = await novoLote({ quantity: 5 })
    await expect(tx((c) => reservar(c, [{ lotId: lot, quantidade: 6 }])))
      .rejects.toThrow(EstoqueInsuficiente)
    expect(await saldo(lot)).toMatchObject({ sold: 0, reserved: 0 })
  })

  it('a transação é atômica entre lotes: se o 2º falha, o 1º volta', async () => {
    const bom = await novoLote({ quantity: 10 })
    const ruim = await novoLote({ quantity: 1 })
    await expect(tx((c) => reservar(c, [
      { lotId: bom, quantidade: 2 },
      { lotId: ruim, quantidade: 5 },
    ]))).rejects.toThrow(EstoqueInsuficiente)
    // o bom NÃO pode ter ficado com reserva órfã
    expect(await saldo(bom)).toMatchObject({ reserved: 0 })
    expect(await saldo(ruim)).toMatchObject({ reserved: 0 })
  })
})

describe('portas de venda', () => {
  it('recusa lote invisível', async () => {
    const lot = await novoLote({ visible: false })
    await expect(tx((c) => reservar(c, [{ lotId: lot, quantidade: 1 }])))
      .rejects.toThrow(LoteIndisponivel)
  })
  it('recusa lote vencido', async () => {
    const lot = await novoLote({ expires_at: new Date(Date.now() - 60_000) })
    await expect(tx((c) => reservar(c, [{ lotId: lot, quantidade: 1 }])))
      .rejects.toThrow(/encerrou/)
  })
  it('recusa lote que ainda não abriu', async () => {
    const lot = await novoLote({ starts_at: new Date(Date.now() + 86_400_000) })
    await expect(tx((c) => reservar(c, [{ lotId: lot, quantidade: 1 }])))
      .rejects.toThrow(/ainda não abriu/)
  })
  it('recusa canal errado', async () => {
    const lot = await novoLote({ channels: ['bilheteria'] })
    await expect(tx((c) => reservar(c, [{ lotId: lot, quantidade: 1 }], { canal: 'online' })))
      .rejects.toThrow(/canal/)
  })
  it('respeita mínimo e máximo por compra', async () => {
    const lot = await novoLote({ min_per_order: 2, max_per_order: 4 })
    await expect(tx((c) => reservar(c, [{ lotId: lot, quantidade: 1 }]))).rejects.toThrow(/Mínimo/)
    await expect(tx((c) => reservar(c, [{ lotId: lot, quantidade: 5 }]))).rejects.toThrow(/Máximo/)
    await tx((c) => reservar(c, [{ lotId: lot, quantidade: 3 }]))
    expect(await saldo(lot)).toMatchObject({ reserved: 3 })
  })
  it('recusa quando o evento não está ativo', async () => {
    const lot = await novoLote()
    await q(`UPDATE events SET status = 'encerrado' WHERE id = $1`, [eventId])
    await expect(tx((c) => reservar(c, [{ lotId: lot, quantidade: 1 }])))
      .rejects.toThrow(/vendas abertas/)
    await q(`UPDATE events SET status = 'ativo' WHERE id = $1`, [eventId])
  })
  it('recusa depois do encerramento das vendas', async () => {
    const lot = await novoLote()
    await q(`UPDATE events SET sales_end_at = now() - interval '1 minute' WHERE id = $1`, [eventId])
    await expect(tx((c) => reservar(c, [{ lotId: lot, quantidade: 1 }])))
      .rejects.toThrow(/encerraram/)
    await q(`UPDATE events SET sales_end_at = NULL WHERE id = $1`, [eventId])
  })
})

describe('CONCORRÊNCIA — o teste que justifica o arquivo', () => {
  it('30 compras simultâneas em 10 ingressos vendem exatamente 10', async () => {
    const lot = await novoLote({ quantity: 10 })

    const tentativas = Array.from({ length: 30 }, () =>
      tx((c) => reservar(c, [{ lotId: lot, quantidade: 1 }]))
        .then(() => 'ok' as const)
        .catch((e) => (e instanceof EstoqueInsuficiente ? 'cheio' : `erro:${e.message}`)))

    const r = await Promise.all(tentativas)
    const ok = r.filter((x) => x === 'ok').length
    const cheio = r.filter((x) => x === 'cheio').length
    const outros = r.filter((x) => x !== 'ok' && x !== 'cheio')

    expect(outros).toEqual([])          // ninguém pode morrer por erro estranho
    expect(ok).toBe(10)                 // vendeu exatamente o que tinha
    expect(cheio).toBe(20)              // e recusou o resto com erro limpo
    expect(await saldo(lot)).toMatchObject({ quantity: 10, reserved: 10, sold: 0 })
  })

  it('pedidos de 3 em 10 ingressos: vende 9 e sobra 1', async () => {
    const lot = await novoLote({ quantity: 10 })
    const r = await Promise.all(Array.from({ length: 12 }, () =>
      tx((c) => reservar(c, [{ lotId: lot, quantidade: 3 }]))
        .then(() => true).catch(() => false)))
    expect(r.filter(Boolean).length).toBe(3)
    const s = await saldo(lot)
    expect(s.reserved).toBe(9)
    expect(disponivel(s)).toBe(1)
  })

  it('o CHECK do banco é a última rede: nem forçando passa', async () => {
    const lot = await novoLote({ quantity: 2 })
    await expect(
      q(`UPDATE lots SET reserved = 5 WHERE id = $1`, [lot]),
    ).rejects.toThrow(/nao_vender_mais_que_tem/)
  })
})

describe('confirmar e liberar', () => {
  it('pagamento vira venda', async () => {
    const lot = await novoLote({ quantity: 10 })
    const itens = [{ lotId: lot, quantidade: 4 }]
    await tx((c) => reservar(c, itens))
    await tx((c) => confirmar(c, itens))
    expect(await saldo(lot)).toMatchObject({ sold: 4, reserved: 0 })
  })

  it('confirmar sem reserva em pé falha alto em vez de desencaixar', async () => {
    const lot = await novoLote({ quantity: 10 })
    await expect(tx((c) => confirmar(c, [{ lotId: lot, quantidade: 1 }])))
      .rejects.toThrow(/não estava mais em pé/)
    expect(await saldo(lot)).toMatchObject({ sold: 0, reserved: 0 })
  })

  it('liberar devolve pra prateleira', async () => {
    const lot = await novoLote({ quantity: 10 })
    const itens = [{ lotId: lot, quantidade: 4 }]
    await tx((c) => reservar(c, itens))
    await tx((c) => liberar(c, itens))
    expect(await saldo(lot)).toMatchObject({ sold: 0, reserved: 0 })
  })
})

describe('varredura de expirados', () => {
  it('carrinho abandonado devolve o ingresso', async () => {
    const lot = await novoLote({ quantity: 10 })
    const order = await q1<any>(
      `INSERT INTO orders (org_id, event_id, code, status, expires_at,
                           face_cents, fee_cents, platform_cents, discount_cents, total_cents)
       VALUES ($1, $2, 'T' || substr(gen_random_uuid()::text,1,8), 'aguardando_pagamento',
               now() - interval '1 minute', 3000, 300, 300, 0, 3300)
       RETURNING id`, [orgId, eventId])
    await q(`INSERT INTO order_items (order_id, lot_id, quantity,
                unit_face_cents, unit_fee_cents, unit_total_cents)
             VALUES ($1, $2, 3, 3000, 300, 3300)`, [order!.id, lot])
    await tx((c) => reservar(c, [{ lotId: lot, quantidade: 3 }]))
    expect(await saldo(lot)).toMatchObject({ reserved: 3 })

    const n = await tx((c) => liberarExpirados(c))
    expect(n).toBeGreaterThanOrEqual(1)
    expect(await saldo(lot)).toMatchObject({ reserved: 0, sold: 0 })
    expect((await q1<any>(`SELECT status FROM orders WHERE id = $1`, [order!.id]))!.status)
      .toBe('expirado')
  })

  it('não mexe em pedido que ainda está no prazo', async () => {
    const lot = await novoLote({ quantity: 10 })
    const order = await q1<any>(
      `INSERT INTO orders (org_id, event_id, code, status, expires_at,
                           face_cents, fee_cents, platform_cents, discount_cents, total_cents)
       VALUES ($1, $2, 'T' || substr(gen_random_uuid()::text,1,8), 'aguardando_pagamento',
               now() + interval '15 minutes', 3000, 300, 300, 0, 3300)
       RETURNING id`, [orgId, eventId])
    await q(`INSERT INTO order_items (order_id, lot_id, quantity,
                unit_face_cents, unit_fee_cents, unit_total_cents)
             VALUES ($1, $2, 2, 3000, 300, 3300)`, [order!.id, lot])
    await tx((c) => reservar(c, [{ lotId: lot, quantidade: 2 }]))
    await tx((c) => liberarExpirados(c))
    expect(await saldo(lot)).toMatchObject({ reserved: 2 })
    expect((await q1<any>(`SELECT status FROM orders WHERE id = $1`, [order!.id]))!.status)
      .toBe('aguardando_pagamento')
  })
})
