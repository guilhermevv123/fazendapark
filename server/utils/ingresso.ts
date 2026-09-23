/**
 * ingresso.ts — geração de código, assinatura do QR e validação na portaria.
 *
 * Duas coisas diferentes que sempre confundem:
 *   • `code`  — o localizador legível que vai impresso ("CPK-7F3K-92"). Serve
 *     pra humano falar no telefone. NÃO é segredo.
 *   • `qr`    — code + assinatura HMAC. É o que a catraca lê. Sem a chave do
 *     servidor ninguém fabrica um válido.
 *
 * Por que assinar em vez de só consultar o banco: a portaria de um parque cai
 * de internet. Com assinatura o leitor sabe OFFLINE que o ingresso é legítimo
 * e da edição certa; só o "já entrou?" precisa de rede. Um leitor que depende
 * 100% de rede vira fila na porteira no primeiro 4G ruim.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const ALFABETO = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' // sem 0/O/1/I: some erro de digitação

function segredo(): string {
  const s = process.env.NUXT_SESSION_SECRET
  if (!s || s.length < 16) {
    throw new Error('NUXT_SESSION_SECRET ausente ou curto demais para assinar ingresso')
  }
  return s
}

/** Código legível do ingresso: PREFIXO-XXXX-XXXX */
export function gerarCodigo(prefixo = 'ING'): string {
  const bytes = randomBytes(8)
  let s = ''
  for (let i = 0; i < 8; i++) s += ALFABETO[bytes[i] % ALFABETO.length]
  return `${prefixo.toUpperCase().slice(0, 4)}-${s.slice(0, 4)}-${s.slice(4)}`
}

/**
 * Código NOVO pro mesmo ingresso, com o mesmo prefixo do antigo.
 *
 * É o que invalida um QR: a assinatura é HMAC(evento:código), então trocar o
 * código mata na hora todo QR, print e e-mail que carregavam o antigo — a
 * catraca procura o código e não acha. Usado na transferência: sem isto o
 * remetente continuava com um QR que dava "Liberado", e os dois entravam.
 *
 * O prefixo é mantido (CON-…) porque é o que o operador reconhece de olho
 * como sendo deste evento.
 */
export function novoCodigoDoIngresso(codigoAtual?: string | null): string {
  const prefixo = String(codigoAtual ?? '').split('-')[0].replace(/[^a-zA-Z]/g, '')
  let novo = gerarCodigo(prefixo || 'ING')
  // chance ínfima (32^8), mas "igual ao antigo" seria o único resultado que
  // não invalida nada — e ele custa uma comparação pra excluir
  while (novo === codigoAtual) novo = gerarCodigo(prefixo || 'ING')
  return novo
}

/** Assinatura curta (10 chars base32) de um código, amarrada ao evento. */
export function assinar(code: string, eventId: string): string {
  const mac = createHmac('sha256', segredo()).update(`${eventId}:${code}`).digest()
  let s = ''
  for (let i = 0; i < 10; i++) s += ALFABETO[mac[i] % ALFABETO.length]
  return s
}

/** Conteúdo do QR. Formato: DT1:<eventId>:<code>:<assinatura> */
export function montarQr(code: string, eventId: string): string {
  return `DT1:${eventId}:${code}:${assinar(code, eventId)}`
}

export interface QrLido {
  ok: boolean
  eventId?: string
  code?: string
  motivo?: 'formato' | 'assinatura'
}

/**
 * Lê e confere a assinatura. NÃO diz se o ingresso já foi usado — isso é
 * consulta ao banco, decidida por quem chama.
 */
export function lerQr(bruto: string): QrLido {
  const partes = String(bruto || '').trim().split(':')
  if (partes.length !== 4 || partes[0] !== 'DT1') return { ok: false, motivo: 'formato' }
  const [, eventId, code, sig] = partes
  if (!eventId || !code || !sig) return { ok: false, motivo: 'formato' }

  const esperado = assinar(code, eventId)
  // comparação em tempo constante: comparar com === vaza o tamanho do prefixo
  // certo e deixa alguém descobrir a assinatura byte a byte
  const a = Buffer.from(sig)
  const b = Buffer.from(esperado)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, motivo: 'assinatura' }
  }
  return { ok: true, eventId, code }
}

export type ResultadoCheckin =
  | 'ok' | 'ja_usado' | 'invalido' | 'cancelado' | 'fora_da_sessao' | 'evento_errado'

export const MENSAGEM_CHECKIN: Record<ResultadoCheckin, string> = {
  ok: 'Liberado',
  ja_usado: 'Este ingresso já entrou',
  invalido: 'Ingresso inválido',
  cancelado: 'Ingresso cancelado',
  fora_da_sessao: 'Fora do horário desta sessão',
  evento_errado: 'Ingresso é de outro evento',
}
