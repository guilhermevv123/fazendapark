/**
 * envio.ts — a fila de e-mail: quem sai, quando, e o que fazer quando falha.
 *
 * O que `email.ts` monta, este arquivo entrega. A divisão não é estética: o
 * corpo do e-mail é puro (dá pra provar sem banco) e a fila é toda estado
 * compartilhado (só dá pra provar contra o banco, com duas conexões).
 *
 * ## Por que fila, e não `await enviarEmail()` dentro do webhook
 *
 * O handler do Asaas tem prazo. Servidor de e-mail engasga, demora 30 s,
 * devolve 421 e pede pra tentar mais tarde — e se isso acontecer dentro do
 * webhook, o Asaas não recebe 200, reentrega o evento, e a confirmação do
 * PAGAMENTO passa a depender do humor do servidor de e-mail. Dinheiro
 * confirmado não pode depender de correio. Aqui o pagamento grava a linha
 * (gatilho da migração 018, dentro da mesma transação) e vai embora.
 *
 * ## O claim é atômico ou a pessoa recebe duas vezes
 *
 * Dois processos varrendo a mesma fila é o caso normal (duas instâncias no
 * ar, ou o trabalhador de fundo e o reenvio do balcão ao mesmo tempo). Ler
 * com SELECT e marcar depois com UPDATE deixa os dois lerem a MESMA linha
 * antes de qualquer um marcar — e aí o comprador recebe o ingresso em
 * duplicata e liga perguntando se foi cobrado duas vezes. A reserva aqui é
 * UM comando: `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)
 * RETURNING`. Quem chega segundo pula a linha travada em vez de esperar por
 * ela, que é o que mantém dois trabalhadores dividindo trabalho em vez de
 * brigando.
 */
import QRCode from 'qrcode'
import type { PoolClient, Pool } from 'pg'
import { db, q, q1 } from './db'
import { montarQr } from './ingresso'
import { PEDIDO_VIVO } from './liquido'
import {
  entregar, montarConfirmacao, type Entrega, type IngressoNoEmail, type Mensagem,
  type Transporte, transporteEscolhido,
} from './email'

/** Conexão OU pool: a reserva é um comando só e roda bem nos dois. */
type Executor = Pool | PoolClient

export interface LinhaEnvio {
  id: string
  org_id: string
  event_id: string | null
  order_id: string | null
  kind: string
  origin: string
  to_email: string
  to_name: string | null
  status: string
  attempts: number
  max_attempts: number
}

/* ------------------------------------------------------------ transporte */

let transporteInjetado: Transporte | null = null

/**
 * Troca o transporte em tempo de execução. Existe por dois motivos: o teste
 * precisa de um transporte que FALHA de propósito, e trocar o correio por um
 * provedor de API (Resend, SES) depois não pode exigir mexer na fila.
 */
export function usarTransporte(t: Transporte | null) {
  transporteInjetado = t
}

const entregarAgora = (m: Mensagem) => (transporteInjetado ?? entregar)(m)

/* ------------------------------------------------------------- a reserva */

/**
 * A reserva atômica. Exportada porque o teste de concorrência tem que rodar
 * EXATAMENTE este comando — um teste que reimplementa a reserva prova a cópia
 * dele, não a que roda em produção.
 *
 * $1 = quem está reservando (nome do trabalhador, pra rastro)
 * $2 = um id específico, ou NULL pra pegar o próximo da fila
 *
 * Quatro coisas dentro dele:
 *  • `status = 'na_fila' AND available_at <= now()` — respeita o adiamento de
 *    quem falhou e ainda está de castigo.
 *  • **pedido por id fura a espera**: quem apertou "mandar de novo" está com o
 *    cliente na frente e não vai esperar o castigo de uma tentativa anterior
 *    terminar. A varredura de fundo (id nulo) continua respeitando.
 *  • `status = 'enviando' AND claimed_at < now() - 5 min` — resgata a linha
 *    que ficou presa porque o processo morreu no meio. Sem isso, um kill -9
 *    durante o envio some com o ingresso pra sempre.
 *  • `SKIP LOCKED` — o segundo trabalhador pula a linha travada e pega outra.
 */
export const SQL_RESERVA = `
  UPDATE email_sends SET
    status = 'enviando',
    attempts = attempts + 1,
    claimed_at = now(),
    claimed_by = $1
  WHERE id = (
    SELECT id FROM email_sends
     WHERE ($2::uuid IS NULL OR id = $2::uuid)
       AND ( (status = 'na_fila' AND (available_at <= now() OR $2::uuid IS NOT NULL))
          OR (status = 'enviando' AND claimed_at < now() - interval '5 minutes') )
     ORDER BY available_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  RETURNING *`

export async function reservarProximo(
  exec: Executor, trabalhador: string, id?: string | null,
): Promise<LinhaEnvio | null> {
  const r = await exec.query(SQL_RESERVA, [trabalhador, id ?? null])
  return (r.rows[0] as LinhaEnvio) ?? null
}

/* ----------------------------------------------------------- enfileirar */

export interface PedidoParaEnfileirar {
  orgId: string
  eventId: string | null
  orderId: string
  paraEmail: string
  paraNome?: string | null
  origem?: 'automatico' | 'reenvio'
  pedidoPor?: string | null
}

/**
 * Põe na fila. O caminho automático NÃO passa por aqui — lá quem enfileira é
 * o gatilho do banco, na mesma transação do pagamento, justamente pra não
 * existir caminho de código que esqueça de chamar. Esta função é o reenvio
 * pedido no balcão.
 *
 * `exec` aceita a conexão de uma transação já aberta. Não é comodidade: a
 * rota de reenvio decide se enfileira depois de olhar o que já está pendente,
 * e olhar num lugar pra gravar em outro é a corrida clássica — dois cliques
 * simultâneos leem "não tem nada pendente" antes de qualquer um gravar, e o
 * comprador recebe o ingresso duas vezes. Com a conexão da transação, o olhar
 * e a gravação ficam do mesmo lado da trava do pedido.
 */
export async function enfileirar(
  p: PedidoParaEnfileirar, exec?: Executor,
): Promise<string> {
  const sql = `INSERT INTO email_sends (org_id, event_id, order_id, kind, origin,
                                        to_email, to_name, requested_by)
               VALUES ($1,$2,$3,'confirmacao_pedido',$4,$5,$6,$7)
               RETURNING id`
  const valores = [p.orgId, p.eventId, p.orderId, p.origem ?? 'reenvio',
    p.paraEmail.trim(), p.paraNome ?? null, p.pedidoPor ?? null]
  if (exec) return (await exec.query(sql, valores)).rows[0].id
  const linha = await q1<any>(sql, valores)
  return linha!.id
}

/* -------------------------------------------------------- montar o corpo */

/** Erro que NÃO adianta repetir: o adiamento não resolveria. */
class ErroDefinitivo extends Error {}

/**
 * Lê o pedido e devolve o e-mail pronto — com um QR gerado na hora por
 * ingresso.
 *
 * O QR é desenhado aqui, e não guardado: assim ingresso cancelado para de
 * produzir imagem no mesmo instante, sem depender de apagar arquivo nenhum.
 */
export async function montarMensagemDoPedido(
  orderId: string, paraEmail: string, paraNome?: string | null,
): Promise<Mensagem> {
  const o = await q1<any>(
    `SELECT o.id, o.code, o.status, o.total_cents, o.event_id,
            (${PEDIDO_VIVO('o.')}) AS vale_ingresso,
            c.name AS comprador, c.email AS comprador_email,
            e.name AS evento, e.starts_at, e.venue_name, e.city, e.state, e.ticket_noun
       FROM orders o
       JOIN events e ON e.id = o.event_id
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.id = $1`, [orderId])
  if (!o) throw new ErroDefinitivo('o pedido não existe mais')

  // Estorno TOTAL, cancelamento, chargeback: o ingresso não vale mais, e
  // mandar "seus ingressos estão confirmados" depois disso é pior do que não
  // mandar nada — a pessoa aparece no portão com um QR morto.
  if (!o.vale_ingresso) {
    throw new ErroDefinitivo(`o pedido saiu de pago (está ${o.status}) antes do e-mail sair`)
  }

  const ingressos = await q<any>(
    `SELECT t.id, t.code, t.status, t.holder_name,
            s.name AS setor, l.name AS lote, tt.name AS tipo,
            ses.title AS sessao, ses.starts_at AS sessao_inicio
       FROM tickets t
       JOIN lots l ON l.id = t.lot_id
       JOIN sectors s ON s.id = l.sector_id
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN event_sessions ses ON ses.id = s.session_id
      WHERE t.order_id = $1 AND t.status <> 'cancelado'
      ORDER BY s.sort_order, t.issued_at, t.code`, [orderId])

  // Sem ingresso não existe e-mail de ingresso. Isto é retentável de
  // propósito: se a emissão ainda estiver acontecendo, a próxima tentativa
  // encontra tudo no lugar.
  if (!ingressos.length) throw new Error('o pedido ainda não tem ingresso emitido')

  const comQr: IngressoNoEmail[] = []
  for (const t of ingressos) {
    comQr.push({
      id: t.id,
      codigo: t.code,
      setor: t.setor,
      lote: t.lote,
      tipo: t.tipo,
      sessao: t.sessao ?? (t.sessao_inicio ? String(t.sessao_inicio) : null),
      titular: t.holder_name,
      qrPng: await QRCode.toBuffer(montarQr(t.code, o.event_id), {
        margin: 1, width: 360, errorCorrectionLevel: 'M',
      }),
    })
  }

  const local = [o.venue_name, [o.city, o.state].filter(Boolean).join('/')]
    .filter(Boolean).join(' · ')

  return montarConfirmacao({
    pedido: o.code,
    compradorNome: paraNome ?? o.comprador,
    compradorEmail: paraEmail,
    eventoNome: o.evento,
    eventoInicio: o.starts_at,
    local: local || null,
    totalCents: Number(o.total_cents),
    substantivo: o.ticket_noun,
    ingressos: comQr,
    linkIngressos: `${baseDoSite()}/ingressos/${o.code}`,
  })
}

/** A URL pública do site. Sem ela o link do e-mail apontaria pro vazio. */
export function baseDoSite(): string {
  return (process.env.PUBLIC_BASE_URL || 'http://localhost:3100').replace(/\/+$/, '')
}

/* ------------------------------------------------------------ processar */

export interface ResultadoEnvio {
  id: string
  ok: boolean
  status: 'enviado' | 'na_fila' | 'falhou'
  para: string
  via?: Entrega['via']
  arquivo?: string
  erro?: string
  tentativa: number
}

/**
 * Pega UMA linha e leva até o fim. Devolve null quando não havia nada pra
 * fazer — é assim que o laço sabe parar.
 *
 * A reserva é comando próprio, fora de transação longa, de propósito: manter
 * a linha travada durante a conversa com o servidor de e-mail prenderia uma
 * conexão do pool por 30 s a cada envio lento.
 */
export async function processarUm(
  trabalhador = 'padrao', id?: string | null,
): Promise<ResultadoEnvio | null> {
  const linha = await reservarProximo(db(), trabalhador, id)
  if (!linha) return null

  const inicio = Date.now()
  const transporte = transporteInjetado ? 'injetado' : transporteEscolhido()
  try {
    const mensagem = await montarMensagemDoPedido(
      linha.order_id!, linha.to_email, linha.to_name)
    const entrega = await entregarAgora(mensagem)

    await q(
      `UPDATE email_sends SET status = 'enviado', sent_at = now(), sent_via = $2,
              message_id = $3, file_path = $4, subject = $5, body_text = $6,
              body_html = $7, last_error = NULL, claimed_at = NULL
        WHERE id = $1`,
      [linha.id, entrega.via, entrega.messageId, entrega.arquivo ?? null,
       mensagem.assunto, mensagem.texto, mensagem.html])
    await anotarTentativa(linha, entrega.via, true, null, Date.now() - inicio, trabalhador)

    return {
      id: linha.id, ok: true, status: 'enviado', para: linha.to_email,
      via: entrega.via, arquivo: entrega.arquivo, tentativa: linha.attempts,
    }
  } catch (e: any) {
    const erro = legivel(e, linha.to_email)
    // Erro definitivo não ganha nova chance: repetir um pedido estornado
    // cinco vezes só enche o log e atrasa a fila de quem tem ingresso válido.
    const desiste = e instanceof ErroDefinitivo || linha.attempts >= linha.max_attempts
    await q(
      `UPDATE email_sends SET status = $2, last_error = $3, claimed_at = NULL,
              available_at = CASE WHEN $2 = 'na_fila'
                                  THEN now() + make_interval(secs => $4) ELSE available_at END
        WHERE id = $1`,
      [linha.id, desiste ? 'falhou' : 'na_fila', erro, adiamentoSegundos(linha.attempts)])
    await anotarTentativa(linha, transporte, false, erro, Date.now() - inicio, trabalhador)

    return {
      id: linha.id, ok: false, status: desiste ? 'falhou' : 'na_fila',
      para: linha.to_email, erro, tentativa: linha.attempts,
    }
  }
}

/** 30 s, 1 min, 2 min, 4 min… com teto de 1 h. */
export function adiamentoSegundos(tentativa: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, tentativa - 1))
}

async function anotarTentativa(
  linha: LinhaEnvio, transporte: string, ok: boolean,
  erro: string | null, ms: number, trabalhador: string,
) {
  await q(
    `INSERT INTO email_send_attempts (send_id, attempt, worker, transport, ok, error, ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [linha.id, linha.attempts, trabalhador, transporte, ok, erro, ms])
}

/**
 * Mensagem de erro escrita pra quem atende o cliente, não pro log. "550" não
 * ajuda ninguém no guichê; "a caixa de entrada recusou" ajuda.
 */
export function legivel(e: any, destino: string): string {
  const cru = String(e?.message ?? e ?? 'erro desconhecido')
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|não respondeu|encerrou a conexão/i.test(cru)) {
    return `Não consegui falar com o servidor de e-mail para entregar em ${destino}: ${cru}`
  }
  return `Não consegui entregar em ${destino}: ${cru}`
}

/** Varre a fila até acabar (ou até o teto). Devolve o que fez. */
export async function processarFila(
  limite = 25, trabalhador = 'fila',
): Promise<ResultadoEnvio[]> {
  const feitos: ResultadoEnvio[] = []
  for (let i = 0; i < limite; i++) {
    const r = await processarUm(trabalhador)
    if (!r) break
    feitos.push(r)
  }
  return feitos
}

/* -------------------------------------------------------- trabalhador */

let relogio: ReturnType<typeof setInterval> | null = null
let rodando = false

export const INTERVALO_MS = Number(process.env.ENVIO_INTERVALO_MS || 15_000)

/**
 * Liga o trabalhador de fundo. Idempotente: chamar dez vezes não cria dez
 * laços.
 *
 * `unref()` pra não segurar o processo vivo — sem isso, o mesmo laço que
 * mantém a fila andando em produção travaria o `vitest` no fim da suíte.
 */
export function garantirWorker(): boolean {
  if (relogio || process.env.DT_ENVIO_WORKER === 'off') return false
  relogio = setInterval(() => {
    if (rodando) return   // varredura anterior ainda não terminou
    rodando = true
    processarFila()
      .then((f) => {
        // Só fala quando fez alguma coisa: "0 enviados" a cada 15 s esconde
        // o dia em que 300 falharem de uma vez.
        const ruins = f.filter((r) => !r.ok)
        if (f.length) console.log(`[envio] ${f.length - ruins.length} enviado(s)` +
          (ruins.length ? `, ${ruins.length} com falha: ${ruins[0].erro}` : ''))
      })
      .catch((e) => console.error('[envio] varredura falhou:', e?.message ?? e))
      .finally(() => { rodando = false })
  }, INTERVALO_MS)
  relogio.unref?.()
  return true
}

export function pararWorker() {
  if (relogio) clearInterval(relogio)
  relogio = null
}

// Sobe junto com quem importar este módulo. `DT_ENVIO_WORKER=off` desliga —
// é o que o teste usa pra decidir na mão quando a fila anda.
garantirWorker()
