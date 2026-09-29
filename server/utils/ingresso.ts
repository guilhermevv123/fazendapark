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
 *
 * ## A chave é DO INGRESSO, e tem nome (27/09)
 *
 * Até aqui o QR era assinado com `NUXT_SESSION_SECRET`. O nome prometia
 * "sessão" e a variável não servia pra mais nada: a sessão do painel é token no
 * banco. Quem "rotacionasse o segredo de sessão" achando que só derrubava login
 * matava TODO QR já mandado por e-mail — a catraca passava a responder
 * "Ingresso inválido" como se cada um fosse fabricado. Numa VPS nova sem o mesmo
 * valor, idem. E `TICKET_SECRET`, que estava no `.env` com cara de ser a chave,
 * ninguém lia.
 *
 * Agora são dois formatos:
 *
 *   DT2:<kid>:<evento>:<código>:<assinatura>   ← o que sai hoje
 *   DT1:<evento>:<código>:<assinatura>         ← o que já foi vendido
 *
 * `TICKET_KEYS="k2:BASE64,k1:BASE64"` — a PRIMEIRA chave válida assina; todas
 * conferem. O `kid` no QR diz qual delas assinou, então dá pra trocar de chave
 * sem matar ingresso vendido: põe a nova na frente, e a antiga só sai da lista
 * quando o último evento assinado com ela acabar.
 *
 * O DT1 continua valendo com a chave que o assinou: `TICKET_KEY_LEGADO_DT1`, ou,
 * sem ela, `NUXT_SESSION_SECRET` — que é o que assinou todo DT1 até hoje. Sem
 * `TICKET_KEYS` configurada, a casa continua emitindo DT1 com essa chave (é o
 * que roda em produção hoje, e trocar de formato no deploy sem a variável
 * mataria a venda); `/api/saude` e o log do boot dizem que falta.
 *
 * Chave aposentada (kid que não está mais na lista, ou DT1 sem a chave antiga)
 * NÃO é o mesmo que QR fabricado: o resultado sai com `chaveAposentada`, pra
 * portaria poder dizer "QR antigo — confira pelo código" em vez de chamar de
 * falsificado o ingresso de quem pagou.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const ALFABETO = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' // sem 0/O/1/I: some erro de digitação

/** Formato do `kid`: curto, porque vai dentro de todo QR impresso. */
const KID = /^[a-z0-9]{1,8}$/i
/** Chave nova com menos que isso é chave fraca — recusada, não aceita calada. */
export const BYTES_MINIMOS_DA_CHAVE = 32
/** O piso que o DT1 sempre exigiu de `NUXT_SESSION_SECRET`. */
const CARACTERES_MINIMOS_DO_LEGADO = 16

interface Chaveiro {
  /** a que assina agora: a primeira entrada válida de `TICKET_KEYS` */
  atual: { kid: string; segredo: Buffer } | null
  /** todas as que conferem, pelo kid */
  porKid: Map<string, Buffer>
  /** a que confere DT1 (e assina, enquanto não houver `TICKET_KEYS`) */
  legado: Buffer | null
  /** o que está torto na configuração — frase pra operador, NUNCA o valor */
  problemas: string[]
}

let memo: { chave: string; chaveiro: Chaveiro } | null = null

/**
 * Lê as chaves do ambiente. Relido a cada chamada (com memória pelo valor
 * cru): o teste troca a variável entre casos, e um valor congelado na carga do
 * módulo faria o segundo caso mentir.
 */
function chaveiro(): Chaveiro {
  const cru = String(process.env.TICKET_KEYS ?? '')
  const legadoCru = String(process.env.TICKET_KEY_LEGADO_DT1 || process.env.NUXT_SESSION_SECRET || '')
  const chave = `${cru}\u0000${legadoCru}`
  if (memo?.chave === chave) return memo.chaveiro

  const problemas: string[] = []
  const porKid = new Map<string, Buffer>()
  let atual: Chaveiro['atual'] = null
  const entradas = cru.split(',').map((s) => s.trim()).filter(Boolean)
  entradas.forEach((par, i) => {
    const dois = par.indexOf(':')
    const kid = dois > 0 ? par.slice(0, dois).trim() : ''
    const b64 = dois > 0 ? par.slice(dois + 1).trim() : ''
    const onde = `TICKET_KEYS, entrada ${i + 1}`
    if (!KID.test(kid)) {
      problemas.push(`${onde}: o nome da chave (kid) tem que ser 1 a 8 letras ou números, antes do ":"`)
      return
    }
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) {
      problemas.push(`${onde} (${kid}): o segredo não é base64`)
      return
    }
    const segredo = Buffer.from(b64, 'base64')
    if (segredo.length < BYTES_MINIMOS_DA_CHAVE) {
      problemas.push(`${onde} (${kid}): o segredo tem ${segredo.length} bytes; o mínimo é `
        + `${BYTES_MINIMOS_DA_CHAVE} (gere com: openssl rand -base64 32)`)
      return
    }
    if (porKid.has(kid)) {
      problemas.push(`${onde}: o kid "${kid}" aparece duas vezes — vale a primeira`)
      return
    }
    porKid.set(kid, segredo)
    if (!atual) atual = { kid, segredo }
  })
  if (entradas.length && !atual) {
    problemas.push('TICKET_KEYS não tem nenhuma chave válida: os ingressos novos seguem no formato antigo (DT1)')
  }

  const legado = legadoCru.length >= CARACTERES_MINIMOS_DO_LEGADO ? Buffer.from(legadoCru, 'utf8') : null
  if (legadoCru && !legado) {
    problemas.push(`a chave do formato antigo (TICKET_KEY_LEGADO_DT1 ou NUXT_SESSION_SECRET) tem menos de `
      + `${CARACTERES_MINIMOS_DO_LEGADO} caracteres e não confere nada`)
  }
  if (!atual) {
    problemas.push(legado
      ? 'TICKET_KEYS não configurada: os ingressos saem assinados com NUXT_SESSION_SECRET (formato DT1). '
        + 'Trocar essa variável invalida todo QR vendido.'
      : 'nenhuma chave de ingresso configurada (TICKET_KEYS): não dá pra assinar nem conferir QR')
  }

  const novo: Chaveiro = { atual, porKid, legado, problemas }
  memo = { chave, chaveiro: novo }
  return novo
}

/** Assinatura curta (10 chars base32) de um conteúdo, com um segredo. */
function assinarCom(segredo: Buffer, conteudo: string): string {
  const mac = createHmac('sha256', segredo).update(conteudo).digest()
  let s = ''
  for (let i = 0; i < 10; i++) s += ALFABETO[mac[i] % ALFABETO.length]
  return s
}

/**
 * O que entra no HMAC de cada formato. O DT1 é o de sempre (`evento:código`) —
 * mudar isso invalidaria o que já foi vendido. O DT2 amarra também a versão e
 * o kid: assinatura de um formato não serve no outro, nem se alguém configurar
 * o mesmo segredo nos dois lugares.
 */
const conteudoDT1 = (eventId: string, code: string) => `${eventId}:${code}`
const conteudoDT2 = (kid: string, eventId: string, code: string) => `DT2:${kid}:${eventId}:${code}`

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

function semChave(): Error {
  return new Error('Sem chave pra assinar ingresso: configure TICKET_KEYS '
    + '(ou NUXT_SESSION_SECRET, que assina o formato antigo)')
}

/**
 * Assinatura curta (10 chars base32) de um código, amarrada ao evento — com a
 * chave que assina AGORA. Mantida pra quem já chamava; o QR inteiro sai de
 * `montarQr`.
 */
export function assinar(code: string, eventId: string): string {
  const k = chaveiro()
  if (k.atual) return assinarCom(k.atual.segredo, conteudoDT2(k.atual.kid, eventId, code))
  if (k.legado) return assinarCom(k.legado, conteudoDT1(eventId, code))
  throw semChave()
}

/**
 * Conteúdo do QR: DT2:<kid>:<eventId>:<code>:<assinatura> — ou, enquanto
 * `TICKET_KEYS` não estiver configurada, o DT1 de sempre.
 */
export function montarQr(code: string, eventId: string): string {
  const k = chaveiro()
  if (k.atual) {
    return `DT2:${k.atual.kid}:${eventId}:${code}:${assinarCom(k.atual.segredo, conteudoDT2(k.atual.kid, eventId, code))}`
  }
  if (k.legado) return `DT1:${eventId}:${code}:${assinarCom(k.legado, conteudoDT1(eventId, code))}`
  throw semChave()
}

export interface QrLido {
  ok: boolean
  eventId?: string
  code?: string
  motivo?: 'formato' | 'assinatura'
  /**
   * A assinatura não pôde ser conferida porque a chave que a fez não está mais
   * configurada (kid fora de `TICKET_KEYS`, ou DT1 sem a chave antiga). Vem com
   * `motivo: 'assinatura'` — quem não olha este campo continua recusando, que é
   * o lado seguro —, e com `eventId`/`code` lidos do QR, pra portaria poder
   * conferir pelo código em vez de chamar o ingresso de fabricado.
   */
  chaveAposentada?: boolean
  /** qual chave assinou (só DT2) */
  kid?: string
}

/** Compara em tempo constante: `===` vaza o tamanho do prefixo certo. */
function confere(sig: string, esperado: string): boolean {
  const a = Buffer.from(sig)
  const b = Buffer.from(esperado)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Lê e confere a assinatura. NÃO diz se o ingresso já foi usado — isso é
 * consulta ao banco, decidida por quem chama.
 */
export function lerQr(bruto: string): QrLido {
  const partes = String(bruto || '').trim().split(':')

  if (partes[0] === 'DT2' && partes.length === 5) {
    const [, kid, eventId, code, sig] = partes
    if (!kid || !eventId || !code || !sig) return { ok: false, motivo: 'formato' }
    const segredo = chaveiro().porKid.get(kid)
    if (!segredo) return { ok: false, motivo: 'assinatura', chaveAposentada: true, kid, eventId, code }
    if (!confere(sig, assinarCom(segredo, conteudoDT2(kid, eventId, code)))) {
      return { ok: false, motivo: 'assinatura' }
    }
    return { ok: true, eventId, code, kid }
  }

  if (partes[0] === 'DT1' && partes.length === 4) {
    const [, eventId, code, sig] = partes
    if (!eventId || !code || !sig) return { ok: false, motivo: 'formato' }
    const legado = chaveiro().legado
    if (!legado) return { ok: false, motivo: 'assinatura', chaveAposentada: true, eventId, code }
    if (!confere(sig, assinarCom(legado, conteudoDT1(eventId, code)))) {
      return { ok: false, motivo: 'assinatura' }
    }
    return { ok: true, eventId, code }
  }

  return { ok: false, motivo: 'formato' }
}

/**
 * Como estão as chaves — pra `/api/saude` e pro log do boot. Diz SIM/NÃO e o
 * nome da chave, NUNCA o segredo.
 */
export function estadoDasChavesDeIngresso(): {
  assinaCom: 'DT2' | 'DT1' | null
  kid: string | null
  kids: string[]
  confereDT1: boolean
  problemas: string[]
} {
  const k = chaveiro()
  return {
    assinaCom: k.atual ? 'DT2' : k.legado ? 'DT1' : null,
    kid: k.atual?.kid ?? null,
    kids: [...k.porKid.keys()],
    confereDT1: !!k.legado,
    problemas: [...k.problemas],
  }
}

export type ResultadoCheckin =
  | 'ok' | 'ja_usado' | 'invalido' | 'cancelado' | 'fora_da_sessao' | 'evento_errado'

export const MENSAGEM_CHECKIN: Record<ResultadoCheckin, string> = {
  ok: 'Liberado',
  ja_usado: 'Ingresso já foi usado — não pode ser usado novamente',
  invalido: 'Ingresso inválido',
  cancelado: 'Ingresso cancelado',
  fora_da_sessao: 'Fora do horário desta sessão',
  evento_errado: 'Ingresso é de outro evento',
}
