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
import { confirmar, EstoqueInsuficiente, LoteIndisponivel, reservar } from './estoque'
import { tx } from './db'
import { gerarCodigo } from './ingresso'
import {
  conferirCotaDeMeia, CotaDeMeiaEsgotada, documentoExigido, motivoValido,
} from './meia-entrada'

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

/* ===========================================================================
 * O carimbo de meia-entrada — o que a portaria vai ler daqui a seis meses
 * ======================================================================== */

/**
 * A exigência congelada no ingresso de meia que nasceu SEM motivo declarado.
 *
 * ## O furo que isto fecha, medido no banco em 21/09
 *
 * ```
 * SELECT tt.kind, count(*), count(t.half_reason) FROM tickets t
 *   JOIN ticket_types tt ON tt.id = t.ticket_type_id GROUP BY 1;
 *   meia    | 23 | 0      <-- vinte e três meias, ZERO com motivo
 * ```
 *
 * `half_reason` não é uma ponta solta que falta preencher: é o campo que quase
 * nenhum ingresso deste banco tem, e **continua nascendo vazio hoje**. O
 * gatilho da migração 015 só COPIA do item do pedido, e só o checkout online
 * escreve motivo no item — `pdv/venda.post.ts` insere `order_items` sem as três
 * colunas de meia (medido), e a `RAISE` da 015 é restrita ao canal `online` de
 * propósito, pra não derrubar venda de guichê com fila na frente.
 *
 * Resultado: a meia do balcão nasce com as TRÊS colunas nulas, e a única coisa
 * no banco que ainda diz que aquele ingresso é meia é `ticket_types.kind` —
 * uma coluna de OUTRA tabela. Toda consulta que ler só as colunas do ingresso
 * (que é o que a portaria fazia, e que é o furo que a `/api/checkin` levou uma
 * frota inteira pra fechar) volta a tratar meia como inteira, em silêncio.
 *
 * Então a emissão passa a gravar a exigência SEMPRE que o tipo for meia. O
 * ingresso passa a carregar no próprio corpo a prova de que é meia, sem
 * depender de um JOIN que alguém pode esquecer.
 *
 * ## Por que isto não é "inventar motivo"
 *
 * Não é. Ninguém escreve em `half_reason` o que ninguém perguntou — esta
 * frase não diz POR QUE a pessoa tem direito, diz O QUE pedir quando o direito
 * não foi declarado. É a mesma escolha do passo 5 da migração 015, que
 * carimbou texto genérico nas meias velhas exatamente pra portaria não ficar
 * cega, e é o oposto de um backfill que chutaria "estudante" e viraria rastro
 * falso no lugar de rastro faltando.
 *
 * `half_reason` segue NULL nesses ingressos, e é assim que a tela consegue
 * contar quantos ficaram sem e mostrar o número pro produtor.
 */
export const EXIGENCIA_SEM_MOTIVO =
  'Documento que comprove o direito à meia-entrada: carteira de estudante, '
  + 'documento com foto que mostre a idade (60 anos ou mais), laudo ou cartão de PCD, '
  + 'ID Jovem, ou carteira funcional de professor da rede pública.'

/**
 * O que vai para `tickets.half_document_required` — em três degraus, nesta
 * ordem, e o primeiro que responde ganha:
 *
 *  1. **o texto congelado no item do pedido** — é a exigência PROMETIDA àquele
 *     comprador. A lei muda; o que foi vendido não.
 *  2. **o texto da tabela de motivos**, quando o motivo veio mas o texto não
 *     (item escrito na mão, importação, rota que só gravou metade).
 *  3. **`EXIGENCIA_SEM_MOTIVO`** — o carimbo explícito de "é meia e ninguém
 *     registrou por quê". Explícito é diferente de NULL: NULL é indistinguível
 *     de "não é meia", e é justamente essa confusão que deixa o operador sem
 *     saber que tem um documento pra pedir.
 *
 * Devolve `null` para inteira e gratuidade: ingresso que não pede documento
 * não pode ganhar bloco de documento, senão a tela passa a pedir papel de todo
 * mundo e o operador para de ler o aviso — que é como um aviso morre.
 */
export function exigenciaDeMeia(item: {
  especie?: string | null
  motivoDaMeia?: string | null
  exigenciaCongelada?: string | null
}): string | null {
  if (item?.especie !== 'meia') return null
  if (item.exigenciaCongelada) return item.exigenciaCongelada
  if (motivoValido(item.motivoDaMeia)) return documentoExigido(item.motivoDaMeia)
  return EXIGENCIA_SEM_MOTIVO
}

export interface ResultadoEmissao {
  emitiu: boolean
  motivo?: string
  ingressos: number
  pedidoCode?: string
  /** a régua da casa aplicada ao que acabou de sair — nunca o valor zero */
  cortesia?: boolean
  /**
   * Quantos ingressos saíram carimbados como meia SEM motivo declarado.
   * O balcão é o caminho que produz isso hoje; quem chama pode relatar.
   */
  meiasSemMotivo?: number
  /**
   * O pagamento chegou com o pedido já expirado e o lugar não voltou (estoque
   * acabou, evento fechou). Dinheiro na conta sem ingresso: quem chama NÃO
   * pode tratar isto como "nada a fazer" — ver `aplicarEventoDoAsaas`.
   */
  pagoSemLugar?: boolean
  /** saiu por reserva refeita: o pagamento chegou depois do prazo e ainda havia lugar */
  reservaRefeita?: boolean
}

/**
 * O pagamento de um pedido EXPIRADO chegou: tenta pôr a reserva de pé de novo.
 *
 * Era o P0 de 22/09. A reserva dura minutos (`events.hold_minutes`), o PIX
 * vale até o dia seguinte (o Asaas só aceita data de vencimento, não hora), e
 * `liberarExpirados` matava o pedido no meio. O comprador pagava o QR que
 * estava na tela, o webhook chegava com o pedido em 'expirado', esta função
 * respondia "pedido em expirado" e a entrega era dada como processada: o
 * dinheiro entrava, o ingresso não saía, e nada no painel mostrava.
 *
 * Quem pagou tem direito ao lugar SE o lugar ainda existe. A reserva é refeita
 * pela MESMA `reservar()` da venda (trava do lote, `WHERE` que não deixa
 * passar do total, cota do tipo) e pela mesma cota de meia do checkout — só as
 * portas comerciais do lote ficam de fora (ver `pagamentoAtrasado`). Tudo num
 * SAVEPOINT: se um item de três não couber, os outros dois voltam pra
 * prateleira na hora, sem meio pedido reservado.
 *
 * Só as recusas de NEGÓCIO viram "sem lugar". Erro de banco sobe, e aí a
 * entrega do webhook fica na fila e é tentada de novo — nunca vira "sem lugar"
 * por uma queda de conexão.
 */
async function refazerReserva(
  c: PoolClient, pedido: any,
): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const { rows: itens } = await c.query(
    `SELECT oi.lot_id AS "lotId", oi.ticket_type_id AS "ticketTypeId",
            oi.quantity AS quantidade, tt.kind AS especie
       FROM order_items oi
       LEFT JOIN ticket_types tt ON tt.id = oi.ticket_type_id
      WHERE oi.order_id = $1`, [pedido.id])
  if (!itens.length) return { ok: false, motivo: 'pedido sem itens' }

  await c.query('SAVEPOINT refazer_reserva')
  try {
    await reservar(c, itens.map((i: any) => ({
      lotId: i.lotId, ticketTypeId: i.ticketTypeId, quantidade: i.quantidade,
    })), { canal: pedido.channel ?? 'online', pagamentoAtrasado: true })

    const meias = new Map<string, number>()
    for (const i of itens) {
      if (i.especie === 'meia') meias.set(i.lotId, (meias.get(i.lotId) ?? 0) + i.quantidade)
    }
    for (const [lotId, n] of [...meias].sort((a, b) => a[0].localeCompare(b[0]))) {
      await conferirCotaDeMeia(c, lotId, n)
    }
    await c.query('RELEASE SAVEPOINT refazer_reserva')
    return { ok: true }
  } catch (e: any) {
    await c.query('ROLLBACK TO SAVEPOINT refazer_reserva')
    await c.query('RELEASE SAVEPOINT refazer_reserva').catch(() => {})
    const negocio = e instanceof EstoqueInsuficiente || e instanceof LoteIndisponivel
      || e instanceof CotaDeMeiaEsgotada
      // trava de dia da sessão (db/016): RAISE escrito por nós, não CHECK quebrado
      || (e?.code === '23514' && e?.routine === 'exec_stmt_raise')
    if (!negocio) throw e
    return { ok: false, motivo: e.message }
  }
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
  // Pago depois de a reserva cair: o lugar volta SE ainda existir. Só
  // 'expirado' — cancelado, estornado, chargeback são decisões sobre o
  // dinheiro, não prazo vencido, e nenhum deles revive por aqui.
  let reservaRefeita = false
  if (pedido.status === 'expirado') {
    const volta = await refazerReserva(c, pedido)
    if (!volta.ok) {
      const motivo = `pago depois do prazo da reserva e sem lugar: ${volta.motivo}. `
        + 'Emitir outro ingresso ou devolver o valor.'
      // A trilha do pedido é o que o painel e a tela do comprador leem pra
      // saber que ENTROU dinheiro aqui. Uma linha por pedido: a entrega é
      // retentada, a anotação não precisa se repetir a cada volta.
      await c.query(
        `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
         SELECT $1::uuid, 'order', $2::text, 'pago_sem_lugar', $3::jsonb
          WHERE NOT EXISTS (SELECT 1 FROM audit_log
                             WHERE entity = 'order' AND entity_id = $2::text
                               AND action = 'pago_sem_lugar')`,
        [pedido.org_id, orderId, JSON.stringify({ motivo: volta.motivo, pedido: pedido.code })])
      return { emitiu: false, motivo, ingressos: 0, pedidoCode: pedido.code, pagoSemLugar: true }
    }
    reservaRefeita = true
  } else if (!['aguardando_pagamento', 'em_analise', 'rascunho'].includes(pedido.status)) {
    return { emitiu: false, motivo: `pedido em ${pedido.status}`, ingressos: 0 }
  }

  const { rows: itens } = await c.query(
    // `tt.kind` e as três colunas de meia entram aqui porque é NESTE INSERT que
    // o ingresso ganha corpo. Sem elas, quem decide se aquele papel vai ser
    // pedido na porta é um gatilho copiando de um item que metade das rotas
    // não preenche — ver `exigenciaDeMeia`, acima.
    //
    // `LEFT JOIN ticket_types`: lote sem variação vende com `ticket_type_id`
    // nulo, e um JOIN comum faria o item inteiro sumir do resultado — o
    // pedido viraria "pedido sem itens" e a venda morreria com o dinheiro já
    // na gaveta. É o mesmo cuidado que a migração 015 tomou no gatilho dela.
    `SELECT oi.id, oi.lot_id AS "lotId", oi.ticket_type_id AS "ticketTypeId",
            oi.quantity AS quantidade, s.id AS sector_id, s.session_id,
            tt.kind AS especie,
            oi.half_reason            AS "motivoDaMeia",
            oi.half_document          AS "numeroDaMeia",
            oi.half_document_required AS "exigenciaCongelada",
            c2.name AS comprador_nome, c2.email AS comprador_email,
            c2.document AS comprador_doc
       FROM order_items oi
       JOIN lots l  ON l.id = oi.lot_id
       JOIN sectors s ON s.id = l.sector_id
       LEFT JOIN ticket_types tt ON tt.id = oi.ticket_type_id
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
  let meiasSemMotivo = 0
  for (const item of itens) {
    // A exigência é calculada UMA vez por item: ela é do tipo de ingresso
    // vendido, não de cada unidade. Calcular dentro do laço só multiplicaria
    // a mesma conta pela quantidade.
    const exigencia = exigenciaDeMeia(item)
    const semMotivo = exigencia != null && !motivoValido(item.motivoDaMeia)

    for (let k = 0; k < item.quantidade; k++) {
      await c.query(
        // As três colunas de meia vêm explícitas. O gatilho da 015 continua
        // sendo a rede (ele só escreve onde encontra NULL, então não briga com
        // estes valores) — mas quem GARANTE que a meia sai carimbada é esta
        // linha, porque o gatilho copia do item e há rota que não preenche o
        // item. `half_reason` vai como veio: nulo quando ninguém perguntou.
        // Chutar um motivo aqui seria rastro falso, que é pior que rastro
        // faltando.
        `INSERT INTO tickets (org_id, event_id, session_id, order_id, order_item_id,
                              sector_id, lot_id, ticket_type_id, code, qr_secret,
                              status, is_courtesy, holder_name, holder_email, holder_document,
                              half_reason, half_document, half_document_required)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,encode(gen_random_bytes(16),'hex'),
                 'valido',$10,$11,$12,$13,$14,$15,$16)`,
        [pedido.org_id, pedido.event_id, item.session_id, orderId, item.id,
         item.sector_id, item.lotId, item.ticketTypeId,
         gerarCodigo(prefixo), fechouEmZero,
         // O 1º ingresso fica no nome do comprador; os demais em branco pra
         // ele nomear depois. Nomear todos com o mesmo nome atrapalha a
         // portaria mais do que ajuda.
         k === 0 ? item.comprador_nome : null,
         k === 0 ? item.comprador_email : null,
         k === 0 ? item.comprador_doc : null,
         item.motivoDaMeia ?? null, item.numeroDaMeia ?? null, exigencia])
      n++
      if (semMotivo) meiasSemMotivo++
    }
  }

  // `canceled_at` sai junto quando a reserva foi refeita: a expiração o
  // carimbou, e pedido pago com data de cancelamento é o relatório lendo um
  // cancelamento que não aconteceu.
  await c.query(
    `UPDATE orders SET status = 'pago', paid_at = COALESCE(paid_at, now()),
                       canceled_at = CASE WHEN $2::boolean THEN NULL ELSE canceled_at END
      WHERE id = $1`,
    [orderId, reservaRefeita])
  await c.query(
    `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
     VALUES ($1,'order',$2,'pago',$3::jsonb)`,
    [pedido.org_id, orderId, JSON.stringify(
      reservaRefeita ? { ingressos: n, pagoDepoisDeExpirar: true } : { ingressos: n })])

  return {
    emitiu: true, ingressos: n, pedidoCode: pedido.code,
    // A pergunta respondida pela ORIGEM. Este caminho é o da VENDA (webhook do
    // Asaas e balcão): mesmo fechando em zero, o que sai por aqui é venda.
    cortesia: eCortesia(fechouEmZero, pedido.channel),
    meiasSemMotivo,
    ...(reservaRefeita ? { reservaRefeita: true } : {}),
  }
}
