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
import { q, q1, tx } from './db'
import { emitirNaTransacao } from './emissao'
import { liberar } from './estoque'

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
 */
export function vencimentoEmDias(dias: number, agora = new Date()): string {
  const d = new Date(agora.getTime())
  d.setDate(d.getDate() + dias)
  const mes = String(d.getMonth() + 1).padStart(2, '0')
  const dia = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mes}-${dia}`
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
    description: `Diamond Tickets — saque ${p.code ?? p.id}`,
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
 */
export function valorEstornadoCents(pagamento: any): number | null {
  const direto = reaisParaCentavos(pagamento?.refundedValue)
  if (direto != null && direto > 0) return direto

  const lista = Array.isArray(pagamento?.refunds) ? pagamento.refunds : []
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
  const COLUNAS = 'id, status, total_cents, installments, payment_method, expires_at'
  const { rows: pedidos } = ehUuid(e.referencia)
    ? await c.query(`SELECT ${COLUNAS} FROM orders WHERE id = $1 FOR UPDATE`, [e.referencia])
    : await c.query(`SELECT ${COLUNAS} FROM orders WHERE asaas_payment_id = $1 FOR UPDATE`,
        [e.idCobranca])
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

  const novo = statusDoEvento(e.nomeEvento, e.pagamento)
  if (!novo) {
    // Status que o gateway inventou depois. Fica registrado sem virar efeito.
    await concluir(`status desconhecido: ${e.pagamento?.status}`)
    return { ok: true, aviso: 'status desconhecido' }
  }

  // ---------------------------------------------------------- pagamento
  if (novo === 'pago') {
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
    await concluir(recado)
    return {
      ok: true, pedido: pedido.id, emitiu: r.emitiu, ingressos: r.ingressos,
      parcela: v.parcela, parcelas: v.parcelas,
      recebidoCents: v.recebidoCents, faltamCents: v.faltamCents, aviso: v.aviso,
    }
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
export async function aplicarEntregaDoAsaas(e: EntregaDoAsaas): Promise<DesfechoDaEntrega> {
  try {
    return { ok: true, resultado: await tx((c) => aplicarEventoDoAsaas(c, e)) }
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
         o.code AS pedido_code, o.status AS pedido_status, o.event_id
    FROM payment_events pe
    LEFT JOIN orders o ON o.id = pe.order_id
   WHERE pe.provider = 'asaas'
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
