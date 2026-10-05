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
 * 5. **Gravou, responde 200 — aconteça o que acontecer depois.** Erro de
 *    lógica E falha de infra no processamento ficam registrados na linha (com
 *    `attempts`), não no status HTTP: a linha sem baixa é a fila do
 *    reprocessador, que termina o serviço. Até 05/10 a falha de infra depois
 *    da gravação respondia 500 "pra o Asaas reentregar" — só que o Asaas conta
 *    como falha todo não-200 e, depois de 15 falhas SEGUIDAS, INTERROMPE a fila
 *    de webhooks da conta inteira (docs.asaas.com/docs/fila-pausada): um banco
 *    lento por alguns minutos parava todos os avisos, de todos os pedidos, até
 *    alguém reativar no painel. A reentrega não acrescentava nada que a linha
 *    gravada já não tenha. **500 só quando o próprio INSERT falha** — aí não há
 *    linha, e a reentrega é a única cópia do aviso.
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
import { tx } from '../../utils/db'
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

/** O teto do registro da entrega (o INSERT). O processamento tem o dele (`PRAZO_DA_ENTREGA`). */
const PRAZO_DO_REGISTRO = '5s'

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
  // Daqui até o registro existir, erro sobe como 500: sem a linha, a reentrega do Asaas é a única
  // cópia do aviso. Depois dele, nunca mais (ver a decisão 5).
  //
  // Com prazo próprio: a chave estrangeira pra `orders` faz o INSERT esperar quem estiver com a
  // linha do pedido em `FOR UPDATE` (a emissão de outra entrega do mesmo pedido, a fila de
  // estorno). Esperar além dos 10 s do Asaas é falha do mesmo jeito — e prende uma conexão do pool.
  const registro = await tx(async (c) => {
    await c.query(`SET LOCAL statement_timeout = '${PRAZO_DO_REGISTRO}'`)
    const { rows: inserido } = await c.query(SQL_REGISTRAR_EVENTO,
      [chave, idCobranca || null, nomeEvento,
       ehUuid(referencia) ? referencia : null, JSON.stringify(corpo)])
    if (inserido[0]?.id) return { id: inserido[0].id as string, terminado: false }
    const { rows: anterior } = await c.query(
      `SELECT id, processed_at FROM payment_events
        WHERE provider = 'asaas' AND gateway_event_id = $1`, [chave])
    return { id: (anterior[0]?.id as string | undefined), terminado: !anterior[0] || !!anterior[0].processed_at }
  })
  if (registro.terminado || !registro.id) return { ok: true, repetido: true, evento: chave }
  // Sem linha nova e sem baixa: a tentativa anterior não chegou ao fim (queda no meio, banco fora).
  // É exatamente pra isso que a reentrega existe: segue e processa.
  const registroId: string = registro.id


  // ----------------------------------------- 3. o efeito, e a conta da tentativa
  // O efeito mora em `utils/asaas.ts` (`aplicarEntregaDoAsaas`) porque ele tem
  // DOIS chamadores: esta rota e o reprocessador da fila de entregas
  // penduradas. Um reprocessador com lógica própria provaria a cópia dele, não
  // o que o webhook faz com o dinheiro.
  let desfecho: Awaited<ReturnType<typeof aplicarEntregaDoAsaas>>
  try {
    desfecho = await aplicarEntregaDoAsaas({
      registroId, chave, nomeEvento, pagamento, referencia, idCobranca,
    })
  } catch (erro: any) {
    // `aplicarEntregaDoAsaas` não lança — mas se um dia lançar, a linha já existe: 200 do mesmo jeito
    desfecho = { ok: false, erro: erro?.message ?? String(erro), indisponivel: true }
  }
  if (desfecho.ok) return desfecho.resultado

  // Gravado e não processado (erro de lógica, banco lento, linha travada, prazo estourado): a
  // linha tem `attempts` contado e `processed_at` nulo — é a fila do reprocessador. 200 sempre.
  if (desfecho.indisponivel) console.warn(`[webhook asaas] ${chave}: ${desfecho.erro} — fica pro reprocessador`)
  return { ok: true, erro: 'registrado para reprocessar' }
})
