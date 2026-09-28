/**
 * O cofre: segredo de TERCEIRO guardado no banco — hoje, a chave de API do Asaas de cada
 * organização —, cifrado com AES-256-GCM.
 *
 * Por que existe: a chave do Asaas cobra, estorna e TRANSFERE dinheiro pra conta de banco. O
 * esquema dizia "cifrada em repouso" desde o primeiro dia (db/001_schema.sql) e nenhuma linha de
 * código cifrava — medido na auditoria de 28/09: a chave ia em texto puro pro banco, pra todo
 * backup e pra todo dump que alguém mandasse pro suporte. Com o cofre, quem tem o banco sem o
 * servidor tem só ruído.
 *
 * Gravado assim: `cofre:v1:<kid>:<iv>:<tag>:<cifrado>` (base64url). `kid` são os 8 primeiros hex
 * do sha256 da chave do cofre: trocar a chave (a nova em COFRE_CHAVE, a velha em
 * COFRE_CHAVES_ANTIGAS) não perde o que já está gravado — o mesmo desenho da chave do QR
 * (TICKET_KEYS). `scripts/cofre-cifrar.mjs` recifra tudo com a chave nova.
 *
 * Sem COFRE_CHAVE no ambiente: grava e lê em TEXTO PURO, exatamente como antes — o deploy deste
 * código não depende de configurar nada, e a cifra liga no dia em que a variável entrar (depois,
 * o script cifra o que já estava gravado). Valor cifrado no banco SEM a chave que o abre:
 * `abrirSegredo` LANÇA. Cobrar com uma chave que não abre só daria 401 do Asaas lá na frente,
 * com o comprador no meio do pagamento — melhor o erro dizer o que falta, na hora.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const PREFIXO = 'cofre:v1:'

export class CofreFechado extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'CofreFechado'
  }
}

function lerChave(texto: string, nome: string): Buffer {
  const b = Buffer.from(texto.trim(), 'base64')
  if (b.length !== 32) {
    throw new CofreFechado(`${nome} precisa ter 32 bytes em base64 (gere com: openssl rand -base64 32)`)
  }
  return b
}

const kidDe = (chave: Buffer) => createHash('sha256').update(chave).digest('hex').slice(0, 8)

/** Lidas a cada uso (e não no carregamento do módulo): o teste troca o ambiente no meio. */
function chavesDoAmbiente() {
  const todas = new Map<string, Buffer>()
  let atual: { kid: string; chave: Buffer } | null = null
  const texto = String(process.env.COFRE_CHAVE ?? '').trim()
  if (texto) {
    const chave = lerChave(texto, 'COFRE_CHAVE')
    atual = { kid: kidDe(chave), chave }
    todas.set(atual.kid, chave)
  }
  for (const antiga of String(process.env.COFRE_CHAVES_ANTIGAS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const chave = lerChave(antiga, 'COFRE_CHAVES_ANTIGAS')
    todas.set(kidDe(chave), chave)
  }
  return { atual, todas }
}

/** O cofre está ligado (existe COFRE_CHAVE)? Pra saúde e pro boot dizerem em que pé está. */
export const cofreLigado = () => !!String(process.env.COFRE_CHAVE ?? '').trim()

/** O id da chave ATUAL do cofre (nulo com o cofre desligado). */
export const kidAtual = () => chavesDoAmbiente().atual?.kid ?? null

/** Com que chave do cofre este valor foi cifrado (nulo pra texto puro). */
export function kidDoGuardado(v: unknown): string | null {
  return estaNoCofre(v) ? (v.slice(PREFIXO.length).split(':')[0] ?? null) : null
}

/** O valor gravado é do cofre (e não texto puro de antes)? */
export const estaNoCofre = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PREFIXO)

/**
 * O que vai pro banco. Cofre desligado: o próprio texto (como antes). Já cifrado: devolve igual
 * (gravar duas vezes não embrulha duas vezes). Nulo/vazio: nulo.
 */
export function guardarSegredo(texto: string | null | undefined): string | null {
  if (texto === null || texto === undefined || texto === '') return null
  if (estaNoCofre(texto)) return texto
  const { atual } = chavesDoAmbiente()
  if (!atual) return texto
  const iv = randomBytes(12)
  const cifra = createCipheriv('aes-256-gcm', atual.chave, iv)
  const cifrado = Buffer.concat([cifra.update(texto, 'utf8'), cifra.final()])
  const tag = cifra.getAuthTag()
  return `${PREFIXO}${atual.kid}:${iv.toString('base64url')}:${tag.toString('base64url')}:${cifrado.toString('base64url')}`
}

/**
 * O segredo de volta, pra usar. Texto puro (gravado antes do cofre): devolve igual. Do cofre:
 * abre com a chave do `kid` — a atual ou uma antiga. Sem a chave, ou com o valor adulterado:
 * lança `CofreFechado` (o GCM confere a integridade: um byte trocado não abre).
 */
export function abrirSegredo(guardado: string | null | undefined): string | null {
  if (guardado === null || guardado === undefined || guardado === '') return null
  if (!estaNoCofre(guardado)) return guardado
  const partes = guardado.slice(PREFIXO.length).split(':')
  if (partes.length !== 4) throw new CofreFechado('segredo do cofre com formato quebrado')
  const [kid, iv, tag, cifrado] = partes as [string, string, string, string]
  const chave = chavesDoAmbiente().todas.get(kid)
  if (!chave) {
    throw new CofreFechado(
      `a chave do cofre que abre este segredo (id ${kid}) não está no servidor — confira COFRE_CHAVE / COFRE_CHAVES_ANTIGAS`)
  }
  try {
    const decifra = createDecipheriv('aes-256-gcm', chave, Buffer.from(iv, 'base64url'))
    decifra.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decifra.update(Buffer.from(cifrado, 'base64url')), decifra.final()]).toString('utf8')
  } catch {
    throw new CofreFechado('segredo do cofre não confere (adulterado ou cifrado com outra chave)')
  }
}

/** Os 6 últimos caracteres do segredo aberto — o que a tela mostra pra conferir qual chave é. */
export function finalDoSegredo(guardado: string | null | undefined): string | null {
  const aberto = abrirSegredo(guardado)
  return aberto ? aberto.slice(-6) : null
}
