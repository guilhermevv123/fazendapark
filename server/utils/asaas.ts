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
import { createHash, timingSafeEqual } from 'node:crypto'
import type { PoolClient } from 'pg'
import { cpfValido } from './documento'
import { db, q, q1, tx } from './db'
import { emitirNaTransacao } from './emissao'
import { liberar, soltarPedidoEmAnalise, SQL_COBRANCAS_A_CANCELAR } from './estoque'
import * as simulado from './gateway-simulado'
import { pendenciaDoEmail, transporteEscolhido } from './email'
import { baseDoSite } from './envio'
import { estadoDasChavesDeIngresso } from './ingresso'
import { estadoDoFreio } from './sessao'
import { abrirSegredo, CofreFechado } from './cofre'
import { pixPeloMercadoPago, type OrgMercadoPago } from './mercadopago-conta'

const PROD_URL = 'https://api.asaas.com/v3'
const SANDBOX_URL = 'https://api-sandbox.asaas.com/v3'

export interface ConfigAsaas {
  apiKey: string
  environment?: 'sandbox' | 'production' | null
  walletId?: string | null
}

export function ambienteDaChave(apiKey?: string | null): 'production' | 'sandbox' | null {
  // A chave pode vir do cofre (`cofre:v1:…`, utils/cofre.ts): o prefixo que diz o ambiente está
  // DENTRO dela. Cofre que não abre aqui vira "não sei" — quem cobra de verdade (`chamar`) é que
  // acusa a falta da chave, alto; a vitrine e o selo não caem por causa disso.
  let k = ''
  try { k = String(abrirSegredo(apiKey) || '') } catch (e) { if (!(e instanceof CofreFechado)) throw e }
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

/**
 * Quanto uma chamada ao Asaas pode demorar antes de desistir.
 *
 * Sem prazo, um Asaas pendurado (conexão aberta, resposta que não vem) segurava o checkout do
 * comprador, a varredura de minuto e a fila de estorno pelo tempo que o socket quisesse — e o
 * runner do Nitro não começa a rodada seguinte de uma tarefa com a anterior viva. Lido a cada
 * chamada (e não no import) pra o teste conseguir encurtar.
 */
function prazoDoAsaasMs(): number {
  const n = Number(process.env.ASAAS_PRAZO_MS)
  return Number.isFinite(n) && n > 0 ? n : 20_000
}

/**
 * A falha do Asaas é PASSAGEIRA (vale tentar depois) ou é uma recusa que vai se repetir?
 *
 * Passageira: rede, prazo estourado, 5xx e o 429 do limite de requisições. Quem varre para na
 * primeira passageira — os pedidos seguintes ouviriam o mesmo não, e no 429 insistir é justamente
 * o que a doc proíbe ("não execute retries imediatamente após 429"). A recusa escrita (4xx com
 * `errors[]`) não melhora com o tempo e não trava a fila dos outros.
 */
export function falhaPassageiraDoAsaas(e: unknown): boolean {
  if (e instanceof ErroAsaas) return e.status === 0 || e.status === 429 || e.status >= 500
  return true
}

async function chamar<T = any>(
  cfg: ConfigAsaas, metodo: string, caminho: string, corpo?: any,
): Promise<T> {
  if (!cfg.apiKey) throw new Error('Asaas sem api key configurada')
  // quem chama passa a chave como está no banco; texto puro de antes do cofre passa igual
  const chave = abrirSegredo(cfg.apiKey)!
  const res = await fetch(`${baseUrl(cfg)}${caminho}`, {
    method: metodo,
    headers: {
      access_token: chave,
      'Content-Type': 'application/json',
      'User-Agent': 'diamond-tickets',
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(prazoDoAsaasMs()),
  })

  // 429: a cota (25.000 chamadas/12h, 50 GETs simultâneos) estourou. Vira erro com o status pra
  // `falhaPassageiraDoAsaas` reconhecer, e com o `RateLimit-Reset` na frase — quem decide QUANDO
  // tentar de novo é a próxima rodada da varredura, nunca um laço aqui dentro.
  if (res.status === 429) {
    const reinicia = res.headers?.get?.('RateLimit-Reset') ?? null
    await res.text().catch(() => '')
    throw new ErroAsaas(429, { rateLimitReset: reinicia },
      `Asaas: limite de requisições atingido (429)${reinicia ? `, libera em ${reinicia} s` : ''}`)
  }

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
  /** "Fone celular" na doc do Asaas */
  mobilePhone?: string
  /** "Fone fixo" na doc do Asaas */
  phone?: string
}

/**
 * O telefone do formulário no campo que o Asaas documenta pra ele: celular
 * (11 dígitos, 9 depois do DDD) em `mobilePhone`, fixo (10 dígitos) em `phone`.
 *
 * B12: todo telefone ia em `mobilePhone`. Fixo como celular é dado que o
 * gateway pode recusar — e a recusa derrubava a compra inteira com "Não foi
 * possível gerar a cobrança", repetindo igual a cada tentativa. Número torto
 * (nem 10 nem 11 dígitos) não vai: o telefone é opcional pro Asaas, e mandar
 * lixo só troca uma venda por uma recusa.
 */
export function telefoneParaAsaas(telefone?: string | null): { mobilePhone?: string; phone?: string } {
  let d = String(telefone ?? '').replace(/\D/g, '')
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2)
  if (d.length === 11 && d[2] === '9') return { mobilePhone: d }
  if (d.length === 10) return { phone: d }
  return {}
}

/** Acha pelo CPF/CNPJ ou cria. O Asaas não faz upsert, então é find-then-create. */
export async function acharOuCriarCliente(cfg: ConfigAsaas, d: DadosCliente): Promise<string> {
  const doc = d.cpfCnpj.replace(/\D/g, '')
  const achados = await chamar<any>(cfg, 'GET', `/customers?cpfCnpj=${doc}&limit=1`)
  if (achados?.data?.[0]?.id) return achados.data[0].id
  const criado = await chamar<any>(cfg, 'POST', '/customers', {
    name: d.name, email: d.email, cpfCnpj: doc, mobilePhone: d.mobilePhone, phone: d.phone,
    notificationDisabled: true, // quem avisa o comprador somos nós
  })
  return criado.id
}

/**
 * A recusa do Asaas que é do DADO do comprador — e o campo dela.
 *
 * B12: qualquer erro do gateway virava "Não foi possível gerar a cobrança.
 * Tente de novo." — e tentar de novo dava o mesmo, porque o que o Asaas
 * recusou foi o celular, o e-mail ou o nome. O motivo ficava só no
 * `audit_log`. O Asaas responde 400 com `errors[{ code, description }]`, a
 * descrição já em português; aqui ela vira frase pro comprador, com o campo
 * pra tela marcar. Recusa que não é de campo do comprador (valor, vencimento,
 * conta) devolve `null` e segue como indisponibilidade.
 */
export function recusaDeDadoDoComprador(e: unknown): { campo: string; recado: string } | null {
  // 400 é a recusa de validação; 2xx com `errors[]` também existe (ver `chamar`)
  if (!(e instanceof ErroAsaas) || !(e.status === 400 || (e.status >= 200 && e.status < 300))) return null
  const erros = (e.detalhes as any)?.errors
  if (!Array.isArray(erros) || !erros.length) return null
  for (const erro of erros) {
    const codigo = String(erro?.code ?? '')
    const campo = /mobilePhone|phone/i.test(codigo) ? 'telefone'
      : /email/i.test(codigo) ? 'email'
      : /cpfCnpj|document/i.test(codigo) ? 'documento'
      : /(^|_)name$/i.test(codigo) ? 'nome'
      : null
    if (!campo) continue
    const rotulo: Record<string, string> = {
      telefone: 'o celular', email: 'o e-mail', documento: 'o CPF', nome: 'o nome',
    }
    const descricao = String(erro?.description ?? '').trim().replace(/\.$/, '')
    return {
      campo,
      recado: `O sistema de pagamento recusou ${rotulo[campo]}`
        + (descricao ? ` (${descricao})` : '') + '. Corrija e tente de novo.',
    }
  }
  return null
}

/**
 * Dá pra cobrar online AGORA? Decidido antes do formulário, não no último clique.
 *
 * PROD-06: organização sem chave do Asaas fazia o comprador preencher tudo e
 * só no fim receber 503 — com o cadastro gravado e o estoque reservado e
 * devolvido. E chave de TESTE (`_hmlg_`) em produção gerava PIX de mentira que
 * nenhum banco paga: todo pedido expirava. A vitrine usa esta mesma resposta
 * pra não oferecer pagamento que vai falhar, e o checkout pra recusar antes
 * de tocar em estoque. Nunca devolve a chave: só SIM/NÃO e o motivo.
 *
 * PROD-01: em produção, sem `ASAAS_WEBHOOK_TOKEN` o webhook recusa todo aviso
 * de pagamento (503, de propósito — aceitar anônimo seria ingresso de graça
 * pra quem achar a URL). Vender assim é cobrar e não entregar: o PIX cai no
 * Asaas e o ingresso não sai. Então também não vende (`sem_webhook`).
 */
export type MotivoSemPagamento = 'sem_chave' | 'chave_de_teste' | 'sem_webhook' | 'cofre_fechado'

export const RECADO_SEM_PAGAMENTO =
  'As vendas online estão indisponíveis no momento. Tente mais tarde ou compre na bilheteria.'

export function pagamentoOnline(
  org: { asaas_api_key?: string | null; asaas_env?: string | null } & OrgMercadoPago,
  /**
   * A forma que vai ser cobrada. Pix pode sair pelo Mercado Pago (28/09); cartão, só pelo Asaas.
   * Sem forma a pergunta é "dá pra vender online por ALGUMA forma?" — a da vitrine e a da saúde.
   */
  forma?: 'pix' | 'credito',
): { ok: true } | { ok: false; motivo: MotivoSemPagamento; recado: string } {
  if (simulado.ligado()) return { ok: true }
  const asaas = pagamentoPeloAsaas(org)
  if (asaas.ok) return asaas
  // O Pix do MP não depende do ASAAS_WEBHOOK_TOKEN: a varredura de minuto em minuto pergunta ao MP
  // por todo Pix esperando, com ou sem aviso chegando.
  const mp = pixPeloMercadoPago(org).ok
  if (forma !== 'credito') return mp ? { ok: true } : asaas
  // Cartão sem Asaas, com o Pix de pé: "vendas indisponíveis" mandaria embora quem pode pagar agora.
  return mp ? { ...asaas, recado: RECADO_CARTAO_FORA } : asaas
}

export const RECADO_CARTAO_FORA = 'O cartão está indisponível no momento. Pague com PIX — é na hora.'

/**
 * A régua do Asaas sozinha — o que era `pagamentoOnline` até o Pix do MP existir. É também a
 * pergunta do checkout quando o MP falha ao gerar o Pix: com o Asaas de pé, o Pix sai por ele.
 */
export function pagamentoPeloAsaas(org: { asaas_api_key?: string | null; asaas_env?: string | null }):
  { ok: true } | { ok: false; motivo: MotivoSemPagamento; recado: string } {
  const fechado = (motivo: MotivoSemPagamento) => ({ ok: false as const, motivo, recado: RECADO_SEM_PAGAMENTO })
  if (!org.asaas_api_key) return fechado('sem_chave')
  // chave no cofre sem a chave do cofre no servidor: não dá pra cobrar — diz isso (a saúde e o
  // aviso do boot leem este motivo), em vez de oferecer um pagamento que vai dar 401
  try { abrirSegredo(org.asaas_api_key) } catch (e) {
    if (e instanceof CofreFechado) return fechado('cofre_fechado')
    throw e
  }
  const producao = process.env.NODE_ENV === 'production'
  const ambiente = ambienteDaChave(org.asaas_api_key) || org.asaas_env || 'sandbox'
  if (producao && ambiente !== 'production') return fechado('chave_de_teste')
  if (producao && !String(process.env.ASAAS_WEBHOOK_TOKEN ?? '').trim()) return fechado('sem_webhook')
  return { ok: true }
}

// ----------------------------------------------------------------- cobrança
export type FormaAsaas = 'PIX' | 'CREDIT_CARD' | 'BOLETO' | 'UNDEFINED'

export interface NovaCobranca {
  customer: string
  billingType: FormaAsaas
  /** à vista, em REAIS (o Asaas fala reais; convertemos na borda). Parcelado NÃO manda — ver `valorDaCobranca` */
  value?: number
  /** parcelado: o TOTAL da compra, em reais; o Asaas divide e põe o centavo do arredondamento na última */
  totalValue?: number
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
  /** volta da fatura pro pedido — só com ASAAS_CALLBACK_LIGADO=1 (ver `retornoDaFatura` no checkout) */
  callback?: { successUrl: string; autoRedirect?: boolean }
}

/** Centavos → reais, na borda e só aqui. Dentro do sistema é sempre centavo. */
export function centavosParaReais(cents: number): number {
  if (!Number.isInteger(cents)) throw new Error('centavos precisa ser inteiro')
  return Number((cents / 100).toFixed(2))
}

/**
 * O valor da cobrança no formato que o Asaas DOCUMENTA pro `POST /v3/payments`.
 *
 * À vista: `value`. Parcelado: `installmentCount` + `totalValue`, e SEM `value`. A doc diz que a
 * cobrança parcelada leva o número de parcelas junto de `installmentValue` (valor de cada uma) OU
 * `totalValue` (o total, que o Asaas divide). O checkout mandava `value` = TOTAL junto de
 * `installmentCount` — combinação fora do contrato, que arrisca o gateway ler o total como valor de
 * CADA parcela: a compra de R$ 60 em 3x virando R$ 180 no cartão do cliente. Achado na auditoria
 * de 27/09 (B06). `totalValue` deixa a divisão (e o centavo que sobra) com quem cobra.
 */
export function valorDaCobranca(totalCents: number, parcelas: number | null | undefined)
  : Pick<NovaCobranca, 'value' | 'totalValue' | 'installmentCount'> {
  const reais = centavosParaReais(totalCents)
  const n = Number(parcelas)
  return Number.isInteger(n) && n > 1 ? { installmentCount: n, totalValue: reais } : { value: reais }
}

/**
 * Reais → centavos. O caminho de volta, e também só aqui.
 *
 * O gateway fala reais em ponto flutuante (`"value": 19.9`); dentro do sistema
 * é centavo inteiro. Converter espalhado pelo código é como aparece
 * `19.900000000000002` num relatório. Devolve `null` quando o campo não veio
 * ou não é número — quem chama decide o que fazer com a ausência, em vez de
 * receber um zero que parece um valor.
 */
export function reaisParaCentavos(v: unknown): number | null {
  const n = typeof v === 'number' ? v
    : typeof v === 'string' && v.trim() !== '' ? Number(v)
    : NaN
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

/**
 * Data de vencimento da cobrança, `YYYY-MM-DD`, em HORÁRIO LOCAL.
 *
 * Nada de `toISOString().slice(0,10)`: ele converte pra UTC ANTES de cortar, e
 * Brasília está 3h atrás. Medido às 23:48 de 20/09, `vencimentoEmDias(1)`
 * devolvia `2026-09-22` — a cobrança nascia com um dia a mais de prazo. O parque
 * vende de noite; a janela errada é justamente o horário de pico.
 *
 * `agora` é injetável pelo mesmo motivo do `prazoDeReserva` em estoque.ts: sem
 * isso o teste depende da hora em que roda e fica verde de dia.
 *
 * E "local" é o do PARQUE (America/Bahia), não o da máquina: o contêiner do EasyPanel nasce em
 * UTC, e aí `getDate()` repetia o defeito do `toISOString()` por outro caminho — às 23:48 de
 * Itapetinga o servidor já está no dia seguinte. A data do Asaas é a do calendário brasileiro.
 */
export function vencimentoEmDias(dias: number, agora = new Date()): string {
  const [ano, mes, dia] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bahia', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(agora).split('-').map(Number)
  // aritmética de CALENDÁRIO, em UTC puro: sem fuso no meio, a virada de mês e de ano é do Date
  return new Date(Date.UTC(ano, mes - 1, dia + dias)).toISOString().slice(0, 10)
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

/* ------------------------------------------------- o PARCELAMENTO (041) */
/**
 * Compra no cartão em 3x vira no Asaas UM parcelamento (`ins_…`) com TRÊS cobranças, uma por
 * parcela. Tudo que age "no pedido inteiro" tem que agir no parcelamento:
 *
 *   · estorno: `POST /installments/{id}/refund` — sem `value` devolve tudo, com `value` é parcial
 *     (docs.asaas.com/reference/estornar-parcelamento). `POST /payments/{1ª}/refund` devolvia só a
 *     1ª parcela e o sistema dava o pedido por devolvido;
 *   · cancelar: `DELETE /installments/{id}`. "Excluir uma parcela não cancela o parcelamento"
 *     (docs.asaas.com/reference/excluir-cobranca): as parcelas 2..n continuavam vivas e pagáveis;
 *   · conferir: `GET /payments?installment={id}` traz as parcelas, e o estornado é a SOMA delas.
 *
 * O id mora em `orders.asaas_installment_id`. Pedido de antes da coluna (ou o checkout que não
 * conseguiu gravar) pergunta em `GET /payments/{id}` — a cobrança traz o campo `installment` — e
 * grava o que achou, pra não perguntar de novo.
 */
export interface PedidoNoAsaas {
  orderId?: string | null
  paymentId: string
  /** `orders.installments` */
  parcelas?: number | null
  /** `orders.asaas_installment_id` */
  parcelamentoId?: string | null
}

export async function parcelamentoDoPedido(cfg: ConfigAsaas, p: PedidoNoAsaas): Promise<string | null> {
  if (p.parcelamentoId) return p.parcelamentoId
  // à vista não tem parcelamento: nada a perguntar (e nenhuma chamada a mais na cota)
  if (!(Number(p.parcelas) > 1) || !p.paymentId || p.paymentId.startsWith('sim_')) return null
  const cobranca = await buscarCobranca(cfg, p.paymentId)
  const id = String(cobranca?.installment ?? '').trim() || null
  if (id && p.orderId) {
    await q(`UPDATE orders SET asaas_installment_id = $2 WHERE id = $1 AND asaas_installment_id IS NULL`,
      [p.orderId, id]).catch(() => {})
  }
  return id
}

/** O pedido como o Asaas precisa vê-lo — lido do banco por id do pedido ou pelo da cobrança. */
async function pedidoNoAsaas(a: { orderId?: string | null; paymentId: string }) {
  const o = a.orderId
    ? await q1<any>(`SELECT id, installments, asaas_installment_id, total_cents FROM orders WHERE id = $1`,
        [a.orderId])
    : await q1<any>(`SELECT id, installments, asaas_installment_id, total_cents FROM orders
                      WHERE asaas_payment_id = $1`, [a.paymentId])
  return {
    pedido: { orderId: o?.id ?? a.orderId ?? null, paymentId: a.paymentId,
              parcelas: o?.installments ?? null, parcelamentoId: o?.asaas_installment_id ?? null },
    totalCents: o ? Number(o.total_cents) : null,
  }
}

/**
 * Devolve o dinheiro de UM PEDIDO pelo Asaas — o parcelamento inteiro quando a compra foi parcelada.
 *
 * `valorCents` é o que falta devolver. Igual ao total do pedido (ou ausente) vai SEM `value`, que
 * é o estorno total da doc; menor, vai com `value` (parcial).
 */
export async function estornarPedidoNoAsaas(
  cfg: ConfigAsaas, a: { orderId?: string | null; paymentId: string; valorCents?: number | null },
): Promise<any> {
  const { pedido, totalCents } = await pedidoNoAsaas(a)
  const parcelamento = await parcelamentoDoPedido(cfg, pedido)
  if (!parcelamento) return estornar(cfg, a.paymentId, a.valorCents ?? undefined)
  const parcial = a.valorCents != null && totalCents != null && a.valorCents < totalCents
  return chamar(cfg, 'POST', `/installments/${encodeURIComponent(parcelamento)}/refund`,
    parcial ? { value: centavosParaReais(a.valorCents!) } : {})
}

/** Cancela a cobrança do pedido no gateway — o parcelamento inteiro, quando houver. */
export async function cancelarCobrancaDoPedido(cfg: ConfigAsaas, p: PedidoNoAsaas): Promise<any> {
  const parcelamento = await parcelamentoDoPedido(cfg, p)
  if (parcelamento) return chamar(cfg, 'DELETE', `/installments/${encodeURIComponent(parcelamento)}`)
  return cancelarCobranca(cfg, p.paymentId)
}

export interface EstornosNoAsaas {
  /** devolvido de verdade: só estorno `DONE` conta (docs.asaas.com/docs/estornos) */
  devolvidoCents: number
  /** pedido ao banco e ainda `PENDING`: não conta como devolvido, mas também não se pede de novo */
  pendenteCents: number
  reciboId: string | null
}

/** Os estornos de UMA cobrança: o que já saiu (DONE) e o que está a caminho (PENDING). */
function estornosDaCobranca(c: any): EstornosNoAsaas {
  let devolvido = valorEstornadoCents(c)
  // cobrança REFUNDED sem o detalhe dos estornos: o próprio status diz que voltou tudo
  if (devolvido == null && String(c?.status ?? '').toUpperCase() === 'REFUNDED') {
    devolvido = reaisParaCentavos(c?.value)
  }
  let pendente = 0
  let recibo: string | null = null
  for (const r of Array.isArray(c?.refunds) ? c.refunds : []) {
    const s = String(r?.status ?? '').toUpperCase()
    if (s === 'PENDING') pendente += reaisParaCentavos(r?.value) ?? 0
    if (s === 'DONE' && r?.id) recibo = String(r.id)
  }
  return { devolvidoCents: devolvido ?? 0, pendenteCents: pendente, reciboId: recibo }
}

/**
 * Quanto o Asaas já devolveu deste PEDIDO — somando todas as parcelas quando é parcelado.
 *
 * É a pergunta "o estorno já saiu?" da fila de devolução. Olhar só a 1ª parcela respondia
 * "devolveu 1/3" de um parcelamento estornado inteiro (e a fila mandaria de novo) ou, no avesso,
 * "devolveu tudo" com só a 1ª parcela de volta.
 */
export async function conferirEstornosNoAsaas(
  cfg: ConfigAsaas, a: { orderId?: string | null; paymentId: string },
): Promise<EstornosNoAsaas> {
  const { pedido } = await pedidoNoAsaas(a)
  const parcelamento = await parcelamentoDoPedido(cfg, pedido)
  const cobrancas: any[] = parcelamento
    ? (await chamar<any>(cfg, 'GET',
        `/payments?installment=${encodeURIComponent(parcelamento)}&limit=100`))?.data ?? []
    : [await buscarCobranca(cfg, a.paymentId)]
  const soma: EstornosNoAsaas = { devolvidoCents: 0, pendenteCents: 0, reciboId: null }
  for (const c of cobrancas) {
    const e = estornosDaCobranca(c)
    soma.devolvidoCents += e.devolvidoCents
    soma.pendenteCents += e.pendenteCents
    soma.reciboId = e.reciboId ?? soma.reciboId
  }
  return soma
}

/* ------------------------------------------- cobrança de reserva que caiu */

/**
 * Como a varredura cancela a cobrança no gateway. Injetável pelo teste. O terceiro argumento é o
 * pedido (parcelas e parcelamento), pro cancelador de verdade apagar o PARCELAMENTO inteiro.
 */
export type Cancelador = (cfg: ConfigAsaas, paymentId: string, pedido?: PedidoNoAsaas) => Promise<any>

let canceladorInjetado: Cancelador | null = null

/** Mesmo motivo do `usarConsultaDeCobranca`: o teste precisa de um que responda sem rede. */
export function usarCancelador(f: Cancelador | null) {
  canceladorInjetado = f
}

/** Tentativas por pedido antes de desistir e deixar a trilha dizendo por quê. */
export const MAX_TENTATIVAS_CANCELAR = 3

export interface ResultadoDoCancelamento {
  pedidoId: string
  ok: boolean
  erro: string | null
}

/**
 * Cancela no Asaas a cobrança de todo pedido que expirou.
 *
 * O P0 de 22/09: reserva morria, cobrança seguia viva, o comprador pagava o
 * QR que ainda estava na tela e o dinheiro entrava sem ingresso. Cancelar a
 * cobrança fecha a porta na origem — o PIX cancelado não é mais pagável.
 *
 * Três decisões:
 *
 *  • **fora da transação que expira o pedido.** Quem chama é a tarefa de fundo,
 *    DEPOIS do commit da expiração. Chamada de rede com lote travado é fila, e
 *    gateway fora do ar não pode segurar estoque preso;
 *  • **erro não trava nada, e não some.** Cada tentativa vira linha no
 *    `audit_log` do pedido (`cobranca_cancelada` / `cobranca_cancelar_falhou`
 *    com a mensagem do gateway). Até `MAX_TENTATIVAS_CANCELAR`, com espera
 *    entre elas. O motivo mais comum de falha é o bom: o comprador pagou no
 *    último segundo e o Asaas recusa apagar cobrança recebida — aí quem
 *    resolve é o webhook, que tenta emitir de novo (`emissao.ts`);
 *  • **uma instância por vez.** A trava consultiva de SESSÃO faz a segunda
 *    cópia do servidor passar reto em vez de cancelar a mesma cobrança duas
 *    vezes (a segunda viraria um "falhou" falso na trilha).
 *
 * 404 do gateway conta como cancelada: a cobrança já não existe.
 */
export async function cancelarCobrancasDeExpirados(limite = 50): Promise<ResultadoDoCancelamento[]> {
  const conexao = await db().connect()
  const feitos: ResultadoDoCancelamento[] = []
  let travou = false
  try {
    const { rows: trava } = await conexao.query(
      `SELECT pg_try_advisory_lock(hashtext('dt:cancelar-cobrancas-expiradas')) AS ok`)
    travou = !!trava[0]?.ok
    if (!travou) return feitos

    const pendentes = await q<any>(SQL_COBRANCAS_A_CANCELAR, [limite, MAX_TENTATIVAS_CANCELAR])
    // o cancelador de verdade apaga o PARCELAMENTO inteiro quando a compra foi parcelada (041)
    const cancelar: Cancelador = canceladorInjetado
      ?? ((cfg, id, pedido) => cancelarCobrancaDoPedido(cfg, pedido ?? { paymentId: id }))
    for (const p of pendentes) {
      let erro: string | null = null
      const cfg = { apiKey: p.asaas_api_key, environment: p.asaas_env, walletId: p.asaas_wallet }
      if (!p.asaas_api_key && !canceladorInjetado) {
        erro = 'organização sem chave do Asaas: não dá pra cancelar a cobrança'
      } else {
        try {
          await cancelar(cfg, p.asaas_payment_id, {
            orderId: p.id, paymentId: p.asaas_payment_id,
            parcelas: p.installments ?? null, parcelamentoId: p.asaas_installment_id ?? null,
          })
        } catch (e: any) {
          if (!(e instanceof ErroAsaas && e.status === 404)) erro = e?.message ?? String(e)
        }
      }

      // O motivo mais comum de o Asaas recusar o cancelamento é o bom: o comprador PAGOU no último
      // segundo (cobrança recebida não se apaga). Só anotar a recusa deixava o dinheiro entrar sem
      // ingresso até um webhook que pode nunca vir. Pergunta ao gateway e, pago, aplica pelo MESMO
      // caminho do webhook (a emissão refaz a reserva do pedido expirado, ou pendura "pago sem
      // lugar" na tela de entregas).
      if (erro) {
        const pago = await aplicarSePago({ orgId: p.org_id, pedidoId: p.id, paymentId: p.asaas_payment_id })
          .catch(() => null)
        if (pago) {
          await q(
            `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
             VALUES ($1, 'order', $2, 'cobranca_paga_no_vao', $3::jsonb)`,
            [p.org_id, p.id, JSON.stringify({ cobranca: p.asaas_payment_id, pedido: p.code,
              statusNoGateway: pago.status, aplicado: pago.desfecho.ok,
              erro: pago.desfecho.ok ? null : pago.desfecho.erro })])
          feitos.push({ pedidoId: p.id, ok: true, erro: null })
          continue
        }
      }
      await q(
        `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
         VALUES ($1, 'order', $2, $3, $4::jsonb)`,
        [p.org_id, p.id, erro ? 'cobranca_cancelar_falhou' : 'cobranca_cancelada',
         JSON.stringify({ cobranca: p.asaas_payment_id, pedido: p.code, erro })])
      if (erro) {
        console.warn(`[asaas] não cancelou a cobrança ${p.asaas_payment_id} do pedido `
          + `${p.code} (expirado): ${erro}`)
      }
      feitos.push({ pedidoId: p.id, ok: !erro, erro })
    }
    return feitos
  } finally {
    if (travou) {
      await conexao.query(`SELECT pg_advisory_unlock(hashtext('dt:cancelar-cobrancas-expiradas'))`)
        .catch(() => {})
    }
    conexao.release()
  }
}

/* ------------------------------------------ análise de risco sem saída (B09) */

/**
 * Depois de quanto tempo em análise o pedido passa a ser perguntado ao gateway,
 * e de quanto em quanto tempo a pergunta se repete.
 *
 * Perguntar cedo não custa nada — o gateway é quem decide, e "ainda em
 * análise" mantém o pedido. O que custa é NÃO perguntar: o pedido em
 * 'em_analise' não tem prazo (o gatilho da 011 só carimba prazo em
 * 'aguardando_pagamento'), `liberarExpirados` não o enxerga, e a reprovação
 * cujo webhook se perdeu segurava o lugar pra sempre.
 */
export const EM_ANALISE_PERGUNTAR_APOS_MIN = Number(process.env.EM_ANALISE_PERGUNTAR_APOS_MIN || 120)
export const EM_ANALISE_REPERGUNTAR_MIN = 60

const STATUS_PAGO = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'])
const STATUS_SEM_ANALISE = new Set(['PENDING', 'OVERDUE'])
const STATUS_ACABOU = new Set(['REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS'])

export interface DesfechoDaAnalise {
  pedidoId: string
  /** 'solto' devolveu o lugar; 'mantido' continua esperando */
  desfecho: 'solto' | 'mantido'
  statusNoGateway: string | null
  motivo: string
}

/**
 * O que fazer com um pedido em análise, dado o que o GATEWAY diz dele.
 *
 * PURO, e a regra que manda é: **nunca soltar o que o gateway diz que foi
 * pago ou aprovado.** Soltar é só quando ele diz, com todas as letras, que a
 * cobrança voltou a esperar pagamento (reprovada), foi apagada ou devolvida.
 * Consulta que falhou, cobrança não encontrada ou status que não conhecemos
 * mantêm o pedido — o custo de errar pra esse lado é um lugar preso por mais
 * uma hora; pro outro, é um comprador pago sem ingresso.
 */
export function decidirEmAnalise(cobranca: any | null):
  { soltar: false; motivo: string } | { soltar: true; para: 'expirado' | 'cancelado'; motivo: string } {
  if (!cobranca) return { soltar: false, motivo: 'o gateway não respondeu sobre a cobrança' }
  const status = String(cobranca.status ?? '').toUpperCase()
  if (STATUS_PAGO.has(status)) {
    return { soltar: false,
      motivo: `o gateway diz ${status}: o pagamento entrou e o webhook não baixou — reprocessar a entrega` }
  }
  if (cobranca.deleted === true) return { soltar: true, para: 'cancelado', motivo: 'cobrança apagada no gateway' }
  if (status === 'AWAITING_RISK_ANALYSIS') return { soltar: false, motivo: 'ainda em análise de risco' }
  if (STATUS_SEM_ANALISE.has(status)) {
    return { soltar: true, para: 'expirado', motivo: `análise encerrada sem pagamento (${status})` }
  }
  if (STATUS_ACABOU.has(status)) return { soltar: true, para: 'cancelado', motivo: `cobrança ${status}` }
  return { soltar: false, motivo: `status ${status || 'vazio'} não é decisão pra soltar lugar` }
}

/**
 * A varredura: pedidos em análise há mais de `EM_ANALISE_PERGUNTAR_APOS_MIN`,
 * não perguntados na última hora, até `limite` por rodada. Cada pergunta vira
 * linha no `audit_log` (`em_analise_consulta`), que é a marca de "já perguntei"
 * e a trilha que o painel mostra. Uma instância por vez (trava de sessão), como
 * `cancelarCobrancasDeExpirados`.
 */
export async function varrerEmAnalise(limite = 20): Promise<DesfechoDaAnalise[]> {
  const conexao = await db().connect()
  const feitos: DesfechoDaAnalise[] = []
  let travou = false
  try {
    const { rows: trava } = await conexao.query(
      `SELECT pg_try_advisory_lock(hashtext('dt:varrer-em-analise')) AS ok`)
    travou = !!trava[0]?.ok
    if (!travou) return feitos

    const candidatos = await q<any>(
      `SELECT o.id, o.org_id, o.code, o.asaas_payment_id
         FROM orders o
        WHERE o.status = 'em_analise'
          AND o.created_at < now() - make_interval(mins => $1)
          AND NOT EXISTS (SELECT 1 FROM audit_log a
                           WHERE a.entity = 'order' AND a.entity_id = o.id::text
                             AND a.action = 'em_analise_consulta'
                             AND a.created_at > now() - make_interval(mins => $2))
        ORDER BY o.created_at
        LIMIT $3`,
      [EM_ANALISE_PERGUNTAR_APOS_MIN, EM_ANALISE_REPERGUNTAR_MIN, limite])

    for (const p of candidatos) {
      let cobranca: any = null
      let erro: string | null = null
      try {
        cobranca = await consultarCobranca({ orgId: p.org_id, paymentId: String(p.asaas_payment_id ?? '') })
      } catch (e: any) {
        erro = e?.message ?? String(e)
      }
      const d = decidirEmAnalise(cobranca)
      let solto = false
      if (d.soltar) solto = await tx((c) => soltarPedidoEmAnalise(c, p.id, d.para))
      const statusNoGateway = cobranca?.status ?? null
      let motivo = erro ? `consulta falhou: ${erro}` : d.motivo
      // PAGO no gateway e o webhook não baixou: antes era só um `console.warn` — o comprador pago
      // seguia sem ingresso até alguém ler o log. Agora aplica pelo MESMO caminho do webhook (a
      // consulta já está na mão: nenhuma chamada a mais), com a chave determinística da varredura.
      if (!solto && cobranca && STATUS_PAGO.has(String(cobranca.status).toUpperCase())) {
        const r = await aplicarCobrancaConsultada({ pedidoId: p.id, cobranca, paymentId: p.asaas_payment_id })
          .catch((e: any) =>
          ({ ok: false as const, erro: e?.message ?? String(e), indisponivel: true }))
        motivo = r.ok ? `${d.motivo} — aplicado pela varredura` : `${d.motivo} — aplicar falhou: ${r.erro}`
        if (!r.ok) console.warn(`[asaas] pedido ${p.code} em análise e PAGO no gateway: ${motivo}`)
      }
      await q(
        `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
         VALUES ($1, 'order', $2, 'em_analise_consulta', $3::jsonb)`,
        [p.org_id, p.id, JSON.stringify({ pedido: p.code, statusNoGateway, solto, motivo })])
      feitos.push({ pedidoId: p.id, desfecho: solto ? 'solto' : 'mantido', statusNoGateway, motivo })
    }
    return feitos
  } finally {
    if (travou) {
      await conexao.query(`SELECT pg_advisory_unlock(hashtext('dt:varrer-em-analise'))`).catch(() => {})
    }
    conexao.release()
  }
}

export async function estornar(cfg: ConfigAsaas, id: string, valorCents?: number): Promise<any> {
  return chamar(cfg, 'POST', `/payments/${id}/refund`,
    valorCents != null ? { value: centavosParaReais(valorCents) } : {})
}

// ------------------------------------------------------ transferência (saque)
/**
 * Daqui pra baixo é o dinheiro SAINDO da plataforma: a fila de saque que
 * `POST /api/admin/evento/:id/financeiro` grava como 'solicitada' e que
 * `POST /api/admin/payout/executar` executa.
 *
 * ## O único defeito que importa aqui é pagar duas vezes
 *
 * Cobrança errada dá pra estornar. Transferência errada sai da conta e vira
 * ligação pro produtor pedindo o dinheiro de volta. São três paredes, nessa
 * ordem, e cada uma cobre o buraco da anterior:
 *
 * 1. **Reivindicação atômica** (`SQL_REIVINDICAR_PAYOUT`): um `UPDATE ...
 *    WHERE status = 'solicitada' RETURNING`. Duas execuções simultâneas na
 *    mesma linha: a segunda espera o commit da primeira, reavalia o `WHERE`,
 *    não acha mais 'solicitada' e volta com ZERO linhas. Um `SELECT` pra ver
 *    se está livre seguido de um `UPDATE` deixa as duas passarem — cabe a
 *    execução inteira entre os dois comandos.
 *
 * 2. **Chave de idempotência no gateway** (`idempotency_key` →
 *    `externalReference`): a parede 1 não cobre o caso que mais acontece de
 *    verdade — a transferência SAIU e a resposta se perdeu (timeout, deploy no
 *    meio, processo morto). A linha fica 'processando' sem id do gateway, e
 *    retentar às cegas transfere de novo. Com a chave dá pra PERGUNTAR ao
 *    Asaas se aquela transferência já existe, e adotá-la em vez de criar outra.
 *
 * 3. **Nunca criar sem uma resposta clara de "não existe"**: se a consulta
 *    pela chave falhar, o executor NÃO transfere — devolve pra fila com o erro
 *    escrito. Falhar fechado deixa o produtor esperando; falhar aberto paga
 *    duas vezes.
 *
 * A transação NUNCA fica aberta durante a chamada ao gateway. A reivindicação
 * é um comando só, que confirma na hora; o gateway é chamado fora de qualquer
 * transação; o resultado é outro comando. Segurar a linha travada enquanto o
 * Asaas pensa é como a fila inteira para quando ele demora.
 */

/** Depois disto a linha vira 'falhou' com o erro escrito, em vez de retentar pra sempre. */
export const MAX_TENTATIVAS = 5

/**
 * Quanto tempo uma linha 'processando' SEM id de transferência precisa ficar
 * parada antes de ser reconciliada. É a carência que separa "o gateway ainda
 * está respondendo" de "o processo morreu no meio". Curta demais reconcilia em
 * cima de uma chamada viva; longa demais deixa o produtor esperando.
 */
export const MINUTOS_DE_CARENCIA = 5

/**
 * A chave que vai ao gateway como `externalReference`.
 *
 * É o id do payout com prefixo — id de payout é único e NÃO muda entre
 * retentativas, que é a única propriedade que importa numa chave de
 * idempotência. O prefixo existe porque a mesma conta Asaas atende outros
 * sistemas (é o arranjo do dono hoje): sem ele, um uuid solto em
 * `externalReference` não diz de quem é.
 */
export function chaveDeIdempotencia(payoutId: string): string {
  const id = String(payoutId ?? '').trim()
  if (!id) throw new Error('payout sem id: não dá pra montar chave de idempotência')
  return `payout_${id}`
}

export type TipoChavePix = 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP'

const UUID_PIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Que tipo de chave PIX é esta — e `null` quando não dá pra saber.
 *
 * O Asaas exige o tipo junto da chave. Chutar aqui é mandar dinheiro pro
 * destino errado, então o que não é reconhecível com certeza volta `null` e a
 * transferência é recusada com uma frase que diz como corrigir o cadastro.
 *
 * O caso ambíguo é 11 dígitos: pode ser CPF ou celular sem o +55. O dígito
 * verificador desempata — CPF inválido com 11 dígitos é celular escrito
 * errado, e aí o operador precisa reescrever com +55.
 */
export function tipoDeChavePix(chave: string | null | undefined): TipoChavePix | null {
  const s = String(chave ?? '').trim()
  if (!s) return null
  if (s.includes('@')) return 'EMAIL'
  if (UUID_PIX.test(s)) return 'EVP'

  const so = s.replace(/\D/g, '')
  // O +55 é a única marca que separa telefone de documento sem adivinhação.
  if (s.startsWith('+')) return so.length === 12 || so.length === 13 ? 'PHONE' : null
  if (so.length === 14) return 'CNPJ'
  if (so.length === 11) return cpfValido(so) ? 'CPF' : null
  if ((so.length === 12 || so.length === 13) && so.startsWith('55')) return 'PHONE'
  return null
}

/**
 * Destino que o gateway não consegue pagar do jeito que está cadastrado.
 *
 * Separado do `ErroAsaas` de propósito: erro de gateway é retentável (ele pode
 * estar fora do ar), erro de destino não melhora sozinho — enquanto o cadastro
 * não mudar, a décima tentativa erra igual à primeira. O executor marca essa
 * linha como 'falhou' na hora, com a frase pronta pro operador.
 */
export class ErroDeDestino extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'ErroDeDestino'
  }
}

export interface PayoutEmExecucao {
  id: string
  code?: string | null
  amount_cents: number
  destination_kind: string
  destination: string
  beneficiary_name?: string | null
  idempotency_key?: string | null
  attempts?: number
}

export interface CorpoDeTransferencia {
  value: number
  operationType: 'PIX'
  pixAddressKey: string
  pixAddressKeyType: TipoChavePix
  description: string
  externalReference: string
}

/**
 * O corpo do POST /transfers — em REAIS, porque é o que o gateway fala, com a
 * conversão acontecendo só aqui na borda (ver `centavosParaReais`).
 *
 * `externalReference` NÃO é enfeite de conciliação: é a chave de idempotência.
 * Sem ela não existe como perguntar ao Asaas "esta transferência já saiu?",
 * e toda retentativa depois de um timeout vira um segundo pagamento.
 *
 * Transferência pra conta bancária fica de fora de propósito: a coluna
 * `destination` guarda TEXTO LIVRE ("Banco do Brasil ag 1234 c/c 56789-0") e o
 * Asaas precisa de banco, agência, conta, dígito, tipo e CPF/CNPJ do titular em
 * campos separados. Quebrar esse texto no palpite é depositar na conta errada —
 * essas ficam pro humano, listadas na resposta da execução.
 */
export function corpoDaTransferencia(p: PayoutEmExecucao): CorpoDeTransferencia {
  if (p.destination_kind !== 'pix') {
    throw new ErroDeDestino(
      'Esta transferência é para conta bancária e o cadastro guarda o destino como texto livre. '
      + 'Faça a transferência pelo painel do Asaas e marque este saque como concluído, '
      + 'ou recadastre o beneficiário com uma chave PIX.')
  }
  const tipo = tipoDeChavePix(p.destination)
  if (!tipo) {
    throw new ErroDeDestino(
      `Não dá para reconhecer "${String(p.destination ?? '').trim()}" como chave PIX. `
      + 'Use CPF, CNPJ, e-mail, chave aleatória, ou telefone com +55 (ex.: +5577999998888).')
  }
  if (!Number.isInteger(p.amount_cents) || p.amount_cents <= 0) {
    throw new ErroDeDestino('Valor do saque inválido. Peça a transferência de novo.')
  }
  return {
    value: centavosParaReais(p.amount_cents),
    operationType: 'PIX',
    pixAddressKey: String(p.destination).trim(),
    pixAddressKeyType: tipo,
    description: `Conquista Park — saque ${p.code ?? p.id}`,
    externalReference: p.idempotency_key || chaveDeIdempotencia(p.id),
  }
}

/** Cria a transferência no gateway. Só isso — quem decide se pode é o executor. */
export async function transferir(cfg: ConfigAsaas, corpo: CorpoDeTransferencia): Promise<any> {
  return chamar(cfg, 'POST', '/transfers', corpo)
}

/**
 * O gateway respondeu, mas a resposta não serve pra concluir nada.
 *
 * Separado do `ErroAsaas` e do `ErroDeDestino` porque é uma terceira coisa:
 * não é o gateway fora do ar, não é cadastro errado — é uma resposta que não
 * responde a pergunta. Quem chama trata como desfecho DESCONHECIDO, que é o
 * único tratamento seguro (ver `devolverOuFalhar`).
 */
export class ErroDeConsulta extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'ErroDeConsulta'
  }
}

/**
 * A transferência com esta chave já existe no gateway?
 *
 * A referência é conferida NA LINHA que voltou, não no filtro da consulta: um
 * parâmetro que o gateway não conhece é ignorado em silêncio e a resposta volta
 * com TODAS as transferências da conta. Adotar a primeira da lista seria dar
 * este saque por pago com a transferência de outro produtor — e o dinheiro
 * deste nunca sairia, sem nenhum erro em lugar nenhum.
 *
 * **E o contrário também não vale.** Se o filtro foi ignorado, a lista é uma
 * janela das transferências da conta INTEIRA — e a nossa pode simplesmente
 * não estar nela (a conta atende outros sistemas; a retentativa pode ser dias
 * depois). Não achar aí não é "não existe", é "não dá pra saber", e a parede 3
 * diz que sem um "não existe" CLARO não se cria. Antes disto a função devolvia
 * `null` nos dois casos e o executor transferia — o pagamento duplicado que a
 * chave de idempotência existe pra impedir entrava justamente por aqui.
 *
 * Como se distingue um do outro sem adivinhar: com o filtro aplicado, toda
 * linha que voltar carrega a chave pedida. **Uma linha com referência
 * diferente é a prova de que o filtro não foi aplicado** — e aí a resposta é
 * inconclusiva, não negativa. Lista vazia continua sendo um "não existe"
 * claro: filtro aplicado sem resultado, ou conta sem transferência nenhuma.
 */
export async function acharTransferencia(cfg: ConfigAsaas, chave: string): Promise<any | null> {
  const r = await chamar<any>(
    cfg, 'GET', `/transfers?externalReference=${encodeURIComponent(chave)}&limit=100`)
  const lista = Array.isArray(r?.data) ? r.data : []
  const minha = lista.find((t: any) => String(t?.externalReference ?? '') === chave)
  if (minha) return minha
  if (lista.length) {
    throw new ErroDeConsulta(
      'O gateway respondeu com transferências de outras referências: o filtro não foi aplicado e '
      + 'não dá para afirmar que esta transferência ainda não saiu. Nada foi transferido — '
      + 'confira no painel do Asaas antes de liberar este saque.')
  }
  return null
}

/**
 * O que o status do Asaas significa pra nós.
 *
 * `null` é status desconhecido — e quem chama trata como 'em_voo', nunca como
 * falha: com id de transferência na mão, o dinheiro pode estar a caminho, e
 * "falhou" liberaria o saldo pra um segundo saque do mesmo dinheiro.
 */
export function estadoDaTransferencia(status?: string | null): 'concluida' | 'em_voo' | 'falhou' | null {
  switch (String(status ?? '').toUpperCase()) {
    case 'DONE': return 'concluida'
    case 'PENDING':
    case 'BANK_PROCESSING': return 'em_voo'
    case 'FAILED':
    case 'CANCELLED': return 'falhou'
    default: return null
  }
}

/* ----------------------------------------------------------- SQL da fila */
/**
 * O SQL fica exportado pelo mesmo motivo do `SQL_REGISTRAR_EVENTO` acima: o
 * teste de duas execuções simultâneas roda EXATAMENTE estas linhas. Um teste
 * que escreve o próprio `UPDATE` atômico prova que o Postgres serializa, não
 * que o executor se apoia nisso — e continua verde no dia em que alguém trocar
 * a reivindicação por um `SELECT` antes do `UPDATE`.
 */

/**
 * Candidatas.
 *
 * **Sem teto de tentativas aqui, de propósito.** Ele já esteve (`attempts <
 * MAX_TENTATIVAS`) e congelava saque em silêncio: desde que desistir passou a
 * exigir uma recusa escrita do gateway (ver `devolverOuFalhar`), uma linha
 * pode voltar pra fila com o contador estourado — foi o reconciliador que
 * provou, perguntando pela chave, que nada saiu. Com o teto no `WHERE` ela
 * ficava 'solicitada' para sempre: sem transferir, sem falhar e sem aparecer
 * em lugar nenhum, que é a fila invisível. Quem encerra o saque é o desfecho,
 * não o contador: destino impossível morre em `corpoDaTransferencia` na
 * primeira tentativa, e recusa escrita do gateway vira 'falhou' no teto.
 *
 * Só PIX. Saque pra conta bancária não é recusado nem marcado como falho — ele
 * simplesmente não é desta fila: o destino está guardado como texto livre e o
 * Asaas precisa de banco, agência, conta e titular em campos separados (ver
 * `corpoDaTransferencia`). Marcar 'falhou' devolveria o saldo pro produtor
 * pedir de novo; deixar 'solicitada' mantém o dinheiro comprometido, que é a
 * verdade enquanto alguém transfere no painel do gateway. A resposta da
 * execução conta quantos estão nessa situação, pra não virarem fila invisível.
 */
export const SQL_FILA_DE_PAYOUTS = `
  SELECT id FROM payouts
   WHERE org_id = $1
     AND status = 'solicitada'
     AND destination_kind = 'pix'
     AND ($2::uuid IS NULL OR id = $2::uuid)
   ORDER BY requested_at
   LIMIT $3`

/** Os que esta fila não alcança — contados pra aparecerem na resposta. */
export const SQL_PAYOUTS_MANUAIS = `
  SELECT count(*)::int AS n, COALESCE(SUM(amount_cents), 0)::bigint AS soma
    FROM payouts
   WHERE org_id = $1 AND status = 'solicitada' AND destination_kind <> 'pix'`

/**
 * A reivindicação. Esta linha é a trava.
 *
 * `idempotency_key` entra com `COALESCE` — fixada na primeira reivindicação e
 * nunca reescrita. Chave que muda a cada tentativa não é chave de idempotência:
 * é um pagamento novo toda vez.
 *
 * `error` é limpo aqui porque o erro que interessa é o da tentativa CORRENTE;
 * deixar o antigo faria a linha em voo exibir a falha de ontem.
 */
export const SQL_REIVINDICAR_PAYOUT = `
  UPDATE payouts
     SET status = 'processando',
         attempts = attempts + 1,
         claimed_at = now(),
         idempotency_key = COALESCE(idempotency_key, $3),
         error = NULL
   WHERE id = $1 AND org_id = $2 AND status = 'solicitada'
  RETURNING id, code, org_id, event_id, amount_cents, destination_kind, destination,
            beneficiary_name, beneficiary_doc, idempotency_key, attempts`

/**
 * As que estão EM VOO: transferência criada, status ainda não final.
 *
 * PIX no Asaas raramente volta `DONE` na hora — quase sempre é `PENDING` ou
 * `BANK_PROCESSING` primeiro. Sem esta consulta o saque ficaria 'processando'
 * pra sempre: o dinheiro saiu, o produtor recebeu, e o painel continuaria
 * dizendo "em andamento" até alguém conferir na mão no site do gateway.
 */
export const SQL_PAYOUTS_EM_VOO = `
  SELECT id, code, amount_cents, destination_kind, destination,
         beneficiary_name, idempotency_key, attempts, asaas_transfer_id
    FROM payouts
   WHERE org_id = $1
     AND status = 'processando'
     AND asaas_transfer_id IS NOT NULL
     AND (gateway_status IS NULL OR gateway_status <> 'DONE')
   ORDER BY claimed_at
   LIMIT $2`

/**
 * Execução interrompida: pegou a linha e nunca escreveu o resultado. Sem id de
 * transferência, ninguém sabe se o dinheiro saiu — e a resposta está no
 * gateway, procurável pela chave.
 */
export const SQL_PAYOUTS_PRESOS = `
  SELECT id, code, amount_cents, destination_kind, destination,
         beneficiary_name, idempotency_key, attempts
    FROM payouts
   WHERE org_id = $1
     AND status = 'processando'
     AND asaas_transfer_id IS NULL
     AND idempotency_key IS NOT NULL
     AND claimed_at < now() - make_interval(mins => $2::int)
   ORDER BY claimed_at
   LIMIT $3`

export const SQL_PAYOUT_CONCLUIDO = `
  UPDATE payouts
     SET status = 'concluida', asaas_transfer_id = $2, gateway_status = $3,
         processed_at = now(), error = NULL
   WHERE id = $1`

/** Saiu da plataforma e está no trilho do banco: segue comprometido, sem processed_at. */
export const SQL_PAYOUT_EM_VOO = `
  UPDATE payouts
     SET status = 'processando', asaas_transfer_id = $2, gateway_status = $3, error = NULL
   WHERE id = $1`

export const SQL_PAYOUT_FALHOU = `
  UPDATE payouts
     SET status = 'falhou', error = $2, gateway_status = $3,
         asaas_transfer_id = COALESCE(asaas_transfer_id, $4),
         processed_at = now()
   WHERE id = $1`

/**
 * De volta pra fila, retentável, com o erro escrito.
 *
 * `asaas_transfer_id IS NULL` é a segunda parede: linha que já tem
 * transferência no gateway NUNCA volta pra fila, por mais que o erro peça.
 * Voltar seria transferir de novo o que já saiu.
 */
export const SQL_PAYOUT_DE_VOLTA_NA_FILA = `
  UPDATE payouts
     SET status = 'solicitada', error = $2, claimed_at = NULL
   WHERE id = $1 AND status = 'processando' AND asaas_transfer_id IS NULL
  RETURNING id`

/**
 * Bateu o teto sem o gateway dizer se transferiu: escreve o erro e deixa a
 * linha onde está — `processando`, sem id de transferência.
 *
 * Não é preguiça de decidir: é o único estado que diz a verdade (o dinheiro
 * está comprometido e o destino está em aberto) e é o estado que
 * `SQL_PAYOUTS_PRESOS` varre. `claimed_at` fica como está, porque é ele que
 * mede a carência da varredura. Carimbar 'falhou' aqui devolveria o valor pro
 * disponível do produtor (ver `saldoParaSaque`) e o próximo pedido sairia com
 * OUTRA chave de idempotência — a transferência duplicada entrando pela porta
 * que a chave existe pra trancar.
 */
export const SQL_PAYOUT_SEM_DESFECHO = `
  UPDATE payouts
     SET error = $2
   WHERE id = $1 AND status = 'processando' AND asaas_transfer_id IS NULL`

/** O mínimo que o executor precisa de um cliente de banco — serve Pool e PoolClient. */
export interface ExecutorSql {
  query: (texto: string, params?: any[]) => Promise<{ rows: any[] }>
}

/**
 * Reivindica a linha. Devolve o payout reivindicado, ou `null` quando outra
 * execução chegou primeiro (ou quando o saque não é desta organização).
 */
export async function reivindicarPayout(
  c: ExecutorSql, payoutId: string, orgId: string,
): Promise<any | null> {
  const { rows } = await c.query(
    SQL_REIVINDICAR_PAYOUT, [payoutId, orgId, chaveDeIdempotencia(payoutId)])
  return rows[0] ?? null
}

/** Uma transferência pelo id dela — é como se confere quem ficou em voo. */
export async function buscarTransferencia(cfg: ConfigAsaas, id: string): Promise<any> {
  return chamar(cfg, 'GET', `/transfers/${encodeURIComponent(id)}`)
}

/** Como o executor fala com o gateway. Trocável pra o simulado e pro teste. */
export interface Transferidor {
  achar: (chave: string) => Promise<any | null>
  criar: (corpo: CorpoDeTransferencia) => Promise<any>
  conferir: (id: string) => Promise<any>
}

export const transferidorAsaas = (cfg: ConfigAsaas): Transferidor => ({
  achar: (chave) => acharTransferencia(cfg, chave),
  criar: (corpo) => transferir(cfg, corpo),
  conferir: (id) => buscarTransferencia(cfg, id),
})

export interface ResultadoDoPayout {
  id: string
  code: string | null
  /** o status em que a linha ficou */
  status: 'concluida' | 'processando' | 'falhou' | 'solicitada'
  transferencia: string | null
  gatewayStatus: string | null
  erro: string | null
  /** o gateway já tinha esta transferência e ela foi adotada em vez de criada */
  adotada: boolean
  valorCents: number
}

/**
 * O gateway ARTICULOU uma recusa, ou só não respondeu?
 *
 * A diferença decide se dá pra desistir do saque. O Asaas nega com `errors[]`
 * no corpo ("Saldo insuficiente", "chave pix inexistente") — quando isso
 * chega, ele leu o pedido e não transferiu: desistir é seguro. Já um socket
 * que caiu, um 502 do proxy ou um corpo que não é JSON não dizem nada sobre o
 * dinheiro: a transferência pode ter saído e só a resposta ter se perdido, que
 * é o caso inteiro da parede 2.
 */
export function recusaDoGateway(e: unknown): boolean {
  if (!(e instanceof ErroAsaas)) return false
  const erros = (e.detalhes as any)?.errors
  return Array.isArray(erros) && erros.length > 0
}

/**
 * Executa UM payout já reivindicado. Nunca é chamado sem a reivindicação ter
 * voltado com linha — é ela que garante que só uma execução chegou aqui.
 *
 * A ordem é: pergunta ao gateway pela chave → só cria se ele responder que não
 * existe → grava o que voltou. Erro na PERGUNTA não vira criação: sem saber se
 * a transferência existe, criar é a aposta que paga duas vezes.
 *
 * `etapa` existe por causa do desfecho: falhar PERGUNTANDO não diz nada sobre
 * o dinheiro, falhar CRIANDO com uma recusa escrita diz que ele não saiu. É o
 * que `devolverOuFalhar` usa pra decidir se pode desistir do saque.
 */
export async function executarPayoutReivindicado(
  c: ExecutorSql, payout: PayoutEmExecucao, t: Transferidor,
): Promise<ResultadoDoPayout> {
  const base = {
    id: payout.id,
    code: payout.code ?? null,
    valorCents: Number(payout.amount_cents),
    adotada: false,
  }
  const chave = payout.idempotency_key || chaveDeIdempotencia(payout.id)

  let transferencia: any = null
  let adotada = false
  let etapa: 'perguntar' | 'criar' = 'perguntar'
  try {
    transferencia = await t.achar(chave)
    adotada = !!transferencia
    if (!transferencia) {
      etapa = 'criar'
      transferencia = await t.criar(corpoDaTransferencia(payout))
    }
  } catch (e: any) {
    // Destino impossível não melhora com o tempo: morre aqui, com a frase que
    // diz o que arrumar. Qualquer outro erro é do gateway e é retentável.
    if (e instanceof ErroDeDestino) {
      await c.query(SQL_PAYOUT_FALHOU, [payout.id, e.message, null, null])
      return { ...base, status: 'falhou', transferencia: null, gatewayStatus: null, erro: e.message }
    }
    return await devolverOuFalhar(c, payout, base, e?.message || String(e),
      etapa === 'criar' && recusaDoGateway(e))
  }

  const idTransferencia = String(transferencia?.id ?? '').trim() || null
  const gatewayStatus = String(transferencia?.status ?? '').trim() || null

  if (!idTransferencia) {
    // 200 sem id: não dá pra acompanhar nem pra marcar como paga — e nem pra
    // dizer que não saiu, por isso o desfecho entra como DESCONHECIDO. Volta
    // pra fila; a próxima execução pergunta pela chave e adota o que existir.
    return await devolverOuFalhar(c, payout, base,
      'O gateway respondeu sem o número da transferência. Vamos tentar de novo.', false)
  }

  const estado = estadoDaTransferencia(gatewayStatus) ?? 'em_voo'

  if (estado === 'falhou') {
    const motivo = String(transferencia?.failReason ?? '').trim()
      || `O banco recusou a transferência (${gatewayStatus}).`
    await c.query(SQL_PAYOUT_FALHOU, [payout.id, motivo, gatewayStatus, idTransferencia])
    return { ...base, adotada, status: 'falhou', transferencia: idTransferencia, gatewayStatus, erro: motivo }
  }

  if (estado === 'concluida') {
    await c.query(SQL_PAYOUT_CONCLUIDO, [payout.id, idTransferencia, gatewayStatus])
    return { ...base, adotada, status: 'concluida', transferencia: idTransferencia, gatewayStatus, erro: null }
  }

  await c.query(SQL_PAYOUT_EM_VOO, [payout.id, idTransferencia, gatewayStatus])
  return { ...base, adotada, status: 'processando', transferencia: idTransferencia, gatewayStatus, erro: null }
}

/**
 * Devolve pra fila, ou desiste com o erro gravado quando já bateu o teto de
 * tentativas. Nos dois caminhos o registro FICA e o erro fica legível: saque
 * que some do painel é o produtor ligando perguntando do dinheiro dele.
 *
 * ## Desistir só com o gateway tendo dito que não transferiu
 *
 * `'falhou'` não é só um rótulo de tela: `saldoParaSaque` conta como
 * comprometido apenas `solicitada`, `processando` e `concluida` — então
 * carimbar 'falhou' DEVOLVE o dinheiro para o disponível do produtor, que
 * pede o saque de novo. O pedido novo é outra linha, com outro id e portanto
 * outra chave de idempotência: o gateway não tem como ligar um ao outro e a
 * segunda transferência sai inteira.
 *
 * Por isso o teto não pode ser aplicado no escuro. Desistir é seguro quando o
 * gateway RECUSOU A CRIAÇÃO com todas as letras (`errors[]` no corpo: chave
 * inexistente, saldo insuficiente) — aí é certo que nada saiu. Quando a
 * resposta se perdeu, quando a pergunta pela chave não pôde ser feita, ou
 * quando o corpo voltou sem número de transferência, o desfecho é
 * DESCONHECIDO: a linha fica em `processando`, que é a verdade (dinheiro
 * comprometido, destino em aberto) e é também o estado que o reconciliador
 * varre a cada execução, perguntando ao gateway pela chave até ele responder.
 * Nunca some, nunca libera saldo, nunca transfere duas vezes.
 */
async function devolverOuFalhar(
  c: ExecutorSql, payout: PayoutEmExecucao,
  base: { id: string; code: string | null; valorCents: number; adotada: boolean },
  erro: string,
  /** o gateway disse, com todas as letras, que NÃO criou a transferência */
  recusouCriar: boolean,
): Promise<ResultadoDoPayout> {
  const tentativas = Number(payout.attempts ?? 0)
  if (tentativas >= MAX_TENTATIVAS) {
    if (recusouCriar) {
      const msg = `${erro} (${tentativas} tentativas; a transferência não foi feita)`
      await c.query(SQL_PAYOUT_FALHOU, [payout.id, msg, null, null])
      return { ...base, status: 'falhou', transferencia: null, gatewayStatus: null, erro: msg }
    }
    const msg = `${erro} (${tentativas} tentativas sem resposta do gateway; o saque segue `
      + 'comprometido até o gateway dizer se a transferência saiu — confira no painel do Asaas)'
    await c.query(SQL_PAYOUT_SEM_DESFECHO, [payout.id, msg])
    return { ...base, status: 'processando', transferencia: null, gatewayStatus: null, erro: msg }
  }
  const { rows } = await c.query(SQL_PAYOUT_DE_VOLTA_NA_FILA, [payout.id, erro])
  // Sem linha de volta = alguém já gravou um id de transferência nela. Não
  // insistir: a linha está em voo e mexer nela é o caminho do pagamento duplo.
  return {
    ...base,
    status: rows[0] ? 'solicitada' : 'processando',
    transferencia: null, gatewayStatus: null, erro,
  }
}

/**
 * Confere uma transferência que já saiu e ainda não tem desfecho.
 *
 * Só lê. Erro aqui NÃO mexe na linha: ela fica 'processando' e a próxima
 * execução pergunta de novo. Marcar falha porque a consulta caiu seria liberar
 * pra novo saque um dinheiro que já está na conta do produtor.
 */
export async function conferirPayoutEmVoo(
  c: ExecutorSql, payout: PayoutEmExecucao & { asaas_transfer_id: string }, t: Transferidor,
): Promise<ResultadoDoPayout> {
  const base = {
    id: payout.id, code: payout.code ?? null,
    valorCents: Number(payout.amount_cents), adotada: true,
  }
  let transferencia: any
  try {
    transferencia = await t.conferir(payout.asaas_transfer_id)
  } catch (e: any) {
    return { ...base, status: 'processando', transferencia: payout.asaas_transfer_id,
      gatewayStatus: null, erro: `Não deu pra conferir no gateway: ${e?.message || String(e)}` }
  }

  const gatewayStatus = String(transferencia?.status ?? '').trim() || null
  const estado = estadoDaTransferencia(gatewayStatus) ?? 'em_voo'

  if (estado === 'concluida') {
    await c.query(SQL_PAYOUT_CONCLUIDO, [payout.id, payout.asaas_transfer_id, gatewayStatus])
    return { ...base, status: 'concluida', transferencia: payout.asaas_transfer_id, gatewayStatus, erro: null }
  }
  if (estado === 'falhou') {
    // O banco devolveu o dinheiro: a linha vira falha e o saldo volta a ficar
    // disponível pro produtor pedir de novo, agora com o destino certo.
    const motivo = String(transferencia?.failReason ?? '').trim()
      || `O banco devolveu a transferência (${gatewayStatus}).`
    await c.query(SQL_PAYOUT_FALHOU, [payout.id, motivo, gatewayStatus, payout.asaas_transfer_id])
    return { ...base, status: 'falhou', transferencia: payout.asaas_transfer_id, gatewayStatus, erro: motivo }
  }

  await c.query(SQL_PAYOUT_EM_VOO, [payout.id, payout.asaas_transfer_id, gatewayStatus])
  return { ...base, status: 'processando', transferencia: payout.asaas_transfer_id, gatewayStatus, erro: null }
}

/**
 * Reconcilia uma linha presa: 'processando' sem id de transferência e parada
 * há mais que a carência. Pergunta ao gateway pela chave — se existe, adota; se
 * não existe, volta pra fila, porque aí é certo que o dinheiro não saiu.
 */
export async function reconciliarPayoutPreso(
  c: ExecutorSql, payout: PayoutEmExecucao, t: Transferidor,
): Promise<ResultadoDoPayout> {
  const base = {
    id: payout.id, code: payout.code ?? null,
    valorCents: Number(payout.amount_cents), adotada: false,
  }
  const chave = payout.idempotency_key || chaveDeIdempotencia(payout.id)

  let transferencia: any = null
  try {
    transferencia = await t.achar(chave)
  } catch (e: any) {
    return { ...base, status: 'processando', transferencia: null, gatewayStatus: null,
      erro: `Não deu pra confirmar no gateway: ${e?.message || String(e)}` }
  }

  if (!transferencia) {
    const motivo = 'Execução interrompida antes de transferir. De volta na fila.'
    await c.query(SQL_PAYOUT_DE_VOLTA_NA_FILA, [payout.id, motivo])
    return { ...base, status: 'solicitada', transferencia: null, gatewayStatus: null, erro: motivo }
  }

  const idTransferencia = String(transferencia?.id ?? '').trim() || null
  const gatewayStatus = String(transferencia?.status ?? '').trim() || null
  const estado = estadoDaTransferencia(gatewayStatus) ?? 'em_voo'

  if (estado === 'falhou') {
    const motivo = String(transferencia?.failReason ?? '').trim()
      || `O banco recusou a transferência (${gatewayStatus}).`
    await c.query(SQL_PAYOUT_FALHOU, [payout.id, motivo, gatewayStatus, idTransferencia])
    return { ...base, adotada: true, status: 'falhou', transferencia: idTransferencia, gatewayStatus, erro: motivo }
  }
  if (estado === 'concluida') {
    await c.query(SQL_PAYOUT_CONCLUIDO, [payout.id, idTransferencia, gatewayStatus])
    return { ...base, adotada: true, status: 'concluida', transferencia: idTransferencia, gatewayStatus, erro: null }
  }
  await c.query(SQL_PAYOUT_EM_VOO, [payout.id, idTransferencia, gatewayStatus])
  return { ...base, adotada: true, status: 'processando', transferencia: idTransferencia, gatewayStatus, erro: null }
}

/**
 * A chave abre a conta? `recusada` = o Asaas leu e disse não (401 `invalid_access_token`, 403);
 * sem `recusada`, o Asaas não respondeu (fora, prazo, 5xx, 429) e não dá pra saber.
 */
export async function testarConexao(cfg: ConfigAsaas):
  Promise<{ ok: boolean; ambiente: string; erro?: string; recusada?: boolean }> {
  const ambiente = ambienteDaChave(cfg.apiKey) || cfg.environment || 'sandbox'
  try {
    await chamar(cfg, 'GET', '/customers?limit=1')
    return { ok: true, ambiente }
  } catch (e: any) {
    const recusada = e instanceof ErroAsaas && (e.status === 401 || e.status === 403)
    return { ok: false, ambiente, erro: e.message, recusada }
  }
}

/* ------------------------------------------- o webhook cadastrado no Asaas */

/**
 * O webhook do Asaas pode estar DESLIGADO do lado de lá sem nenhum sinal do lado de cá.
 *
 * Após 15 falhas seguidas o Asaas INTERROMPE a fila de webhooks da conta e não manda mais nada —
 * e evento com mais de 14 dias na fila é apagado (docs.asaas.com/docs/fila-pausada). Um deploy
 * que devolveu 502 por meia hora basta. Daí pra frente nenhum cartão vira ingresso pelo aviso,
 * e o painel daqui continua dizendo "webhook configurado". `GET /v3/webhooks` lista as
 * configurações com `enabled` e `interrupted`: a saúde pergunta (com cache, pra não gastar cota a
 * cada minuto do monitor) e acusa crítico quando a NOSSA está desligada, interrompida ou sumiu.
 */
export type ConsultaDeWebhooks = (cfg: ConfigAsaas) => Promise<any[]>

let consultaDeWebhooksInjetada: ConsultaDeWebhooks | null = null
const webhooksConferidos = new Map<string, { ate: number; problemas: ProblemaDeConfiguracao[] }>()

/** Troca a consulta (o teste não fala com o Asaas) — e esquece o que estava guardado. */
export function usarConsultaDeWebhooks(f: ConsultaDeWebhooks | null) {
  consultaDeWebhooksInjetada = f
  webhooksConferidos.clear()
}

export const CACHE_WEBHOOKS_MS = 5 * 60_000

const ROTA_DO_WEBHOOK = '/api/webhooks/asaas'

/** O que a lista de webhooks da conta diz do NOSSO. PURO. */
export function avaliarWebhooksDoAsaas(lista: any[], org: string, base: string | null): ProblemaDeConfiguracao[] {
  const caminho = (u: any) => { try { return new URL(String(u)).pathname.replace(/\/+$/, '') } catch { return '' } }
  const host = (u: any) => { try { return new URL(String(u)).host } catch { return '' } }
  const nossos = (Array.isArray(lista) ? lista : []).filter((w) => caminho(w?.url) === ROTA_DO_WEBHOOK)
  if (!nossos.length) {
    return [{ item: 'webhook do Asaas', critico: true,
      frase: `O Asaas de "${org}" não tem webhook apontando pra ${base ?? ''}${ROTA_DO_WEBHOOK}: nenhum `
        + 'pagamento de cartão vira ingresso pelo aviso (a varredura de minuto ainda pergunta, mas '
        + 'com atraso). Cadastre em Integrações → Webhooks no painel do Asaas, com o ASAAS_WEBHOOK_TOKEN.' }]
  }
  const hostDaBase = base ? host(base) : ''
  const daBase = hostDaBase ? nossos.filter((w) => host(w?.url) === hostDaBase) : nossos
  const alvo = daBase.length ? daBase : nossos
  const vivo = alvo.find((w) => w?.enabled !== false && w?.interrupted !== true)
  if (!vivo) {
    const w = alvo[0]
    return [{ item: 'webhook do Asaas', critico: true,
      frase: w?.interrupted === true
        ? `A fila de webhooks do Asaas de "${org}" está INTERROMPIDA (15 falhas seguidas): o Asaas parou de `
          + 'avisar pagamentos, e aviso com mais de 14 dias na fila é apagado. Reative no painel do Asaas '
          + '(Integrações → Webhooks) depois de conferir que a rota responde.'
        : `O webhook do Asaas de "${org}" está DESATIVADO no painel dele: nenhum aviso de pagamento chega. `
          + 'Ative em Integrações → Webhooks.' }]
  }
  if (hostDaBase && !daBase.length) {
    return [{ item: 'webhook do Asaas', critico: false,
      frase: `O webhook do Asaas de "${org}" aponta pra ${host(vivo.url)}, e o site é ${hostDaBase}: `
        + 'confira se o endereço não redireciona (redirecionamento conta como falha pro Asaas).' }]
  }
  return []
}

/**
 * Os problemas do webhook de cada organização que cobra pelo Asaas. Só em produção (ou com a
 * consulta trocada pelo teste): fora dela as chaves são de sandbox/fixture e perguntar seria
 * gastar cota — ou falar com o Asaas de verdade a partir da suíte.
 */
export async function conferirWebhooksDoAsaas(agora = Date.now()): Promise<ProblemaDeConfiguracao[]> {
  if (!consultaDeWebhooksInjetada && process.env.NODE_ENV !== 'production') return []
  const consulta: ConsultaDeWebhooks = consultaDeWebhooksInjetada
    ?? (async (cfg) => (await chamar<any>(cfg, 'GET', '/webhooks?limit=100'))?.data ?? [])
  const orgs = await q<any>(
    `SELECT id, name, asaas_api_key, asaas_env, asaas_wallet FROM organizations WHERE asaas_api_key IS NOT NULL`)
  const problemas: ProblemaDeConfiguracao[] = []
  for (const org of orgs) {
    if (!pagamentoPeloAsaas(org).ok) continue // sem chave útil: a saúde já acusa por outro item
    // a chave entra na chave do cache (resumida): trocar a chave no painel não espera 5 minutos
    const marca = `${org.id}:${createHash('sha256').update(String(org.asaas_api_key)).digest('hex').slice(0, 12)}`
    const guardado = webhooksConferidos.get(marca)
    if (guardado && guardado.ate > agora) { problemas.push(...guardado.problemas); continue }
    let achados: ProblemaDeConfiguracao[]
    let validade = CACHE_WEBHOOKS_MS
    try {
      const lista = await consulta({ apiKey: org.asaas_api_key, environment: org.asaas_env, walletId: org.asaas_wallet })
      achados = avaliarWebhooksDoAsaas(lista, org.name, baseDoSite())
    } catch (e: any) {
      // não saber não é "desligado": aviso, e pergunta de novo no minuto seguinte
      achados = [{ item: 'webhook do Asaas', critico: false,
        frase: `Não consegui conferir no Asaas o webhook de "${org.name}": ${e?.message ?? e}` }]
      validade = 60_000
    }
    webhooksConferidos.set(marca, { ate: agora + validade, problemas: achados })
    problemas.push(...achados)
  }
  return problemas
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
  const bruto = String(s || '').toUpperCase()
  switch (bruto) {
    case 'RECEIVED':
    case 'CONFIRMED':
    case 'RECEIVED_IN_CASH':
      return 'pago'
    case 'PENDING':
    case 'AWAITING_RISK_ANALYSIS':
      // comparar o valor JÁ em maiúsculas: comparar o original fazia
      // "awaiting_risk_analysis" cair em aguardando_pagamento.
      return bruto === 'AWAITING_RISK_ANALYSIS' ? 'em_analise' : 'aguardando_pagamento'
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
  // existem na doc e eram só registrados: a cobrança apagada que VOLTA a ser pagável, e o
  // "recebido em dinheiro" desfeito no painel — o ingresso tinha saído por um dinheiro que não veio
  'PAYMENT_RESTORED', 'PAYMENT_RECEIVED_IN_CASH_UNDONE',
])

/**
 * O que este EVENTO diz do pedido — o nome do evento manda, o status da
 * cobrança é o desempate.
 *
 * Ler só `payment.status` tem um buraco que custa estoque: numa cobrança
 * APAGADA (`PAYMENT_DELETED`) o Asaas manda o pagamento com `deleted: true` e
 * `status` ainda em `PENDING`. Traduzido só pelo status, o evento virava
 * "aguardando pagamento" — anotação sem efeito — e os lugares reservados desse
 * pedido ficavam presos até a varredura de expirados, ou pra sempre se o
 * pedido não tinha prazo. O nome do evento não tem essa ambiguidade.
 */
export function statusDoEvento(nomeEvento: string, pagamento: any) {
  switch (nomeEvento) {
    // Reprovado na análise de risco: a cobrança volta a esperar pagamento. Pelo
    // status só, um payload que ainda diga AWAITING_RISK_ANALYSIS deixava o
    // pedido em 'em_analise' — sem prazo, segurando lugar (B09). Como
    // 'aguardando_pagamento', o prazo da reserva volta a valer e a varredura
    // de expirados devolve o lugar e cancela a cobrança.
    case 'PAYMENT_REPROVED_BY_RISK_ANALYSIS': return 'aguardando_pagamento' as const
    case 'PAYMENT_DELETED': return 'cancelado' as const
    case 'PAYMENT_REFUNDED': return 'estornado' as const
    case 'PAYMENT_PARTIALLY_REFUNDED': return 'estornado_parcial' as const
    case 'PAYMENT_CHARGEBACK_REQUESTED':
    case 'PAYMENT_CHARGEBACK_DISPUTE': return 'chargeback' as const
    case 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL': return 'disputa' as const
  }
  if (pagamento?.deleted === true) return 'cancelado' as const
  return traduzirStatus(pagamento?.status)
}

/**
 * Chave de idempotência da entrega: o id do EVENTO, não o da cobrança.
 *
 * Uma cobrança (`payment.id`) gera vários eventos ao longo da vida —
 * CONFIRMED, RECEIVED, REFUNDED. Usar o id dela como chave faria o estorno ser
 * descartado como "repetido" do pagamento. O que não se repete é
 * `body.id` (`evt_...`).
 *
 * Sem `body.id` (entrega manual, reprocessamento antigo), a chave é o sha256
 * do próprio corpo: corpo byte a byte igual é a mesma entrega. Dois eventos
 * DIFERENTES nunca geram o mesmo corpo — o Asaas carimba `dateCreated` em
 * cada um.
 */
export function chaveDoEvento(corpo: any): string {
  const id = String(corpo?.id ?? '').trim()
  if (id) return id
  return 'sha256:' + createHash('sha256').update(JSON.stringify(corpo ?? {})).digest('hex')
}

/**
 * O registro cru da entrega — a primeira coisa que acontece no webhook.
 *
 * Fica exportado por dois motivos, e o segundo é o que importa (mesma razão do
 * `SQL_TRAVA_LOTE` em estoque.ts): o teste de duas entregas simultâneas roda
 * EXATAMENTE esta linha. Um teste que escreve o próprio `ON CONFLICT` prova que
 * o Postgres tem índice único, não que o webhook se apoia nele — e continua
 * verde no dia em que a rota trocar a trava por um `SELECT` antes do `INSERT`
 * (medido: a troca passou pelos 13 casos sem nenhum vermelho).
 *
 * Duas decisões dentro do statement:
 *
 * 1. `ON CONFLICT DO NOTHING` é a idempotência. Entre um `SELECT` que procura e
 *    um `INSERT` que grava cabe a segunda entrega inteira; aqui não cabe.
 *
 * 2. `order_id` entra por SUBCONSULTA, não pelo parâmetro cru. A coluna tem
 *    chave estrangeira pra `orders`: um `externalReference` que é UUID mas não
 *    é pedido nosso fazia o INSERT explodir com violação de FK — e aí a rota
 *    devolvia 500 e NÃO GRAVAVA NADA, justo o contrário do que ela promete
 *    ("grava antes de agir"). Com 500 o Asaas reentrega pra sempre a mesma
 *    coisa, e a fila de webhook da conta engasga naquele evento. O caso chega
 *    sozinho quando a mesma conta Asaas atende outro sistema (é o arranjo do
 *    dono hoje) e também quando o pedido foi apagado depois da cobrança.
 *    Pedido que não existe vira `order_id` nulo: o payload cru fica gravado e o
 *    evento é respondido com "pedido não encontrado", que é a verdade.
 */
export const SQL_REGISTRAR_EVENTO = `
  INSERT INTO payment_events (provider, gateway_event_id, external_id,
                              event_name, order_id, payload)
  VALUES ('asaas', $1, $2, $3,
          (SELECT o.id FROM orders o WHERE o.id = $4::uuid), $5::jsonb)
  ON CONFLICT (provider, gateway_event_id) DO NOTHING
  RETURNING id`

/**
 * Quanto voltou pro comprador, em centavos, olhando o payload do gateway.
 *
 * `refundedValue` é o ACUMULADO da cobrança, não a parcela deste estorno — por
 * isso o webhook grava `refunded_cents` por atribuição e não somando: entrega
 * repetida não infla o estorno. Quando o campo não vem, soma os estornos
 * de `refunds[]` (o cancelado não conta).
 *
 * Devolve `null` quando o payload não diz — e aí NÃO é zero: gravar
 * `estornado_parcial` com zero devolvido faz o líquido contar o pedido inteiro
 * como se nada tivesse voltado, e isso não aparece em lugar nenhum.
 *
 * **Só estorno `DONE` conta** (docs.asaas.com/docs/estornos: o estorno nasce PENDING e pode
 * terminar CANCELLED — conta sem saldo, por exemplo). Quando a lista traz o status de cada
 * estorno, ela manda, e o acumulado `refundedValue` (que não diz se o que está nele já saiu) fica
 * de fora. Lista com status e nenhum DONE é `null`: "ainda não voltou nada que dê pra contar" — a
 * entrega fica pendurada e o reprocessador pergunta de novo ao gateway depois.
 */
export function valorEstornadoCents(pagamento: any): number | null {
  const lista = Array.isArray(pagamento?.refunds) ? pagamento.refunds : []
  if (lista.some((r: any) => String(r?.status ?? '').trim())) {
    let soma = 0
    let achou = false
    for (const r of lista) {
      if (String(r?.status ?? '').toUpperCase() !== 'DONE') continue
      const v = reaisParaCentavos(r?.value)
      if (v != null && v > 0) { soma += v; achou = true }
    }
    return achou ? soma : null
  }

  const direto = reaisParaCentavos(pagamento?.refundedValue)
  if (direto != null && direto > 0) return direto

  // lista sem status (payload antigo, entrega manual): o que veio, e o cancelado não conta
  let soma = 0
  let achou = false
  for (const r of lista) {
    if (String(r?.status ?? '').toUpperCase() === 'CANCELLED') continue
    const v = reaisParaCentavos(r?.value)
    if (v != null && v > 0) { soma += v; achou = true }
  }
  return achou ? soma : direto
}

/**
 * O pedido pode ser ANOTADO com este status novo?
 *
 * Só vale pro caminho que apenas anota (aguardando_pagamento, em_análise,
 * disputa) — quem emite e quem estorna tem trava própria.
 *
 * Existe porque reentrega não chega em ordem. O Asaas reenvia um
 * PAYMENT_OVERDUE de ontem depois do PAYMENT_RECEIVED de hoje, e o UPDATE
 * antigo (`status <> 'pago'`) só protegia o pedido pago: um pedido já
 * ESTORNADO voltava pra "aguardando_pagamento". A partir daí o dinheiro some
 * do relatório em silêncio — `PEDIDO_VIVO()` deixa de contar o pedido e
 * `refunded_cents` continua lá.
 *
 * Lista de permissão, não de proibição: status novo do gateway nasce recusado.
 */
export function permiteAnotarStatus(atual: string, novo: string): boolean {
  if (atual === novo) return false
  // Reversão de chargeback em análise: único avanço legítimo a partir de um
  // pedido cujo dinheiro já foi resolvido, e só DEPOIS do chargeback. A partir
  // de 'pago' não vale — 'disputa' sai do `PEDIDO_VIVO()`, e o líquido do
  // produtor cairia sem que ninguém tivesse tirado dinheiro dele.
  if (novo === 'disputa') return atual === 'chargeback'
  return ['rascunho', 'aguardando_pagamento', 'em_analise'].includes(atual)
}

// ----------------------------------------------------- segredo do webhook
export interface VeredictoSegredo {
  ok: boolean
  /** status HTTP a devolver quando não passa */
  status?: 401 | 503
  motivo?: string
  /** passou, mas sem segredo configurado (só fora de produção) */
  aviso?: string
}

/** Compara sem vazar tempo — e sem vazar o tamanho do segredo no caminho. */
function iguaisEmTempoConstante(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

/**
 * O webhook do Asaas se autentica por token no header `asaas-access-token`
 * (o mesmo que se cadastra na tela de webhooks do painel dele).
 *
 * Sem isto, quem descobrir a URL posta `PAYMENT_RECEIVED` e retira ingresso de
 * graça — a URL é o único segredo, e ela vaza em log de proxy, em print de
 * tela e no painel do gateway.
 *
 * Em produção, segredo AUSENTE é 503 e não "passa mesmo assim": aceitar
 * webhook anônimo em silêncio é o buraco chegando pronto. Fora de produção
 * passa com aviso, senão ninguém roda o fluxo na máquina.
 */
export function conferirSegredoWebhook(args: {
  esperado?: string | null
  recebido?: string | null
  producao: boolean
}): VeredictoSegredo {
  const esperado = String(args.esperado ?? '').trim()
  const recebido = String(args.recebido ?? '').trim()

  if (!esperado) {
    if (args.producao) {
      return {
        ok: false,
        status: 503,
        motivo: 'Webhook sem token configurado. Defina ASAAS_WEBHOOK_TOKEN antes de receber pagamento.',
      }
    }
    return { ok: true, aviso: 'sem ASAAS_WEBHOOK_TOKEN: aceitando sem conferir (fora de produção)' }
  }

  if (!recebido || !iguaisEmTempoConstante(esperado, recebido)) {
    return { ok: false, status: 401, motivo: 'Token do webhook não confere.' }
  }
  return { ok: true }
}

/* ===================================================================== */
/*  O EFEITO DA ENTREGA — o que o webhook faz com o pedido                */
/* ===================================================================== */
/**
 * Isto morava dentro do handler de `POST /api/webhooks/asaas`, e morar lá
 * custava o item mais caro desta rodada: **a fila de reprocessamento não
 * tinha consumidor**. A rota grava a entrega em `payment_events` antes de
 * agir e deixa `processed_at` nulo quando não consegue tratar — a linha
 * "fica na fila". Só que a fila era uma promessa: nada lia `processed_at IS
 * NULL` (o único leitor era a tela de reconciliação, que MOSTRA e não
 * reprocessa), e como a rota responde 200 o Asaas também nunca reentrega.
 * O evento que falha alto de propósito (estorno parcial sem o valor no
 * payload) ficava perdido para sempre: o pedido seguia 'pago' com
 * `refunded_cents = 0` e o líquido contava dinheiro que já tinha voltado
 * pro comprador.
 *
 * Com o efeito aqui, a MESMA função atende os dois caminhos — a entrega que
 * chega agora e a que ficou pendurada. Um reprocessamento que rode outra
 * cópia da lógica só prova a cópia.
 */

/** Pedido cujo desfazimento já aconteceu. Reentrega não desfaz de novo:
 * `liberar()` rodado duas vezes come a reserva de OUTRO pedido do mesmo lote
 * (o `GREATEST(...,0)` só segura quando a reserva é do pedido sozinho), e o
 * lote passa a vender lugar que não existe.
 *
 * `disputa` está aqui e isso NÃO é enfeite. O chargeback no Asaas é uma
 * sequência, não um evento. A ordem OFICIAL (docs.asaas.com, "Eventos para
 * cobranças" e "Chargeback", conferida em 27/09):
 *
 *   PAYMENT_CHARGEBACK_REQUESTED → desfaz (o pedido sai de 'pago')
 *   PAYMENT_CHARGEBACK_DISPUTE → "em disputa após apresentação de documentos":
 *                                 o pedido já está desfeito, nada muda
 *   e aí um de dois fins:
 *     GANHOU: PAYMENT_AWAITING_CHARGEBACK_REVERSAL ("disputa vencida, aguardando
 *             repasse da adquirente") → 'disputa'; e depois PAYMENT_CONFIRMED ou
 *             PAYMENT_RECEIVED — o dinheiro volta, e o pedido volta a contar
 *             (ver "chargeback revertido" em `aplicarEventoDoAsaas`)
 *     PERDEU: PAYMENT_REFUNDED → segue 'chargeback'
 *
 * Fora de ordem (o Asaas reentrega), um DISPUTE pode chegar DEPOIS do
 * AWAITING_REVERSAL, com o pedido em 'disputa'. Sem 'disputa' nesta lista ele
 * não conta como desfeito, e como também não está em 'pago' o `desfazer` cai
 * no `liberar()` — que subtrai `reserved` de um pedido que não reserva mais
 * nada. Medido: lote com um vizinho segurando 5 lugares ficou com 3. Os 2
 * lugares não voltaram pro vizinho; o lote passou a achar que tem 2 a mais pra
 * vender.
 *
 * Só se chega em 'disputa' vindo de 'chargeback' (ver `permiteAnotarStatus`),
 * e 'chargeback' já desfez — então 'disputa' SEMPRE quer dizer "já desfeito".
 */
export const JA_DESFEITO = new Set([
  'estornado', 'cancelado', 'chargeback', 'disputa', 'expirado', 'falhou',
])

export function ehUuid(v: any): boolean {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

/** nunca devolver mais do que entrou */
function limitar(valor: number, teto: number): number {
  return Math.max(0, Math.min(valor, teto))
}

/* ------------------------------------------------- quanto entrou de verdade */

export interface VeredictoDoRecebimento {
  /** dá pra entregar o ingresso agora? */
  emitir: boolean
  /** o que o gateway diz que entrou NESTA cobrança; null = ele não disse */
  recebidoCents: number | null
  /** parcela k de n, quando é parcelamento */
  parcela: number | null
  parcelas: number
  /** quanto ainda falta do total do pedido; null quando não dá pra saber */
  faltamCents: number | null
  /** a frase que fica na trilha do pedido. null = não há nada a dizer */
  aviso: string | null
  /**
   * a compra foi autorizada INTEIRA de uma vez (cartão)? É o que separa
   * "parcelamento do banco com o comprador" de "carnê, uma cobrança por mês".
   */
  cartao: boolean
}

const real = (c: number) => (c / 100).toLocaleString('pt-BR',
  { style: 'currency', currency: 'BRL' })

/**
 * O evento diz "pago" — mas pago de QUANTO?
 *
 * O ramo de pagamento chamava `emitirNaTransacao` sem nunca comparar
 * `payment.value` com `orders.total_cents`. O checkout manda `installmentCount`
 * até 12 e o Asaas dispara um PAYMENT_RECEIVED **por parcela**: a parcela 1 de
 * 12 emitia TODOS os ingressos, válidos na catraca, com 1/12 do dinheiro na
 * conta.
 *
 * Bloquear por valor seria pior do que o defeito: juros de boleto vencido
 * fazem `value` MAIOR que o total, desconto concedido no painel do gateway faz
 * `value` menor, e recusar a emissão de quem pagou é o cliente parado no
 * portão. A resposta não é bloquear nem ignorar — é **distinguir**:
 *
 *  • **à vista** (sem parcelamento): emite sempre. Valor MAIOR que o total não
 *    diz nada (juros são do banco, não nossos). Valor MENOR vira alerta
 *    escrito na trilha do pedido, nunca recusa silenciosa;
 *  • **parcelado em CARNÊ** (boleto/pix, uma cobrança por mês): emite na
 *    parcela que COMPLETA (a última) ou quando o próprio evento já traz o
 *    total. No meio do parcelamento o recebimento fica registrado, com a
 *    diferença escrita, e o ingresso não sai;
 *  • **parcelado no CARTÃO**: emite na PRIMEIRA. Ver abaixo.
 *
 * ## Por que o cartão é outra história
 *
 * Esperar a última parcela sem olhar a forma de pagamento trocava o defeito
 * por um PIOR, e bem mais provável: o checkout desta casa só manda
 * `installmentCount` junto de `billingType: 'CREDIT_CARD'`
 * (`checkout.post.ts`), e no cartão a compra inteira é autorizada de uma vez,
 * no segundo da venda — o parcelamento é do BANCO com o comprador. O que
 * chega mês a mês é o Asaas creditando a nossa fatia, não o comprador pagando
 * de novo. Medido na porta de verdade, antes desta distinção: pedido de
 * R$ 220 em 12x no cartão, PAYMENT_CONFIRMED da parcela 1 →
 * `emitiu: false, ingressos: 0`, pedido parado em 'aguardando_pagamento' com
 * prazo pra agosto de 2027. Quem pagou tudo ficaria no portão, e o evento
 * acontece onze meses antes de a parcela 12 cair.
 *
 * O carnê (boleto/pix parcelado) continua com a régua antiga porque ali cada
 * parcela é dinheiro separado de verdade: a 1 de 12 paga significa que onze
 * doze avos ainda podem não vir nunca.
 *
 * `parcelasDoPedido` e `formaDoPedido` são a rede de baixo: `installmentCount`
 * e `billingType` nem sempre vêm no payload da entrega, e `orders.installments`
 * / `orders.payment_method` guardam o que NÓS pedimos ao gateway no checkout.
 * Quando o payload FALA a forma, ela manda — é o gateway que sabe como a
 * cobrança ficou de verdade.
 */
export function conferirValorRecebido(args: {
  pagamento: any
  totalCents: number
  parcelasDoPedido?: number | null
  /** `orders.payment_method` ('credito' | 'pix') */
  formaDoPedido?: string | null
}): VeredictoDoRecebimento {
  const recebidoCents = reaisParaCentavos(args.pagamento?.value)
  const total = Number(args.totalCents)

  const doPayload = Number(args.pagamento?.installmentCount)
  const doPedido = Number(args.parcelasDoPedido)
  const parcelas = Number.isFinite(doPayload) && doPayload > 1 ? doPayload
    : Number.isFinite(doPedido) && doPedido > 1 ? doPedido
    : 1

  const numero = Number(args.pagamento?.installmentNumber)
  const parcela = Number.isFinite(numero) && numero > 0 ? numero : null
  const faltamCents = recebidoCents == null ? null : Math.max(0, total - recebidoCents)

  // A forma do GATEWAY manda; a nossa é a rede de baixo. Cartão de crédito e
  // de débito autorizam a compra inteira no ato — o resto (boleto, pix,
  // indefinido) é dinheiro que chega uma cobrança de cada vez.
  const formaDoGateway = String(args.pagamento?.billingType ?? '').trim().toUpperCase()
  const formaNossa = String(args.formaDoPedido ?? '').trim().toLowerCase()
  const cartao = formaDoGateway
    ? formaDoGateway === 'CREDIT_CARD' || formaDoGateway === 'DEBIT_CARD'
    : formaNossa === 'credito' || formaNossa === 'cartao'

  // O gateway não informou valor nenhum: não dá pra conferir, e não conferir
  // nunca pode virar porta fechada. Emite e diz que não conferiu.
  if (recebidoCents == null) {
    return {
      emitir: true, recebidoCents: null, parcela, parcelas, faltamCents: null, cartao,
      aviso: 'o gateway não informou o valor recebido: emissão liberada sem conferência',
    }
  }

  // O dinheiro todo está na mesa — inclusive quando veio com juros por cima.
  if (recebidoCents >= total) {
    return { emitir: true, recebidoCents, parcela, parcelas, faltamCents: 0, cartao, aviso: null }
  }

  if (parcelas > 1) {
    // Cartão: o banco já assumiu a compra inteira. Segurar o ingresso aqui é
    // deixar no portão quem pagou — e o portão é hoje, não daqui a um ano.
    if (cartao) {
      return {
        emitir: true, recebidoCents, parcela, parcelas, faltamCents, cartao,
        // "liberada", e não "emitidos": da parcela 2 em diante o pedido já
        // está pago e `emitirNaTransacao` não emite nada (nem deve). Quem diz
        // o que aconteceu de fato é a linha da entrega, que junta este aviso
        // com o "não emitiu: já emitido".
        aviso: `parcela ${parcela ?? '?'} de ${parcelas} (${real(recebidoCents)}) de uma compra `
          + 'no cartão: a compra inteira foi autorizada na venda e o restante entra na conta '
          + `mês a mês (${real(faltamCents ?? 0)} a creditar). Emissão liberada.`,
      }
    }
    // A parcela que completa é a última. Aí o somatório das parcelas fecha o
    // total, mesmo com cada evento trazendo só a fatia dele.
    if (parcela != null && parcela >= parcelas) {
      return {
        emitir: true, recebidoCents, parcela, parcelas, faltamCents, cartao,
        aviso: `parcela ${parcela} de ${parcelas} (${real(recebidoCents)}): `
          + 'última parcela recebida, ingressos emitidos',
      }
    }
    return {
      emitir: false, recebidoCents, parcela, parcelas, faltamCents, cartao,
      aviso: `parcela ${parcela ?? '?'} de ${parcelas} recebida (${real(recebidoCents)}) — `
        + `faltam ${real(faltamCents ?? 0)} do total de ${real(total)}. `
        + 'Os ingressos saem quando a última parcela cair.',
    }
  }

  // À vista e veio menos. Pode ser desconto dado no painel do gateway, pode
  // ser erro — mas quem pagou está no portão. Emite e DENUNCIA.
  return {
    emitir: true, recebidoCents, parcela, parcelas, faltamCents, cartao,
    aviso: `ATENÇÃO: o gateway informou ${real(recebidoCents)} e o pedido é de `
      + `${real(total)} — faltam ${real(faltamCents ?? 0)}. Os ingressos foram emitidos `
      + '(quem pagou não pode ficar no portão); confira o desconto no painel do Asaas.',
  }
}

/* ----------------------------------------------------------- o desfazimento */

/**
 * Desfaz o pedido: devolve estoque e marca o status final.
 *
 * Dentro da transação de quem chama, com a linha do pedido já travada.
 */
async function desfazerPedido(
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

  // ------------------------------------------- o estoque já foi resolvido?
  //
  // `JA_DESFEITO` olha o STATUS, e existe um caminho que devolve o estoque
  // deixando o pedido em 'pago' DE PROPÓSITO: a desistência do comprador
  // (`cancelar.post.ts`) e a escolha 'reembolso' do adiamento
  // (`remarcar.post.ts`) matam o ingresso, devolvem o lugar e enfileiram a
  // devolução — o pedido só sai de 'pago' quando o dinheiro sai de verdade.
  // Entre a resposta do gateway e o commit de `gravarDevolucao` cabe o
  // PAYMENT_REFUNDED do estorno que NÓS pedimos, e nele o pedido ainda está
  // 'pago': o ramo de baixo devolvia o MESMO lugar uma segunda vez. Medido:
  // lote com 6 vendidos virou 2 depois da sequência desistência + webhook, e
  // os 4 lugares que o lote passou a achar que tem pra vender são de gente
  // que já comprou.
  //
  // A linha em `refund_jobs` é a marca desse caminho, e é a marca certa: ela
  // nasce na MESMA transação que devolveu o estoque, e as duas transações se
  // serializam no `FOR UPDATE` da linha do pedido — quem chegar depois
  // enxerga a linha da fila commitada.
  //
  // No cancelamento do EVENTO inteiro a fila também existe e o estoque é
  // deixado quieto de propósito (ninguém vai vender mais nada, e zerar `sold`
  // apagaria do relatório o quanto tinha sido vendido até a hora). Nos dois
  // casos a regra é a mesma: **existe linha de devolução = a decisão sobre o
  // estoque deste pedido já foi tomada por quem a criou.**
  const { rows: devolucao } = await c.query(
    `SELECT reason, status FROM refund_jobs WHERE order_id = $1`, [pedido.id])
  const estoqueJaResolvido = devolucao.length > 0

  const { rows: itens } = await c.query(
    `SELECT lot_id AS "lotId", ticket_type_id AS "ticketTypeId", quantity AS quantidade
       FROM order_items WHERE order_id = $1`, [pedido.id])

  if (estoqueJaResolvido) {
    // nada de estoque aqui: quem enfileirou a devolução já decidiu
  } else if (pedido.status === 'pago' || pedido.status === 'estornado_parcial') {
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
  } else {
    await liberar(c, itens)
  }

  // Ingresso que JÁ ENTROU não é cancelado: a pessoa usou o parque. Vira
  // prejuízo a cobrar, não estoque de volta — e some do relatório se a
  // gente apagar. (Fora do `if` acima de propósito: o ingresso morre mesmo
  // quando o estoque já tinha voltado, e matar duas vezes não custa nada.)
  await c.query(
    `UPDATE tickets SET status = 'cancelado', canceled_at = now()
      WHERE order_id = $1 AND status <> 'usado'`, [pedido.id])

  await c.query(
    `UPDATE orders SET status = $2, canceled_at = now(),
            refunded_at = CASE WHEN $2 LIKE 'estornado%' OR $2 = 'chargeback'
                               THEN now() ELSE refunded_at END,
            refunded_cents = COALESCE($3, refunded_cents)
      WHERE id = $1`, [pedido.id, status, refundCents])
  return { mexeu: true }
}

/* ------------------------------------------------------- aplicar a entrega */

export interface EntregaDoAsaas {
  /** id da linha em `payment_events` */
  registroId: string
  /** `gateway_event_id` — só pra resposta */
  chave: string
  nomeEvento: string
  pagamento: any
  referencia: any
  idCobranca: string
}

/**
 * O efeito, dentro de uma transação já aberta e com a linha do evento travada.
 *
 * Fechar a linha do evento e produzir o efeito são o MESMO commit: se a baixa
 * falhasse sozinha, a reentrega emitiria de novo.
 */
export async function aplicarEventoDoAsaas(
  c: PoolClient, e: EntregaDoAsaas,
): Promise<Record<string, any>> {
  // Trava a linha do evento. Se duas entregas passaram pela porta ao mesmo
  // tempo (a segunda achou a linha ainda não processada), a segunda espera
  // aqui e encontra `processed_at` preenchido.
  const { rows: linhas } = await c.query(
    `SELECT processed_at FROM payment_events WHERE id = $1 FOR UPDATE`, [e.registroId])
  if (!linhas[0] || linhas[0].processed_at) {
    return { ok: true, repetido: true, evento: e.chave }
  }

  /** fecha a linha do evento no MESMO commit do efeito */
  const concluir = (erro?: string | null) =>
    c.query(
      `UPDATE payment_events
          SET processed_at = now(), attempts = attempts + 1, error = $2
        WHERE id = $1`, [e.registroId, erro ?? null])

  if (!EVENTOS_QUE_IMPORTAM.has(e.nomeEvento)) {
    await concluir()
    return { ok: true, ignorado: e.nomeEvento }
  }

  // O externalReference é nosso order.id. Se faltar, cai pro asaas_payment_id.
  // `FOR UPDATE` aqui e não depois: quem lê o status do pedido pra decidir
  // precisa ser o mesmo que o escreve, sem ninguém no meio.
  const COLUNAS = 'id, org_id, status, total_cents, installments, payment_method, expires_at, asaas_installment_id'
  const { rows: pedidos } = ehUuid(e.referencia)
    ? await c.query(`SELECT ${COLUNAS} FROM orders WHERE id = $1 FOR UPDATE`, [e.referencia])
    : await c.query(`SELECT ${COLUNAS} FROM orders WHERE asaas_payment_id = $1 FOR UPDATE`,
        [e.idCobranca])
  // A parcela 2..n tem id PRÓPRIO (`pay_…`), diferente do que o pedido guarda (o da 1ª). Sem
  // `externalReference`, só o parcelamento (041) liga a parcela ao pedido.
  const parcelamento = String(e.pagamento?.installment ?? '').trim() || null
  if (!pedidos[0] && parcelamento && !ehUuid(e.referencia)) {
    pedidos.push(...(await c.query(
      `SELECT ${COLUNAS} FROM orders WHERE asaas_installment_id = $1 FOR UPDATE`, [parcelamento])).rows)
  }
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
    [e.registroId, pedido.id])

  // ------------------------------------------- cobrança apagada que VOLTOU
  //
  // PAYMENT_RESTORED: alguém restaurou no Asaas uma cobrança removida — ela volta a ser pagável.
  // Com o pedido ainda esperando, nada muda. Com o pedido já desfeito (expirado, cancelado…), o
  // QR/fatura volta a receber dinheiro de um pedido que não segura lugar nenhum: não há o que
  // emitir agora, e calar seria o P0 de 22/09 de novo. Vira PENDÊNCIA visível — a entrega fica
  // sem baixa (Financeiro → entregas, e a saúde conta), e a trilha do pedido diz o que houve. Se
  // a cobrança for paga, o pagamento chega pelo caminho de sempre (o expirado refaz a reserva).
  if (e.nomeEvento === 'PAYMENT_RESTORED') {
    if (['aguardando_pagamento', 'em_analise', 'rascunho'].includes(pedido.status)) {
      await concluir('cobrança restaurada com o pedido ainda esperando pagamento: nada a fazer')
      return { ok: true, pedido: pedido.id, status: pedido.status }
    }
    const recado = `A cobrança ${e.idCobranca} foi RESTAURADA no Asaas com o pedido em `
      + `${pedido.status}: ela voltou a ser pagável. Cancele-a no painel do Asaas, ou confira se `
      + 'alguém pretende pagar — o ingresso não sai sozinho daqui.'
    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       SELECT $1, 'order', $2, 'cobranca_restaurada', $3::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE entity = 'order' AND entity_id = $2
                             AND action = 'cobranca_restaurada')`,
      [pedido.org_id, pedido.id, JSON.stringify({ cobranca: e.idCobranca, statusDoPedido: pedido.status })])
    await c.query(`UPDATE payment_events SET attempts = attempts + 1, error = $2 WHERE id = $1`,
      [e.registroId, recado])
    return { ok: true, pedido: pedido.id, pendente: true, aviso: recado }
  }

  // ------------------------------- "recebido em dinheiro" desfeito no painel
  //
  // O ingresso saiu porque alguém marcou no Asaas que recebeu em dinheiro — e agora desmarcou: o
  // dinheiro não veio. O pedido é desfeito como EXPIRADO, e não como cancelado, de propósito: a
  // cobrança volta a esperar pagamento no Asaas, e 'expirado' é o estado que o resto do sistema
  // já sabe tratar nesse caso — a varredura cancela a cobrança no gateway (fecha a porta), e se o
  // comprador pagar antes disso a emissão refaz a reserva (ou pendura "pago sem lugar"). Com
  // 'cancelado', um pagamento posterior seria baixado como "pedido em cancelado", em silêncio.
  if (e.nomeEvento === 'PAYMENT_RECEIVED_IN_CASH_UNDONE') {
    if (pedido.status !== 'pago' && pedido.status !== 'estornado_parcial') {
      await concluir(`recebimento em dinheiro desfeito com o pedido em ${pedido.status}: nada a desfazer`)
      return { ok: true, pedido: pedido.id, status: pedido.status }
    }
    await desfazerPedido(c, pedido, 'expirado', null)
    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1, 'order', $2, 'recebimento_em_dinheiro_desfeito', $3::jsonb)`,
      [pedido.org_id, pedido.id, JSON.stringify({ cobranca: e.idCobranca, statusAntes: pedido.status,
        ingressos: 'cancelados (os já usados ficam como usados)' })])
    await concluir('recebimento em dinheiro desfeito no Asaas: pedido desfeito (expirado)')
    return { ok: true, pedido: pedido.id, status: 'expirado', desfez: true }
  }

  const novo = statusDoEvento(e.nomeEvento, e.pagamento)
  if (!novo) {
    // Status que o gateway inventou depois. Fica registrado sem virar efeito.
    await concluir(`status desconhecido: ${e.pagamento?.status}`)
    return { ok: true, aviso: 'status desconhecido' }
  }

  // ------------------------------------------ chargeback revertido (ganho)
  //
  // Na disputa GANHA o Asaas manda PAYMENT_AWAITING_CHARGEBACK_REVERSAL e, com
  // o repasse da adquirente, PAYMENT_CONFIRMED ou PAYMENT_RECEIVED (docs,
  // "Chargeback": "o evento posterior a PAYMENT_AWAITING_CHARGEBACK_REVERSAL
  // será PAYMENT_CONFIRMED ou PAYMENT_RECEIVED"). O pagamento caía na emissão,
  // que recusa pedido em 'disputa' ("pedido em disputa") — a entrega era dada
  // por concluída e o pedido ficava fora do líquido PRA SEMPRE, com o dinheiro
  // de volta na conta do produtor.
  //
  // O pedido volta a CONTAR ('pago', ou 'estornado_parcial' se parte já tinha
  // sido devolvida). Os ingressos NÃO voltam: foram cancelados no chargeback,
  // o lugar pode ter sido vendido de novo e, a esta altura, o evento em geral
  // já passou — reemitir é decisão do produtor, pelo painel.
  if (novo === 'pago' && pedido.status === 'chargeback') {
    // O dinheiro só volta DEPOIS do AWAITING_CHARGEBACK_REVERSAL. Pagamento
    // antes dele é entrega fora de ordem: fica pendurada (sem baixa) e o
    // reprocessador tenta de novo — quando o REVERSAL chegar, ela vale.
    throw new Error('pagamento confirmado com o pedido ainda em chargeback: '
      + 'aguardando PAYMENT_AWAITING_CHARGEBACK_REVERSAL')
  }
  if (novo === 'pago' && pedido.status === 'disputa') {
    const total = Number(pedido.total_cents)
    const devolvido = limitar(valorEstornadoCents(e.pagamento) ?? 0, total)
    if (devolvido >= total) {
      await concluir('pagamento em disputa com o valor inteiro devolvido: nada a reverter')
      return { ok: true, pedido: pedido.id, status: pedido.status }
    }
    const status = devolvido > 0 ? 'estornado_parcial' : 'pago'
    await c.query(
      `UPDATE orders SET status = $2, refunded_cents = $3,
              refunded_at = CASE WHEN $3::bigint > 0 THEN refunded_at END,
              canceled_at = NULL
        WHERE id = $1`, [pedido.id, status, devolvido])
    await c.query(
      `INSERT INTO audit_log (entity, entity_id, action, after)
       VALUES ('order', $1, 'chargeback_revertido', $2::jsonb)`,
      [pedido.id, JSON.stringify({ evento: e.nomeEvento, status, estornadoCents: devolvido,
        ingressos: 'continuam cancelados (reemitir é decisão do produtor)' })])
    await concluir('chargeback revertido: o dinheiro voltou; os ingressos continuam cancelados')
    return { ok: true, pedido: pedido.id, status, chargebackRevertido: true }
  }

  // ---------------------------------------------------------- pagamento
  if (novo === 'pago') {
    // Débito: o checkout grava 'credito' (a API não recebe cartão de débito; a fatura do Asaas é
    // quem oferece a opção). Quem pagou com débito pela fatura chega aqui com `billingType`
    // DEBIT_CARD — e o relatório por forma de pagamento passa a dizer a verdade.
    if (String(e.pagamento?.billingType ?? '').toUpperCase() === 'DEBIT_CARD') {
      await c.query(
        `UPDATE orders SET payment_method = 'debito' WHERE id = $1 AND payment_method IS DISTINCT FROM 'debito'`,
        [pedido.id])
    }
    const v = conferirValorRecebido({
      pagamento: e.pagamento,
      totalCents: Number(pedido.total_cents),
      parcelasDoPedido: pedido.installments,
      formaDoPedido: pedido.payment_method,
    })

    if (!v.emitir) {
      // Parcela do meio: o recebimento fica registrado e o ingresso não sai.
      //
      // O prazo PRECISA ser esticado aqui. Ele nasce com minutos de vida (o
      // carrinho abandonado, `events.hold_minutes`) e `liberarExpirados()`
      // mata todo pedido 'aguardando_pagamento' vencido, devolvendo o
      // estoque. Parar de emitir na parcela 1 sem mexer no prazo trocaria um
      // defeito por outro pior: o comprador pagaria as 12 parcelas e a venda
      // teria morrido na primeira meia hora.
      //
      // Zerar a coluna NÃO resolve — e foi assim que este conserto nasceu
      // errado. O gatilho `pedido_pendente_tem_prazo`
      // (`db/011_reserva_de_estoque.sql`) reescreve todo `expires_at` nulo de
      // pedido pendente pro `hold_minutes` do evento, em silêncio, dentro do
      // próprio UPDATE: o código "limpava" o prazo e o banco devolvia 20
      // minutos sem erro nenhum. Medido: `expires_at` continuava preenchido
      // logo depois do UPDATE que o tinha posto em NULL.
      //
      // E o gatilho está certo: reserva sem prazo é lugar preso pra sempre. O
      // certo é dar o prazo DO PARCELAMENTO — a reserva vive enquanto o plano
      // pode terminar, e morre sozinha se o comprador parar de pagar. Uma
      // parcela por mês, mais uma semana de folga pra atraso.
      const mesesQueFaltam = Math.max(1, v.parcelas - (v.parcela ?? 0))
      await c.query(
        `UPDATE orders
            SET expires_at = GREATEST(expires_at,
                                      now() + make_interval(months => $2::int, days => 7))
          WHERE id = $1 AND status = 'aguardando_pagamento'`,
        [pedido.id, mesesQueFaltam])
      await concluir(v.aviso)
      return {
        ok: true, pedido: pedido.id, emitiu: false, ingressos: 0,
        parcela: v.parcela, parcelas: v.parcelas,
        recebidoCents: v.recebidoCents, faltamCents: v.faltamCents, aviso: v.aviso,
      }
    }

    const r = await emitirNaTransacao(c, pedido.id)
    const recado = [v.aviso, r.emitiu ? null : `não emitiu: ${r.motivo}`]
      .filter(Boolean).join(' · ') || null

    if (r.pagoSemLugar) {
      // PIX pago depois de a reserva cair, e o lugar já foi de outra pessoa.
      // NÃO dá baixa: dar baixa aqui era o P0 de 22/09 — o dinheiro entrava, a
      // linha saía da fila como "processada" e ninguém ficava sabendo. Sem
      // `processed_at` a entrega fica na lista de penduradas do painel
      // (Financeiro → entregas), com o erro escrito, e o reprocessador tenta
      // de novo com espera crescente: se alguém desistir e o lugar voltar, o
      // ingresso sai sozinho. Se não voltar, é decisão de gente — outro
      // ingresso ou devolução do dinheiro — e a trilha do pedido já tem a
      // linha `pago_sem_lugar` (gravada por `emitirNaTransacao`).
      //
      // O efeito da transação (a tentativa de reservar) já foi desfeito no
      // savepoint da emissão; o que fica gravado é só a anotação.
      await c.query(
        `UPDATE payment_events SET attempts = attempts + 1, error = $2 WHERE id = $1`,
        [e.registroId, recado])
      console.warn(`[webhook asaas] ${recado} (pedido ${pedido.id})`)
      return {
        ok: true, pedido: pedido.id, emitiu: false, ingressos: 0, pendente: true,
        pagoSemLugar: true, aviso: recado,
      }
    }

    await concluir(recado)
    return {
      ok: true, pedido: pedido.id, emitiu: r.emitiu, ingressos: r.ingressos,
      parcela: v.parcela, parcelas: v.parcelas,
      recebidoCents: v.recebidoCents, faltamCents: v.faltamCents, aviso: v.aviso,
    }
  }

  // --------------------------------------- estorno de COMPRA PARCELADA (041)
  //
  // Cada parcela é uma cobrança, e o estorno chega UMA PARCELA POR VEZ: o estorno do parcelamento
  // inteiro em 3x são três PAYMENT_REFUNDED, cada um com o valor da sua parcela. Os ramos de baixo
  // leem o evento como se fosse o pedido: o 1º dos três desfazia a venda gravando 1/3 em
  // `refunded_cents` (e os outros dois batiam em "já desfeito"), e um estorno parcial de UMA
  // parcela virava `refunded_cents` do pedido inteiro. Aqui o devolvido é a SOMA das parcelas,
  // tirada dos avisos já gravados deste pedido — sem rede dentro da transação.
  // 'disputa'/'chargeback' seguem pelos ramos de sempre: ali o estorno tem outro significado.
  if ((novo === 'estornado' || novo === 'estornado_parcial')
      && pedido.status !== 'disputa'
      && (parcelamento || Number(pedido.installments) > 1)) {
    return await estornoDoParcelamento(c, e, pedido, concluir)
  }

  // ---------------------------------------------------- estorno parcial
  if (novo === 'estornado_parcial') {
    const devolvido = valorEstornadoCents(e.pagamento)
    if (devolvido == null || devolvido <= 0) {
      // Gravar 'estornado_parcial' com zero devolvido faria o líquido
      // contar o pedido INTEIRO como se nada tivesse voltado. Erra em
      // dinheiro e não aparece em lugar nenhum. Falha alto: a linha fica
      // sem `processed_at`, ou seja, na fila de quem precisa olhar — e agora
      // essa fila tem consumidor (`reprocessarEventosPendentes`), que busca o
      // valor no gateway antes de tentar de novo.
      throw new Error('estorno parcial sem valor devolvido no payload')
    }
    const total = Number(pedido.total_cents)
    if (devolvido >= total) {
      // Devolveu tudo, em parcelas: isso é estorno total, e desfaz a venda.
      await desfazerPedido(c, pedido, 'estornado', total)
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

  // Disputa que parecia ganha e terminou em estorno: o dinheiro não volta
  // mais. 'disputa' diz "o dinheiro está voltando"; deixar o pedido nela seria
  // prometer um repasse que não vem. O estoque e os ingressos já foram
  // desfeitos no chargeback — só o nome do fim muda.
  if (novo === 'estornado' && pedido.status === 'disputa') {
    await c.query(
      `UPDATE orders SET status = 'chargeback', refunded_at = COALESCE(refunded_at, now()),
              refunded_cents = GREATEST(refunded_cents, $2)
        WHERE id = $1`,
      [pedido.id, limitar(valorEstornadoCents(e.pagamento) ?? Number(pedido.total_cents),
                          Number(pedido.total_cents))])
    await concluir('estorno depois da disputa: o chargeback ficou perdido')
    return { ok: true, pedido: pedido.id, status: 'chargeback' }
  }

  // -------------------------------------- estorno / cancelamento / chargeback
  if (novo === 'estornado' || novo === 'cancelado' || novo === 'chargeback') {
    // 'cancelado' é cobrança apagada antes de pagar: ninguém devolveu nada,
    // então `refunded_cents` fica como está em vez de fingir um estorno.
    const devolvido = novo === 'cancelado'
      ? null
      : limitar(valorEstornadoCents(e.pagamento)
                ?? reaisParaCentavos(e.pagamento?.value)
                ?? Number(pedido.total_cents), Number(pedido.total_cents))
    const r = await desfazerPedido(c, pedido, novo, devolvido)
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
}

/**
 * O estorno que chega por PARCELA, somado no pedido. Ver o comentário no ponto de chamada.
 *
 * Por parcela vale o MAIOR valor visto (o `refundedValue`/`refunds[]` de uma cobrança é acumulado,
 * então reentrega e aviso fora de ordem não inflam); entre parcelas, soma. PAYMENT_REFUNDED sem o
 * detalhe dos estornos vale o valor da parcela (o status diz que ela voltou inteira).
 */
async function estornoDoParcelamento(
  c: PoolClient, e: EntregaDoAsaas, pedido: any,
  concluir: (erro?: string | null) => Promise<any>,
): Promise<Record<string, any>> {
  const total = Number(pedido.total_cents)
  if (JA_DESFEITO.has(pedido.status)) {
    await concluir(`estorno de parcela com o pedido já em ${pedido.status}`)
    return { ok: true, pedido: pedido.id, status: pedido.status, desfez: false }
  }
  // Devolução na fila (cancelamento do evento, desistência, ficha): quem conta o dinheiro é a
  // fila, quando o gateway confirma — e ela SOMA em `refunded_cents`. Contar aqui também seria o
  // mesmo dinheiro duas vezes (o `WHERE status IN ('pago','estornado_parcial')` da fila deixa o
  // pedido parcial passar).
  const { rows: fila } = await c.query(
    `SELECT 1 FROM refund_jobs WHERE order_id = $1 AND status IN ('na_fila', 'estornando') LIMIT 1`,
    [pedido.id])
  if (fila.length) {
    await concluir('estorno de parcela com a devolução deste pedido na fila: quem conta o dinheiro é a fila')
    return { ok: true, pedido: pedido.id, status: pedido.status, daFila: true }
  }

  const porParcela = new Map<string, number>()
  const anotar = (nomeEvento: string, p: any) => {
    const id = String(p?.id ?? '').trim()
    if (!id) return
    let v = valorEstornadoCents(p)
    if (v == null && nomeEvento === 'PAYMENT_REFUNDED') v = reaisParaCentavos(p?.value)
    if (v == null || v <= 0) return
    porParcela.set(id, Math.max(porParcela.get(id) ?? 0, v))
  }
  const { rows } = await c.query(
    `SELECT event_name, payload -> 'payment' AS p FROM payment_events
      WHERE provider = 'asaas' AND order_id = $1
        AND event_name IN ('PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED')`, [pedido.id])
  for (const r of rows) anotar(r.event_name, r.p)
  anotar(e.nomeEvento, e.pagamento) // a entrega de agora, com o payload já completado pelo reprocessador

  const devolvido = limitar([...porParcela.values()].reduce((a, b) => a + b, 0), total)
  if (devolvido <= 0) {
    // mesma regra do estorno parcial sem valor: falha alto, fica na fila, e o reprocessador
    // pergunta ao gateway quanto voltou (só estorno DONE conta)
    throw new Error('estorno de parcela sem valor devolvido no payload')
  }
  if (devolvido >= total) {
    await desfazerPedido(c, pedido, 'estornado', total)
    await concluir(`estorno das ${porParcela.size} parcela(s) somou o total: estorno total`)
    return { ok: true, pedido: pedido.id, status: 'estornado', estornadoCents: total, parcelas: porParcela.size }
  }
  await c.query(
    `UPDATE orders SET status = 'estornado_parcial', refunded_at = now(),
                       refunded_cents = GREATEST(refunded_cents, $2)
      WHERE id = $1`, [pedido.id, devolvido])
  await concluir(`estorno de parcela: ${real(devolvido)} devolvidos somando ${porParcela.size} parcela(s)`)
  return { ok: true, pedido: pedido.id, status: 'estornado_parcial', estornadoCents: devolvido,
           parcelas: porParcela.size }
}

export type DesfechoDaEntrega =
  | { ok: true; resultado: Record<string, any> }
  | { ok: false; erro: string; indisponivel: boolean }

/** Banco fora é a única falha que merece 500: aí sim queremos a reentrega. */
function ehFalhaDeInfra(motivo: string): boolean {
  return /ECONNREFUSED|timeout|Connection terminated|too many clients/i.test(motivo)
}

/**
 * A entrega inteira: transação, efeito e contabilidade da tentativa.
 *
 * Usada pela rota (entrega que chega agora) e pelo reprocessador (entrega que
 * ficou pendurada). As duas precisam se comportar igual, inclusive no erro.
 */
/**
 * O teto de cada comando da transação da entrega. O Asaas espera a resposta do webhook por até
 * 10 s (docs.asaas.com/docs/fila-pausada) e conta como falha o que passar disso; 15 falhas
 * seguidas PAUSAM a fila da conta inteira. Uma linha de pedido travada por outra transação (a fila
 * de estorno, um cancelamento no painel) segurava a entrega pelo tempo do outro lado. Com o teto, a
 * entrega desiste antes, a linha fica sem baixa e o reprocessador termina depois.
 */
export const PRAZO_DA_ENTREGA = '7s'

export async function aplicarEntregaDoAsaas(e: EntregaDoAsaas): Promise<DesfechoDaEntrega> {
  try {
    return {
      ok: true,
      resultado: await tx(async (c) => {
        await c.query(`SET LOCAL statement_timeout = '${PRAZO_DA_ENTREGA}'`)
        return aplicarEventoDoAsaas(c, e)
      }),
    }
  } catch (erro: any) {
    const motivo = erro?.message ?? String(erro)
    // A transação já voltou atrás: nenhum efeito ficou pela metade. A conta da
    // tentativa é gravada FORA dela, senão o rollback apagaria a própria
    // anotação do erro. `processed_at` segue nulo — a linha fica na fila.
    await q(`UPDATE payment_events SET attempts = attempts + 1, error = $2 WHERE id = $1`,
      [e.registroId, motivo]).catch(() => {})
    return { ok: false, erro: motivo, indisponivel: ehFalhaDeInfra(motivo) }
  }
}

/* ===================================================================== */
/*  O CONSUMIDOR DA FILA DE ENTREGAS                                      */
/* ===================================================================== */

/**
 * Depois disto a entrega para de ser retentada sozinha — mas NÃO some: ela
 * continua na listagem, com o erro e o número de tentativas, e o operador
 * ainda alcança cada uma por id (a mesma porta do "tentar de novo" da fila de
 * estorno). Retentar pra sempre uma entrega que não tem conserto automático é
 * girar em brasa contra o gateway.
 */
export const MAX_REPROCESSOS = 12

/** Carência entre tentativas, multiplicada pelo número de tentativas já feitas. */
export const CARENCIA_REPROCESSO_MIN =
  Number(process.env.DT_WEBHOOK_CARENCIA_MIN || 5)

/**
 * As entregas que ficaram sem baixa.
 *
 * `created_at < now() - carência × tentativas` é a espera crescente sem
 * precisar de coluna nova: a entrega que acabou de falhar não é retentada no
 * mesmo minuto, e a que já falhou cinco vezes espera cinco vezes mais. Pedido
 * por id fura a espera E o teto — é o operador com o cliente na linha.
 *
 * `$5` é a cerca de organização, e ela é OPCIONAL de propósito: o trabalhador
 * de fundo é do processo e varre tudo (cada entrega resolve com o pedido
 * dela), mas quando quem mandou varrer é uma PESSOA a varredura tem que parar
 * na produtora dela. Sem a cerca, medido na rota: logado como dono de uma
 * produtora, `POST /api/admin/financeiro/entregas` com corpo vazio devolveu a
 * entrega pendurada da produtora VIZINHA, com o id do pedido dela e o erro
 * dela. `$6` é o master, que alcança a entrega ÓRFÃ (sem pedido, logo sem
 * organização) — a mesma régua da listagem.
 */
export const SQL_ENTREGAS_PENDENTES = `
  SELECT pe.id, pe.gateway_event_id, pe.external_id, pe.event_name, pe.order_id,
         pe.payload, pe.attempts, pe.error, pe.created_at
    FROM payment_events pe
    LEFT JOIN orders o ON o.id = pe.order_id
   WHERE pe.provider = 'asaas'
     AND pe.processed_at IS NULL
     AND ( $3::uuid IS NOT NULL
        OR ( pe.attempts < $1
             AND pe.created_at < now()
                 - make_interval(mins => $2::int * GREATEST(pe.attempts, 1)) ) )
     AND ($3::uuid IS NULL OR pe.id = $3::uuid)
     AND ( $5::uuid IS NULL
        OR o.org_id = $5::uuid
        OR (pe.order_id IS NULL AND $6::boolean) )
   ORDER BY pe.created_at
   LIMIT $4`

/**
 * Tudo que ficou pendurado, pra tela do operador — sem carência e sem teto.
 *
 * $1 = a organização da SESSÃO, $2 = quem pergunta é master, $3 = limite.
 *
 * A cerca é aqui porque `middleware/02.tenant` só cerca o que tem id de
 * recurso na URL. `o.org_id = $1` sem alternativa deixaria a entrega ÓRFÃ
 * (a que não achou pedido, e por isso não tem organização) invisível pra
 * todo mundo — e ela é a mais suspeita das três: costuma ser o webhook
 * apontado pro ambiente errado, ou cobrança de outro sistema na mesma conta
 * do Asaas. Ela aparece só pro master, e nunca a do vizinho: master aqui é
 * dono de UMA produtora, não da plataforma (o `payout` segue a mesma régua).
 *
 * `LEFT JOIN` e não `JOIN` pelo mesmo motivo — `JOIN` come a linha órfã e a
 * tela fica dizendo "nada pendente" com dinheiro parado.
 */
export const SQL_ENTREGAS_PENDENTES_TODAS = `
  SELECT pe.id, pe.gateway_event_id, pe.external_id, pe.event_name, pe.order_id,
         pe.attempts, pe.error, pe.created_at,
         pe.payload -> 'payment' ->> 'value' AS valor,
         -- Quantas existem de verdade, e não quantas couberam no LIMIT: no
         -- Postgres a janela é calculada ANTES do corte. Uma tela que diz
         -- "100 penduradas" com 400 na fila é a mesma classe de número que
         -- mente dos outros painéis desta casa.
         count(*) OVER ()::int AS total_geral,
         o.code AS pedido_code, o.status AS pedido_status, o.event_id, pe.provider
    FROM payment_events pe
    LEFT JOIN orders o ON o.id = pe.order_id
   -- o Pix do Mercado Pago (28/09) pendura no MESMO lugar: um pago sem lugar é dinheiro parado
   -- venha de qual gateway vier, e a tela é uma só
   WHERE pe.provider IN ('asaas', 'mercadopago')
     AND pe.processed_at IS NULL
     AND ( o.org_id = $1::uuid OR (pe.order_id IS NULL AND $2::boolean) )
   ORDER BY pe.created_at DESC
   LIMIT $3`

/** Como o reprocessador pergunta ao gateway o que aconteceu com a cobrança. */
export type ConsultaDeCobranca = (args: {
  orgId: string | null; paymentId: string
}) => Promise<any | null>

let consultaInjetada: ConsultaDeCobranca | null = null

/**
 * Troca a consulta em tempo de execução — mesmo motivo do `usarEstornador` da
 * fila de devolução: o teste precisa de uma que responda sem rede.
 */
export function usarConsultaDeCobranca(f: ConsultaDeCobranca | null) {
  consultaInjetada = f
}

const consultarCobrancaDeVerdade: ConsultaDeCobranca = async ({ orgId, paymentId }) => {
  // Cobrança de mentira (gateway simulado) não tem o que consultar.
  if (!paymentId || paymentId.startsWith('sim_') || !orgId) return null
  const org = await q1<any>(
    `SELECT asaas_api_key, asaas_env, asaas_wallet FROM organizations WHERE id = $1`, [orgId])
  if (!org?.asaas_api_key) return null
  return await buscarCobranca(
    { apiKey: org.asaas_api_key, environment: org.asaas_env, walletId: org.asaas_wallet },
    paymentId)
}

const consultarCobranca = (a: { orgId: string | null; paymentId: string }) =>
  (consultaInjetada ?? consultarCobrancaDeVerdade)(a)

/* ===================================================================== */
/*  A REDE DE BAIXO DO WEBHOOK — perguntar ao Asaas pelo que está pago     */
/* ===================================================================== */

/**
 * A cobrança que o gateway diz PAGA, aplicada pelo MESMO caminho do webhook.
 *
 * Vira linha em `payment_events` com chave determinística `poll:<cobrança>:<status>` — o índice
 * único `(provider, gateway_event_id)` é a idempotência: duas varreduras (ou varredura + webhook
 * ao mesmo tempo) não emitem duas vezes, porque a emissão trava a linha do pedido e a segunda vê
 * 'pago'. O evento sintético carrega o nome que o Asaas teria mandado (CONFIRMED/RECEIVED), e o
 * pedido é o NOSSO (achado pelo `asaas_payment_id`), nunca a referência que vem de fora.
 */
export async function aplicarCobrancaConsultada(a: {
  pedidoId: string; cobranca: any; paymentId?: string | null
}): Promise<DesfechoDaEntrega> {
  const status = String(a.cobranca?.status ?? '').toUpperCase()
  const paymentId = String(a.cobranca?.id ?? a.paymentId ?? '').trim()
  if (!paymentId || !STATUS_PAGO.has(status)) {
    return { ok: false, erro: `cobrança ${paymentId || '?'} não está paga (${status || 'sem status'})`, indisponivel: false }
  }
  const ref = a.cobranca?.externalReference
  if (ref != null && ehUuid(ref) && ref !== a.pedidoId) {
    return { ok: false, erro: `a cobrança ${paymentId} diz ser do pedido ${ref}, não deste: nada aplicado`, indisponivel: false }
  }
  const nomeEvento = status === 'RECEIVED_IN_CASH' ? 'PAYMENT_RECEIVED_IN_CASH'
    : status === 'RECEIVED' ? 'PAYMENT_RECEIVED' : 'PAYMENT_CONFIRMED'
  const chave = `poll:${paymentId}:${status}`
  const pagamento = { ...a.cobranca, id: paymentId, status, externalReference: a.pedidoId }
  const corpo = { id: chave, event: nomeEvento, origem: 'varredura', payment: pagamento }

  const novo = await q<{ id: string }>(SQL_REGISTRAR_EVENTO,
    [chave, paymentId, nomeEvento, a.pedidoId, JSON.stringify(corpo)])
  let registroId = novo[0]?.id
  if (!registroId) {
    const antes = await q1<any>(
      `SELECT id, processed_at FROM payment_events WHERE provider = 'asaas' AND gateway_event_id = $1`, [chave])
    if (!antes || antes.processed_at) return { ok: true, resultado: { ok: true, repetido: true, evento: chave } }
    registroId = antes.id as string
  }
  return aplicarEntregaDoAsaas({
    registroId, chave, nomeEvento, pagamento, referencia: a.pedidoId, idCobranca: paymentId,
  })
}

/**
 * Pergunta ao gateway pela cobrança do pedido e, se estiver paga, aplica. `null` = não está paga
 * (ou o gateway não disse). Erro da consulta sobe pra quem chama decidir.
 */
async function aplicarSePago(a: { orgId: string; pedidoId: string; paymentId: string }):
  Promise<{ status: string; desfecho: DesfechoDaEntrega } | null> {
  if (!podeVarrerOAsaas()) return null
  const cobranca = await consultarCobranca({ orgId: a.orgId, paymentId: a.paymentId })
  const status = String(cobranca?.status ?? '').toUpperCase()
  if (!cobranca || !STATUS_PAGO.has(status)) return null
  return { status, desfecho: await aplicarCobrancaConsultada({ pedidoId: a.pedidoId, cobranca, paymentId: a.paymentId }) }
}

/**
 * Os pedidos do Asaas a perguntar. Hoje o cartão (e o Pix plano B) só virava ingresso pelo
 * webhook: aviso perdido, fila do webhook pausada no Asaas (15 falhas seguidas), URL errada no
 * painel — e o comprador pago ficava sem ingresso até alguém olhar.
 *
 *  · esperando pagamento há mais de 5 min (antes disso o aviso costuma chegar sozinho), uma vez
 *    por rodada;
 *  · expirados dos últimos 3 dias cuja cobrança NÃO foi cancelada no gateway (o pago no vão), a
 *    cada 10 min — `asaas_checked_at` (041) espaça, e espaçar é a cota: 25.000 chamadas por 12 h.
 *
 * Ordem sorteada pelo mesmo motivo do Pix do MP (`SQL_PIX_ESPERANDO`): num pico com mais pedidos
 * que o limite da rodada, "os mais velhos primeiro" deixaria os novos sem pergunta.
 */
export const SQL_COBRANCAS_A_CONFERIR = `
  SELECT o.id, o.org_id, o.code, o.asaas_payment_id
    FROM orders o
    JOIN organizations org ON org.id = o.org_id AND org.asaas_api_key IS NOT NULL
   WHERE o.asaas_payment_id IS NOT NULL
     AND left(o.asaas_payment_id, 4) <> 'sim_'
     AND ( ( o.status = 'aguardando_pagamento'
             AND o.created_at < now() - interval '5 minutes'
             AND (o.asaas_checked_at IS NULL OR o.asaas_checked_at < now() - interval '50 seconds') )
        OR ( o.status = 'expirado'
             AND o.canceled_at > now() - interval '3 days'
             AND (o.asaas_checked_at IS NULL OR o.asaas_checked_at < now() - interval '10 minutes')
             AND NOT EXISTS (SELECT 1 FROM audit_log a
                              WHERE a.entity = 'order' AND a.entity_id = o.id::text
                                AND a.action IN ('cobranca_cancelada', 'cobranca_paga_no_vao')) ) )
   ORDER BY random()
   LIMIT $1`

export interface DesfechoDaConferencia {
  pedidoId: string
  ok: boolean
  statusNoGateway?: string | null
  /** pago no gateway e aplicado agora */
  aplicado?: boolean
  erro?: string
  passageira?: boolean
}

/**
 * Varredura de fundo fala com o Asaas? Não na máquina com PAGAMENTO_SIMULADO=1 (nunca liga em
 * produção): os servidores de teste dividem banco com a suíte, e a suíte grava organizações com
 * chave de MENTIRA — sem esta guarda, o servidor de outra trilha perguntaria ao Asaas de verdade
 * pelos pedidos de fixture a cada minuto. O teste troca a consulta (`usarConsultaDeCobranca`) ou
 * desliga o simulado no próprio processo.
 */
function podeVarrerOAsaas(): boolean {
  return !!consultaInjetada || !simulado.ligado()
}

/** Uma cópia por vez em toda a frota (trava consultiva de SESSÃO), como as outras varreduras. */
async function umaVarreduraPorVez<T>(nome: string, vazio: T, f: () => Promise<T>): Promise<T> {
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
 * A varredura: pergunta `GET /payments/{id}` por cada pedido da vez e aplica o que estiver pago.
 *
 * Com prazo (`ate`) e limite por rodada, e PARA na primeira falha passageira (Asaas fora, 429,
 * rede): os pedidos seguintes ouviriam o mesmo não — e no 429 a doc proíbe insistir. A marca
 * `asaas_checked_at` só é posta quando o gateway respondeu: pergunta que falhou volta na rodada
 * seguinte.
 */
export async function varrerCobrancasDoAsaas(r: { limite?: number; ate?: number } = {}):
  Promise<DesfechoDaConferencia[]> {
  const { limite = 30, ate = Date.now() + 20_000 } = r
  if (!podeVarrerOAsaas()) return []
  return umaVarreduraPorVez('dt:asaas-cobrancas', [] as DesfechoDaConferencia[], async () => {
    const feitos: DesfechoDaConferencia[] = []
    for (const o of await q<any>(SQL_COBRANCAS_A_CONFERIR, [limite])) {
      if (Date.now() >= ate) break
      let cobranca: any
      try {
        cobranca = await consultarCobranca({ orgId: o.org_id, paymentId: String(o.asaas_payment_id) })
      } catch (e: any) {
        const passageira = falhaPassageiraDoAsaas(e)
        feitos.push({ pedidoId: o.id, ok: false, erro: e?.message ?? String(e), passageira })
        if (passageira) break
        // recusa de regra (404: cobrança de outra conta, apagada): não trava a fila, mas espaça
        await q(`UPDATE orders SET asaas_checked_at = now() WHERE id = $1`, [o.id])
        continue
      }
      await q(`UPDATE orders SET asaas_checked_at = now() WHERE id = $1`, [o.id])
      const status = String(cobranca?.status ?? '').toUpperCase() || null
      if (!status || !STATUS_PAGO.has(status)) {
        feitos.push({ pedidoId: o.id, ok: true, statusNoGateway: status, aplicado: false })
        continue
      }
      const d = await aplicarCobrancaConsultada({ pedidoId: o.id, cobranca, paymentId: o.asaas_payment_id })
      if (!d.ok) {
        console.warn(`[asaas] pedido ${o.code} PAGO no gateway e a aplicação falhou: ${d.erro}`)
        feitos.push({ pedidoId: o.id, ok: false, statusNoGateway: status, erro: d.erro, passageira: d.indisponivel })
        if (d.indisponivel) break
        continue
      }
      feitos.push({ pedidoId: o.id, ok: true, statusNoGateway: status, aplicado: !d.resultado?.repetido })
    }
    return feitos
  })
}

/**
 * O payload guardado não tem o que a entrega precisava — vai buscar no gateway.
 *
 * É o conserto do caso que a rota deixa cair de propósito: PAYMENT_REFUNDED /
 * PAYMENT_PARTIALLY_REFUNDED **sem** `refundedValue` nem `refunds[]`. Reprocessar
 * o mesmo payload daria o mesmo erro pra sempre; a única fonte do valor
 * devolvido é a cobrança no gateway, e ela responde `refundedValue` e a lista
 * de estornos. Sem chave, sem cobrança de verdade ou com o gateway fora, a
 * entrega volta pra fila com o erro escrito em vez de virar um número inventado.
 */
async function completarPayload(linha: any): Promise<any> {
  const corpo = linha.payload ?? {}
  const pagamento = corpo?.payment ?? {}
  const precisaDoValor = linha.event_name === 'PAYMENT_REFUNDED'
    || linha.event_name === 'PAYMENT_PARTIALLY_REFUNDED'
  if (!precisaDoValor || valorEstornadoCents(pagamento) != null) return corpo

  const orgId = linha.order_id
    ? (await q1<any>(`SELECT org_id FROM orders WHERE id = $1`, [linha.order_id]))?.org_id ?? null
    : null
  const cobranca = await consultarCobranca({
    orgId, paymentId: String(pagamento?.id ?? linha.external_id ?? ''),
  }).catch(() => null)
  if (!cobranca) return corpo

  return {
    ...corpo,
    payment: {
      ...pagamento,
      refundedValue: cobranca?.refundedValue ?? pagamento?.refundedValue,
      refunds: cobranca?.refunds ?? pagamento?.refunds,
      // o status também pode ter andado desde a entrega
      status: cobranca?.status ?? pagamento?.status,
    },
  }
}

export interface ResultadoDoReprocesso {
  id: string
  evento: string
  ok: boolean
  /** deu baixa agora? (uma entrega pode ser aplicada e continuar sem efeito) */
  resolvido: boolean
  pedidoId: string | null
  erro: string | null
}

/**
 * Pega as entregas penduradas e leva cada uma até o fim.
 *
 * Roda a MESMA `aplicarEntregaDoAsaas` da rota: um reprocessador com lógica
 * própria prova a cópia dele, não o que o webhook faz.
 */
export async function reprocessarEntregasPendentes(opcoes: {
  limite?: number
  /** uma entrega específica — fura a carência e o teto de tentativas */
  id?: string | null
  /** minutos de espera antes da primeira retentativa (o teste usa 0) */
  carenciaMin?: number
  /**
   * a produtora de quem mandou varrer. `null` é o trabalhador de fundo, que é
   * do PROCESSO e varre tudo; uma pessoa varre só a dela (ver
   * `SQL_ENTREGAS_PENDENTES`).
   */
  orgId?: string | null
  /** master alcança também a entrega órfã, que não tem organização */
  ehMaster?: boolean
} = {}): Promise<ResultadoDoReprocesso[]> {
  const {
    limite = 50, id = null, carenciaMin = CARENCIA_REPROCESSO_MIN,
    orgId = null, ehMaster = false,
  } = opcoes
  const pendentes = await q<any>(SQL_ENTREGAS_PENDENTES,
    [MAX_REPROCESSOS, carenciaMin, id, limite, orgId, ehMaster])

  const feitos: ResultadoDoReprocesso[] = []
  for (const linha of pendentes) {
    const corpo = await completarPayload(linha).catch(() => linha.payload ?? {})
    const pagamento = corpo?.payment ?? {}
    const desfecho = await aplicarEntregaDoAsaas({
      registroId: linha.id,
      chave: linha.gateway_event_id,
      nomeEvento: String(linha.event_name || '') || 'desconhecido',
      pagamento,
      referencia: pagamento?.externalReference,
      idCobranca: String(pagamento?.id ?? linha.external_id ?? ''),
    })

    // "Aplicou" não é "resolveu": a entrega pode ter sido aplicada e a linha
    // continuar sem baixa (não acontece hoje, mas é o banco que responde).
    const baixa = await q1<any>(
      `SELECT processed_at, order_id FROM payment_events WHERE id = $1`, [linha.id])
    feitos.push({
      id: linha.id,
      evento: String(linha.event_name || ''),
      ok: desfecho.ok,
      resolvido: !!baixa?.processed_at,
      pedidoId: baixa?.order_id ?? null,
      erro: desfecho.ok ? null : desfecho.erro,
    })
  }
  return feitos
}

/* -------------------------------------------------------- o trabalhador */

let relogioWebhook: ReturnType<typeof setInterval> | null = null
let varrendo = false

export const INTERVALO_WEBHOOK_MS = Number(process.env.DT_WEBHOOK_INTERVALO_MS || 60_000)

/**
 * Liga o trabalhador que drena a fila de entregas. Idempotente.
 *
 * Quem o liga é o MÓDULO DA ROTA do webhook (`api/webhooks/asaas.post.ts`), e
 * não este arquivo: `utils/asaas.ts` é importado por meia dúzia de rotas e
 * pelos testes, e um laço subindo em todo import faria o reprocessamento
 * andar no meio das afirmações de quem nem sabe que ele existe. A rota do
 * webhook é o lugar certo por ser exatamente quem ENCHE a fila.
 *
 * `unref()` pra não segurar o processo vivo — sem isso o mesmo laço que
 * mantém a fila andando em produção travaria o `vitest` no fim da suíte.
 */
export function garantirWorkerDoWebhook(): boolean {
  if (relogioWebhook || process.env.DT_WEBHOOK_WORKER === 'off') return false
  relogioWebhook = setInterval(() => {
    if (varrendo) return
    varrendo = true
    reprocessarEntregasPendentes()
      .then((f) => {
        // Só fala quando fez alguma coisa: "0 entregas" a cada minuto esconde
        // o dia em que 300 ficarem penduradas de uma vez.
        if (!f.length) return
        const presas = f.filter((r) => !r.resolvido)
        console.log(`[webhook] ${f.length - presas.length} entrega(s) reprocessada(s)`
          + (presas.length ? `, ${presas.length} ainda sem baixa: ${presas[0].erro}` : ''))
      })
      .catch((erro) => console.error('[webhook] varredura falhou:', erro?.message ?? erro))
      .finally(() => { varrendo = false })
  }, INTERVALO_WEBHOOK_MS)
  relogioWebhook.unref?.()
  return true
}

export function pararWorkerDoWebhook() {
  if (relogioWebhook) clearInterval(relogioWebhook)
  relogioWebhook = null
}

/**
 * E o consumidor sobe com o PROCESSO, não com a rota.
 *
 * Ele nasceu chamado só do módulo da rota do webhook, com o argumento de que
 * a rota é quem enche a fila. O argumento é bom e a consequência é a mesma
 * que `server/plugins/00.filas.ts` documenta pras outras duas filas: **no
 * `npm run build` o Nitro fatia o servidor por rota e só carrega o pedaço
 * quando alguém bate nela.** Medido no build:
 *
 *   .output/server/chunks/nitro/nitro.mjs
 *     { route: '/api/webhooks/asaas', handler: _lazy_…, lazy: true }
 *   .output/server/chunks/routes/api/webhooks/asaas.post.mjs:18
 *     garantirWorkerDoWebhook();
 *
 * Ou seja: depois de todo deploy o consumidor ficava esperando o Asaas bater
 * — e a entrega pendurada que ele existe pra resolver é justamente dinheiro
 * que já voltou pro comprador com o pedido ainda em 'pago'. Numa noite sem
 * venda nova, ninguém drena.
 *
 * Aqui funciona porque ESTE módulo cai no pedaço quente: `garantirWorkerDeEstorno()`
 * do `utils/cancelamento.ts` sai como chamada de primeiro nível em
 * `nitro.mjs` (linha 7314 do build medido), que é avaliado no boot.
 *
 * `VITEST` é o que o `utils/cancelamento.ts` resolve com `DT_ESTORNO_WORKER=off`
 * declarado em cada arquivo de teste: aqui a guarda é do lado de cá pra não
 * depender de ninguém lembrar. Meia dúzia de rotas e de testes importam este
 * módulo, e um laço de 60 s andando no meio das afirmações de quem nem sabe
 * que ele existe é ruído caro de achar.
 */
if (!process.env.VITEST) garantirWorkerDoWebhook()

/* ===================================================================== */
/*  A CONFIGURAÇÃO DE PRODUÇÃO — que grita no boot e em /api/saude       */
/* ===================================================================== */
/**
 * O que falta no ambiente pra vender e entregar, em SIM/NÃO e em frases —
 * NUNCA o valor de variável nenhuma.
 *
 * Por que existe (PROD-01, 03, 04, 05, 06 e B05): cada peça que faltava no
 * deploy falhava em SILÊNCIO e longe da causa — o webhook recusando todo
 * pagamento, o e-mail simulado num disco que ninguém lê, o link do e-mail pra
 * localhost, o QR que morre quando alguém troca o segredo da sessão, o freio
 * por IP travando todo mundo atrás do proxy. O dono descobria pelo telefone
 * do cliente. Agora a mesma lista sai em três lugares: no log do boot (uma
 * vez, com `console.error` no que impede venda ou entrega), em `/api/saude`
 * (que um monitor externo lê) e — o que impede cobrar — na vitrine, que não
 * oferece pagamento que vai falhar (`pagamentoOnline`).
 *
 * `critico` = alguém paga e não recebe, ou não consegue pagar.
 */
export interface ProblemaDeConfiguracao {
  /** o nome da peça — da variável, nunca o valor */
  item: string
  critico: boolean
  frase: string
}

export interface EstadoDaConfiguracao {
  producao: boolean
  itens: Record<string, 'SIM' | 'NÃO'>
  assinaQrCom: 'DT2' | 'DT1' | null
  proxy: 'traefik' | 'cloudflare' | 'nenhum'
  problemas: ProblemaDeConfiguracao[]
}

export function conferirConfiguracao(): EstadoDaConfiguracao {
  const env = process.env
  const producao = env.NODE_ENV === 'production'
  const problemas: ProblemaDeConfiguracao[] = []
  const sim = (b: boolean): 'SIM' | 'NÃO' => (b ? 'SIM' : 'NÃO')
  const url = (v?: string) => {
    try { return !!v && /^[a-z]+:$/.test(new URL(v).protocol) } catch { return false }
  }

  // PROD-01 — o webhook é a única porta por onde o pagamento vira ingresso
  const token = !!String(env.ASAAS_WEBHOOK_TOKEN ?? '').trim()
  if (producao && !token) {
    problemas.push({ item: 'ASAAS_WEBHOOK_TOKEN', critico: true,
      frase: 'ASAAS_WEBHOOK_TOKEN não configurado: o webhook recusa todo aviso de pagamento '
        + 'e nenhum PIX vira ingresso. A vitrine não vende enquanto faltar (configure o mesmo '
        + 'token no painel de webhooks do Asaas e no ambiente do deploy).' })
  }

  // PROD-05 — a mesma régua de `entregar()`
  const email = pendenciaDoEmail(env)
  if (email) problemas.push({ item: 'SMTP_URL/EMAIL_REMETENTE', critico: true, frase: email })
  const remetenteOk = !!env.EMAIL_REMETENTE && pendenciaDoEmail({
    NODE_ENV: 'production', SMTP_URL: 'smtp://conferencia.invalid', EMAIL_REMETENTE: env.EMAIL_REMETENTE,
  }) === null

  // PROD-04
  const base = baseDoSite()
  const baseOk = producao ? !!base : url(String(env.PUBLIC_BASE_URL ?? '').trim())
  if (producao && !base) {
    problemas.push({ item: 'PUBLIC_BASE_URL', critico: false,
      frase: 'PUBLIC_BASE_URL ausente, inválido ou apontando pra esta máquina: o e-mail do '
        + 'ingresso sai sem o link do pedido (o QR vai anexado).' })
  }

  // PROD-03 — sem chave nenhuma, nenhum QR é gerado
  const chaves = estadoDasChavesDeIngresso()
  if (chaves.assinaCom === 'DT1') {
    // A frase do chaveiro ("TICKET_KEYS não configurada…") não diz o que NÃO fazer. Até 28/09 este
    // aviso mandava esperar a validação OFFLINE da portaria ler DT2; ela lê desde a F3 (521fe4d,
    // `codigoDoQr` e a lista do tablet) — então o aviso diz que a troca está pronta, e como.
    problemas.push({ item: 'TICKET_KEYS', critico: false,
      frase: 'Os ingressos saem no formato DT1, assinados com NUXT_SESSION_SECRET: NÃO troque essa '
        + 'variável (invalida todo QR vendido). A portaria, com e sem rede, já lê o formato novo '
        + '(DT2, chave própria): pra ligar, ponha em TICKET_KEYS uma chave "k1:" + 32 bytes em base64 — '
        + 'os DT1 já vendidos continuam entrando.' })
    for (const frase of chaves.problemas.filter((f) => !/^TICKET_KEYS não configurada/.test(f))) {
      problemas.push({ item: 'TICKET_KEYS', critico: false, frase })
    }
  } else {
    for (const frase of chaves.problemas) problemas.push({ item: 'TICKET_KEYS', critico: false, frase })
  }
  if (!chaves.assinaCom) {
    problemas.push({ item: 'TICKET_KEYS', critico: true,
      frase: 'Nenhuma chave pra assinar ingresso: NUXT_SESSION_SECRET ausente (ou curto) e '
        + 'TICKET_KEYS vazio. Nenhum QR é gerado.' })
  }

  // B05 — atrás do Traefik sem CONFIAR_PROXY todo mundo tem o IP do proxy
  const freio = estadoDoFreio()
  if (freio.proxySemConfiancaVisto) {
    problemas.push({ item: 'CONFIAR_PROXY', critico: false,
      frase: 'Chegou requisição por proxy (x-forwarded-for) e CONFIAR_PROXY não está ligado: '
        + 'o freio por IP do login e da loja fica DESLIGADO. Configure CONFIAR_PROXY=1 (Traefik '
        + 'do EasyPanel) ou CONFIAR_PROXY=cloudflare.' })
  }

  return {
    producao,
    itens: {
      webhookToken: sim(token),
      smtp: sim(url(env.SMTP_URL)),
      remetente: sim(remetenteOk),
      emailDeVerdade: sim(transporteEscolhido() === 'smtp'),
      publicBaseUrl: sim(baseOk),
      chaveDoIngresso: sim(chaves.assinaCom === 'DT2'),
      confereQrAntigo: sim(chaves.confereDT1),
      confiarProxy: sim(freio.proxy !== 'nenhum'),
      monitorToken: sim(String(env.MONITOR_TOKEN ?? '').length >= 32),
    },
    assinaQrCom: chaves.assinaCom,
    proxy: freio.proxy,
    problemas,
  }
}

/**
 * Os eventos À VENDA que não têm como cobrar online (PROD-06): sem chave, com
 * chave de teste em produção, ou sem o webhook que confirma o pagamento. Só o
 * slug (público) e o motivo — a chave nunca sai daqui.
 */
export async function eventosSemPagamentoOnline(): Promise<Array<{ slug: string; motivo: MotivoSemPagamento }>> {
  const eventos = await q<any>(
    `SELECT e.slug, o.asaas_api_key, o.asaas_env, o.mp_access_token, o.mp_test
       FROM events e JOIN organizations o ON o.id = e.org_id
      WHERE e.status = 'ativo'
        AND (e.ends_at IS NULL OR e.ends_at > now())
        AND (e.sales_end_at IS NULL OR e.sales_end_at > now())
      ORDER BY e.starts_at`)
  const fora: Array<{ slug: string; motivo: MotivoSemPagamento }> = []
  for (const e of eventos) {
    const p = pagamentoOnline(e)
    if (!p.ok) fora.push({ slug: e.slug, motivo: p.motivo })
  }
  return fora
}

/**
 * O aviso do boot: uma vez por processo, alto no que impede venda ou entrega.
 * Fora de produção também avisa (em `warn`), pra ninguém descobrir a falta
 * no dia do deploy.
 */
export async function avisarConfiguracaoNoBoot(
  saida: Pick<Console, 'error' | 'warn' | 'log'> = console,
): Promise<void> {
  const c = conferirConfiguracao()
  for (const p of c.problemas) {
    const linha = `[config] ${p.item}: ${p.frase}`
    if (p.critico && c.producao) saida.error(linha)
    else saida.warn(linha)
  }
  try {
    const fora = await eventosSemPagamentoOnline()
    for (const e of fora) {
      const linha = `[config] evento à venda SEM pagamento online (${e.motivo}): ${e.slug} — `
        + 'a vitrine mostra "vendas online indisponíveis" e o checkout recusa antes do estoque.'
      if (c.producao) saida.error(linha)
      else saida.warn(linha)
    }
  } catch (e: any) {
    saida.warn(`[config] não deu pra conferir as chaves do Asaas no banco: ${e?.message ?? e}`)
  }
  if (c.producao && !c.problemas.some((p) => p.critico)) {
    saida.log(`[config] produção: webhook=${c.itens.webhookToken} email=${c.itens.emailDeVerdade} `
      + `site=${c.itens.publicBaseUrl} qr=${c.assinaQrCom} proxy=${c.proxy}`)
  }
}

// Mesmo motivo do `garantirWorkerDoWebhook()` acima: este módulo cai no pedaço
// avaliado no boot, então o aviso sai quando o processo sobe — e uma vez só
// (o `globalThis` sobrevive ao recarregamento do `nuxt dev`). Fora da suíte:
// teste que importa este arquivo não quer o aviso no meio das afirmações.
if (!process.env.VITEST && !(globalThis as any).__dtConfigAvisada) {
  ;(globalThis as any).__dtConfigAvisada = true
  setTimeout(() => { avisarConfiguracaoNoBoot().catch(() => {}) }, 0).unref?.()
}
