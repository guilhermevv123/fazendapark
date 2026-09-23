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
 *
 * A TRAVA VEM PRIMEIRO. Toda decisão desta função — porta de venda, saldo,
 * devolver carrinho vencido — é tomada com a linha do lote já travada. Conferir
 * o saldo antes do lock passa em teste sequencial e não serializa nada: o
 * segundo comprador decide em cima do estoque que o primeiro já gastou, e o
 * erro que ele lê ("disponível 1") é mentira na hora em que ele mais dói.
 *
 * O outro lado da mesma moeda é o lugar que fica preso: reserva sem prazo
 * segura o ingresso pra sempre e o evento "esgota" com a casa vazia. Por isso
 * a reserva tem janela (`prazoDeReserva`, carimbada também pelo gatilho da
 * migração 011) e por isso o lote cheio devolve carrinho vencido NA HORA da
 * próxima compra (`reclamarVencidosDoLote`), sem depender da varredura de
 * minuto em minuto estar de pé.
 */
import type { PoolClient } from 'pg'

export interface PedidoDeReserva {
  lotId: string
  ticketTypeId?: string | null
  quantidade: number
}

/**
 * Acabou o estoque — e `nome`/`disponivel` dizem de QUE prateleira.
 *
 * `nome` é o que faltou: o lote, ou o tipo dentro dele ("Meia-entrada"). Já
 * se chamou `nomeLote` e carregava sempre o nome do lote, mesmo quando quem
 * tinha acabado era o tipo: a rota transformava isso em "Restaram 10
 * ingressos de Lote Único, mude a quantidade para 10" com a meia esgotada e o
 * lote sobrando — conselho que falha de novo na tentativa seguinte. Quem lê
 * esta frase está com o cartão na mão; o nome e o número têm que ser os da
 * prateleira que realmente travou a venda.
 */
export class EstoqueInsuficiente extends Error {
  constructor(
    public readonly lotId: string,
    public readonly pedido: number,
    public readonly disponivel: number,
    public readonly nome: string,
  ) {
    super(`"${nome}": pedido ${pedido}, disponível ${disponivel}`)
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
 * A trava do lote, como statement solto.
 *
 * Fica exportada por dois motivos, e o segundo é o que importa: o teste de
 * concorrência força a ordem das duas conexões rodando EXATAMENTE esta linha.
 * Um teste que escreve o próprio `FOR UPDATE` prova que o Postgres trava, não
 * que a reserva trava — e continua verde no dia em que a reserva parar de
 * travar. Se esta consulta mudar, o teste muda junto.
 *
 * `FOR UPDATE OF l` trava só a linha do lote. Setor e evento entram no JOIN
 * apenas pra ler a porta de venda; travar os três faria a venda do evento
 * inteiro virar fila de uma pessoa por vez.
 */
export const SQL_TRAVA_LOTE = `
  SELECT l.id, l.name, l.quantity, l.sold, l.reserved, l.visible,
         l.expires_at, l.starts_at, l.channels,
         l.min_per_order, l.max_per_order,
         e.status AS event_status, e.sales_end_at
    FROM lots l
    JOIN sectors s ON s.id = l.sector_id
    JOIN events  e ON e.id = s.event_id
   WHERE l.id = $1
   FOR UPDATE OF l`

/** Janela de reserva quando o evento não disser outra. Bate com o DEFAULT do schema. */
export const RESERVA_MINUTOS_PADRAO = 20
/** Os mesmos limites do CHECK de `events.hold_minutes` — repetidos aqui de propósito. */
export const RESERVA_MINUTOS_MIN = 5
export const RESERVA_MINUTOS_MAX = 120

/**
 * Até quando este pedido segura o lote.
 *
 * Nunca devolve data inválida nem prazo infinito: `hold_minutes` chega de uma
 * coluna que já foi editada por tela de configuração, e um valor torto vira
 * ou `Invalid Date` (o INSERT explode com fila na frente) ou um pedido que
 * segura ingresso por 40 dias. Os dois extremos são apertados aqui.
 */
export function prazoDeReserva(minutosDoEvento?: number | string | null, agora = new Date()): Date {
  const n = Number(minutosDoEvento)
  const minutos = Number.isFinite(n) && n > 0
    ? Math.min(Math.max(Math.round(n), RESERVA_MINUTOS_MIN), RESERVA_MINUTOS_MAX)
    : RESERVA_MINUTOS_PADRAO
  return new Date(agora.getTime() + minutos * 60_000)
}

/**
 * Reserva estoque para um pedido pendente. Chamar SEMPRE dentro de tx().
 *
 * Reserva ≠ venda: o ingresso fica segurado enquanto o pagamento não cai, e
 * volta pra prateleira sozinho quando o pedido expira — pela varredura
 * (`liberarExpirados`) ou, se o lote estiver cheio, na hora da próxima compra
 * (`reclamarVencidosDoLote`). Quem chama só precisa gravar o prazo no pedido:
 * `prazoDeReserva` dá a data e o gatilho da migração 011 carimba quem esquecer.
 */
export async function reservar(
  c: PoolClient,
  itens: PedidoDeReserva[],
  opts: {
    canal: string
    agora?: Date
    /**
     * O dinheiro JÁ entrou: é o PIX pago depois de a reserva ter caído
     * (`emissao.ts`, pedido 'expirado'). As portas COMERCIAIS do lote
     * (visível, datas, canal, mínimo/máximo) valiam quando o pedido nasceu e
     * foram respeitadas naquela hora — recusar agora porque o lote virou é
     * deixar sem ingresso quem pagou o preço combinado. O que continua
     * valendo: evento com vendas abertas e, principalmente, o ESTOQUE, com a
     * mesma trava e o mesmo WHERE de sempre. Lugar que não existe não se cria
     * nem pra quem pagou.
     */
    pagamentoAtrasado?: boolean
  } = { canal: 'online' },
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

    // Trava ANTES de qualquer conferência. Ver o comentário de SQL_TRAVA_LOTE.
    const { rows } = await c.query(SQL_TRAVA_LOTE, [item.lotId])
    const lote = rows[0]
    if (!lote) throw new LoteIndisponivel(item.lotId, 'Lote não existe')

    // ---- porta de venda ---------------------------------------------------
    if (lote.event_status !== 'ativo') {
      throw new LoteIndisponivel(item.lotId, 'O evento não está com vendas abertas')
    }
    if (lote.sales_end_at && new Date(lote.sales_end_at) <= agora) {
      throw new LoteIndisponivel(item.lotId, 'As vendas deste evento já encerraram')
    }
    if (!opts.pagamentoAtrasado) {
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
    }

    // ---- estoque ----------------------------------------------------------
    let sobra = lote.quantity - lote.sold - lote.reserved

    // Prateleira presa por carrinho abandonado: devolve AGORA, com a trava do
    // lote já na mão. Sem isto o último lugar só volta quando a varredura de
    // minuto em minuto passar — e nunca, se ela estiver fora do ar. Quem paga
    // essa espera é o comprador que estava na página vendo "esgotado" com o
    // lugar vazio do lado.
    //
    // Só roda quando falta estoque: na venda normal o caminho quente segue
    // com uma consulta só.
    if (item.quantidade > sobra) {
      const devolvidos = await reclamarVencidosDoLote(c, item.lotId)
      if (devolvidos > 0) {
        // Releitura sem novo FOR UPDATE de propósito: a trava é nossa desde
        // antes da primeira leitura, ninguém mais mexeu neste lote.
        const { rows: depois } = await c.query(
          `SELECT quantity, sold, reserved FROM lots WHERE id = $1`, [item.lotId])
        sobra = depois[0].quantity - depois[0].sold - depois[0].reserved
      }
    }

    if (item.quantidade > sobra) {
      throw new EstoqueInsuficiente(item.lotId, item.quantidade, sobra, lote.name)
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
      throw new EstoqueInsuficiente(item.lotId, item.quantidade, sobra, lote.name)
    }

    if (item.ticketTypeId) {
      // Sem `FOR UPDATE` aqui de propósito, e não por esquecimento: um tipo
      // pertence a UM lote (`ticket_types.lot_id`, FK simples), e todo mundo
      // que mexe em `ticket_types.sold` — esta função e a cortesia — passa
      // antes pela linha do lote. A trava do lote já serializa este número.
      // Trancar a linha do tipo também só acrescentaria superfície de deadlock
      // e nenhum teste conseguiria ficar vermelho sem ela.
      //
      // `lot_id = $2` é rede: as duas rotas que chamam isto já conferem que o
      // tipo é do lote pedido, mas se uma terceira esquecer, a meia-entrada de
      // um lote sairia do estoque de outro sem erro em lugar nenhum.
      const { rows: tipos } = await c.query(
        `SELECT name, quantity, sold FROM ticket_types
          WHERE id = $1 AND lot_id = $2`,
        [item.ticketTypeId, item.lotId],
      )
      const tipo = tipos[0]
      if (!tipo) throw new LoteIndisponivel(item.lotId, 'Este tipo de ingresso não é deste lote')

      let sobraDoTipo = tipo.quantity - tipo.sold
      // O tipo também fica preso por carrinho abandonado, e o carrinho que
      // segura a meia segura um lugar DESTE lote — então é a mesma faxina que
      // resolve. Sem isto, lote com sobra e tipo esgotado por carrinho vencido
      // só destrava quando a varredura passar.
      if (item.quantidade > sobraDoTipo) {
        if (await reclamarVencidosDoLote(c, item.lotId) > 0) {
          const { rows: depois } = await c.query(
            `SELECT quantity, sold FROM ticket_types WHERE id = $1`, [item.ticketTypeId])
          sobraDoTipo = depois[0].quantity - depois[0].sold
        }
      }
      if (item.quantidade > sobraDoTipo) {
        throw new EstoqueInsuficiente(
          item.lotId, item.quantidade, Math.max(sobraDoTipo, 0), tipo.name)
      }

      const t = await c.query(
        `UPDATE ticket_types
            SET sold = sold + $2
          WHERE id = $1 AND sold + $2 <= quantity
          RETURNING id`,
        [item.ticketTypeId, item.quantidade],
      )
      if (t.rowCount !== 1) {
        throw new EstoqueInsuficiente(
          item.lotId, item.quantidade, Math.max(sobraDoTipo, 0), tipo.name)
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
 * Mata um pedido vencido e devolve o que ele segurava. Único lugar do sistema
 * onde "o prazo acabou" vira estoque de volta — a varredura e a reserva
 * sob demanda entram as duas por aqui.
 *
 * A virada de status é a trava: `WHERE status = 'aguardando_pagamento'` só
 * acerta uma vez, então dois caminhos concorrentes não devolvem o mesmo lugar
 * duas vezes (o que faria o lote "ganhar" ingresso que não existe e vender a
 * mais lá na frente). Quem perde a corrida devolve `false` e não toca em
 * `lots` — inclusive quando quem ganhou foi o pagamento chegando na virada do
 * prazo: pedido pago não é pedido vencido.
 */
async function matarPedidoVencido(c: PoolClient, orderId: string): Promise<boolean> {
  const virou = await c.query(
    `UPDATE orders SET status = 'expirado', canceled_at = now()
      WHERE id = $1 AND status = 'aguardando_pagamento'
      RETURNING id`,
    [orderId],
  )
  if (virou.rowCount !== 1) return false

  const { rows: itens } = await c.query(
    `SELECT lot_id AS "lotId", ticket_type_id AS "ticketTypeId", quantity AS quantidade
       FROM order_items WHERE order_id = $1`,
    [orderId],
  )
  await liberar(c, itens)
  return true
}

/**
 * O pedido expirado ainda tem cobrança viva no gateway?
 *
 * Matar a reserva sem cancelar a cobrança era o P0 de 22/09: o PIX nasce com
 * vencimento de um dia (`vencimentoEmDias(1)` no checkout — o Asaas só aceita
 * DATA, não hora) e a reserva dura minutos. O comprador pagava o QR que ainda
 * estava na tela dele, o dinheiro entrava e o ingresso não saía.
 *
 * O cancelamento em si mora em `asaas.ts` (`cancelarCobrancasDeExpirados`) e
 * roda FORA da transação: chamada de rede com a linha do lote travada é fila
 * na virada de lote, e gateway fora do ar não pode impedir o estoque de
 * voltar. Esta consulta é o elo entre os dois — ela acha, sem depender de quem
 * matou o pedido (varredura ou `reclamarVencidosDoLote`), as cobranças que
 * ainda precisam ser canceladas. A marca de "já tentei" é o `audit_log`, que
 * já existe e já é a trilha que o painel lê: nenhuma coluna nova.
 *
 * `sim_` fica de fora: cobrança do gateway simulado não existe em lugar nenhum.
 * Janela de 3 dias: passado disso o PIX já venceu sozinho no Asaas.
 */
export const SQL_COBRANCAS_A_CANCELAR = `
  SELECT o.id, o.org_id, o.code, o.asaas_payment_id,
         org.asaas_api_key, org.asaas_env, org.asaas_wallet
    FROM orders o
    JOIN organizations org ON org.id = o.org_id
   WHERE o.status = 'expirado'
     AND o.asaas_payment_id IS NOT NULL
     AND left(o.asaas_payment_id, 4) <> 'sim_'
     AND o.canceled_at > now() - interval '3 days'
     AND NOT EXISTS (SELECT 1 FROM audit_log a
                      WHERE a.entity = 'order' AND a.entity_id = o.id::text
                        AND a.action = 'cobranca_cancelada')
     AND (SELECT count(*) FROM audit_log a
           WHERE a.entity = 'order' AND a.entity_id = o.id::text
             AND a.action = 'cobranca_cancelar_falhou') < $2
     -- espera crescente entre tentativas: gateway fora não leva uma por minuto
     AND COALESCE((SELECT max(a.created_at) FROM audit_log a
                    WHERE a.entity = 'order' AND a.entity_id = o.id::text
                      AND a.action = 'cobranca_cancelar_falhou'), '-infinity')
         < now() - interval '10 minutes'
   ORDER BY o.canceled_at
   LIMIT $1`

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
    if (await matarPedidoVencido(c, id)) n++
  }
  return n
}

/**
 * Devolve na hora os carrinhos vencidos que seguram ESTE lote.
 *
 * Chamada de dentro de `reservar`, com a linha do lote já travada, quando o
 * lote parece cheio. É o que separa "esgotado" de "esgotado por enquanto":
 * numa noite de pico o lugar volta pra prateleira no instante em que alguém
 * pede por ele, e não até um minuto depois — nem nunca, se o agendador
 * estiver fora do ar no meio de um deploy.
 *
 * `SKIP LOCKED` porque comprador não espera varredura: pedido que já está na
 * mão de outra transação fica pra ela. O pedido morre inteiro, com todos os
 * itens, mesmo os de outros lotes — meio pedido vivo deixaria o outro lote
 * preso exatamente pelo defeito que esta função existe pra fechar.
 *
 * Tudo dentro de SAVEPOINT: se esta devolução falhar (deadlock com outra
 * reserva mexendo nos mesmos lotes, por exemplo), a compra segue e o pior
 * caso é o comprador ouvir "esgotado" — nunca uma venda boa morrer por causa
 * da faxina.
 */
export async function reclamarVencidosDoLote(
  c: PoolClient, lotId: string, limite = 20,
): Promise<number> {
  await c.query('SAVEPOINT reclamar_vencidos')
  try {
    const { rows } = await c.query(
      `SELECT o.id
         FROM orders o
        WHERE o.status = 'aguardando_pagamento'
          AND o.expires_at IS NOT NULL AND o.expires_at <= now()
          AND EXISTS (SELECT 1 FROM order_items oi
                       WHERE oi.order_id = o.id AND oi.lot_id = $1)
        ORDER BY o.expires_at
        LIMIT $2
        FOR UPDATE OF o SKIP LOCKED`,
      [lotId, limite],
    )
    let n = 0
    for (const { id } of rows) {
      if (await matarPedidoVencido(c, id)) n++
    }
    await c.query('RELEASE SAVEPOINT reclamar_vencidos')
    return n
  } catch (e: any) {
    await c.query('ROLLBACK TO SAVEPOINT reclamar_vencidos')
    // Desfazer não apaga o ponto: sem este RELEASE, um pedido de vários lotes
    // empilharia uma subtransação por lote na mesma conexão.
    await c.query('RELEASE SAVEPOINT reclamar_vencidos').catch(() => {})
    // Silêncio aqui esconderia estoque preso: o comprador vê "esgotado" e o
    // diário não diz por quê.
    console.warn(`[estoque] não deu pra devolver carrinho vencido do lote ${lotId}: ${e.message}`)
    return 0
  }
}

/** Quanto ainda dá pra vender de um lote. */
export function disponivel(lote: { quantity: number; sold: number; reserved: number }): number {
  return Math.max(lote.quantity - lote.sold - lote.reserved, 0)
}
