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
  liberarExpirados, LoteIndisponivel, prazoDeReserva, reclamarVencidosDoLote,
  reservar, RESERVA_MINUTOS_PADRAO, SQL_TRAVA_LOTE,
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

const statusDo = async (orderId: string) =>
  (await q1<any>(`SELECT status FROM orders WHERE id = $1`, [orderId]))!.status as string

/**
 * Um carrinho de verdade segurando estoque: pedido pendente + itens + reserva.
 *
 * `vencido` empurra o prazo pra trás DEPOIS de reservar, que é a única ordem
 * que funciona — reservar por um pedido já vencido dispararia a devolução sob
 * demanda e o fixture nasceria desfeito.
 */
async function carrinho(
  itens: Array<{ lot: string; qtd: number }>,
  opts: { vencido?: boolean } = {},
): Promise<string> {
  const pedido = await q1<any>(
    `INSERT INTO orders (org_id, event_id, code, status, expires_at,
                         face_cents, fee_cents, platform_cents, discount_cents, total_cents)
     VALUES ($1, $2, 'T' || substr(gen_random_uuid()::text,1,8), 'aguardando_pagamento',
             now() + interval '15 minutes', 3000, 300, 300, 0, 3300)
     RETURNING id`, [orgId, eventId])
  for (const i of itens) {
    await q(`INSERT INTO order_items (order_id, lot_id, quantity,
                  unit_face_cents, unit_fee_cents, unit_total_cents)
             VALUES ($1, $2, $3, 3000, 300, 3300)`, [pedido!.id, i.lot, i.qtd])
  }
  await tx((c) => reservar(c, itens.map((i) => ({ lotId: i.lot, quantidade: i.qtd }))))
  if (opts.vencido) {
    await q(`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [pedido!.id])
  }
  return pedido!.id
}

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

describe('janela da reserva', () => {
  it('a janela sai do evento, e hold_minutes torto não vira data inválida nem reserva eterna', () => {
    const t0 = new Date('2026-09-20T20:00:00.000Z')
    const minutos = (d: Date) => Math.round((d.getTime() - t0.getTime()) / 60_000)

    expect(minutos(prazoDeReserva(20, t0))).toBe(20)
    expect(minutos(prazoDeReserva(45, t0))).toBe(45)
    // coluna vazia/torta cai no padrão em vez de produzir Invalid Date — que
    // derrubaria o INSERT do pedido com o comprador na tela de pagamento
    expect(minutos(prazoDeReserva(null, t0))).toBe(RESERVA_MINUTOS_PADRAO)
    expect(minutos(prazoDeReserva('vinte' as any, t0))).toBe(RESERVA_MINUTOS_PADRAO)
    expect(prazoDeReserva(undefined, t0).getTime()).not.toBeNaN()
    // e os dois extremos: 1 minuto não dá tempo de pagar um pix, 40 dias
    // prende o lugar até depois do evento
    expect(minutos(prazoDeReserva(1, t0))).toBe(5)
    expect(minutos(prazoDeReserva(60_000, t0))).toBe(120)
  })

  it('pedido pendente não nasce sem prazo — quem esquecer a coluna recebe a janela do evento', async () => {
    // 7 é um número que não existe em lugar nenhum do código: se o prazo vier
    // de um 20 chumbado em vez da configuração do evento, o caso morre aqui.
    await q(`UPDATE events SET hold_minutes = 7 WHERE id = $1`, [eventId])
    try {
      const pedido = await q1<any>(
        `INSERT INTO orders (org_id, event_id, code, status,
                             face_cents, fee_cents, platform_cents, discount_cents, total_cents)
         VALUES ($1, $2, 'T' || substr(gen_random_uuid()::text,1,8), 'aguardando_pagamento',
                 3000, 300, 300, 0, 3300)
         RETURNING id, expires_at`, [orgId, eventId])

      expect(pedido!.expires_at,
        'pedido pendente sem prazo: a varredura não enxerga, o lugar fica preso pra sempre')
        .not.toBeNull()
      const emMinutos = (new Date(pedido!.expires_at).getTime() - Date.now()) / 60_000
      expect(emMinutos).toBeGreaterThan(6)
      expect(emMinutos).toBeLessThan(8)
    } finally {
      await q(`UPDATE events SET hold_minutes = 20 WHERE id = $1`, [eventId])
    }
  })
})

describe('o lugar preso volta pra prateleira', () => {
  it('último ingresso preso por carrinho abandonado volta na hora da próxima compra', async () => {
    const lot = await novoLote({ quantity: 1 })
    const abandonado = await carrinho([{ lot, qtd: 1 }], { vencido: true })
    expect(disponivel((await saldo(lot))!)).toBe(0)   // a página diz "esgotado"

    // repare no que NÃO roda aqui: a varredura de minuto em minuto. O lugar
    // tem que voltar por causa de quem chegou pra comprar.
    await tx((c) => reservar(c, [{ lotId: lot, quantidade: 1 }]))

    const s = await saldo(lot)
    expect(s.sold + s.reserved, 'o lote vendeu mais do que tem').toBe(1)
    expect(await statusDo(abandonado)).toBe('expirado')
  })

  it('carrinho ainda no prazo não é tomado de quem está pagando', async () => {
    const lot = await novoLote({ quantity: 1 })
    const meu = await carrinho([{ lot, qtd: 1 }])     // vence daqui a 15 min

    await expect(tx((c) => reservar(c, [{ lotId: lot, quantidade: 1 }])))
      .rejects.toThrow(EstoqueInsuficiente)

    expect(await statusDo(meu),
      'mataram um carrinho dentro do prazo: o comprador paga e não tem ingresso')
      .toBe('aguardando_pagamento')
    expect(await saldo(lot)).toMatchObject({ reserved: 1, sold: 0 })
  })

  it('pedido vencido devolve o pedido inteiro, não só o lote que alguém pediu', async () => {
    const pista = await novoLote({ quantity: 1 })
    const camarote = await novoLote({ quantity: 1 })
    await carrinho([{ lot: pista, qtd: 1 }, { lot: camarote, qtd: 1 }], { vencido: true })

    await tx((c) => reservar(c, [{ lotId: pista, quantidade: 1 }]))

    expect(disponivel((await saldo(camarote))!),
      'o outro lote do pedido morto continuou preso — some do estoque e ninguém procura').toBe(1)
  })

  it('pedido que pagou na virada do prazo não perde o lugar', async () => {
    const lot = await novoLote({ quantity: 1 })
    const pago = await carrinho([{ lot, qtd: 1 }], { vencido: true })
    await q(`UPDATE orders SET status = 'pago', paid_at = now() WHERE id = $1`, [pago])

    // nem a varredura...
    await tx((c) => liberarExpirados(c))
    // ...nem a devolução sob demanda podem mexer em pedido pago
    await expect(tx((c) => reservar(c, [{ lotId: lot, quantidade: 1 }])))
      .rejects.toThrow(EstoqueInsuficiente)

    expect(await statusDo(pago), 'expiraram um pedido que já tinha sido pago').toBe('pago')
    expect(await saldo(lot)).toMatchObject({ reserved: 1 })
  })

  it('o mesmo carrinho vencido não devolve o lugar duas vezes', async () => {
    const lot = await novoLote({ quantity: 2 })
    const vencido = await carrinho([{ lot, qtd: 1 }], { vencido: true })
    await carrinho([{ lot, qtd: 1 }])                // esse continua vivo
    expect(await saldo(lot)).toMatchObject({ reserved: 2 })

    // varredura e devolução sob demanda caindo no mesmo carrinho
    await tx((c) => liberarExpirados(c))
    await tx((c) => reclamarVencidosDoLote(c, lot))

    const s = await saldo(lot)
    expect(s.reserved,
      'devolveram o mesmo lugar duas vezes: o lote ganhou ingresso que não existe').toBe(1)
    expect(disponivel(s)).toBe(1)
    expect(await statusDo(vencido)).toBe('expirado')
  })
})

/**
 * Quando o que acaba é o TIPO (meia-entrada), não o lote.
 *
 * O erro carrega nome + saldo, e a rota vira isso em conselho pro comprador
 * ("mude a quantidade para N"). Mandar o número do lote quando quem esgotou
 * foi a meia dá um conselho que falha de novo na tentativa seguinte — e o
 * comprador conclui que o site está quebrado, com ingresso na prateleira.
 */
describe('o tipo de ingresso tem prateleira própria', () => {
  async function novoTipo(lot: string, quantidade: number, nome = 'Meia'): Promise<string> {
    const r = await q1<any>(
      `INSERT INTO ticket_types (lot_id, name, quantity) VALUES ($1, $2, $3) RETURNING id`,
      [lot, nome, quantidade])
    return r!.id
  }

  it('meia esgotada com lote sobrando: o recado é o da meia, não o do lote', async () => {
    const lot = await novoLote({ quantity: 10 })
    const tipo = await novoTipo(lot, 1)
    await tx((c) => reservar(c, [{ lotId: lot, ticketTypeId: tipo, quantidade: 1 }]))

    let erro: any = null
    await tx((c) => reservar(c, [{ lotId: lot, ticketTypeId: tipo, quantidade: 2 }]))
      .catch((e) => { erro = e })

    expect(erro).toBeInstanceOf(EstoqueInsuficiente)
    expect(erro.nome,
      'o erro nomeou o lote quando quem acabou foi o tipo').toBe('Meia')
    expect(erro.disponivel,
      'mandou o saldo do lote: a tela diz "mude para 9" com a meia esgotada').toBe(0)
    // e o lote de verdade continua com lugar — é isso que torna a mentira cara
    expect(disponivel((await saldo(lot))!)).toBe(9)
  })

  it('meia presa por carrinho abandonado volta na hora da próxima compra', async () => {
    const lot = await novoLote({ quantity: 10 })
    const tipo = await novoTipo(lot, 1, 'Meia presa')

    // carrinho vencido segurando a última meia (o lote tem sobra de sobra)
    const pedido = await q1<any>(
      `INSERT INTO orders (org_id, event_id, code, status, expires_at,
                           face_cents, fee_cents, platform_cents, discount_cents, total_cents)
       VALUES ($1, $2, 'T' || substr(gen_random_uuid()::text,1,8), 'aguardando_pagamento',
               now() + interval '15 minutes', 3000, 300, 300, 0, 3300)
       RETURNING id`, [orgId, eventId])
    await q(`INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity,
                  unit_face_cents, unit_fee_cents, unit_total_cents)
             VALUES ($1, $2, $3, 1, 3000, 300, 3300)`, [pedido!.id, lot, tipo])
    await tx((c) => reservar(c, [{ lotId: lot, ticketTypeId: tipo, quantidade: 1 }]))
    await q(`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [pedido!.id])

    // de novo: a varredura NÃO roda aqui. Quem devolve é quem chegou comprando.
    await tx((c) => reservar(c, [{ lotId: lot, ticketTypeId: tipo, quantidade: 1 }]))

    const t = await q1<any>(`SELECT quantity, sold FROM ticket_types WHERE id = $1`, [tipo])
    expect(t!.sold, 'a meia vendeu mais do que tem').toBe(1)
    expect(await statusDo(pedido!.id)).toBe('expirado')
  })

  it('tipo que não é deste lote não sai do estoque do vizinho', async () => {
    const meu = await novoLote({ quantity: 10 })
    const outro = await novoLote({ quantity: 10 })
    const tipoDoOutro = await novoTipo(outro, 5, 'Meia do vizinho')

    await expect(tx((c) => reservar(c, [{ lotId: meu, ticketTypeId: tipoDoOutro, quantidade: 1 }])))
      .rejects.toThrow(LoteIndisponivel)
    expect((await q1<any>(`SELECT sold FROM ticket_types WHERE id = $1`, [tipoDoOutro]))!.sold)
      .toBe(0)
    expect(await saldo(meu)).toMatchObject({ reserved: 0, sold: 0 })
  })
})

/**
 * Serialização de verdade — duas conexões, ordem forçada na mão.
 *
 * Por que não dá pra provar isto com `Promise.all` de reservas: elas não
 * chegam juntas no banco. A primeira já gravou quando a segunda lê, e o caso
 * fica VERDE com o `FOR UPDATE` arrancado — o teste de 30 compras simultâneas
 * lá em cima continua passando sem trava nenhuma, porque quem segura aquele
 * caso é o `WHERE sold+reserved+n <= quantity` do UPDATE, não o lock.
 *
 * O que só o lock faz é garantir que o SEGUNDO comprador decida em cima do
 * estoque que o primeiro já gravou. Os dois casos abaixo medem as duas caras
 * disso, e os dois ficam vermelhos sem o `FOR UPDATE`:
 *   - ele decide cedo demais e recusa venda com o lugar já livre;
 *   - ele decide cedo demais e o número que o comprador lê é mentira.
 */
describe('CONCORRÊNCIA — a trava vem antes da decisão', () => {
  it('quem chega segundo espera a trava — e leva o lugar que o primeiro devolveu', async () => {
    const lot = await novoLote({ quantity: 1 })
    const abandonado = await carrinho([{ lot, qtd: 1 }], { vencido: true })

    const c1 = await db().connect()
    const c2 = await db().connect()
    let desfecho = ''
    try {
      await c1.query('BEGIN')
      await c2.query('BEGIN')

      // A trava o lote e devolve o carrinho abandonado — SEM confirmar ainda.
      await c1.query(SQL_TRAVA_LOTE, [lot])
      expect(await reclamarVencidosDoLote(c1, lot)).toBe(1)

      // B chega pra comprar. Enquanto A não confirma, B não pode decidir: o
      // estoque que ele leria é o de antes da devolução ("tudo reservado").
      const bComprando = reservar(c2, [{ lotId: lot, quantidade: 1 }])
        .then(() => { desfecho = 'comprou' })
        .catch((e) => { desfecho = `recusado: ${e.message}` })

      // tempo de sobra pro Postgres soltar B, se ele fosse soltar
      await new Promise((r) => setTimeout(r, 400))
      expect(desfecho,
        'o segundo comprador decidiu sem esperar a trava — leu estoque velho').toBe('')

      await c1.query('COMMIT')
      await bComprando
      expect(desfecho,
        'o lugar tinha voltado pra prateleira e a venda foi recusada assim mesmo').toBe('comprou')
      await c2.query('COMMIT')
    } finally {
      // ROLLBACK antes de devolver ao pool, sempre: `release()` não desfaz
      // transação aberta, e uma falha de asserção aqui deixaria a trava do
      // lote pendurada travando o caso seguinte até o timeout.
      await c1.query('ROLLBACK').catch(() => {})
      await c2.query('ROLLBACK').catch(() => {})
      c1.release()
      c2.release()
    }

    const s = await saldo(lot)
    expect(s.sold + s.reserved, 'o lote vendeu mais do que tem').toBe(1)
    expect(await statusDo(abandonado)).toBe('expirado')
  }, 20_000)

  it('dois no último ingresso: um leva, e o outro ouve a verdade em vez de "sobrou 1"', async () => {
    const lot = await novoLote({ quantity: 1 })

    const c1 = await db().connect()
    const c2 = await db().connect()
    let recusa: any = null
    let acabou = false
    try {
      await c1.query('BEGIN')
      await c2.query('BEGIN')

      // A pega a trava e o último ingresso
      await reservar(c1, [{ lotId: lot, quantidade: 1 }])

      const bComprando = reservar(c2, [{ lotId: lot, quantidade: 1 }])
        .catch((e) => { recusa = e })
        .finally(() => { acabou = true })

      await new Promise((r) => setTimeout(r, 400))
      expect(acabou,
        'o segundo comprador decidiu sem esperar a trava — leu estoque velho').toBe(false)

      await c1.query('COMMIT')
      await bComprando
      await c2.query('ROLLBACK')
    } finally {
      await c1.query('ROLLBACK').catch(() => {})
      await c2.query('ROLLBACK').catch(() => {})
      c1.release()
      c2.release()
    }

    expect(recusa, 'os dois levaram o mesmo ingresso').toBeInstanceOf(EstoqueInsuficiente)
    expect(recusa.disponivel,
      'o recusado ouviu que ainda sobrava ingresso: número lido antes da trava').toBe(0)

    const s = await saldo(lot)
    expect(s.sold + s.reserved, 'o lote vendeu mais do que tem').toBe(1)
  }, 20_000)
})
