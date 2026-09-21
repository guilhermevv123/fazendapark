/**
 * emissao.ts — pagamento confirmado vira ingresso.
 *
 * Precisa ser IDEMPOTENTE. O Asaas reenvia webhook: manda PAYMENT_CONFIRMED e
 * depois PAYMENT_RECEIVED pra mesma cobrança, e repete quando não recebe 200.
 * Emitir duas vezes significa duas entradas válidas pro mesmo ingresso pago —
 * o parque deixa entrar gente a mais e só descobre no fim do dia.
 *
 * A proteção é o estado do pedido lido DENTRO da transação com lock: quem
 * chega segundo vê 'pago' e sai sem fazer nada.
 */
import type { PoolClient } from 'pg'
import { confirmar } from './estoque'
import { tx } from './db'
import { gerarCodigo } from './ingresso'

/* ===========================================================================
 * O que é cortesia — e por que `tickets.is_courtesy` não responde isso
 * ======================================================================== */

/**
 * O canal que a rota de cortesia grava no pedido. É ELE que define cortesia.
 */
export const CANAL_CORTESIA = 'cortesia'

/**
 * `tickets.is_courtesy` diz uma coisa só: **o pedido fechou em zero**.
 *
 * É o que a linha lá embaixo carimba (`fechouEmZero`), e é o que ela sempre
 * carimbou. Três coisas diferentes fecham em zero e só UMA é cortesia:
 *
 *   | o que aconteceu                  | canal do pedido | é cortesia? |
 *   |----------------------------------|-----------------|-------------|
 *   | convite da imprensa/patrocinador | `cortesia`      | **sim**     |
 *   | cupom/promoção de 100%           | `online`        | não, é VENDA|
 *   | criança até 5 anos (lote R$ 0)   | `online`/balcão | não, é VENDA|
 *
 * Venda que deu zero tem comprador, CPF, pedido e nota — ela aparece em
 * Vendas e em Participantes. Chamar isso de cortesia no borderô que o produtor
 * leva pro sócio é dizer que ele deu de graça o que ele vendeu numa promoção.
 *
 * ## Por que a coluna não foi "consertada" pra dizer a verdade
 *
 * Porque carimbar certo daqui pra frente só conserta o FUTURO: as linhas que
 * já existem continuariam marcadas, e quem lesse a coluna continuaria errando
 * sobre elas — que é justamente "o que o sócio vai ler daqui a seis meses".
 * A **origem** conserta os dois lados de graça: `orders.channel` sempre foi
 * gravado, então o passado se distingue sozinho, sem migração e sem backfill
 * inventado. Medido no banco antes de escrever isto: dos ingressos marcados
 * hoje, nenhum precisou de chute — cada um tinha pedido com canal.
 *
 * Fica UM caso que ninguém consegue distinguir, e ele tem nome próprio
 * (`SQL_CORTESIA_SEM_ORIGEM`): ingresso **sem pedido** — INSERT na mão,
 * importação, ou pedido apagado (a FK é `ON DELETE SET NULL`). Aí não existe
 * origem pra conferir, a régua da casa conta como cortesia (o lado seguro:
 * entrada de graça que ninguém explica) e a leitura marca a linha pra tela
 * poder dizer que aquilo ali não dá pra provar — em vez de fingir que dá.
 *
 * A régua mora aqui, encostada na caneta que carimba a coluna, e é importada
 * por todo mundo que precisa dela (borderô, cortesias, participantes, pedido).
 * Reescrever a condição no arquivo de quem lê é como a tela de Cortesias
 * passou a dizer 2 e o borderô 3 sobre os mesmos ingressos.
 */
export const SQL_ORIGEM_NAO_E_VENDA = (apelido: string) => `
  NOT EXISTS (SELECT 1 FROM orders origem_do_ingresso
               WHERE origem_do_ingresso.id = ${apelido}.order_id
                 AND origem_do_ingresso.channel <> '${CANAL_CORTESIA}')`

/**
 * A régua inteira: marca + origem. É o que conta como cortesia na casa.
 *
 * Recebe o apelido da tabela em vez de fixar um: consulta que apelida
 * `tickets t` não enxerga `tickets.order_id`, e o erro só apareceria em
 * runtime, na consulta que ninguém exercitou.
 */
export const SQL_E_CORTESIA = (apelido: string) =>
  `(${apelido}.is_courtesy AND ${SQL_ORIGEM_NAO_E_VENDA(apelido)})`

/**
 * O outro lado da mesma moeda: saiu de graça e é VENDA.
 *
 * Escrito como a negação de `SQL_ORIGEM_NAO_E_VENDA`, e não como uma condição
 * nova, pra que os dois recortes PARTICIONEM os ingressos marcados: nenhum
 * ingresso pode cair nos dois nem sumir dos dois quando a régua mudar.
 */
export const SQL_E_VENDA_GRATUITA = (apelido: string) =>
  `(${apelido}.is_courtesy AND NOT ${SQL_ORIGEM_NAO_E_VENDA(apelido)})`

/** Marcado como gratuito e sem pedido: a origem não foi registrada. */
export const SQL_CORTESIA_SEM_ORIGEM = (apelido: string) =>
  `(${apelido}.is_courtesy AND ${apelido}.order_id IS NULL)`

/**
 * A MESMA régua de `SQL_E_CORTESIA`, pra quem já tem as duas colunas na mão
 * e não vai consultar de novo (o caso de `GET /api/pedido/:id`, que já leu o
 * pedido inteiro).
 *
 * Sem pedido devolve `true` pelo mesmo motivo do SQL: não há origem pra
 * contradizer a marca. As duas precisam concordar — a tela do comprador e o
 * relatório do produtor falando do mesmo ingresso não podem divergir.
 */
export function eCortesia(
  marcadoGratuito: boolean, canalDoPedido: string | null | undefined,
): boolean {
  return Boolean(marcadoGratuito)
    && (canalDoPedido == null || canalDoPedido === CANAL_CORTESIA)
}

export interface ResultadoEmissao {
  emitiu: boolean
  motivo?: string
  ingressos: number
  pedidoCode?: string
  /** a régua da casa aplicada ao que acabou de sair — nunca o valor zero */
  cortesia?: boolean
}

/**
 * Caminho de sempre: abre a própria transação. É o que o webhook do Asaas usa.
 */
export async function emitirIngressos(orderId: string): Promise<ResultadoEmissao> {
  return tx((c) => emitirNaTransacao(c, orderId))
}

/**
 * Mesma emissão, dentro de uma transação que já está aberta.
 *
 * Existe pela bilheteria física: lá o dinheiro chega na mão junto com o
 * pedido, então gravar a venda e emitir o ingresso precisam ser o MESMO
 * commit. Separado em dois, uma queda no meio deixa o dinheiro na gaveta e o
 * cliente sem ingresso — e é o operador, com fila na frente, que descobre.
 *
 * Não abrir uma transação nova aqui também é o que evita o travamento óbvio:
 * a linha do pedido já está bloqueada pela transação de fora, e uma segunda
 * conexão pedindo `FOR UPDATE` na mesma linha esperaria pra sempre.
 */
export async function emitirNaTransacao(
  c: PoolClient, orderId: string,
): Promise<ResultadoEmissao> {
  const { rows: pedidos } = await c.query(
    `SELECT o.*, e.name AS evento_nome, e.slug AS evento_slug
       FROM orders o JOIN events e ON e.id = o.event_id
      WHERE o.id = $1
      FOR UPDATE OF o`, [orderId])
  const pedido = pedidos[0]
  if (!pedido) return { emitiu: false, motivo: 'pedido não existe', ingressos: 0 }

  // Porta da idempotência: só emite quem ainda não foi pago.
  if (pedido.status === 'pago') {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM tickets WHERE order_id = $1`, [orderId])
    return { emitiu: false, motivo: 'já emitido', ingressos: rows[0].n, pedidoCode: pedido.code }
  }
  if (!['aguardando_pagamento', 'em_analise', 'rascunho'].includes(pedido.status)) {
    return { emitiu: false, motivo: `pedido em ${pedido.status}`, ingressos: 0 }
  }

  const { rows: itens } = await c.query(
    `SELECT oi.id, oi.lot_id AS "lotId", oi.ticket_type_id AS "ticketTypeId",
            oi.quantity AS quantidade, s.id AS sector_id, s.session_id,
            c2.name AS comprador_nome, c2.email AS comprador_email,
            c2.document AS comprador_doc
       FROM order_items oi
       JOIN lots l  ON l.id = oi.lot_id
       JOIN sectors s ON s.id = l.sector_id
       LEFT JOIN customers c2 ON c2.id = $2
      WHERE oi.order_id = $1`, [orderId, pedido.customer_id])
  if (!itens.length) return { emitiu: false, motivo: 'pedido sem itens', ingressos: 0 }

  // Pedido gratuito nunca reservou via gateway, mas reservou estoque no
  // checkout — então confirma igual.
  await confirmar(c, itens.map((i: any) => ({
    lotId: i.lotId, ticketTypeId: i.ticketTypeId, quantidade: i.quantidade,
  })))

  const prefixo = String(pedido.evento_slug || 'ING').replace(/[^a-zA-Z]/g, '').slice(0, 3) || 'ING'

  // `is_courtesy` é "o pedido fechou em zero" — NÃO é "isto é cortesia". O
  // nome da coluna mente; o nome da variável não pode mentir junto, senão a
  // próxima pessoa lê `cortesia` aqui e carrega a confusão pro arquivo dela.
  // Quem quer saber se é cortesia usa `eCortesia()` / `SQL_E_CORTESIA`, lá em
  // cima, que olham a ORIGEM do pedido.
  const fechouEmZero = Number(pedido.total_cents) === 0

  let n = 0
  for (const item of itens) {
    for (let k = 0; k < item.quantidade; k++) {
      await c.query(
        `INSERT INTO tickets (org_id, event_id, session_id, order_id, order_item_id,
                              sector_id, lot_id, ticket_type_id, code, qr_secret,
                              status, is_courtesy, holder_name, holder_email, holder_document)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,encode(gen_random_bytes(16),'hex'),
                 'valido',$10,$11,$12,$13)`,
        [pedido.org_id, pedido.event_id, item.session_id, orderId, item.id,
         item.sector_id, item.lotId, item.ticketTypeId,
         gerarCodigo(prefixo), fechouEmZero,
         // O 1º ingresso fica no nome do comprador; os demais em branco pra
         // ele nomear depois. Nomear todos com o mesmo nome atrapalha a
         // portaria mais do que ajuda.
         k === 0 ? item.comprador_nome : null,
         k === 0 ? item.comprador_email : null,
         k === 0 ? item.comprador_doc : null])
      n++
    }
  }

  await c.query(
    `UPDATE orders SET status = 'pago', paid_at = COALESCE(paid_at, now()) WHERE id = $1`,
    [orderId])
  await c.query(
    `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
     VALUES ($1,'order',$2,'pago',$3::jsonb)`,
    [pedido.org_id, orderId, JSON.stringify({ ingressos: n })])

  return {
    emitiu: true, ingressos: n, pedidoCode: pedido.code,
    // A pergunta respondida pela ORIGEM. Este caminho é o da VENDA (webhook do
    // Asaas e balcão): mesmo fechando em zero, o que sai por aqui é venda.
    cortesia: eCortesia(fechouEmZero, pedido.channel),
  }
}
