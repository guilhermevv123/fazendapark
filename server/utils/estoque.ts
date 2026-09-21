/**
 * estoque.ts — reserva e baixa de ingresso.
 *
 * Esta é a função mais perigosa do sistema. Duas pessoas clicando "comprar" no
 * último ingresso ao mesmo tempo é o caso normal, não o excepcional: numa
 * virada de lote chegam dezenas de cliques no mesmo segundo.
 *
 * A garantia vem de três camadas, e nenhuma delas sozinha basta:
 *   1. SELECT ... FOR UPDATE serializa quem mexe no mesmo lote;
 *   2. o UPDATE só grava se ainda couber (WHERE sold+reserved+n <= quantity);
 *   3. o CHECK do schema (sold+reserved <= quantity) é a rede — se algum
 *      caminho novo esquecer as duas de cima, o banco recusa em vez de
 *      vender a mais.
 *
 * Ler o saldo e depois gravar SEM lock é o bug clássico de bilheteria: os dois
 * leem "resta 1", os dois gravam, e o evento vendeu 2.
 */
import type { PoolClient } from 'pg'

export interface PedidoDeReserva {
  lotId: string
  ticketTypeId?: string | null
  quantidade: number
}

export class EstoqueInsuficiente extends Error {
  constructor(
    public readonly lotId: string,
    public readonly pedido: number,
    public readonly disponivel: number,
    public readonly nomeLote: string,
  ) {
    super(`Lote "${nomeLote}": pedido ${pedido}, disponível ${disponivel}`)
    this.name = 'EstoqueInsuficiente'
  }
}

export class LoteIndisponivel extends Error {
  constructor(public readonly lotId: string, public readonly motivo: string) {
    super(motivo)
    this.name = 'LoteIndisponivel'
  }
}

/**
 * Reserva estoque para um pedido pendente. Chamar SEMPRE dentro de tx().
 *
 * Reserva ≠ venda: o ingresso fica segurado enquanto o pagamento não cai, e
 * volta pra prateleira sozinho quando o pedido expira (ver liberarExpirados).
 */
export async function reservar(
  c: PoolClient,
  itens: PedidoDeReserva[],
  opts: { canal: string; agora?: Date } = { canal: 'online' },
): Promise<void> {
  if (!itens.length) throw new Error('pedido sem itens')
  const agora = opts.agora ?? new Date()

  // Ordem determinística pelo id evita deadlock: duas transações que peguem os
  // mesmos dois lotes em ordens opostas travam uma na outra pra sempre.
  const ordenados = [...itens].sort((a, b) => a.lotId.localeCompare(b.lotId))

  for (const item of ordenados) {
    if (!Number.isInteger(item.quantidade) || item.quantidade <= 0) {
      throw new Error('quantidade precisa ser inteiro positivo')
    }

    const { rows } = await c.query(
      `SELECT l.id, l.name, l.quantity, l.sold, l.reserved, l.visible,
              l.expires_at, l.starts_at, l.channels,
              l.min_per_order, l.max_per_order,
              e.status AS event_status, e.sales_end_at
         FROM lots l
         JOIN sectors s ON s.id = l.sector_id
         JOIN events  e ON e.id = s.event_id
        WHERE l.id = $1
        FOR UPDATE OF l`,
      [item.lotId],
    )
    const lote = rows[0]
    if (!lote) throw new LoteIndisponivel(item.lotId, 'Lote não existe')

    // ---- porta de venda ---------------------------------------------------
    if (lote.event_status !== 'ativo') {
      throw new LoteIndisponivel(item.lotId, 'O evento não está com vendas abertas')
    }
    if (lote.sales_end_at && new Date(lote.sales_end_at) <= agora) {
      throw new LoteIndisponivel(item.lotId, 'As vendas deste evento já encerraram')
    }
    if (!lote.visible) {
      throw new LoteIndisponivel(item.lotId, 'Lote não está disponível')
    }
    if (lote.starts_at && new Date(lote.starts_at) > agora) {
      throw new LoteIndisponivel(item.lotId, 'Este lote ainda não abriu')
    }
    if (lote.expires_at && new Date(lote.expires_at) <= agora) {
      throw new LoteIndisponivel(item.lotId, 'Este lote já encerrou')
    }
    if (!lote.channels.includes(opts.canal)) {
      throw new LoteIndisponivel(item.lotId, 'Lote não é vendido por este canal')
    }
    if (item.quantidade < lote.min_per_order) {
      throw new LoteIndisponivel(item.lotId, `Mínimo de ${lote.min_per_order} por compra`)
    }
    if (item.quantidade > lote.max_per_order) {
      throw new LoteIndisponivel(item.lotId, `Máximo de ${lote.max_per_order} por compra`)
    }

    // ---- estoque ----------------------------------------------------------
    const disponivel = lote.quantity - lote.sold - lote.reserved
    if (item.quantidade > disponivel) {
      throw new EstoqueInsuficiente(item.lotId, item.quantidade, disponivel, lote.name)
    }

    // O WHERE repete a condição de propósito: mesmo com o FOR UPDATE acima,
    // esta linha é a que garante que nenhum caminho futuro grave a mais.
    const upd = await c.query(
      `UPDATE lots
          SET reserved = reserved + $2
        WHERE id = $1
          AND sold + reserved + $2 <= quantity
        RETURNING id`,
      [item.lotId, item.quantidade],
    )
    if (upd.rowCount !== 1) {
      throw new EstoqueInsuficiente(item.lotId, item.quantidade, disponivel, lote.name)
    }

    if (item.ticketTypeId) {
      const t = await c.query(
        `UPDATE ticket_types
            SET sold = sold + $2
          WHERE id = $1 AND sold + $2 <= quantity
          RETURNING id`,
        [item.ticketTypeId, item.quantidade],
      )
      if (t.rowCount !== 1) {
        throw new EstoqueInsuficiente(item.lotId, item.quantidade, disponivel, lote.name)
      }
    }
  }
}

/** Pagamento caiu: a reserva vira venda. Sempre dentro de tx(). */
export async function confirmar(c: PoolClient, itens: PedidoDeReserva[]): Promise<void> {
  for (const item of [...itens].sort((a, b) => a.lotId.localeCompare(b.lotId))) {
    const r = await c.query(
      `UPDATE lots
          SET reserved = reserved - $2, sold = sold + $2
        WHERE id = $1 AND reserved >= $2
        RETURNING id`,
      [item.lotId, item.quantidade],
    )
    // Se a reserva sumiu, algo já mexeu neste pedido (expiração concorrente
    // com a confirmação). Falhar alto: confirmar venda sem baixar reserva
    // desencaixa o estoque em silêncio, e ninguém descobre até faltar ingresso
    // na portaria.
    if (r.rowCount !== 1) {
      throw new Error(`Reserva do lote ${item.lotId} não estava mais em pé ao confirmar`)
    }
  }
}

/** Pedido morreu (expirou/cancelou/falhou): devolve pra prateleira. */
export async function liberar(c: PoolClient, itens: PedidoDeReserva[]): Promise<void> {
  for (const item of [...itens].sort((a, b) => a.lotId.localeCompare(b.lotId))) {
    await c.query(
      `UPDATE lots SET reserved = GREATEST(reserved - $2, 0) WHERE id = $1`,
      [item.lotId, item.quantidade],
    )
    if (item.ticketTypeId) {
      await c.query(
        `UPDATE ticket_types SET sold = GREATEST(sold - $2, 0) WHERE id = $1`,
        [item.ticketTypeId, item.quantidade],
      )
    }
  }
}

/**
 * Varre pedidos pendentes vencidos e devolve o estoque.
 *
 * Sem isto, um carrinho abandonado segura ingresso pra sempre e o evento
 * "esgota" com metade vendida. No painel da Zig o abandono estava em 57% —
 * é muita prateleira presa se ninguém varre.
 */
export async function liberarExpirados(c: PoolClient, limite = 200): Promise<number> {
  const { rows } = await c.query(
    `SELECT id FROM orders
      WHERE status = 'aguardando_pagamento'
        AND expires_at IS NOT NULL AND expires_at <= now()
      ORDER BY expires_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limite],
  )
  let n = 0
  for (const { id } of rows) {
    const { rows: itens } = await c.query(
      `SELECT lot_id AS "lotId", ticket_type_id AS "ticketTypeId", quantity AS quantidade
         FROM order_items WHERE order_id = $1`,
      [id],
    )
    await liberar(c, itens)
    await c.query(
      `UPDATE orders SET status = 'expirado', canceled_at = now() WHERE id = $1`,
      [id],
    )
    n++
  }
  return n
}

/** Quanto ainda dá pra vender de um lote. */
export function disponivel(lote: { quantity: number; sold: number; reserved: number }): number {
  return Math.max(lote.quantity - lote.sold - lote.reserved, 0)
}
