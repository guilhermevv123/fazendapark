/**
 * asaas.ts — cliente do Asaas para cobrança de ingresso.
 *
 * Portado do Diamond CRM (apps/web/server/utils/asaas.ts), que já roda isso em
 * produção. Mantidas as lições que custaram caro lá:
 *
 *   • A chave carrega o ambiente no prefixo ($aact_prod_ / $aact_hmlg_). Chave
 *     de produção batendo na URL de sandbox devolve 401 em TUDO — e o erro não
 *     diz "ambiente errado", diz "não autorizado". Aqui o ambiente é deduzido
 *     da chave e a config só desempata quando o prefixo não conta.
 *   • `access_token` vai no header, não Bearer.
 *   • Erro do Asaas vem 200 com corpo de erro em alguns casos: sempre olhar
 *     `errors[]` além do status.
 */

const PROD_URL = 'https://api.asaas.com/v3'
const SANDBOX_URL = 'https://api-sandbox.asaas.com/v3'

export interface ConfigAsaas {
  apiKey: string
  environment?: 'sandbox' | 'production' | null
  walletId?: string | null
}

export function ambienteDaChave(apiKey?: string | null): 'production' | 'sandbox' | null {
  const k = String(apiKey || '')
  if (k.includes('_prod_')) return 'production'
  if (k.includes('_hmlg_')) return 'sandbox'
  return null
}

function baseUrl(cfg: ConfigAsaas): string {
  const env = ambienteDaChave(cfg.apiKey) || cfg.environment || 'sandbox'
  return env === 'production' ? PROD_URL : SANDBOX_URL
}

export class ErroAsaas extends Error {
  constructor(public readonly status: number, public readonly detalhes: any, msg: string) {
    super(msg)
    this.name = 'ErroAsaas'
  }
}

async function chamar<T = any>(
  cfg: ConfigAsaas, metodo: string, caminho: string, corpo?: any,
): Promise<T> {
  if (!cfg.apiKey) throw new Error('Asaas sem api key configurada')
  const res = await fetch(`${baseUrl(cfg)}${caminho}`, {
    method: metodo,
    headers: {
      access_token: cfg.apiKey,
      'Content-Type': 'application/json',
      'User-Agent': 'diamond-tickets',
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  })

  const texto = await res.text()
  let json: any = null
  try { json = texto ? JSON.parse(texto) : null } catch { /* corpo não-JSON */ }

  // O Asaas devolve 200 com errors[] em alguns caminhos. Confiar só no status
  // deixa passar erro como sucesso.
  const erros = json?.errors
  if (!res.ok || (Array.isArray(erros) && erros.length)) {
    const msg = Array.isArray(erros) && erros.length
      ? erros.map((e: any) => e.description || e.code).join('; ')
      : `HTTP ${res.status}`
    const dica = res.status === 401
      ? ' (401 costuma ser chave de um ambiente batendo na URL do outro)'
      : ''
    throw new ErroAsaas(res.status, json ?? texto, `Asaas: ${msg}${dica}`)
  }
  return json as T
}

// ------------------------------------------------------------------ cliente
export interface DadosCliente {
  name: string
  email: string
  cpfCnpj: string
  mobilePhone?: string
}

/** Acha pelo CPF/CNPJ ou cria. O Asaas não faz upsert, então é find-then-create. */
export async function acharOuCriarCliente(cfg: ConfigAsaas, d: DadosCliente): Promise<string> {
  const doc = d.cpfCnpj.replace(/\D/g, '')
  const achados = await chamar<any>(cfg, 'GET', `/customers?cpfCnpj=${doc}&limit=1`)
  if (achados?.data?.[0]?.id) return achados.data[0].id
  const criado = await chamar<any>(cfg, 'POST', '/customers', {
    name: d.name, email: d.email, cpfCnpj: doc, mobilePhone: d.mobilePhone,
    notificationDisabled: true, // quem avisa o comprador somos nós
  })
  return criado.id
}

// ----------------------------------------------------------------- cobrança
export type FormaAsaas = 'PIX' | 'CREDIT_CARD' | 'BOLETO' | 'UNDEFINED'

export interface NovaCobranca {
  customer: string
  billingType: FormaAsaas
  value: number              // em REAIS (o Asaas fala reais; convertemos na borda)
  dueDate: string            // YYYY-MM-DD
  description?: string
  externalReference?: string // nosso order.id — é o que liga webhook a pedido
  installmentCount?: number
  creditCard?: {
    holderName: string; number: string; expiryMonth: string
    expiryYear: string; ccv: string
  }
  creditCardHolderInfo?: Record<string, any>
  remoteIp?: string
}

/** Centavos → reais, na borda e só aqui. Dentro do sistema é sempre centavo. */
export function centavosParaReais(cents: number): number {
  if (!Number.isInteger(cents)) throw new Error('centavos precisa ser inteiro')
  return Number((cents / 100).toFixed(2))
}

export function vencimentoEmDias(dias: number): string {
  const d = new Date()
  d.setDate(d.getDate() + dias)
  return d.toISOString().slice(0, 10)
}

export async function criarCobranca(cfg: ConfigAsaas, c: NovaCobranca): Promise<any> {
  const corpo: any = { ...c }
  if (cfg.walletId) {
    // split: a plataforma fica com a taxa, o resto vai pro produtor
    corpo.split = undefined // preenchido por quem chama, quando houver
  }
  return chamar(cfg, 'POST', '/payments', corpo)
}

export async function buscarCobranca(cfg: ConfigAsaas, id: string): Promise<any> {
  return chamar(cfg, 'GET', `/payments/${id}`)
}

export async function qrCodePix(
  cfg: ConfigAsaas, id: string,
): Promise<{ encodedImage?: string; payload?: string; expirationDate?: string } | null> {
  try {
    return await chamar(cfg, 'GET', `/payments/${id}/pixQrCode`)
  } catch (e) {
    // QR ainda não gerado é normal logo depois de criar a cobrança
    if (e instanceof ErroAsaas && e.status === 404) return null
    throw e
  }
}

export async function cancelarCobranca(cfg: ConfigAsaas, id: string): Promise<any> {
  return chamar(cfg, 'DELETE', `/payments/${id}`)
}

export async function estornar(cfg: ConfigAsaas, id: string, valorCents?: number): Promise<any> {
  return chamar(cfg, 'POST', `/payments/${id}/refund`,
    valorCents != null ? { value: centavosParaReais(valorCents) } : {})
}

export async function testarConexao(cfg: ConfigAsaas): Promise<{ ok: boolean; ambiente: string; erro?: string }> {
  const ambiente = ambienteDaChave(cfg.apiKey) || cfg.environment || 'sandbox'
  try {
    await chamar(cfg, 'GET', '/customers?limit=1')
    return { ok: true, ambiente }
  } catch (e: any) {
    return { ok: false, ambiente, erro: e.message }
  }
}

// ------------------------------------------------------------------ webhook
/**
 * Traduz o status do Asaas pro nosso. Deliberadamente explícito: um status
 * novo do gateway cai em `null` e o webhook registra sem inventar efeito,
 * em vez de virar 'pago' por descuido de um default.
 */
export function traduzirStatus(s?: string | null):
  | 'pago' | 'aguardando_pagamento' | 'estornado' | 'estornado_parcial'
  | 'cancelado' | 'chargeback' | 'disputa' | 'em_analise' | null {
  switch (String(s || '').toUpperCase()) {
    case 'RECEIVED':
    case 'CONFIRMED':
    case 'RECEIVED_IN_CASH':
      return 'pago'
    case 'PENDING':
    case 'AWAITING_RISK_ANALYSIS':
      return s === 'AWAITING_RISK_ANALYSIS' ? 'em_analise' : 'aguardando_pagamento'
    case 'OVERDUE':
      return 'aguardando_pagamento'
    case 'REFUNDED':
      return 'estornado'
    case 'PARTIALLY_REFUNDED':
      return 'estornado_parcial'
    case 'DELETED':
      return 'cancelado'
    case 'CHARGEBACK_REQUESTED':
    case 'CHARGEBACK_DISPUTE':
      return 'chargeback'
    case 'AWAITING_CHARGEBACK_REVERSAL':
      return 'disputa'
    default:
      return null
  }
}

/** Eventos de webhook que mexem em pedido. O resto a gente só registra. */
export const EVENTOS_QUE_IMPORTAM = new Set([
  'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH',
  'PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'PAYMENT_REFUNDED',
  'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED',
  'PAYMENT_CHARGEBACK_DISPUTE', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
  'PAYMENT_AWAITING_RISK_ANALYSIS', 'PAYMENT_APPROVED_BY_RISK_ANALYSIS',
  'PAYMENT_REPROVED_BY_RISK_ANALYSIS',
])
