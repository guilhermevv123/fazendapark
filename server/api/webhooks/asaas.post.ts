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
 *
 * 6. **A linha sem baixa é uma FILA, e fila precisa de consumidor.** Por muito
 *    tempo a decisão 5 foi meia verdade: nada lia `processed_at IS NULL` (o
 *    único leitor, a tela de reconciliação, mostra e não reprocessa) e, como
 *    a resposta é 200, o Asaas também nunca reentrega. A entrega que falha
 *    alto de propósito — estorno parcial sem o valor no payload — ficava
 *    perdida pra sempre: o pedido seguia 'pago' com `refunded_cents = 0` e o
 *    líquido contava dinheiro que já tinha voltado pro comprador. O consumidor
 *    é `reprocessarEntregasPendentes()`, e ele sobe daqui.
 */
import { q, q1 } from '../../utils/db'
import {
  SQL_REGISTRAR_EVENTO, aplicarEntregaDoAsaas, chaveDoEvento, conferirSegredoWebhook,
  ehUuid, garantirWorkerDoWebhook,
} from '../../utils/asaas'

// A fila de reprocessamento nasce AQUI (toda entrega que não dá baixa fica com
// `processed_at` nulo), então é daqui que o consumidor dela sobe. Antes não
// subia de lugar nenhum: nada lia `processed_at IS NULL`, e como a rota
// responde 200 o Asaas também nunca reentrega — a entrega pendurada ficava
// perdida pra sempre, com o dinheiro dela fora da conta do líquido.
garantirWorkerDoWebhook()

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


  // ----------------------------------------- 3. o efeito, e a conta da tentativa
  // O efeito mora em `utils/asaas.ts` (`aplicarEntregaDoAsaas`) porque ele tem
  // DOIS chamadores: esta rota e o reprocessador da fila de entregas
  // penduradas. Um reprocessador com lógica própria provaria a cópia dele, não
  // o que o webhook faz com o dinheiro.
  const desfecho = await aplicarEntregaDoAsaas({
    registroId, chave, nomeEvento, pagamento, referencia, idCobranca,
  })
  if (desfecho.ok) return desfecho.resultado

  // Banco fora → 500 pro Asaas reentregar. Erro de lógica já virou linha, com
  // `attempts` contado e `processed_at` nulo: fica na fila do reprocessador.
  if (desfecho.indisponivel) {
    throw createError({ statusCode: 500, statusMessage: 'indisponível' })
  }
  return { ok: true, erro: 'registrado para reprocessar' }
})
