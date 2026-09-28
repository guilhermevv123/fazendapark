/**
 * mercadopago.ts — o Pix do Mercado Pago dentro do pedido.
 *
 * A conversa com a API mora em `mercadopago-conta.ts`. Aqui fica o que mexe em pedido, e a regra
 * que governa o arquivo é uma só: **o Pix do MP anda pelo MESMO trilho do Asaas.** O estado do
 * pagamento vira fatos no vocabulário que `aplicarEventoDoAsaas` já sabe aplicar (pago, estorno,
 * cancelado, disputa), gravados em `payment_events` com `provider = 'mercadopago'`. Emissão,
 * conferência de valor, pago-no-vão, estorno parcial e chargeback são os do Asaas — testados,
 * medidos, com as lições de cada incidente. Uma segunda máquina de estados pro mesmo dinheiro seria
 * a segunda verdade que esta casa passou setembro inteiro desfazendo.
 *
 * Quatro portas chegam no mesmo `processarPagamentoMp`:
 *
 *   · o aviso do MP (`api/webhooks/mercadopago/[org].post.ts`) — rápido, mas é só um aviso;
 *   · a varredura de minuto em minuto dos Pix esperando (`varrerPixEsperando`) — é ela que garante
 *     o ingresso mesmo com o webhook mal configurado ou o aviso perdido;
 *   · o cancelamento do Pix de reserva vencida (`cancelarPixVencidos`) — o MP NÃO expira o Pix no
 *     vencimento (só marca 30 dias depois), então quem fecha a porta somos nós;
 *   · o reprocesso das entregas penduradas (`reprocessarFatosMp`).
 *
 * Todas perguntam ao MP com o token da organização DONA do pedido e aplicam a resposta. Nenhuma
 * confia no corpo do aviso. As três varreduras rodam na tarefa `mercadopago-pix`, separada da
 * `liberar-expirados` de propósito: MP lento não segura a devolução de estoque de ninguém.
 */
import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'
import { db, q, q1 } from './db'
import { aplicarEntregaDoAsaas, CARENCIA_REPROCESSO_MIN, MAX_REPROCESSOS } from './asaas'
import { reais as formatarReais } from './dinheiro'
import { baseDoSite } from './envio'
import {
  buscarPagamento, cancelarPagamento, centavosDoMp, corpoDoPix, criarPix, devolvidoNoMp,
  ehFalhaPassageira, ErroMercadoPago, estornarPagamento, fatosDoPagamento, MP_AINDA_ESPERANDO,
  reaisDoMp, resumoDoPagamento, tarifaELiquido, tokenDaOrg, urlDoAviso, type OrgMercadoPago,
} from './mercadopago-conta'

/* ============================================================ criar o Pix */

export interface PixDoPedido {
  paymentId: string
  copiaECola: string
  qrBase64: string
}

/**
 * Gera o Pix do pedido no MP. A chave de idempotência é do PEDIDO: um reenvio da mesma chamada
 * não cria um segundo Pix pro mesmo ingresso.
 *
 * Sem copia-e-cola não há o que mostrar ao comprador — o Pix criado é cancelado na hora (melhor
 * esforço) e quem chama desfaz o pedido. A imagem, quando o MP não manda (no sandbox vem vazia), é
 * desenhada aqui a partir do copia-e-cola: é o mesmo QR.
 */
export async function gerarPixDoPedido(a: {
  org: OrgMercadoPago & { id: string }
  pedido: { id: string; code: string }
  valorCents: number
  descricao: string
  expiraEm: Date
  comprador: { email: string; nome: string; cpf: string }
}): Promise<PixDoPedido> {
  const token = tokenDaOrg(a.org)
  const corpo = corpoDoPix({
    valorCents: a.valorCents, descricao: a.descricao, pedidoId: a.pedido.id, expiraEm: a.expiraEm,
    urlDeAviso: urlDoAviso(baseDoSite(), a.org.id), comprador: a.comprador,
  })
  const pix = await criarPix(token, corpo, `pix-${a.pedido.id}`)
  if (!pix.id || !pix.copiaECola) {
    if (pix.id) await cancelarPagamento(token, pix.id).catch(() => {})
    throw new ErroMercadoPago(0, pix, 'o Mercado Pago não devolveu o QR do Pix')
  }
  const qrBase64 = pix.qrBase64
    ?? (await QRCode.toDataURL(pix.copiaECola, { margin: 1, width: 400 })).split(',')[1]!
  return { paymentId: pix.id, copiaECola: pix.copiaECola, qrBase64 }
}

/* ================================================= aplicar o que o MP diz */

/**
 * O registro cru de cada fato — a primeira coisa que acontece, antes do efeito (a mesma regra do
 * webhook do Asaas: "grava antes de agir"). `ON CONFLICT DO NOTHING` sobre `(provider,
 * gateway_event_id)` é a idempotência: o mesmo fato chegando pelo aviso e pela varredura no mesmo
 * segundo disputa a mesma linha do índice, e só um sai daqui com id.
 */
export const SQL_REGISTRAR_FATO_MP = `
  INSERT INTO payment_events (provider, gateway_event_id, external_id, event_name, order_id, payload)
  VALUES ('mercadopago', $1, $2, $3, (SELECT o.id FROM orders o WHERE o.id = $4::uuid), $5::jsonb)
  ON CONFLICT (provider, gateway_event_id) DO NOTHING
  RETURNING id`

export interface DesfechoMp {
  ok: boolean
  pedidoId?: string
  /** o status que o MP respondeu */
  statusMp?: string
  /** o MP ainda espera o Pix: nada foi gravado */
  pendente?: boolean
  /** fatos NOVOS aplicados nesta chamada */
  fatos?: number
  /** pago sem lugar: o fato ficou na fila pra alguém (ou o reprocesso) resolver */
  pendurado?: boolean
  aviso?: string | null
  ignorado?: string
  erro?: string
  /** vale tentar de novo (rede, MP fora, banco fora) */
  passageira?: boolean
  /** o pedido diz devolvido e o MP ainda não confirmou (em processamento ou recusado): a frase */
  devolucaoAConfirmar?: string | null
}

/**
 * Pergunta ao MP o estado do pagamento e aplica no pedido.
 *
 * O pedido é achado por `(org_id, mp_payment_id)` — nunca pela referência que vem de fora —, e o
 * token é o da organização dele. Duas conferências antes de qualquer efeito: o MP respondeu o
 * pagamento que foi perguntado, e o `external_reference` dele é ESTE pedido. Qualquer divergência
 * para tudo e diz por quê.
 *
 * `pagamento`: quem já tem a resposta do MP na mão (o cancelamento do vencido) passa ela e poupa
 * uma consulta.
 *
 * `contarTentativa`: o reprocesso conta cada volta nas linhas penduradas deste pagamento — é a
 * conta que dá a carência crescente e o teto (`MAX_REPROCESSOS`). O aviso e a varredura não contam:
 * o MP manda o mesmo aviso várias vezes, e cada um gastaria uma tentativa à toa.
 */
export async function processarPagamentoMp(a: {
  orgId: string; paymentId: string; pagamento?: any; contarTentativa?: boolean
}): Promise<DesfechoMp> {
  const pedido = await q1<any>(
    `SELECT o.id, o.status, org.mp_access_token
       FROM orders o JOIN organizations org ON org.id = o.org_id
      WHERE o.org_id = $1 AND o.mp_payment_id = $2`, [a.orgId, a.paymentId])
  if (!pedido) return { ok: true, ignorado: 'pagamento que não é de pedido desta organização' }

  let p = a.pagamento
  if (!p) {
    try {
      p = await buscarPagamento(tokenDaOrg(pedido), a.paymentId)
    } catch (e: any) {
      const erro = e?.message ?? String(e)
      // Sem resposta nada é aplicado — mas a linha pendurada deste pagamento ganha a volta e o
      // motivo. Sem isso o reprocesso girava sem teto, e a tela mostrava o erro de ontem.
      if (a.contarTentativa) {
        await q(
          `UPDATE payment_events SET attempts = attempts + 1, error = $2
            WHERE provider = 'mercadopago' AND external_id = $1 AND processed_at IS NULL`,
          [a.paymentId, `sem resposta do Mercado Pago: ${erro}`.slice(0, 500)]).catch(() => {})
      }
      return { ok: false, pedidoId: pedido.id, erro, passageira: ehFalhaPassageira(e) }
    }
  }
  if (String(p?.id ?? '') !== a.paymentId) {
    return { ok: false, pedidoId: pedido.id, erro: `o Mercado Pago respondeu outro pagamento (${p?.id}) no lugar de ${a.paymentId}` }
  }
  if (p?.external_reference != null && String(p.external_reference) !== pedido.id) {
    console.warn(`[mercadopago] pagamento ${a.paymentId} diz ser do pedido ${p.external_reference}, mas é do ${pedido.id}: nada aplicado`)
    return { ok: false, pedidoId: pedido.id, erro: 'a referência do pagamento no Mercado Pago não é este pedido' }
  }

  const statusMp = String(p?.status ?? '').toLowerCase()
  const fatos = fatosDoPagamento(p, pedido.status)
  if (!fatos.length) {
    return { ok: true, pedidoId: pedido.id, statusMp, pendente: MP_AINDA_ESPERANDO.has(statusMp), fatos: 0 }
  }

  let aplicados = 0
  let aviso: string | null = null
  for (const f of fatos) {
    const payload = JSON.stringify({ event: f.nomeEvento, payment: f.pagamento, mercadopago: resumoDoPagamento(p) })
    const novo = await q<{ id: string }>(SQL_REGISTRAR_FATO_MP,
      [f.chave, a.paymentId, f.nomeEvento, pedido.id, payload])
    let registroId = novo[0]?.id
    if (!registroId) {
      const antes = await q1<any>(
        `SELECT id, processed_at FROM payment_events
          WHERE provider = 'mercadopago' AND gateway_event_id = $1`, [f.chave])
      if (!antes || antes.processed_at) continue // esse fato já foi aplicado
      registroId = antes.id as string
      // o fato é o mesmo; a foto do pagamento é mais nova
      await q(`UPDATE payment_events SET payload = $2::jsonb WHERE id = $1`, [registroId, payload])
    }
    const d = await aplicarEntregaDoAsaas({
      registroId, chave: f.chave, nomeEvento: f.nomeEvento, pagamento: f.pagamento,
      referencia: pedido.id, idCobranca: a.paymentId,
    })
    if (!d.ok) {
      return { ok: false, pedidoId: pedido.id, statusMp, fatos: aplicados, erro: d.erro, passageira: d.indisponivel }
    }
    aviso = d.resultado?.aviso ?? aviso
    // Pago sem lugar (o Pix caiu depois de a reserva morrer e o lugar já é de outro): o fato fica
    // na fila, sem baixa, e os fatos seguintes (um estorno, por exemplo) esperam por ele.
    if (d.resultado?.pendente) {
      return { ok: true, pedidoId: pedido.id, statusMp, fatos: aplicados, pendurado: true, aviso }
    }
    aplicados++
  }

  const { taxaCents, liquidoCents } = tarifaELiquido(p)
  if (taxaCents != null || liquidoCents != null) {
    await q(
      `UPDATE orders SET gateway_fee_cents = COALESCE($2, gateway_fee_cents),
                         gateway_net_cents = COALESCE($3, gateway_net_cents)
        WHERE id = $1`, [pedido.id, taxaCents, liquidoCents])
  }
  const devolucao = await conferirDevolucaoMp({
    orgId: a.orgId, pedidoId: pedido.id, paymentId: a.paymentId, pagamento: p,
    contarTentativa: !!a.contarTentativa,
  })
  return { ok: true, pedidoId: pedido.id, statusMp, fatos: aplicados, aviso: devolucao ?? aviso, devolucaoAConfirmar: devolucao }
}

/* ============================================ a devolução que o MP não confirmou */

/**
 * O pedido diz "devolvido X"; o MP diz quanto devolveu. Com o nosso número maior, o dinheiro ainda
 * não voltou pro comprador — e a fila de devolução, que já anotou o recibo, não olha de novo.
 *
 * Dois jeitos de acontecer: o estorno está em processamento (a contingência do Pix no Banco
 * Central — `in_process`, confirma sozinho), ou o MP recusou ou cancelou o estorno depois de
 * aceitar (conta sem saldo pra devolver). Os dois viram UMA linha pendurada em `payment_events`
 * (`mp:<id>:devolucao-a-confirmar`): aparece em Financeiro → entregas, com a frase do que houve, e
 * o reprocesso volta a conferir com a carência crescente de sempre. Confirmado, a linha fecha
 * sozinha. Recusado, a trilha do pedido ganha `devolucao_mp_recusada`.
 */
export const chaveDaDevolucaoAConfirmar = (paymentId: string) => `mp:${paymentId}:devolucao-a-confirmar`

async function conferirDevolucaoMp(a: {
  orgId: string; pedidoId: string; paymentId: string; pagamento: any; contarTentativa: boolean
}): Promise<string | null> {
  const o = await q1<any>(`SELECT code, refunded_cents FROM orders WHERE id = $1`, [a.pedidoId])
  const nosso = Number(o?.refunded_cents ?? 0)
  const confirmado = centavosDoMp(a.pagamento?.transaction_amount_refunded) ?? 0
  if (nosso <= confirmado) {
    await q(
      `UPDATE payment_events SET processed_at = now(), error = NULL
        WHERE provider = 'mercadopago' AND gateway_event_id = $1 AND processed_at IS NULL`,
      [chaveDaDevolucaoAConfirmar(a.paymentId)])
    return null
  }
  const aCaminho = devolvidoNoMp(a.pagamento)
  const recusada = nosso > aCaminho
  return await marcarDevolucaoAConfirmar({
    orgId: a.orgId, pedidoId: a.pedidoId, pedidoCode: o?.code ?? null, paymentId: a.paymentId,
    faltaCents: nosso - confirmado, recusada, contarTentativa: a.contarTentativa,
    resumo: resumoDoPagamento(a.pagamento),
    erro: recusada
      ? `O Mercado Pago não devolveu ${formatarReais(nosso - aCaminho)} que o sistema deu como devolvidos `
        + '(a devolução foi recusada ou cancelada lá — costuma ser falta de saldo na conta). '
        + 'Confira no painel do Mercado Pago e devolva por lá; esta linha fecha sozinha quando ele confirmar.'
      : `Devolução de ${formatarReais(nosso - confirmado)} em processamento no Mercado Pago. Confirma sozinha.`,
  })
}

async function marcarDevolucaoAConfirmar(a: {
  orgId: string; pedidoId: string; pedidoCode?: string | null; paymentId: string; faltaCents: number
  recusada: boolean; contarTentativa: boolean; resumo: Record<string, any>; erro: string
}): Promise<string> {
  const chave = chaveDaDevolucaoAConfirmar(a.paymentId)
  const antes = await q1<any>(
    `SELECT error, processed_at FROM payment_events WHERE provider = 'mercadopago' AND gateway_event_id = $1`,
    [chave])
  const payload = JSON.stringify({
    event: 'MP_DEVOLUCAO_A_CONFIRMAR', payment: { value: reaisDoMp(a.faltaCents) }, mercadopago: a.resumo,
  })
  // reaberta (fechou e voltou a divergir) recomeça a conta; aberta, só o reprocesso conta volta
  await q(
    `INSERT INTO payment_events (provider, gateway_event_id, external_id, event_name, order_id, payload, error, attempts)
     VALUES ('mercadopago', $1, $2, 'MP_DEVOLUCAO_A_CONFIRMAR', $3::uuid, $4::jsonb, $5, 1)
     ON CONFLICT (provider, gateway_event_id) DO UPDATE
        SET payload = EXCLUDED.payload, error = EXCLUDED.error, processed_at = NULL,
            attempts = CASE WHEN payment_events.processed_at IS NOT NULL THEN 1
                            ELSE payment_events.attempts + CASE WHEN $6::boolean THEN 1 ELSE 0 END END`,
    [chave, a.paymentId, a.pedidoId, payload, a.erro, a.contarTentativa])
  const jaSabia = !!antes && !antes.processed_at && antes.error === a.erro
  if (a.recusada && !jaSabia) {
    await q(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1, 'order', $2, 'devolucao_mp_recusada', $3::jsonb)`,
      [a.orgId, a.pedidoId, JSON.stringify({ pagamentoMp: a.paymentId, pedido: a.pedidoCode, erro: a.erro })],
    ).catch(() => {})
    console.warn(`[mercadopago] pedido ${a.pedidoCode ?? a.pedidoId}: ${a.erro}`)
  }
  return a.erro
}

/* ============================================================ as varreduras */

/**
 * Uma cópia da varredura por vez, em toda a frota (trava consultiva de SESSÃO, a mesma de
 * `cancelarCobrancasDeExpirados`): duas instâncias perguntando pelo mesmo Pix não quebram nada —
 * o índice único segura —, mas dobram as chamadas ao MP à toa.
 */
async function umaPorVez<T>(nome: string, vazio: T, f: () => Promise<T>): Promise<T> {
  const conexao = await db().connect()
  let travou = false
  try {
    const { rows } = await conexao.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [nome])
    travou = !!rows[0]?.ok
    if (!travou) return vazio
    return await f()
  } finally {
    if (travou) await conexao.query(`SELECT pg_advisory_unlock(hashtext($1))`, [nome]).catch(() => {})
    conexao.release()
  }
}

/**
 * Os Pix esperando pagamento. Os 20 primeiros segundos ficam de fora: é a janela em que o aviso do
 * MP costuma chegar sozinho. A ordem é sorteada de propósito: num pico com mais Pix abertos que o
 * limite da rodada, "os mais novos primeiro" deixaria os mais velhos sem pergunta nenhuma até
 * vencer (quem os pega aí é o cancelamento do vencido, que também aplica o pago — mas um minuto
 * de espera vira meia hora).
 */
export const SQL_PIX_ESPERANDO = `
  SELECT o.id, o.org_id, o.mp_payment_id
    FROM orders o
   WHERE o.mp_payment_id IS NOT NULL
     AND o.status = 'aguardando_pagamento'
     AND o.created_at < now() - interval '20 seconds'
   ORDER BY random()
   LIMIT $1`

/**
 * Quanto uma varredura pode gastar. A tarefa roda de minuto em minuto e o runner do Nitro não
 * começa uma rodada com a anterior viva: sem prazo, MP lento (8 s por pergunta × 60 Pix) comeria
 * as rodadas seguintes inteiras.
 */
export interface RodadaMp {
  limite?: number
  /** relógio (ms) a partir do qual a varredura não começa pergunta nova */
  ate?: number
}

const PRAZO_PADRAO_MS = 20_000

/**
 * Pergunta ao MP por cada Pix esperando e aplica o que mudou. É a rede de baixo do webhook: com o
 * aviso perdido (URL errada no painel, MP fora, deploy no meio), o ingresso sai no minuto seguinte
 * do mesmo jeito. O Pix pago no último minuto que escapar daqui (a expiração corre em paralelo,
 * noutra tarefa) é pego pelo cancelamento do vencido, que aplica o pago e refaz a reserva.
 *
 * Para na primeira falha passageira (MP fora, rede, banco): os seguintes ouviriam o mesmo não,
 * gastando o prazo da rodada.
 */
export async function varrerPixEsperando(r: RodadaMp = {}): Promise<DesfechoMp[]> {
  const { limite = 60, ate = Date.now() + PRAZO_PADRAO_MS } = r
  return umaPorVez('dt:mp-pix-esperando', [] as DesfechoMp[], async () => {
    const feitos: DesfechoMp[] = []
    for (const o of await q<any>(SQL_PIX_ESPERANDO, [limite])) {
      if (Date.now() >= ate) break
      const d = await processarPagamentoMp({ orgId: o.org_id, paymentId: o.mp_payment_id })
      feitos.push(d)
      if (!d.ok && d.passageira) break
    }
    return feitos
  })
}

/**
 * Recusas de REGRA (4xx) ao cancelar o Pix de um pedido vencido antes de desistir (a trilha diz
 * por quê). MP fora não conta: não é motivo pra largar aberta a porta de um QR pagável — esse
 * volta a cada 10 minutos dentro da janela de 3 dias.
 */
export const MAX_TENTATIVAS_CANCELAR_PIX = 3

/** Mesma régua de `SQL_COBRANCAS_A_CANCELAR` (estoque.ts), pro Pix do MP. */
export const SQL_PIX_A_CANCELAR = `
  SELECT o.id, o.org_id, o.code, o.mp_payment_id, org.mp_access_token
    FROM orders o
    JOIN organizations org ON org.id = o.org_id
   WHERE o.status = 'expirado'
     AND o.mp_payment_id IS NOT NULL
     AND o.canceled_at > now() - interval '3 days'
     AND NOT EXISTS (SELECT 1 FROM audit_log a
                      WHERE a.entity = 'order' AND a.entity_id = o.id::text
                        AND a.action IN ('pix_mp_cancelado', 'pix_mp_pago_no_vao'))
     AND (SELECT count(*) FROM audit_log a
           WHERE a.entity = 'order' AND a.entity_id = o.id::text
             AND a.action = 'pix_mp_cancelar_falhou'
             AND COALESCE((a.after ->> 'passageira')::boolean, false) = false) < $2
     AND COALESCE((SELECT max(a.created_at) FROM audit_log a
                    WHERE a.entity = 'order' AND a.entity_id = o.id::text
                      AND a.action = 'pix_mp_cancelar_falhou'), '-infinity')
         < now() - interval '10 minutes'
   ORDER BY o.canceled_at
   LIMIT $1`

export interface CancelamentoDoPix { pedidoId: string; ok: boolean; desfecho: string; erro: string | null }

/**
 * Fecha no MP o Pix de UM pedido e diz como ficou. Quando o MP recusa cancelar, a pergunta seguinte
 * é "por quê?": o motivo bom é o comprador ter pago no último segundo — aí o pagamento é aplicado (a
 * emissão refaz a reserva, ou o pedido fica pendurado como pago sem lugar, à vista no painel).
 *
 * Pedido ainda esperando (a troca de token fecha esses também): cancelado lá, o cancelamento é
 * aplicado aqui na hora — o lugar volta pra prateleira em vez de esperar a reserva cair.
 */
async function fecharPixDoPedido(o: {
  id: string; org_id: string; code: string; status?: string; mp_payment_id: string; mp_access_token: string | null
}): Promise<{ acao: string; erro: string | null; passageira: boolean }> {
  try {
    const token = tokenDaOrg(o)
    let p: any = null
    try {
      await cancelarPagamento(token, o.mp_payment_id)
    } catch (e: any) {
      p = await buscarPagamento(token, o.mp_payment_id)
      const s = String(p?.status ?? '').toLowerCase()
      if (MP_AINDA_ESPERANDO.has(s)) throw e
      if (s !== 'cancelled' && s !== 'rejected') {
        const r = await processarPagamentoMp({ orgId: o.org_id, paymentId: o.mp_payment_id, pagamento: p })
        return { acao: 'pix_mp_pago_no_vao', erro: r.ok ? null : (r.erro ?? 'não consegui aplicar o pagamento'),
                 passageira: !r.ok && !!r.passageira }
      }
      // já estava morto: é o que a gente queria
    }
    if (o.status === 'aguardando_pagamento') {
      const r = await processarPagamentoMp({ orgId: o.org_id, paymentId: o.mp_payment_id, pagamento: p ?? undefined })
      if (!r.ok) return { acao: 'pix_mp_cancelado', erro: r.erro ?? 'cancelado no Mercado Pago, mas não aqui', passageira: !!r.passageira }
    }
    return { acao: 'pix_mp_cancelado', erro: null, passageira: false }
  } catch (e: any) {
    return { acao: 'pix_mp_cancelar_falhou', erro: e?.message ?? String(e), passageira: ehFalhaPassageira(e) }
  }
}

async function anotarFechamento(o: { id: string; org_id: string; code: string; mp_payment_id: string },
  f: { acao: string; erro: string | null; passageira: boolean }, contexto: string) {
  await q(
    `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
     VALUES ($1, 'order', $2, $3, $4::jsonb)`,
    [o.org_id, o.id, f.acao, JSON.stringify({
      pagamentoMp: o.mp_payment_id, pedido: o.code, erro: f.erro, contexto,
      ...(f.acao === 'pix_mp_cancelar_falhou' ? { passageira: f.passageira } : {}),
    })])
  if (f.erro) console.warn(`[mercadopago] Pix ${o.mp_payment_id} do pedido ${o.code} (${contexto}): ${f.acao} — ${f.erro}`)
}

/**
 * Cancela no MP o Pix de todo pedido que venceu — o P0 de 22/09 do Asaas, do lado do MP: reserva
 * morta, Pix vivo, o comprador paga o QR que ainda está na tela e o dinheiro entra sem ingresso.
 * Toda tentativa vira linha no `audit_log`; a primeira falha passageira encerra a rodada.
 */
export async function cancelarPixVencidos(r: RodadaMp = {}): Promise<CancelamentoDoPix[]> {
  const { limite = 50, ate = Date.now() + PRAZO_PADRAO_MS } = r
  return umaPorVez('dt:mp-pix-vencido', [] as CancelamentoDoPix[], async () => {
    const feitos: CancelamentoDoPix[] = []
    for (const o of await q<any>(SQL_PIX_A_CANCELAR, [limite, MAX_TENTATIVAS_CANCELAR_PIX])) {
      if (Date.now() >= ate) break
      const f = await fecharPixDoPedido(o)
      await anotarFechamento(o, f, 'vencido')
      feitos.push({ pedidoId: o.id, ok: !f.erro, desfecho: f.acao, erro: f.erro })
      if (f.passageira) break
    }
    return feitos
  })
}

/* ======================================================= troca da conta do MP */

/**
 * Todo Pix desta organização que ainda pode receber dinheiro: o esperando e o vencido que ninguém
 * fechou. É o que fica ÓRFÃO quando o token sai (ou troca de conta): o QR continua pagável, e sem o
 * token daquela conta ninguém mais pergunta por ele — o dinheiro entraria sem ingresso e sem linha
 * em lugar nenhum.
 */
export const SQL_PIX_ABERTOS_DA_ORG = `
  SELECT o.id, o.org_id, o.code, o.status, o.mp_payment_id, org.mp_access_token
    FROM orders o
    JOIN organizations org ON org.id = o.org_id
   WHERE o.org_id = $1
     AND o.mp_payment_id IS NOT NULL
     AND ( o.status = 'aguardando_pagamento'
        OR ( o.status = 'expirado'
             AND NOT EXISTS (SELECT 1 FROM audit_log a
                              WHERE a.entity = 'order' AND a.entity_id = o.id::text
                                AND a.action IN ('pix_mp_cancelado', 'pix_mp_pago_no_vao')) ) )
   ORDER BY o.created_at
   LIMIT 300`

/** Devoluções do MP que ainda vão sair — sem o token daquela conta, não saem. */
export const SQL_DEVOLUCOES_MP_NA_FILA = `
  SELECT count(*)::int AS n
    FROM refund_jobs
   WHERE org_id = $1 AND asaas_payment_id LIKE 'mp:%' AND status IN ('na_fila', 'estornando')`

/**
 * Antes de o token sair (ou trocar de conta): fecha, com o token AINDA gravado, todo Pix que pode
 * receber. O pago no vão vira ingresso; o esperando é cancelado lá e aqui. O que não fechou volta
 * nomeado, e quem chama não troca nada.
 */
export async function fecharPixAbertos(orgId: string, prazoMs = 25_000): Promise<{
  fechados: number; abertos: { pedido: string; erro: string }[]; devolucoesNaFila: number
}> {
  const ate = Date.now() + prazoMs
  const abertos: { pedido: string; erro: string }[] = []
  let fechados = 0
  for (const o of await q<any>(SQL_PIX_ABERTOS_DA_ORG, [orgId])) {
    if (Date.now() >= ate) { abertos.push({ pedido: o.code, erro: 'não deu tempo nesta tentativa' }); continue }
    const f = await fecharPixDoPedido(o)
    await anotarFechamento(o, f, 'troca do token')
    if (f.erro) abertos.push({ pedido: o.code, erro: f.erro })
    else fechados++
  }
  const fila = await q1<{ n: number }>(SQL_DEVOLUCOES_MP_NA_FILA, [orgId])
  return { fechados, abertos, devolucoesNaFila: Number(fila?.n ?? 0) }
}

/**
 * Fatos do MP sem baixa (pago sem lugar, banco piscando no meio). A mesma carência crescente e o
 * mesmo teto do reprocessador do Asaas (`SQL_ENTREGAS_PENDENTES`). Aqui não se reaplica o payload
 * guardado: se pergunta de novo ao MP — o estado pode ter andado (um estorno, uma disputa).
 */
export const SQL_FATOS_MP_PENDENTES = `
  SELECT external_id, org_id FROM (
    SELECT DISTINCT ON (pe.external_id) pe.external_id, o.org_id, pe.created_at
      FROM payment_events pe
      JOIN orders o ON o.id = pe.order_id
     WHERE pe.provider = 'mercadopago'
       AND pe.processed_at IS NULL
       AND pe.attempts < $1
       AND pe.created_at < now() - make_interval(mins => $2::int * GREATEST(pe.attempts, 1))
       AND ($4::uuid IS NULL OR pe.id = $4::uuid)
       AND ($5::uuid IS NULL OR o.org_id = $5::uuid)
     ORDER BY pe.external_id, pe.created_at
  ) pendentes
  -- o mais antigo primeiro: com mais pendurados que o limite, nenhum fica sem vez
  ORDER BY created_at
  LIMIT $3`

export async function reprocessarFatosMp(opcoes: RodadaMp & {
  carenciaMin?: number; id?: string | null
  /** a produtora de quem mandou varrer (uma pessoa varre só a dela); `null` é o trabalhador de fundo */
  orgId?: string | null
} = {}) {
  const {
    limite = 30, carenciaMin = CARENCIA_REPROCESSO_MIN, id = null, orgId = null,
    ate = Date.now() + PRAZO_PADRAO_MS,
  } = opcoes
  const feitos: DesfechoMp[] = []
  // com `id` (o "tentar agora" do painel) a carência, o teto e o prazo não valem
  const linhas = await q<any>(SQL_FATOS_MP_PENDENTES,
    [id ? 2_147_483_647 : MAX_REPROCESSOS, id ? 0 : carenciaMin, limite, id, orgId])
  for (const l of linhas) {
    if (!id && Date.now() >= ate) break
    const d = await processarPagamentoMp({ orgId: l.org_id, paymentId: l.external_id, contarTentativa: true })
    feitos.push(d)
    if (!id && !d.ok && d.passageira) break
  }
  return feitos
}

/* ================================================================= estorno */

/**
 * Na fila de devolução (`refund_jobs.asaas_payment_id`, que é "o id no gateway") o pagamento do MP
 * vai com este prefixo — o mesmo desenho do `sim_` do gateway simulado. É ele que faz o estornador
 * escolher o gateway certo, e o que mantém a regra da fila de pé: sem id nenhum, "devolver na mão".
 */
export const PREFIXO_MP = 'mp:'

export function idNoGateway(o: { asaas_payment_id?: string | null; mp_payment_id?: string | null }): string | null {
  return o.asaas_payment_id || (o.mp_payment_id ? `${PREFIXO_MP}${o.mp_payment_id}` : null)
}

const semPrefixo = (id: string) => id.slice(PREFIXO_MP.length)

async function orgComToken(orgId: string) {
  const org = await q1<any>(`SELECT mp_access_token FROM organizations WHERE id = $1`, [orgId])
  if (!org?.mp_access_token) {
    throw new Error('esta organização está sem o token do Mercado Pago — '
      + 'cadastre em Dados e cobrança e mande tentar de novo')
  }
  return org
}

/**
 * Devolve pelo MP. A chave de idempotência é da CHAMADA: uma chave repetida devolve a resposta
 * guardada da chamada anterior — inclusive o erro dela, e o estorno nunca sairia. Era da
 * tentativa, e o "tentar de novo" da ficha (que manda sempre a tentativa 2) batia na mesma chave
 * da segunda vez em diante. Quem impede a devolução em dobro é a fila e a ficha (recibo antes do
 * resto, e a PERGUNTA ao gateway antes de mandar de novo), não a chave.
 *
 * Estorno aceito mas em processamento (`in_process`, a contingência do Pix): a devolução fica a
 * confirmar (`marcarDevolucaoAConfirmar`), e o reprocesso confere até o MP dizer que saiu.
 */
export async function estornarNoMp(p: {
  orgId: string; paymentId: string; valorCents: number; jobId: string; tentativa: number
  orderId?: string | null
}): Promise<{ id: string | null }> {
  const org = await orgComToken(p.orgId)
  const chave = `estorno-${p.jobId}-${p.tentativa}-${randomUUID().slice(0, 8)}`
    .replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120)
  const id = semPrefixo(p.paymentId)
  const r: any = await estornarPagamento(tokenDaOrg(org), id, p.valorCents, chave)
  const status = String(r?.status ?? '').toLowerCase()
  if (p.orderId && status && status !== 'approved') {
    await marcarDevolucaoAConfirmar({
      orgId: p.orgId, pedidoId: p.orderId, paymentId: id, faltaCents: p.valorCents,
      recusada: false, contarTentativa: false,
      resumo: { estorno: { id: r?.id ?? null, status, amount: r?.amount ?? null } },
      erro: `Devolução de ${formatarReais(p.valorCents)} em processamento no Mercado Pago. Confirma sozinha.`,
    }).catch((e) => console.warn(`[mercadopago] estorno ${r?.id} em processamento sem marca: ${e?.message ?? e}`))
  }
  return { id: r?.id != null ? String(r.id) : null }
}

/**
 * Quanto o MP já devolveu deste pagamento, e o recibo do último estorno. CONTA o estorno em
 * processamento: esta é a pergunta "já mandei?" da retentativa, e responder "não" pra um estorno
 * a caminho é mandar o mesmo dinheiro duas vezes.
 */
export async function conferirNoMp(p: { orgId: string; paymentId: string }): Promise<{ devolvidoCents: number; reciboId: string | null }> {
  const org = await orgComToken(p.orgId)
  const pg: any = await buscarPagamento(tokenDaOrg(org), semPrefixo(p.paymentId))
  const lista = Array.isArray(pg?.refunds) ? pg.refunds : []
  const ultimo = [...lista].reverse()
    .find((r: any) => !['cancelled', 'rejected'].includes(String(r?.status ?? '').toLowerCase()))
  return {
    devolvidoCents: devolvidoNoMp(pg),
    reciboId: ultimo?.id != null ? String(ultimo.id) : null,
  }
}
