/**
 * POST /api/webhooks/asaas — a única porta por onde a plataforma descobre que
 * o dinheiro entrou.
 *
 * Cinco decisões, todas com preço conhecido:
 *
 * 1. **Confere o segredo antes de tudo.** Sem isso, quem descobrir a URL posta
 *    "PAYMENT_RECEIVED" e retira ingresso de graça. Ver
 *    `conferirSegredoWebhook()` em utils/asaas.ts.
 *
 * 2. **Grava ANTES de agir.** O payload vira linha em `payment_events` antes de
 *    qualquer efeito. Quando um pagamento "não cai", a primeira pergunta é "o
 *    Asaas mandou?" — e sem a linha crua não existe resposta.
 *
 * 3. **A idempotência é o índice único `(provider, gateway_event_id)`, não um
 *    if.** O Asaas reenvia a mesma entrega quando não recebe 200 (e também
 *    quando o 200 demora). Entre um `SELECT` que procura e um `INSERT` que
 *    grava cabe a segunda entrega inteira; o índice único não tem esse vão.
 *    Reentrega do que já terminou: **200 e ponto final, sem reprocessar** —
 *    devolver erro faz o Asaas retentar pra sempre.
 *
 * 4. **Efeito e baixa no MESMO commit.** Emitir o ingresso e marcar o evento
 *    como processado são a mesma transação: se a segunda falhasse sozinha, a
 *    reentrega emitiria de novo.
 *
 * 5. **Responde 200 mesmo quando não soube tratar.** Erro de lógica fica
 *    registrado na linha (com `attempts`), não no status HTTP. A exceção é
 *    falha de infra (banco fora): aí 500 é certo, porque aí queremos a
 *    reentrega.
 */
import { q, q1, tx } from '../../utils/db'
import type { PoolClient } from 'pg'
import {
  EVENTOS_QUE_IMPORTAM, SQL_REGISTRAR_EVENTO, chaveDoEvento, conferirSegredoWebhook,
  permiteAnotarStatus, reaisParaCentavos, statusDoEvento, valorEstornadoCents,
} from '../../utils/asaas'
import { emitirNaTransacao } from '../../utils/emissao'
import { liberar } from '../../utils/estoque'

/**
 * Pedido cujo desfazimento já aconteceu. Reentrega não desfaz de novo:
 * `liberar()` rodado duas vezes come a reserva de OUTRO pedido do mesmo lote
 * (o `GREATEST(...,0)` só segura quando a reserva é do pedido sozinho), e o
 * lote passa a vender lugar que não existe.
 *
 * `disputa` está aqui e isso NÃO é enfeite. O caminho do chargeback no Asaas é
 * uma sequência de três eventos, não um:
 *
 *   PAYMENT_CHARGEBACK_REQUESTED → desfaz (o pedido sai de 'pago')
 *   PAYMENT_AWAITING_CHARGEBACK_REVERSAL → só anota: 'chargeback' vira 'disputa'
 *   PAYMENT_CHARGEBACK_DISPUTE → desfaz DE NOVO
 *
 * No terceiro o pedido está em 'disputa'. Sem 'disputa' nesta lista ele não
 * conta como desfeito, e como também não está em 'pago' o `desfazer` cai no
 * `liberar()` — que subtrai `reserved` de um pedido que não reserva mais nada.
 * Medido: lote com um vizinho segurando 5 lugares ficou com 3 depois da
 * sequência. Os 2 lugares não voltaram pro vizinho; o lote passou a achar que
 * tem 2 a mais pra vender.
 *
 * Só se chega em 'disputa' vindo de 'chargeback' (ver `permiteAnotarStatus`),
 * e 'chargeback' já desfez — então 'disputa' SEMPRE quer dizer "já desfeito".
 */
const JA_DESFEITO = new Set([
  'estornado', 'cancelado', 'chargeback', 'disputa', 'expirado', 'falhou',
])

export default defineEventHandler(async (event) => {
  // ------------------------------------------------------------- 1. segredo
  const veredicto = conferirSegredoWebhook({
    esperado: process.env.ASAAS_WEBHOOK_TOKEN,
    recebido: getHeader(event, 'asaas-access-token'),
    producao: process.env.NODE_ENV === 'production',
  })
  if (!veredicto.ok) {
    // Nada é gravado aqui de propósito: quem não passou da porta não escreve
    // no banco, senão a própria trilha vira alvo de inundação.
    console.warn('[webhook asaas] recusado:', veredicto.motivo)
    throw createError({ statusCode: veredicto.status!, statusMessage: veredicto.motivo! })
  }
  if (veredicto.aviso) console.warn('[webhook asaas]', veredicto.aviso)

  const corpo = (await readBody<any>(event)) ?? {}
  const nomeEvento = String(corpo?.event || '') || 'desconhecido'
  const pagamento = corpo?.payment ?? {}
  const idCobranca = String(pagamento?.id ?? '')
  const referencia = pagamento?.externalReference
  const chave = chaveDoEvento(corpo)

  // ----------------------------------- 2. registra ANTES de qualquer efeito
  // O `ON CONFLICT DO NOTHING` é a trava: duas entregas simultâneas do mesmo
  // evento disputam a mesma linha do índice único e só uma sai daqui com id.
  const inserido = await q<{ id: string }>(SQL_REGISTRAR_EVENTO,
    [chave, idCobranca || null, nomeEvento,
     ehUuid(referencia) ? referencia : null, JSON.stringify(corpo)])

  let registroId: string | undefined = inserido[0]?.id
  if (!registroId) {
    const anterior = await q1<any>(
      `SELECT id, processed_at FROM payment_events
        WHERE provider = 'asaas' AND gateway_event_id = $1`, [chave])
    if (!anterior || anterior.processed_at) {
      return { ok: true, repetido: true, evento: chave }
    }
    // A tentativa anterior não chegou ao fim (queda no meio, banco fora). É
    // exatamente pra isso que a reentrega existe: segue e processa.
    registroId = anterior.id as string
  }

  // --------------------------------------------- 3. efeito, dentro de uma tx
  try {
    return await tx(async (c) => {
      // Trava a linha do evento. Se duas entregas passaram pela porta acima ao
      // mesmo tempo (a segunda achou a linha ainda não processada), a segunda
      // espera aqui e encontra `processed_at` preenchido.
      const { rows: linhas } = await c.query(
        `SELECT processed_at FROM payment_events WHERE id = $1 FOR UPDATE`, [registroId])
      if (!linhas[0] || linhas[0].processed_at) {
        return { ok: true, repetido: true, evento: chave }
      }

      /** fecha a linha do evento no MESMO commit do efeito */
      const concluir = (erro?: string | null) =>
        c.query(
          `UPDATE payment_events
              SET processed_at = now(), attempts = attempts + 1, error = $2
            WHERE id = $1`, [registroId, erro ?? null])

      if (!EVENTOS_QUE_IMPORTAM.has(nomeEvento)) {
        await concluir()
        return { ok: true, ignorado: nomeEvento }
      }

      // O externalReference é nosso order.id. Se faltar, cai pro asaas_payment_id.
      // `FOR UPDATE` aqui e não depois: quem lê o status do pedido pra decidir
      // precisa ser o mesmo que o escreve, sem ninguém no meio.
      const { rows: pedidos } = ehUuid(referencia)
        ? await c.query(
            `SELECT id, status, total_cents FROM orders WHERE id = $1 FOR UPDATE`,
            [referencia])
        : await c.query(
            `SELECT id, status, total_cents FROM orders
              WHERE asaas_payment_id = $1 FOR UPDATE`, [idCobranca])
      const pedido = pedidos[0]

      if (!pedido) {
        await concluir('pedido não encontrado')
        return { ok: true, aviso: 'pedido não encontrado' }
      }

      // Liga o evento ao pedido também quando quem achou foi o `asaas_payment_id`
      // (cobrança sem externalReference). A única tela que mostra esta trilha
      // procura por `order_id`; sem isto o operador abre o pedido e vê "o Asaas
      // nunca mandou nada" com o evento gravado do lado.
      await c.query(
        `UPDATE payment_events SET order_id = $2 WHERE id = $1 AND order_id IS NULL`,
        [registroId, pedido.id])

      const novo = statusDoEvento(nomeEvento, pagamento)
      if (!novo) {
        // Status que o gateway inventou depois. Fica registrado sem virar efeito.
        await concluir(`status desconhecido: ${pagamento?.status}`)
        return { ok: true, aviso: 'status desconhecido' }
      }

      // ---------------------------------------------------------- pagamento
      if (novo === 'pago') {
        const r = await emitirNaTransacao(c, pedido.id)
        await concluir(r.emitiu ? null : `não emitiu: ${r.motivo}`)
        return { ok: true, pedido: pedido.id, emitiu: r.emitiu, ingressos: r.ingressos }
      }

      // ---------------------------------------------------- estorno parcial
      if (novo === 'estornado_parcial') {
        const devolvido = valorEstornadoCents(pagamento)
        if (devolvido == null || devolvido <= 0) {
          // Gravar 'estornado_parcial' com zero devolvido faria o líquido
          // contar o pedido INTEIRO como se nada tivesse voltado. Erra em
          // dinheiro e não aparece em lugar nenhum. Falha alto: a linha fica
          // sem `processed_at`, ou seja, na fila de quem precisa olhar.
          throw new Error('estorno parcial sem valor devolvido no payload')
        }
        const total = Number(pedido.total_cents)
        if (devolvido >= total) {
          // Devolveu tudo, em parcelas: isso é estorno total, e desfaz a venda.
          await desfazer(c, pedido, 'estornado', total)
          await concluir('estorno parcial devolveu o total: gravado como estorno total')
          return { ok: true, pedido: pedido.id, status: 'estornado', estornadoCents: total }
        }
        // Atribuição, não soma: `refundedValue` é o acumulado da cobrança, e
        // somar faria a reentrega inflar o estorno.
        await c.query(
          `UPDATE orders SET status = 'estornado_parcial', refunded_at = now(),
                             refunded_cents = $2
            WHERE id = $1`, [pedido.id, devolvido])
        await concluir()
        return { ok: true, pedido: pedido.id, status: novo, estornadoCents: devolvido }
      }

      // -------------------------------------- estorno / cancelamento / chargeback
      if (novo === 'estornado' || novo === 'cancelado' || novo === 'chargeback') {
        // 'cancelado' é cobrança apagada antes de pagar: ninguém devolveu nada,
        // então `refunded_cents` fica como está em vez de fingir um estorno.
        const devolvido = novo === 'cancelado'
          ? null
          : limitar(valorEstornadoCents(pagamento)
                    ?? reaisParaCentavos(pagamento?.value)
                    ?? Number(pedido.total_cents), Number(pedido.total_cents))
        const r = await desfazer(c, pedido, novo, devolvido)
        await concluir(r.motivo ?? null)
        return { ok: true, pedido: pedido.id, status: r.mexeu ? novo : pedido.status,
                 desfez: r.mexeu }
      }

      // ------------------------------------------- só anota (não mexe em nada)
      if (!permiteAnotarStatus(pedido.status, novo)) {
        await concluir(`evento fora de ordem: pedido já em ${pedido.status}`)
        return { ok: true, pedido: pedido.id, status: pedido.status, foraDeOrdem: true }
      }
      await c.query(`UPDATE orders SET status = $2 WHERE id = $1`, [pedido.id, novo])
      await concluir()
      return { ok: true, pedido: pedido.id, status: novo }
    })
  } catch (e: any) {
    const motivo = e?.message ?? String(e)
    // A transação já voltou atrás: nenhum efeito ficou pela metade. A conta da
    // tentativa é gravada FORA dela, senão o rollback apagaria a própria
    // anotação do erro. `processed_at` segue nulo — a linha fica na fila.
    await q(`UPDATE payment_events SET attempts = attempts + 1, error = $2 WHERE id = $1`,
      [registroId, motivo]).catch(() => {})
    // Banco fora → 500 pro Asaas reentregar. Erro de lógica já virou linha.
    if (/ECONNREFUSED|timeout|Connection terminated|too many clients/i.test(motivo)) {
      throw createError({ statusCode: 500, statusMessage: 'indisponível' })
    }
    return { ok: true, erro: 'registrado para reprocessar' }
  }
})

/**
 * Desfaz o pedido: devolve estoque e marca o status final.
 *
 * Dentro da transação de quem chama, com a linha do pedido já travada.
 */
async function desfazer(
  c: PoolClient,
  pedido: { id: string; status: string; total_cents: number | string },
  status: string,
  refundCents: number | null,
): Promise<{ mexeu: boolean; motivo?: string }> {
  if (JA_DESFEITO.has(pedido.status)) {
    // Segunda camada da idempotência, pra quando a repetição não vem do mesmo
    // evento: o Asaas manda PAYMENT_DELETED e depois PAYMENT_REFUNDED da mesma
    // cobrança, com ids diferentes. Devolver o estoque de novo tira lugar de
    // quem está com reserva em pé no mesmo lote.
    return { mexeu: false, motivo: `pedido já estava em ${pedido.status}` }
  }

  const { rows: itens } = await c.query(
    `SELECT lot_id AS "lotId", ticket_type_id AS "ticketTypeId", quantity AS quantidade
       FROM order_items WHERE order_id = $1`, [pedido.id])

  if (pedido.status === 'pago' || pedido.status === 'estornado_parcial') {
    // Já tinha virado venda: desfaz a venda, não a reserva.
    for (const i of itens) {
      await c.query(`UPDATE lots SET sold = GREATEST(sold - $2, 0) WHERE id = $1`,
        [i.lotId, i.quantidade])
      // A COTA DO TIPO também volta. `reservar()` soma em `ticket_types.sold` e
      // `confirmar()` não mexe nessa coluna — quem devolve é só `liberar()`, que
      // este ramo não chama. Sem esta linha, estornar uma venda devolvia o lugar
      // em `lots` e deixava a cota de "meia"/"inteira" consumida pra sempre:
      // medido, um estorno de 2 meias deixou o tipo em 2/4 com o lote vazio, e a
      // porta de venda (`sold + n <= quantity`) recusa a próxima meia com o
      // parque com lugar sobrando.
      if (i.ticketTypeId) {
        await c.query(`UPDATE ticket_types SET sold = GREATEST(sold - $2, 0) WHERE id = $1`,
          [i.ticketTypeId, i.quantidade])
      }
    }
    await c.query(
      `UPDATE tickets SET status = 'cancelado', canceled_at = now()
        WHERE order_id = $1 AND status <> 'usado'`, [pedido.id])
    // Ingresso que JÁ ENTROU não é cancelado: a pessoa usou o parque. Vira
    // prejuízo a cobrar, não estoque de volta — e some do relatório se a
    // gente apagar.
  } else {
    await liberar(c, itens)
  }

  await c.query(
    `UPDATE orders SET status = $2, canceled_at = now(),
            refunded_at = CASE WHEN $2 LIKE 'estornado%' OR $2 = 'chargeback'
                               THEN now() ELSE refunded_at END,
            refunded_cents = COALESCE($3, refunded_cents)
      WHERE id = $1`, [pedido.id, status, refundCents])
  return { mexeu: true }
}

/** nunca devolver mais do que entrou */
function limitar(valor: number, teto: number): number {
  return Math.max(0, Math.min(valor, teto))
}

function ehUuid(v: any): boolean {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}
