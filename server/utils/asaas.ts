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
import { cpfValido } from './documento'

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
