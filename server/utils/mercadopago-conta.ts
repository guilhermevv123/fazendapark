/**
 * mercadopago-conta.ts — a conversa com o Mercado Pago, sem banco no meio.
 *
 * O Pix do site passa a ser gerado no Mercado Pago quando a organização tem o token dele; o cartão
 * (crédito e débito) segue no Asaas. A conta do dono pra um ingresso de R$ 30 (28/09): Pix no MP
 * rende R$ 29,70 (0,99%); no Asaas o Pix é tarifa fixa por cobrança.
 *
 * Este arquivo é o que dá pra testar sem rede e sem Postgres: o corpo do Pix, a assinatura do
 * webhook e a TRADUÇÃO do estado do pagamento. O que mexe em pedido mora em `mercadopago.ts`.
 *
 * ## Qual API, e por quê (doc oficial lida em 28/09)
 *
 * `POST /v1/payments` com `payment_method_id: 'pix'`. A doc hoje recomenda a Orders API
 * (`/v1/orders`) pra integração nova e marca a Payments como legado ("não receberá novas features,
 * apenas correções de segurança e estabilidade"). Ficamos na Payments por duas coisas que a Orders
 * não dá: o `notification_url` POR PAGAMENTO (é ele que diz de qual organização é o aviso, sem
 * depender do painel do MP) e o líquido na resposta (`transaction_details.net_received_amount` e
 * `fee_details`) — a Orders devolve só valores brutos. Trocar depois é trocar este arquivo.
 *
 * ## O que o webhook do MP NÃO é
 *
 * Prova de pagamento. O aviso traz só o id; o estado vem de `GET /v1/payments/{id}` feito com o
 * NOSSO token. Um aviso forjado, no pior caso, faz a gente perguntar ao MP por um pagamento que é
 * nosso — e a resposta é a verdade. A assinatura (`x-signature`) é conferida quando vem, como
 * segunda parede, não como a única.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { abrirSegredo, CofreFechado } from './cofre'

const API_PADRAO = 'https://api.mercadopago.com'

/**
 * A base da API. Fora de produção dá pra apontar pra um MP de mentira (`MERCADOPAGO_API_URL`, é o
 * que o teste sobe); EM PRODUÇÃO NUNCA — o token vai no cabeçalho de toda chamada, e uma variável
 * torta mandaria a credencial da conta pra outro endereço.
 */
export function baseDaApi(env: Record<string, string | undefined> = process.env): string {
  const outra = String(env.MERCADOPAGO_API_URL ?? '').trim()
  if (outra && env.NODE_ENV !== 'production') return outra.replace(/\/+$/, '')
  return API_PADRAO
}

export class ErroMercadoPago extends Error {
  constructor(public readonly status: number, public readonly detalhes: any, msg: string) {
    super(msg)
    this.name = 'ErroMercadoPago'
  }
}

/** Falha de rede ou de servidor do MP: vale tentar de novo. 4xx de regra não vale. */
export function ehFalhaPassageira(e: unknown): boolean {
  if (e instanceof ErroMercadoPago) return e.status === 0 || e.status === 429 || e.status >= 500
  return true
}

async function chamar<T = any>(token: string, metodo: string, caminho: string, opcoes: {
  corpo?: unknown; idempotencia?: string; cabecalhos?: Record<string, string>; prazoMs?: number
} = {}): Promise<T> {
  if (!token) throw new ErroMercadoPago(0, null, 'Mercado Pago sem token configurado')
  let res: Response
  try {
    res = await fetch(`${baseDaApi()}${caminho}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'diamond-tickets',
        ...(opcoes.idempotencia ? { 'X-Idempotency-Key': opcoes.idempotencia } : {}),
        ...(opcoes.cabecalhos ?? {}),
      },
      body: opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo),
      // curto de propósito: a varredura de minuto faz dezenas destas, e MP lento não pode segurar a
      // rodada (a criação do Pix, com o comprador esperando, pede o dela)
      signal: AbortSignal.timeout(opcoes.prazoMs ?? 8_000),
    })
  } catch (e: any) {
    throw new ErroMercadoPago(0, null, `Mercado Pago fora do ar ou sem resposta: ${e?.message ?? e}`)
  }
  const texto = await res.text()
  let json: any = null
  try { json = texto ? JSON.parse(texto) : null } catch { /* corpo não-JSON */ }
  if (!res.ok) {
    const causa = Array.isArray(json?.cause) && json.cause.length
      ? json.cause.map((c: any) => c?.description || c?.code).filter(Boolean).join('; ')
      : ''
    const msg = causa || json?.message || json?.error || `HTTP ${res.status}`
    throw new ErroMercadoPago(res.status, json ?? texto, `Mercado Pago: ${msg}`)
  }
  return json as T
}

/* ================================================================ a conta */

/** O que o banco guarda da organização sobre o MP (o token e o segredo podem estar no cofre). */
export interface OrgMercadoPago {
  mp_access_token?: string | null
  mp_webhook_secret?: string | null
  mp_test?: boolean | null
}

/** Token de credencial de TESTE da Payments API. `APP_USR-` pode ser de teste também — quem diz é o /users/me. */
export function ehTokenDeTeste(token: string | null | undefined): boolean {
  return /^TEST-/i.test(String(token ?? '').trim())
}

export type MotivoSemMercadoPago = 'sem_token' | 'cofre_fechado' | 'token_de_teste'

/**
 * O Pix desta organização sai pelo Mercado Pago? Nunca devolve o token: só o veredito e o motivo.
 *
 * Token de teste em PRODUÇÃO não liga o MP — gera um Pix que banco nenhum paga, o comprador fica
 * olhando pro QR e o lugar preso. Aí o Pix continua no Asaas, e a tela de Dados e cobrança diz por
 * quê. É a lição do ORG-01 (a chave de um ambiente cobrando no outro), aplicada antes de acontecer.
 */
export function pixPeloMercadoPago(org: OrgMercadoPago, env: Record<string, string | undefined> = process.env):
  { ok: true } | { ok: false; motivo: MotivoSemMercadoPago } {
  if (!org?.mp_access_token) return { ok: false, motivo: 'sem_token' }
  let token: string | null
  try { token = abrirSegredo(org.mp_access_token) } catch (e) {
    if (e instanceof CofreFechado) return { ok: false, motivo: 'cofre_fechado' }
    throw e
  }
  if (!token) return { ok: false, motivo: 'sem_token' }
  if (env.NODE_ENV === 'production' && (org.mp_test || ehTokenDeTeste(token))) {
    return { ok: false, motivo: 'token_de_teste' }
  }
  return { ok: true }
}

/** O token aberto, pra quem vai chamar a API. Lança quando não há. */
export function tokenDaOrg(org: OrgMercadoPago): string {
  const t = abrirSegredo(org?.mp_access_token)
  if (!t) throw new ErroMercadoPago(0, null, 'esta organização está sem o token do Mercado Pago')
  return t
}

/** Quem é o dono do token — e se é conta de teste. É a conferência do "Salvar" do painel. */
export async function quemEhAConta(token: string): Promise<{ id: string; teste: boolean; apelido: string | null }> {
  const u: any = await chamar(token, 'GET', '/users/me', { prazoMs: 10_000 })
  const etiquetas: string[] = Array.isArray(u?.tags) ? u.tags.map(String) : []
  // a doc diz que o token de conta de teste também começa com APP_USR: a etiqueta pode não vir,
  // e o e-mail do usuário de teste do MP é sempre @testuser.com — os dois sinais contam
  const emailDeTeste = /@testuser\.com$/i.test(String(u?.email ?? '').trim())
  return {
    id: String(u?.id ?? ''),
    teste: ehTokenDeTeste(token) || etiquetas.includes('test_user') || emailDeTeste,
    apelido: u?.nickname ? String(u.nickname) : null,
  }
}

/* ================================================================== o Pix */

/** Centavo → real, na borda. O MP fala número com até 2 casas; dentro do sistema é centavo inteiro. */
export function reaisDoMp(cents: number): number {
  if (!Number.isInteger(cents)) throw new Error('centavos precisa ser inteiro')
  return Number((cents / 100).toFixed(2))
}

/** Real → centavo. `null` quando o campo não veio — ausência não é zero. */
export function centavosDoMp(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

/** O MP aceita de 30 min a 30 dias; abaixo disso ele recusa o Pix inteiro. */
export const PIX_MINIMO_MIN = 30
const PIX_MAXIMO_MS = 30 * 24 * 3600_000

/**
 * `yyyy-MM-ddTHH:mm:ss.SSS-03:00` — o formato que a doc pede (qualquer outro é o erro 23). Em
 * horário de Brasília porque é o do parque, e Brasília não tem horário de verão desde 2019.
 */
export function dataDoMP(d: Date): string {
  return new Date(d.getTime() - 3 * 3600_000).toISOString().replace('Z', '-03:00')
}

export interface NovoPix {
  valorCents: number
  descricao: string
  /** nosso `orders.id` — vira `external_reference` (até 64, só `[A-Za-z0-9-_]`: o UUID cabe) */
  pedidoId: string
  /** até quando a reserva segura o lugar */
  expiraEm: Date
  /** https público do nosso webhook; `null` = sem aviso (a varredura pergunta sozinha) */
  urlDeAviso: string | null
  comprador: { email: string; nome: string; cpf: string }
}

/**
 * O corpo do `POST /v1/payments`.
 *
 * A validade do Pix acompanha a reserva, com o piso de 30 min do MP. Quando a reserva é mais curta,
 * o QR vive um pouco mais que ela: a varredura cancela o Pix assim que o pedido expira
 * (`cancelarPixVencidos`), e o pago no vão é tratado pela emissão (refaz a reserva ou avisa) — o
 * mesmo caminho do Pix do Asaas, cuja cobrança também sobrevive à reserva.
 */
export function corpoDoPix(p: NovoPix, agora = new Date()) {
  const piso = agora.getTime() + (PIX_MINIMO_MIN + 1) * 60_000
  const teto = agora.getTime() + PIX_MAXIMO_MS
  const expira = new Date(Math.min(teto, Math.max(p.expiraEm.getTime(), piso)))
  const [primeiro, ...resto] = String(p.comprador.nome ?? '').trim().split(/\s+/)
  return {
    transaction_amount: reaisDoMp(p.valorCents),
    description: String(p.descricao).slice(0, 200),
    payment_method_id: 'pix',
    external_reference: p.pedidoId,
    date_of_expiration: dataDoMP(expira),
    ...(p.urlDeAviso ? { notification_url: p.urlDeAviso } : {}),
    payer: {
      email: p.comprador.email,
      first_name: primeiro || undefined,
      last_name: resto.join(' ') || undefined,
      identification: { type: 'CPF', number: String(p.comprador.cpf).replace(/\D/g, '') },
    },
  }
}

/**
 * O endereço do aviso desta organização. O id dela vai no caminho porque é ele que diz com QUAL
 * token perguntar ao MP; `source_news=webhooks` pede o formato novo (com `data.id` e assinatura)
 * em vez do IPN, que a doc diz que vai ser descontinuado. Sem https o MP recusa o Pix inteiro
 * (erro 4020) — aí não vai aviso nenhum e a varredura de minuto em minuto é quem pergunta.
 */
export function urlDoAviso(base: string | null | undefined, orgId: string): string | null {
  const b = String(base ?? '').trim().replace(/\/+$/, '')
  if (!/^https:\/\//i.test(b)) return null
  const url = `${b}/api/webhooks/mercadopago/${orgId}?source_news=webhooks`
  return url.length <= 248 ? url : null
}

export interface PixCriado {
  id: string
  status: string
  copiaECola: string | null
  qrBase64: string | null
  linkDoMp: string | null
  /** `live_mode` do pagamento: `false` = criado numa conta/credencial de teste; `null` = não veio */
  aoVivo: boolean | null
}

export async function criarPix(token: string, corpo: ReturnType<typeof corpoDoPix>, idempotencia: string): Promise<PixCriado> {
  const r: any = await chamar(token, 'POST', '/v1/payments', { corpo, idempotencia, prazoMs: 20_000 })
  const dados = r?.point_of_interaction?.transaction_data ?? {}
  return {
    id: String(r?.id ?? ''),
    status: String(r?.status ?? ''),
    copiaECola: dados.qr_code ? String(dados.qr_code) : null,
    // no sandbox ele pode vir "" — quem chama gera a imagem a partir do copia-e-cola
    qrBase64: dados.qr_code_base64 ? String(dados.qr_code_base64) : null,
    linkDoMp: dados.ticket_url ? String(dados.ticket_url) : null,
    aoVivo: typeof r?.live_mode === 'boolean' ? r.live_mode : null,
  }
}

export async function buscarPagamento(token: string, id: string): Promise<any> {
  return chamar(token, 'GET', `/v1/payments/${encodeURIComponent(id)}`)
}

/** Só vale com o pagamento em `pending`/`in_process`/`authorized`; pago o MP recusa (e é o bom caso). */
export async function cancelarPagamento(token: string, id: string): Promise<any> {
  return chamar(token, 'PUT', `/v1/payments/${encodeURIComponent(id)}`, { corpo: { status: 'cancelled' } })
}

/**
 * Estorno total (sem valor) ou parcial. `X-Render-In-Process-Refunds`: estorno de Pix pode ficar em
 * contingência no Banco Central, e sem este cabeçalho o MP responde 400 mesmo tendo ACEITO — a fila
 * trataria como falha e mandaria de novo. Com ele volta 201 com `status: in_process`.
 *
 * 201 não é "devolvido": o estorno pode voltar recusado ou cancelado (conta sem saldo pra devolver,
 * por exemplo). Isso é falha — sai como erro, e a fila tenta de novo em vez de anotar recibo de um
 * dinheiro que não saiu. O `in_process` é aceito e fica a confirmar (`mercadopago.ts`).
 */
export async function estornarPagamento(token: string, id: string, valorCents: number | null, idempotencia: string): Promise<any> {
  const r: any = await chamar(token, 'POST', `/v1/payments/${encodeURIComponent(id)}/refunds`, {
    corpo: valorCents == null ? {} : { amount: reaisDoMp(valorCents) },
    idempotencia,
    cabecalhos: { 'X-Render-In-Process-Refunds': 'true' },
    prazoMs: 20_000,
  })
  const status = String(r?.status ?? '').toLowerCase()
  if (ESTORNO_NAO_SAIU.has(status)) {
    throw new ErroMercadoPago(422, r, `o Mercado Pago recusou a devolução (${status}${r?.status_detail ? `: ${r.status_detail}` : ''})`)
  }
  return r
}

/** Estorno que o MP respondeu mas que NÃO devolveu o dinheiro. */
export const ESTORNO_NAO_SAIU = new Set(['rejected', 'cancelled'])
/** Estorno que devolveu, ou está devolvendo (o `in_process` da contingência do Pix). */
export const ESTORNO_VALE = new Set(['approved', 'in_process', 'authorized'])

/* ======================================================= assinatura do aviso */

function iguais(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

/**
 * Confere o `x-signature` do webhook (doc "Webhooks", 28/09).
 *
 * Manifesto EXATO: `id:[data.id];request-id:[x-request-id];ts:[ts];` — `data.id` da QUERY STRING
 * (não do corpo) e em minúsculas; parte que não veio sai do manifesto. HMAC-SHA256 em hex com a
 * assinatura secreta do painel, comparado em tempo constante.
 */
export function assinaturaConfere(a: {
  assinatura?: string | null; requestId?: string | null; dataId?: string | null; segredo: string
}): boolean {
  const partes: Record<string, string> = {}
  for (const pedaco of String(a.assinatura ?? '').split(',')) {
    const i = pedaco.indexOf('=')
    if (i > 0) partes[pedaco.slice(0, i).trim()] = pedaco.slice(i + 1).trim()
  }
  const ts = partes.ts
  const v1 = partes.v1
  if (!ts || !v1 || !a.segredo) return false
  let manifesto = ''
  if (a.dataId) manifesto += `id:${String(a.dataId).toLowerCase()};`
  if (a.requestId) manifesto += `request-id:${a.requestId};`
  manifesto += `ts:${ts};`
  const esperado = createHmac('sha256', a.segredo).update(manifesto).digest('hex')
  return iguais(esperado, v1.toLowerCase())
}

/* ============================================================ a tradução */

/** Um fato do pagamento, no vocabulário que a máquina de estados do pedido já entende. */
export interface FatoDoMp {
  /** `payment_events.gateway_event_id` — a mesma chave pro mesmo fato, venha ele por onde vier */
  chave: string
  /** o nome do evento no vocabulário do Asaas (é o que `aplicarEventoDoAsaas` sabe aplicar) */
  nomeEvento: string
  /** o pagamento no formato do Asaas: `value`, `status`, `refundedValue`, `billingType`… */
  pagamento: Record<string, any>
}

/** Estados do MP em que ainda não há nada a aplicar. */
export const MP_AINDA_ESPERANDO = new Set(['pending', 'in_process', 'authorized'])

/** Pedido que já saiu de "pago" por disputa: um `approved` depois disso é disputa GANHA. */
const EM_DISPUTA = new Set(['chargeback', 'disputa'])

/**
 * Pedido que NUNCA virou venda aqui dentro. Quando o MP já diz que o dinheiro voltou (ou está em
 * disputa) e o pedido nunca foi pago do nosso lado, o fato "pago" antes do final seria emitir
 * ingresso pra desfazer no mesmo segundo — com e-mail de ingresso chegando pro comprador — ou,
 * sem lugar, um "pago sem lugar" pendurado que manda a equipe devolver um dinheiro que já voltou.
 */
const NUNCA_PAGO = new Set(['aguardando_pagamento', 'expirado', 'em_analise', 'rascunho', 'falhou', 'cancelado'])

/** Soma dos estornos que valem (aprovados ou a caminho). O MP pode não contar o que está em processamento no acumulado. */
export function devolvidoNoMp(p: any): number {
  const acumulado = centavosDoMp(p?.transaction_amount_refunded) ?? 0
  let lista = 0
  for (const r of Array.isArray(p?.refunds) ? p.refunds : []) {
    if (ESTORNO_VALE.has(String(r?.status ?? '').toLowerCase())) {
      lista += centavosDoMp(r?.amount) ?? 0
    }
  }
  return Math.max(acumulado, lista)
}

/**
 * O estado ATUAL do pagamento vira a SEQUÊNCIA de fatos que levou até ele.
 *
 * Por que sequência: o Asaas avisa cada passagem (recebido, depois estornado); o MP responde o
 * estado de agora. Se a gente só visse "aprovado com estorno parcial" e aplicasse o estorno, um
 * pedido que ainda estava esperando pagamento iria direto pra `estornado_parcial` SEM ingresso
 * emitido e com o lugar só reservado. Então todo estado que pressupõe pagamento começa pelo fato
 * "pago" — cada fato com a sua chave, e o que já foi aplicado é descartado pelo índice único de
 * `payment_events`, não por um if.
 *
 * As chaves são do FATO, não da entrega: `mp:<id>:pago` é a mesma no webhook, na varredura e no
 * reprocesso. O estorno parcial leva o acumulado devolvido na chave (é o acumulado que o MP
 * informa, em `transaction_amount_refunded`): um estorno novo é um fato novo; o mesmo, repetido,
 * não é.
 */
export function fatosDoPagamento(p: any, statusDoPedido: string | null | undefined): FatoDoMp[] {
  const id = String(p?.id ?? '').trim()
  if (!id) return []
  const status = String(p?.status ?? '').trim().toLowerCase()
  const valorCents = centavosDoMp(p?.transaction_amount)
  const devolvidoCents = centavosDoMp(p?.transaction_amount_refunded) ?? 0
  const tipo = String(p?.payment_type_id ?? '').toLowerCase()
  const billingType = tipo === 'credit_card' ? 'CREDIT_CARD' : tipo === 'debit_card' ? 'DEBIT_CARD' : 'PIX'

  const base = {
    object: 'payment', id, gateway: 'mercadopago',
    value: p?.transaction_amount ?? null,
    netValue: p?.transaction_details?.net_received_amount ?? null,
    billingType,
    externalReference: p?.external_reference ?? null,
    statusMp: status, statusDetalheMp: p?.status_detail ?? null,
  }
  const fato = (sufixo: string, nomeEvento: string, extra: Record<string, any> = {}): FatoDoMp =>
    ({ chave: `mp:${id}:${sufixo}`, nomeEvento, pagamento: { ...base, ...extra } })
  const pago = fato('pago', 'PAYMENT_RECEIVED', { status: 'RECEIVED' })
  const estorno = (): FatoDoMp => (valorCents != null && devolvidoCents >= valorCents
    ? fato('estorno-total', 'PAYMENT_REFUNDED', { status: 'REFUNDED', refundedValue: reaisDoMp(devolvidoCents) })
    : fato(`estorno-${devolvidoCents}`, 'PAYMENT_PARTIALLY_REFUNDED',
        { status: 'RECEIVED', refundedValue: reaisDoMp(devolvidoCents) }))

  // o "pago" só vai na frente quando o pedido ainda pode virar venda por ele (ver NUNCA_PAGO)
  const antes = NUNCA_PAGO.has(String(statusDoPedido ?? '')) ? [] : [pago]

  switch (status) {
    case 'approved': {
      // disputa ganha: o dinheiro voltou. A ordem do Asaas é "aguardando reversão" e depois
      // "recebido" — é ela que devolve o pedido à conta (os ingressos continuam cancelados). O
      // que já tinha sido devolvido antes da disputa vai junto: o ramo da disputa no Asaas faz
      // o pedido voltar como 'estornado_parcial' em vez de 'pago'.
      if (EM_DISPUTA.has(String(statusDoPedido ?? ''))) {
        return [
          fato('reversao', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL', { status: 'AWAITING_CHARGEBACK_REVERSAL' }),
          fato('pago-apos-disputa', 'PAYMENT_RECEIVED', {
            status: 'RECEIVED', ...(devolvidoCents > 0 ? { refundedValue: reaisDoMp(devolvidoCents) } : {}),
          }),
        ]
      }
      // aprovado com estorno parcial é dinheiro que FICOU: emite mesmo nunca tendo sido pago aqui
      return devolvidoCents > 0 ? [pago, estorno()] : [pago]
    }
    case 'refunded':
      return [...antes, fato('estorno-total', 'PAYMENT_REFUNDED', {
        status: 'REFUNDED',
        refundedValue: reaisDoMp(devolvidoCents > 0 ? devolvidoCents : (valorCents ?? 0)),
      })]
    case 'charged_back':
      return [...antes, fato('chargeback', 'PAYMENT_CHARGEBACK_REQUESTED', { status: 'CHARGEBACK_REQUESTED' })]
    case 'in_mediation':
      // Pix contestado (MED): o dinheiro fica bloqueado. Tratado como o chargeback do cartão —
      // o ingresso de quem diz que não comprou não passa na catraca.
      return [...antes, fato('disputa-aberta', 'PAYMENT_CHARGEBACK_DISPUTE', { status: 'CHARGEBACK_DISPUTE' })]
    case 'cancelled':
    case 'rejected':
      // cancelado (vencido, ou por nós) e recusado são finais: esse QR não recebe mais
      return [fato('cancelado', 'PAYMENT_DELETED', { status: 'DELETED', deleted: true })]
    default:
      return []
  }
}

/** O que guardamos do pagamento na trilha: sem a imagem do QR (KB inúteis por linha) e sem dado do pagador. */
export function resumoDoPagamento(p: any): Record<string, any> {
  return {
    id: p?.id ?? null,
    status: p?.status ?? null,
    status_detail: p?.status_detail ?? null,
    payment_method_id: p?.payment_method_id ?? null,
    payment_type_id: p?.payment_type_id ?? null,
    transaction_amount: p?.transaction_amount ?? null,
    transaction_amount_refunded: p?.transaction_amount_refunded ?? null,
    net_received_amount: p?.transaction_details?.net_received_amount ?? null,
    fee_details: Array.isArray(p?.fee_details) ? p.fee_details : null,
    external_reference: p?.external_reference ?? null,
    date_created: p?.date_created ?? null,
    date_approved: p?.date_approved ?? null,
    date_last_updated: p?.date_last_updated ?? null,
    date_of_expiration: p?.date_of_expiration ?? null,
    money_release_date: p?.money_release_date ?? null,
    live_mode: p?.live_mode ?? null,
    refunds: Array.isArray(p?.refunds)
      ? p.refunds.map((r: any) => ({ id: r?.id ?? null, amount: r?.amount ?? null, status: r?.status ?? null }))
      : null,
  }
}

/** Tarifa e líquido na palavra do MP. Pagamento ainda pendente vem com líquido 0 — aí não serve. */
export function tarifaELiquido(p: any): { taxaCents: number | null; liquidoCents: number | null } {
  if (String(p?.status ?? '').toLowerCase() !== 'approved') return { taxaCents: null, liquidoCents: null }
  const liquido = centavosDoMp(p?.transaction_details?.net_received_amount)
  const taxas = Array.isArray(p?.fee_details) ? p.fee_details : []
  let taxa: number | null = null
  for (const f of taxas) {
    const v = centavosDoMp(f?.amount)
    if (v != null) taxa = (taxa ?? 0) + v
  }
  return { taxaCents: taxa, liquidoCents: liquido != null && liquido > 0 ? liquido : null }
}
