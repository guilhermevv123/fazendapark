<script lang="ts">
/**
 * As decisões desta tela que NÃO dependem de estado — exportadas pra teste
 * (`app/composables/leitor-entrada.test.ts`). Moram aqui, e não num arquivo
 * à parte, porque só esta tela as usa; o que importa é que o teste rode
 * exatamente estas linhas, não uma cópia.
 */

import { diaLocal } from '~/composables/formato'
import { decidirAcesso, ehPapel } from '~~/server/utils/papeis'
import { fraseDosDiasDeUso, mensagemForaDoDiaDeUso, rotuloDoDiaDeUso, valeNoDiaDeUso } from '~~/server/utils/dias-de-uso'
import {
  FORMAS_DE_TROCA, opcoesDeTroca, reaisDaTroca, ROTULO_DA_FORMA,
  type FormaDeTroca, type OpcaoDeTroca, type TipoParaTroca,
} from '~~/server/utils/troca-de-dia'

/**
 * Este papel pode ler o log de leituras (`/checkins`)? A MESMA grade que tranca a rota no servidor
 * (`decidirAcesso`, do middleware 03). A portaria não tem `portaria_historico`: pedir mesmo assim
 * dava 403 no console ao abrir o leitor e de novo a cada entrada liberada — uma ida à rede do
 * portão jogada fora por pessoa que passa. Papel ainda desconhecido (aparelho reaberto sem rede)
 * pede como antes: quem pode não fica sem o log por falta de uma resposta.
 */
export function pedeOLogDeLeituras(papel: unknown, eventoId: string): boolean {
  if (!ehPapel(papel)) return true
  return decidirAcesso(papel, `/api/admin/evento/${eventoId}/checkins`).liberado
}

/** o que a portaria pede quando o ingresso é meia — ver o comentário no setup */
export type Meia = { motivo: string | null; rotulo: string; documento: string; numero: string | null }

/** o retrato do público — um objeto, uma consulta (ver `publico` no setup) */
export type Publico = {
  pessoas: number; entradas: number; ingressos: number
  offline: number; aptos: number; faltam: number; comparecimentoPct: number
}

export type Resposta = {
  ok: boolean; resultado: string; mensagem: string; consulta?: boolean
  titular?: string | null; entrouEm?: string | null
  portao?: string | null; operadorEntrada?: string | null
  local?: boolean; pessoas?: number
  /** só nas respostas do SERVIDOR: a decisão local não sabe contar o parque */
  publico?: Publico
  ingresso?: {
    titular: string | null; setor: string; lote: string; tipo: string | null
    meia?: Meia | null
  }
  /** `nao_lido` por sessão vencida: a tela oferece o link de entrar de novo */
  entrarDeNovo?: boolean
  /** o código veio DIGITADO, sem a assinatura do QR — a tela pede pra conferir o documento */
  digitado?: boolean
  /** QR assinado com uma chave que saiu da lista (troca de chave): vale como digitado, com o aviso */
  qrAntigo?: boolean
  /** o tipo do ingresso não vale HOJE (047, dias de uso): "NÃO VALE HOJE", não "AINDA NÃO" */
  foraDoDia?: boolean
  /** os dias em que o ingresso vale — a pergunta da troca diz "é de sábado, hoje é domingo" */
  diasDeUso?: string[] | null
  /** troca de dia (049): as opções de hoje com a diferença — o porteiro cobra e libera */
  troca?: { hoje: string; pagoCents: number; pessoas: number; opcoes: OpcaoDeTroca[] }
  /** a troca que liberou esta pessoa: o tipo de hoje, quanto foi cobrado e como */
  trocaFeita?: { tipo: string; cobradoCents: number; forma: FormaDeTroca }
  /** combo (050): esta é a pessoa `seq` de `tamanho`, e o estado de cada parte do combo */
  combo?: ComboDaPorta
}

type ComboDaPorta = { seq: number; tamanho: number; partes: { seq: number; status: string }[] }

/** o mesmo mínimo do servidor (`qr: z.string().min(4)` em `/api/checkin`) */
export const MINIMO_DO_CODIGO = 4

/**
 * Separa o código do QR assinado; o resto é código digitado à mão.
 *
 * Os dois formatos que existem (ver `lerQr` em server/utils/ingresso.ts):
 *   DT2:<kid>:<evento>:<código>:<assinatura>   ← o que a casa passa a emitir (chave com nome)
 *   DT1:<evento>:<código>:<assinatura>         ← o que já foi vendido
 * Sem o DT2 aqui, todo ingresso novo lido SEM REDE caía como "código digitado" com o QR inteiro
 * no lugar do código — "fora da lista, chame o supervisor" na fila inteira do apagão.
 */
export function codigoDoQr(bruto: string): { codigo: string; eventoDoQr: string | null; digitado: boolean } {
  const partes = bruto.trim().split(':')
  if (partes.length === 5 && partes[0] === 'DT2') {
    return { codigo: partes[3], eventoDoQr: partes[2], digitado: false }
  }
  if (partes.length === 4 && partes[0] === 'DT1') {
    return { codigo: partes[2], eventoDoQr: partes[1], digitado: false }
  }
  return { codigo: bruto.trim().toUpperCase(), eventoDoQr: null, digitado: true }
}

/* ---------------------------------------------------------- a chave da lista offline
 * A lista que desce pro tablet NÃO traz o código do ingresso em claro (ADM-25). Quem pegasse o
 * aparelho levava do localStorage a lista inteira de códigos válidos, e código digitado entra
 * sem assinatura. Cada item traz `chave` = SHA-256(sal da lista + ":" + código), cortada em 96
 * bits; o sal é novo a cada descida e mora junto da lista. O leitor calcula a chave do que leu e
 * procura — a decisão continua local, sem rede, e custa microssegundos.
 *
 * É SHA-256 escrito à mão, síncrono, e não `crypto.subtle`: o tablet do parque roda em http na
 * LAN, onde o `crypto.subtle` não existe (é o mesmo motivo do `novoId`). O servidor calcula a
 * mesma chave com `node:crypto` (`chaveDoCodigo` em server/utils/catraca.ts) — o teste confere
 * que as duas batem.
 *
 * Não é cofre: com o sal no aparelho, força bruta nos ~10¹² códigos possíveis é viável pra quem
 * tem GPU. Tira o código do alcance de quem só abre o armazenamento do navegador.
 */
const K_SHA256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

/** SHA-256 de um texto (UTF-8), em hexadecimal */
export function sha256Hex(texto: string): string {
  const dados = new TextEncoder().encode(texto)
  const blocos = Math.ceil((dados.length + 9) / 64)
  const m = new Uint8Array(blocos * 64)
  m.set(dados)
  m[dados.length] = 0x80
  const dv = new DataView(m.buffer)
  const bits = dados.length * 8
  dv.setUint32(m.length - 8, Math.floor(bits / 0x1_0000_0000))
  dv.setUint32(m.length - 4, bits >>> 0)
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Uint32Array(64)
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K_SHA256[i] + w[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('')
}

/** a chave de um código na lista offline — a MESMA conta de `chaveDoCodigo` do servidor */
export function chaveDoCodigo(sal: string, codigo: string): string {
  return sha256Hex(`${sal}:${codigo.trim().toUpperCase()}`).slice(0, 24)
}

/**
 * Lista baixada há mais que isto é "antiga": ao voltar a rede, desce de novo.
 *
 * Ingresso vendido no balcão DEPOIS da descida não está no aparelho, e no
 * próximo apagão ele cai em "não está na lista". Baixar só quando a lista
 * estava vazia (era a regra) deixava o tablet com a lista da abertura do
 * portão a noite inteira.
 */
export const LISTA_VELHA_MS = 15 * 60_000

/** de quanto em quanto tempo o leitor offline tenta o servidor sozinho */
export const RETENTAR_MS = 20_000

/**
 * Status que, vindos na resposta, querem dizer "o servidor não está lá" — é
 * o proxy na frente dele respondendo. Tratados como falha de rede: a porta
 * segue pela lista do aparelho em vez de parar.
 */
const SEM_SERVIDOR = new Set([502, 503, 504])

export function statusDaFalha(e: any): number | null {
  const s = Number(e?.statusCode ?? e?.response?.status ?? e?.status ?? 0)
  return s > 0 ? s : null
}

/** `true` = a falha foi de REDE (ou do proxy sem servidor atrás): decide pela lista */
export function falhaDeRede(e: any): boolean {
  const s = statusDaFalha(e)
  return s === null || SEM_SERVIDOR.has(s)
}

/**
 * A falha do SERVIDOR vira "NÃO LIDO — tente de novo", nunca "BARRADO".
 *
 * Toda decisão sobre o INGRESSO volta com 200 (`/api/checkin` responde
 * `ok: false` com o motivo). Um erro HTTP, então, nunca é veredito: é sessão
 * vencida, permissão, dado malformado ou o servidor caindo. Pintar isso de
 * vermelho com "BARRADO" em cima fazia o porteiro mandar embora quem tinha
 * ingresso — medido com a sessão expirada: toda leitura virava "BARRADO /
 * Faça login para continuar".
 */
export function respostaDeFalha(e: any): Resposta {
  const s = statusDaFalha(e)
  const doServidor = e?.data?.statusMessage || e?.statusMessage || ''
  if (s === 401) {
    return { ok: false, resultado: 'nao_lido', entrarDeNovo: true,
             mensagem: 'Sua sessão expirou — entre de novo para continuar lendo.' }
  }
  if (s === 403) {
    return { ok: false, resultado: 'nao_lido',
             mensagem: doServidor || 'Este login não pode validar entradas. Chame o supervisor.' }
  }
  if (s !== null && s >= 500) {
    return { ok: false, resultado: 'nao_lido',
             mensagem: 'O sistema falhou ao conferir este ingresso. Leia de novo; '
               + 'se repetir, chame o supervisor.' }
  }
  return { ok: false, resultado: 'nao_lido',
           mensagem: doServidor
             ? `${doServidor} — leia de novo.`
             : 'Não deu pra conferir este código. Leia de novo.' }
}

/** a lista do aparelho é antiga o bastante pra descer de novo? */
export function listaVelha(listaEm: string | null, agora = Date.now()): boolean {
  if (!listaEm) return true
  const t = new Date(listaEm).getTime()
  return Number.isNaN(t) || agora - t > LISTA_VELHA_MS
}

/** "21:47" — a hora em que a lista desceu, do jeito que o porteiro fala */
export function horaDaLista(listaEm: string | null): string {
  if (!listaEm) return '—'
  const d = new Date(listaEm)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

/**
 * Offline, código que não está na lista baixada NÃO é "inválido": pode ser
 * ingresso vendido depois da descida, ou de outro evento digitado à mão. O
 * aparelho não tem como saber — quem decide é o supervisor. Âmbar, não
 * vermelho.
 */
export function respostaForaDaLista(listaEm: string | null): Resposta {
  return { local: true, ok: false, resultado: 'fora_da_lista',
           mensagem: `Não está na lista deste aparelho (baixada às ${horaDaLista(listaEm)}) `
             + '— chame o supervisor.' }
}

/**
 * O título grande do veredito — o MESMO no cartão e em cima da câmera.
 *
 * A consulta boa diz "VÁLIDO — NÃO ENTROU" (ADM-03): era "VÁLIDO", no mesmo verde e com o
 * mesmo bipe do PODE ENTRAR, e com o "Só conferir" esquecido ligado o portão deixava a fila
 * passar sem queimar ingresso nenhum — o mesmo QR entrava quantas vezes fosse lido.
 */
export function tituloDoVeredito(r: Resposta): string {
  if (r.resultado === 'nao_lido') return 'NÃO LIDO — TENTE DE NOVO'
  if (r.resultado === 'fora_da_lista') return 'CHAME O SUPERVISOR'
  if (r.foraDoDia) return 'NÃO VALE HOJE'
  if (r.consulta) {
    if (r.ok) return 'VÁLIDO — NÃO ENTROU'
    return r.resultado === 'fora_da_sessao' ? 'AINDA NÃO' : 'BARRADO'
  }
  return r.ok ? 'PODE ENTRAR' : 'BARRADO'
}

/** a cor da CONSULTA boa: roxo da marca, nunca o verde de quem entrou (ADM-03) */
export const CLASSE_CONSULTA = 'bg-grape-600 text-white'

/** a cor do cartão (e da faixa da câmera) pra ESTA resposta */
export function classeDoVeredito(r: Resposta): string {
  // dia errado (047) é parada, não "espera": vermelho, mesmo sendo `fora_da_sessao` no livro
  if (r.foraDoDia) return 'bg-erro text-white'
  if (r.consulta && r.ok) return CLASSE_CONSULTA
  return CLASSE[r.resultado] ?? 'bg-erro text-white'
}

/**
 * Passaporte de vários dias SEM REDE (ADM-04) — a mesma régua da porta online, com o que desce
 * na lista: quantos dias cobre, quais dias já usou (no fuso do parque) e em quais dias vale.
 * `null` = pode entrar. O dia de hoje é o do relógio do aparelho — o tablet está no parque.
 */
export type PassaporteLocal = {
  diasCobertos?: number; diasUsados?: string[]
  sessoes?: { inicio: string; fim: string | null }[]
  /** os dias em que ESTE aparelho já deixou passar, sem rede */
  diasAqui?: string[]
}
export function decisaoDoPassaporte(t: PassaporteLocal, agora = new Date()): Resposta | null {
  const cobre = Number(t.diasCobertos ?? 1)
  if (t.sessoes?.length) {
    const n = agora.getTime()
    const aberta = t.sessoes.some((s) => {
      const abre = new Date(s.inicio).getTime() - 2 * 3600_000
      const fecha = new Date(s.fim ?? s.inicio).getTime() + 2 * 3600_000
      return n >= abre && n <= fecha
    })
    if (!aberta) {
      return { local: true, ok: false, resultado: 'fora_da_sessao',
               mensagem: 'Este passaporte não vale neste dia/horário' }
    }
  }
  const usados = new Set([...(t.diasUsados ?? []), ...(t.diasAqui ?? [])])
  if (usados.has(diaLocal(agora))) {
    return { local: true, ok: false, resultado: 'ja_usado', mensagem: 'Este passaporte já entrou hoje' }
  }
  if (usados.size >= cobre) {
    return { local: true, ok: false, resultado: 'ja_usado',
             mensagem: `Este passaporte já usou os ${cobre} dias que cobre` }
  }
  return null
}

/**
 * A lista baixada envelhece mesmo COM rede (ADM-06): só descia na montagem e no botão, e o
 * ingresso cancelado às 11h entrava às 14h quando o 4G caía, pela foto das 8h. Com rede, a
 * lista é conferida a cada minuto e desce de novo quando passa de `LISTA_VELHA_MS`.
 */
export const CONFERIR_LISTA_A_CADA_MS = 60_000
export function precisaRenovarLista(online: boolean, listaEm: string | null, agora = Date.now()): boolean {
  return online && listaVelha(listaEm, agora)
}

/**
 * A cor de cada resultado. `nao_lido` é NEUTRA de propósito: não é sim nem
 * não, é "não sei" — e vermelho na porta quer dizer "mande embora".
 */
export const CLASSE: Record<string, string> = {
  ok: 'bg-ok text-white',
  ja_usado: 'bg-alerta text-white',
  invalido: 'bg-erro text-white',
  cancelado: 'bg-erro text-white',
  fora_da_sessao: 'bg-alerta text-white',
  evento_errado: 'bg-erro text-white',
  fora_da_lista: 'bg-alerta text-white',
  nao_lido: 'bg-tinta-suave text-white',
}

/** a bolinha do histórico da tela, com a mesma régua de cor */
export function corDoPonto(r: Resposta): string {
  if (r.consulta && r.ok) return 'bg-grape-600'
  if (r.ok) return 'bg-ok'
  if (r.resultado === 'nao_lido') return 'bg-tinta-suave'
  if (r.foraDoDia) return 'bg-erro'
  if (r.resultado === 'fora_da_lista' || r.resultado === 'ja_usado'
      || r.resultado === 'fora_da_sessao') return 'bg-alerta'
  return 'bg-erro'
}
</script>

<script setup lang="ts">
/**
 * Leitor de entrada — a tela que roda com gente na fila.
 *
 * Três decisões que vieram de como a porta funciona de verdade:
 *
 * 1. O campo de código NUNCA perde o foco. Leitor de código de barras é um
 *    teclado: ele digita e dá Enter. Se o foco escapar pra outro lugar (um
 *    clique, um alerta), a próxima leitura some no vazio e o operador só
 *    descobre quando a fila para.
 *
 * 2. A resposta é GRANDE e colorida. Quem opera olha a tela de relance com o
 *    celular na mão; um texto de 14px dizendo "já usado" não é lido a tempo.
 *
 * 3. "Só conferir" existe porque perguntar é diferente de deixar entrar. O
 *    operador precisa poder checar um ingresso sem queimá-lo.
 *
 * ## E a quarta, que muda o resto: o 4G cai
 *
 * O parque fica na Bahia. Quando a rede some, o portão não pode parar — e é
 * por isso que esta tela guarda três coisas no próprio aparelho:
 *
 *   • a LISTA de ingressos do evento, baixada quando havia rede;
 *   • a FILA das passagens que aconteceram sem rede;
 *   • o ID DO APARELHO, que é o que explica depois por que o mesmo ingresso
 *     entrou por dois portões.
 *
 * Com rede, nada muda: quem decide é o servidor, que é o único que enxerga os
 * dois portões ao mesmo tempo. Sem rede, a decisão é local, contra a lista, e
 * a passagem entra na fila com um `id` criado AQUI. Esse id é o que faz a
 * sincronização ser idempotente: mandar a mesma fila duas vezes não conta a
 * pessoa duas vezes (`ON CONFLICT (id) DO NOTHING`, em utils/catraca.ts).
 *
 * O que esta tela NÃO faz: fingir que está online. Toda resposta decidida
 * localmente vem marcada como tal, porque a diferença importa — "pode entrar
 * (offline)" quer dizer "ainda não foi conferido com os outros portões".
 */
definePageMeta({
  layout: 'admin',
  // 30/09: o endereço curto do porteiro. `/portaria/<id>` é ESTA tela, na moldura da portaria
  // (sem a lateral do painel) — a lista de eventos com os números mora em `/portaria`.
  alias: '/portaria/:id',
  middleware: [async (para) => {
    if (!para.path.startsWith('/portaria/')) return
    setPageLayout('portaria')
    // o `admin.global` só guarda /admin: aqui a guarda é esta. Só volta pro login quando o
    // SERVIDOR diz que não há sessão — sem rede, a portaria segue com o que o aparelho já tem.
    const { data } = await useFetch<any>('/api/auth/eu', { key: 'auth-eu' })
    if (data.value && !data.value.usuario) return navigateTo('/portaria')
  }],
})

const route = useRoute()
const id = route.params.id as string
/** aberta pelo endereço da portaria (`/portaria/<id>`): sem as abas do painel */
const naPortaria = route.path.startsWith('/portaria/')
// na portaria o título é o NOME do evento (sem as abas, a tela não dizia qual era); vem da mesma
// lista que o porteiro acabou de tocar — só id, nome e números
const { data: destinoDaPortaria } = useFetch<{ eventos: { id: string; nome: string }[] }>('/api/portaria/destino',
  { key: 'portaria-destino-nome', server: false, immediate: naPortaria })
const nomeNaPortaria = computed(() => destinoDaPortaria.value?.eventos.find((e) => e.id === id)?.nome ?? '')

const codigo = ref('')
const gate = ref('')
const apenasConsultar = ref(false)
const lendo = ref(false)
const campo = ref<HTMLInputElement | null>(null)
/**
 * Dois jeitos de ler, os mesmos do app da Funz: "campo" (coletor — leitor USB ou
 * Bluetooth digita o código e dá Enter) e "câmera" (o celular lê o QR). Os dois
 * caem na mesma `ler()`, então a decisão é uma só.
 */
const modoCamera = ref(false)
/** no celular, portão e "só conferir" ficam atrás de "Mais opções" — a tela da porta é câmera + números */
const maisOpcoes = ref(false)
/** no celular o veredito sobe por cima da câmera; "OK, próximo" tira ele da frente (volta na próxima leitura) */
const vereditoFechado = ref(false)

/*
 * `Meia`, `Publico` e `Resposta` moram no <script> de cima, junto das
 * decisões puras. Sobre a meia (migração 015): `motivo` é `string | null` e o
 * `null` é o caso NORMAL — medido em 21/09, 23 dos 23 ingressos de meia do
 * evento estão sem motivo declarado. É essa distinção que abre os dois blocos
 * diferentes lá embaixo.
 */
const ultima = ref<Resposta | null>(null)
watch(ultima, () => { vereditoFechado.value = false })
const historico = ref<(Resposta & { codigo: string; quando: Date })[]>([])

// o `key` é o do layout e das abas: a mesma resposta, sem outra ida ao servidor
const { data: eu } = await useFetch<any>('/api/auth/eu', { key: 'auth-eu' })
const veLog = computed(() => pedeOLogDeLeituras(eu.value?.usuario?.papel, id))
const { data, refresh: recarregarLog } = await useFetch<any>(`/api/admin/evento/${id}/checkins`,
  { immediate: veLog.value })
/** repinta o log de leituras — só pra quem pode lê-lo (ver `pedeOLogDeLeituras`) */
function refresh() {
  if (veLog.value) void recarregarLog()
}

/* ----------------------------------------------------------- estado offline */

type IngressoLocal = {
  /** a chave do código (ADM-25); lista guardada por versão anterior traz `codigo` em claro */
  chave?: string; codigo?: string
  status: string; titular: string | null
  setor: string; lote: string; tipo: string | null; pessoas: number
  /** a meia desce com a lista: é no apagão que o operador mais precisa dela */
  meia?: Meia | null
  sessaoInicio: string | null; sessaoFim: string | null
  /** dias de uso do tipo (047), 'AAAA-MM-DD'; ausente = qualquer dia */
  diasDeUso?: string[]
  /** troca de dia sem rede (049): o tipo comprado e quanto custou a face */
  tipoId?: string | null; pagoCents?: number; pessoasDoTipo?: number
  /** combo (050): a parte `seq` de `tamanho` do grupo — sem rede o portão libera as irmãs */
  combo?: { grupo: string; seq: number; tamanho: number }
  /** marcado por ESTE aparelho enquanto estava sem rede */
  usadoAqui?: { em: string; gate: string | null }
} & PassaporteLocal
type Passagem = { id: string; qr: string; gate: string | null; em: string; offline: boolean
  /** troca de dia cobrada sem rede (049) — sobe na sincronização junto da passagem */
  troca?: { tipoId: string; forma: FormaDeTroca; cobradoCents: number; tipoNome: string }
  /** combo (050): a passagem é da pessoa k do combo do QR lido */
  parte?: number }

const CHAVE_LISTA = `dt_portaria_lista_${id}`
const CHAVE_FILA = `dt_portaria_fila_${id}`
const CHAVE_APARELHO = 'dt_portaria_aparelho'
/** lido no setup: depois de um await o Nuxt já não sabe de qual app é o useRuntimeConfig */
const VERSAO_DO_APP = String(useRuntimeConfig().app?.buildId ?? '')

const lista = ref<IngressoLocal[]>([])
const listaEm = ref<string | null>(null)
/** o sal da lista baixada — sem ele, a lista é de uma versão antiga, com o código em claro */
const salDaLista = ref<string | null>(null)
const fila = ref<Passagem[]>([])
const aparelho = ref('')
const online = ref(true)
const sincronizando = ref(false)
const baixando = ref(false)
const avisoLocal = ref('')
/**
 * O retrato do público — UM objeto, vindo de UMA consulta
 * (`retratoDoPublico`/`SQL_PUBLICO`, em server/utils/catraca.ts).
 *
 * Os três cards de cima saíam de dois lugares e se contradiziam na cara do
 * operador: "Pessoas dentro = 2 (em 2 passagens)" ao lado de "Já entraram = 0
 * (de 392 aptos)" e "Comparecimento = 0%". Um contava o LIVRO de passagens
 * (`entries`) e os outros dois contavam o carimbo do ingresso
 * (`tickets.status = 'usado'`), que é trava e não ledger — ele volta atrás em
 * cancelamento e nunca existiu para a passagem retroativa da migração 013.
 *
 * Agora os três leem daqui. Sem rede eles mostram "—" juntos: não saber é
 * honesto, discordar não.
 *
 * Quem escreve aqui são os DOIS caminhos que falam com o servidor: a
 * sincronização (`sincronizar`) e cada leitura registrada (`ler`). Ficar só na
 * sincronização foi um furo medido em 21/09: com rede boa ela roda uma vez, na
 * montagem, e os três números congelavam na abertura da tela enquanto a porta
 * seguia deixando gente entrar — servidor com `pessoas = 1`, tela mostrando
 * `0`. O quarto card (do log do leitor) continuava andando ao lado, que é a
 * discordância de sempre por outro caminho.
 */
const publico = ref<Publico | null>(null)
/** aparelho que sincronizou com o relógio fora da janela do evento */
const avisoRelogio = ref<{ passagens: number; dispositivo: string | null
                           motivo: string; piorEnviado: string | null } | null>(null)
const conflitos = ref<any[]>([])
const swPronto = ref<'sim' | 'nao' | 'indisponivel'>('indisponivel')
/**
 * O servidor cortou a lista no teto — a contagem abaixo fica parcial.
 *
 * Mora GUARDADO junto com a lista (`CHAVE_LISTA`), e não só em memória, porque
 * a marca e a lista são a mesma informação: uma lista cortada continua cortada
 * depois do F5, e este é o único leitor do sistema feito pra **reabrir sem
 * rede** — quando isso acontece, `sincronizar()` não roda e nada redescobre o
 * corte. Em memória, a faixa voltava dizendo "N de M meias deste evento" sobre
 * um pedaço do evento, sem o aviso de parcial: número incompleto que se
 * apresenta como completo é exatamente o que ela existe pra não fazer.
 */
const listaTruncada = ref(false)
/** os tipos com o preço de quando a lista desceu — a conta da troca de dia sem rede (049) */
const tiposDaTroca = ref<TipoParaTroca[]>([])

/** A lista e a marca de corte viajam juntas pro localStorage — ver acima. */
function guardarLista() {
  guardar(CHAVE_LISTA, {
    em: listaEm.value, truncada: listaTruncada.value, sal: salDaLista.value, ingressos: lista.value,
    tiposDaTroca: tiposDaTroca.value,
  })
}

const mapa = computed(() => {
  const m = new Map<string, IngressoLocal>()
  for (const i of lista.value) m.set(i.chave ?? i.codigo ?? '', i)
  return m
})
/** onde procurar um código na lista deste aparelho */
const chaveLocal = (codigo: string, sal: string | null = salDaLista.value) =>
  sal ? chaveDoCodigo(sal, codigo) : codigo.trim().toUpperCase()

/**
 * Quantas meias deste evento vão chegar na porta sem dizer por quê.
 *
 * Contado na LISTA baixada, e não numa segunda consulta ao servidor, por dois
 * motivos que apontam pro mesmo lugar:
 *
 *  • é a mesma régua — cada item da lista traz o `meia` calculado pelo mesmo
 *    `meiaDoIngresso` que a porta online usa (server/utils/catraca.ts). Uma
 *    contagem própria aqui seria a segunda definição de "meia sem motivo", e
 *    é assim que duas telas passam a mostrar números diferentes da mesma coisa;
 *  • é exatamente o conjunto que ESTE portão vai validar no apagão. Um total
 *    vindo do banco diria um número que o aparelho na mão do operador não
 *    tem como cumprir.
 *
 * O número existe pro PRODUTOR, não pro operador: é ele que decide se manda
 * avisar na bilheteria, e é ele que precisa saber que ninguém inventou motivo
 * pros ingressos antigos. Fica parcial e DIZ que está parcial quando o servidor
 * cortou a lista — número incompleto que se apresenta como completo é como o
 * produtor toma decisão errada achando que está informado.
 */
const meiasDoEvento = computed(() => {
  let total = 0
  let semMotivo = 0
  for (const i of lista.value) {
    if (!i.meia) continue
    total++
    if (!i.meia.motivo) semMotivo++
  }
  return { total, semMotivo, parcial: listaTruncada.value }
})

/** uuid mesmo fora de contexto seguro — tablet do parque roda em http na LAN,
 *  e ali `crypto.randomUUID` não existe. Sem id não há idempotência. */
function novoId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  } catch { /* segue pro plano B */ }
  const h = '0123456789abcdef'
  let s = ''
  for (let i = 0; i < 36; i++) {
    s += i === 8 || i === 13 || i === 18 || i === 23 ? '-'
      : i === 14 ? '4'
      : i === 19 ? h[8 + Math.floor(Math.random() * 4)]
      : h[Math.floor(Math.random() * 16)]
  }
  return s
}

function guardar(chave: string, valor: unknown) {
  try { localStorage.setItem(chave, JSON.stringify(valor)) } catch (e: any) {
    // Cota estourada com 20 mil ingressos é possível. O operador precisa saber
    // AGORA, não descobrir no apagão — uma fila que não persiste some no F5.
    avisoLocal.value = 'Não foi possível guardar os dados no aparelho '
      + '(memória do navegador cheia). Sem rede, este leitor não vai funcionar.'
  }
}
function recuperar<T>(chave: string, padrao: T): T {
  try {
    const cru = localStorage.getItem(chave)
    return cru ? JSON.parse(cru) as T : padrao
  } catch { return padrao }
}

/* ------------------------------------------------------------- ciclo de vida */

// Gate fica no navegador: é propriedade do PORTÃO, não do usuário. O mesmo
// login opera a portaria norte hoje e a sul amanhã, e o servidor não tem como
// adivinhar em qual das duas aquele tablet está.
onMounted(async () => {
  gate.value = localStorage.getItem(`dt_gate_${id}`) ?? ''

  aparelho.value = localStorage.getItem(CHAVE_APARELHO) ?? ''
  if (!aparelho.value) {
    aparelho.value = novoId().slice(0, 8)
    try { localStorage.setItem(CHAVE_APARELHO, aparelho.value) } catch { /* aba anônima */ }
  }

  const guardada = recuperar<
    { em: string; truncada?: boolean; sal?: string | null; ingressos: IngressoLocal[]
      tiposDaTroca?: TipoParaTroca[] } | null>(CHAVE_LISTA, null)
  if (guardada) {
    lista.value = guardada.ingressos
    tiposDaTroca.value = Array.isArray(guardada.tiposDaTroca) ? guardada.tiposDaTroca : []
    listaEm.value = guardada.em
    salDaLista.value = guardada.sal ?? null
    // Lista guardada por uma versão anterior não tem a marca: fica `false`,
    // que é o que a tela já fazia. A próxima descida da lista corrige.
    listaTruncada.value = Boolean(guardada.truncada)
  }
  fila.value = recuperar<Passagem[]>(CHAVE_FILA, [])

  online.value = navigator.onLine
  window.addEventListener('online', aoVoltarRede)
  window.addEventListener('offline', () => { online.value = false })

  await registrarWorker()
  if (online.value) sincronizar({ comLista: true })

  campo.value?.focus()

  // A escolha salva vence. Sem ela, celular/tablet (dedo, não mouse) abre JÁ na câmera: é o que o
  // porteiro usa; o campo segue embaixo pro leitor de código de barras e pro código digitado.
  try {
    const salvo = localStorage.getItem('dt_modo_leitura')
    modoCamera.value = salvo ? salvo === 'camera' : window.matchMedia('(pointer: coarse)').matches
  } catch { /* aba anônima */ }
  // Aquece o decodificador de reserva do QR enquanto ainda há rede: o service
  // worker guarda o pedaço, e a câmera abre mesmo que o 4G caia depois.
  if (!('BarcodeDetector' in window)) import('jsqr').catch(() => {})
})

onBeforeUnmount(() => {
  window.removeEventListener('online', aoVoltarRede)
  clearInterval(timerDeReconexao)
  clearInterval(timerDaLista)
})

/**
 * Com rede, a lista do aparelho não pode envelhecer (ADM-06): a cada minuto confere a idade e,
 * passada de `LISTA_VELHA_MS`, desce de novo — em segundo plano, sem segurar leitura nenhuma.
 */
let timerDaLista: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timerDaLista = setInterval(() => {
    if (precisaRenovarLista(online.value, listaEm.value) && !sincronizando.value) {
      void sincronizar({ comLista: true })
    }
  }, CONFERIR_LISTA_A_CADA_MS)
})

/** lista vazia OU antiga desce de novo junto com a volta da rede */
const precisaBaixarLista = () => lista.value.length === 0 || listaVelha(listaEm.value)

function aoVoltarRede() {
  // Não marca `online` aqui: o navegador dizer que tem rede não é o servidor
  // responder. Quem liga o online é a sincronização que der certo.
  void sincronizar({ comLista: precisaBaixarLista() })
}

/* ------------------------------------------------ volta sozinho pro online */
/**
 * Uma falha de rede deixava o leitor offline até alguém recarregar a página:
 * `online` virava `false` e nada o trazia de volta — o evento `online` do
 * navegador não dispara quando quem caiu foi o SERVIDOR (ou o 4G voltou sem
 * o aparelho ter percebido que tinha saído). A porta passava a noite
 * decidindo pela lista com a rede de pé.
 *
 * Agora, enquanto estiver offline, o leitor tenta o servidor a cada
 * `RETENTAR_MS` e também a cada leitura (sem segurar a fila, ver `ler`). A
 * tentativa é a própria sincronização: sobe a fila, traz o retrato do
 * público, e baixa a lista de novo se ela for antiga.
 */
let timerDeReconexao: ReturnType<typeof setInterval> | undefined
const ultimaTentativa = ref<Date | null>(null)

async function tentarReconectar() {
  if (online.value || sincronizando.value) return
  // o navegador SABE que está sem rede: nem tenta, o evento `online` avisa
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  ultimaTentativa.value = new Date()
  await sincronizar({ comLista: precisaBaixarLista() })
}

watch(online, (v) => {
  if (v) {
    clearInterval(timerDeReconexao)
    timerDeReconexao = undefined
  } else if (!timerDeReconexao) {
    timerDeReconexao = setInterval(() => { void tentarReconectar() }, RETENTAR_MS)
  }
})

watch(gate, (v) => {
  try { localStorage.setItem(`dt_gate_${id}`, v) } catch { /* aba anônima */ }
})

/**
 * O service worker é o que faz a PÁGINA abrir sem rede — sem ele, o F5 no
 * meio do apagão mostra a tela de erro do navegador e some com tudo.
 * Registrar pode falhar (http sem TLS fora de localhost, navegador antigo,
 * modo anônimo): isso não pode derrubar o leitor, só muda o que a faixa de
 * estado promete.
 */
async function registrarWorker() {
  if (!('serviceWorker' in navigator)) { swPronto.value = 'indisponivel'; return }
  try {
    // a versão do build na URL: cada deploy é um worker novo, com cache novo (o velho é apagado)
    const reg = await navigator.serviceWorker.register(`/sw-portaria.js?v=${VERSAO_DO_APP}`)
    reg.update?.().catch(() => {})
    swPronto.value = 'sim'
  } catch {
    swPronto.value = 'nao'
  }
}

/* ------------------------------------------------------------------ leitura */


/**
 * A decisão sem servidor. Confere contra a lista baixada — que é uma prova
 * mais forte que a assinatura do QR, porque além de dizer que o ingresso é
 * legítimo diz de qual evento ele é e em que estado está. A chave que assina
 * o QR não sai do servidor, então conferir assinatura aqui seria impossível
 * de qualquer jeito.
 */
/**
 * O ingresso da lista deste aparelho — o do QR, ou (combo, 050) a parte `parte` do mesmo combo do QR.
 */
function ingressoLocalDe(bruto: string, parte?: number): IngressoLocal | undefined {
  const t = mapa.value.get(chaveLocal(codigoDoQr(bruto).codigo))
  if (!parte) return t
  if (!t?.combo) return undefined
  return lista.value.find((x) => x.combo?.grupo === t.combo!.grupo && x.combo.seq === parte)
}

/** as partes do combo como a lista deste aparelho as vê (o que passou aqui conta como usado) */
function comboLocal(t: IngressoLocal): ComboDaPorta | undefined {
  if (!t.combo) return undefined
  const partes = lista.value.filter((x) => x.combo?.grupo === t.combo!.grupo)
    .map((x) => ({ seq: x.combo!.seq, status: x.usadoAqui && x.status === 'valido' ? 'usado' : x.status }))
    .sort((a, b) => a.seq - b.seq)
  return { seq: t.combo.seq, tamanho: t.combo.tamanho, partes }
}

function validarLocal(bruto: string, idPassagem: string = novoId(),
                      consultar: boolean = apenasConsultar.value, parte?: number): Resposta {
  const r = validarLocalSemCombo(bruto, idPassagem, consultar, parte)
  const t = ingressoLocalDe(bruto, parte)
  const combo = t ? comboLocal(t) : undefined
  return combo ? { ...r, combo } : r
}

function validarLocalSemCombo(bruto: string, idPassagem: string, consultar: boolean, parte?: number): Resposta {
  const { codigo: cod, eventoDoQr } = codigoDoQr(bruto)
  const base = { local: true, ok: false }

  // O QR diz de qual evento ele é, e isso não depende de lista nenhuma: vem
  // ANTES da checagem de lista vazia. Offline, o QR de outro evento dizia
  // "inválido" (ou "sem lista"), e o servidor, com rede, diz "outro evento".
  if (eventoDoQr && eventoDoQr !== id) {
    return { ...base, resultado: 'evento_errado', mensagem: 'Ingresso é de outro evento' }
  }
  // Sem lista o aparelho não sabe nada — isso é "não deu pra conferir", não
  // "barrado": o ingresso pode ser perfeitamente bom.
  if (!lista.value.length) {
    return { ...base, resultado: 'nao_lido',
             mensagem: 'Sem rede e sem lista baixada neste aparelho — não dá pra conferir. '
               + 'Chame o supervisor.' }
  }

  const t = parte ? ingressoLocalDe(bruto, parte) : mapa.value.get(chaveLocal(cod))
  // Fora da lista baixada não é prova de fraude: pode ser venda de depois da
  // descida, ou código de outro evento digitado à mão. Âmbar e supervisor.
  if (!t) return respostaForaDaLista(listaEm.value)
  if (t.status === 'cancelado') {
    return { ...base, resultado: 'cancelado', mensagem: 'Ingresso cancelado' }
  }
  // Passaporte de vários dias: `usadoAqui` é de UM dia, não do ingresso (ADM-04)
  const passaporte = Number(t.diasCobertos ?? 1) > 1
  if (t.status === 'usado' || (t.usadoAqui && !passaporte)) {
    return { ...base, resultado: 'ja_usado', mensagem: 'Ingresso já foi usado — não pode ser usado novamente',
             titular: t.titular, entrouEm: t.usadoAqui?.em ?? null,
             portao: t.usadoAqui?.gate ?? null }
  }
  if (passaporte) {
    const barrado = decisaoDoPassaporte(t)
    if (barrado && !consultar) {
      return { ...barrado, titular: t.titular, entrouEm: t.usadoAqui?.em ?? null,
               portao: t.usadoAqui?.gate ?? null }
    }
  }
  let foraDaSessao = false
  if (t.sessaoInicio) {
    // a mesma folga de 2h do servidor: chegar cedo é normal
    const agora = Date.now()
    const abre = new Date(t.sessaoInicio).getTime() - 2 * 3600_000
    const fecha = new Date(t.sessaoFim ?? t.sessaoInicio).getTime() + 2 * 3600_000
    foraDaSessao = agora < abre || agora > fecha
  }

  // A meia sai da lista baixada, igual ao resto: sem rede o operador continua
  // precisando saber QUAL papel pedir, e é justamente no apagão que ele não
  // tem como perguntar a ninguém.
  const dados = { titular: t.titular, setor: t.setor, lote: t.lote, tipo: t.tipo,
                  meia: t.meia ?? null }

  // Dia de uso do tipo (047), a mesma régua da porta online: o ingresso de sexta não passa no
  // domingo. O dia é o do relógio do aparelho — o tablet está no parque.
  if (!valeNoDiaDeUso(t.diasDeUso, diaLocal())) {
    // troca de dia (049): a MESMA conta do servidor, com os preços da lista baixada
    const hoje = diaLocal()
    const pagoCents = Math.max(0, Number(t.pagoCents ?? 0))
    const troca = passaporte || !tiposDaTroca.value.length ? undefined
      : { hoje, pagoCents, pessoas: Number(t.pessoas ?? 1),
          opcoes: opcoesDeTroca({ tipo: t.tipo, pessoas: Number(t.pessoas ?? 1),
            pessoasDoTipo: Number(t.pessoasDoTipo ?? t.pessoas ?? 1), pagoCents }, tiposDaTroca.value, hoje) }
    return { local: true, ok: false, resultado: 'fora_da_sessao', foraDoDia: true, diasDeUso: t.diasDeUso ?? null,
             mensagem: mensagemForaDoDiaDeUso(t.diasDeUso), ingresso: dados, troca,
             ...(consultar ? { consulta: true } : {}) }
  }

  // Mesma regra do servidor (`/api/checkin`): a consulta responde SEMPRE, com
  // os dados do ingresso, e diz se o horário ainda não chegou. As duas portas
  // precisam responder igual — offline, a pergunta "o que este cliente precisa
  // trazer?" é a única que o operador ainda consegue resolver sozinho.
  if (consultar) {
    return { local: true, ok: !foraDaSessao,
             resultado: foraDaSessao ? 'fora_da_sessao' : 'ok',
             mensagem: foraDaSessao
               ? 'Ainda não é o horário desta sessão — mas o ingresso é válido'
               : 'Válido (não marcado)',
             consulta: true, ingresso: dados }
  }

  if (foraDaSessao) {
    return { ...base, resultado: 'fora_da_sessao', mensagem: 'Fora do horário desta sessão' }
  }

  // Passou: entra na fila com id criado AQUI, e o ingresso fica marcado no
  // aparelho pra que o mesmo QR não passe duas vezes NESTE portão. Os outros
  // portões só saberão quando a rede voltar — e aí o servidor mostra o
  // conflito em vez de escondê-lo.
  const em = new Date().toISOString()
  t.usadoAqui = { em, gate: gate.value || null }
  if (passaporte) t.diasAqui = [...new Set([...(t.diasAqui ?? []), diaLocal(new Date(em))])]
  fila.value = [...fila.value, { id: idPassagem, qr: bruto.trim(), gate: gate.value || null,
                                 em, offline: true, ...(parte ? { parte } : {}) }]
  guardar(CHAVE_FILA, fila.value)
  guardarLista()

  return { local: true, ok: true, resultado: 'ok', mensagem: 'Liberado (sem rede)',
           pessoas: t.pessoas, ingresso: dados }
}

/**
 * Leitura COM rede também marca a lista do aparelho (dono, 05/10: "estar preparado pra todas as
 * variáveis"). Antes só a leitura offline marcava: quem entrou às 10h com rede e voltou ao portão
 * às 10h05, com a internet caída, passava de novo — a lista do aparelho ainda dizia "válido" até a
 * próxima descida (15 min). Agora o que o servidor decidiu fica escrito aqui na hora.
 */
function marcarNaListaDoAparelho(bruto: string, r: Resposta | null, parte?: number) {
  if (!r || r.consulta || !lista.value.length) return
  const t = ingressoLocalDe(bruto, parte)
  if (!t) return
  if (r.ok) {
    const em = new Date().toISOString()
    t.usadoAqui = { em, gate: gate.value || null }
    if (Number(t.diasCobertos ?? 1) > 1) t.diasAqui = [...new Set([...(t.diasAqui ?? []), diaLocal(new Date(em))])]
  } else if (r.resultado === 'ja_usado' && Number(t.diasCobertos ?? 1) <= 1) {
    t.status = 'usado'
  } else if (r.resultado === 'cancelado') {
    t.status = 'cancelado'
  } else return
  guardarLista()
}

/** aviso debaixo do campo — código curto demais nem sai do aparelho */
const avisoCodigo = ref('')
watch(codigo, () => { avisoCodigo.value = '' })

async function ler() {
  const c = codigo.value.trim()
  if (!c || lendo.value) return
  // O servidor recusa menos de 4 caracteres com 400 ("Dados inválidos"), que
  // chegava na porta como veredito. É erro de digitação: avisa aqui, mantém o
  // que foi digitado pra corrigir, e não gasta rede nem vira leitura.
  if (c.length < MINIMO_DO_CODIGO) {
    avisoCodigo.value = `Código curto demais (${c.length} ${c.length === 1 ? 'caractere' : 'caracteres'}). `
      + 'Confira o ingresso e digite o código inteiro.'
    nextTick(() => campo.value?.focus())
    return
  }
  lendo.value = true
  // "Só conferir" vale UMA leitura (ADM-03): ficava ligado entre leituras e o portão seguia
  // respondendo VÁLIDO sem queimar ingresso — o mesmo QR entrava de novo, inclusive passado
  // pela grade pra outra pessoa. A escolha é lida AGORA e desligada no fim desta leitura.
  const consultar = apenasConsultar.value
  /**
   * UM id por passagem FÍSICA, criado antes de saber se vai ter rede.
   *
   * Online, é ele que o servidor grava no livro (`entradaId`). Se a resposta
   * morrer no caminho — o 4G do parque cai entre o INSERT e o recibo — a
   * decisão cai pro aparelho, e é o MESMO id que vai pra fila. Aí a
   * sincronização bate no `ON CONFLICT (id) DO NOTHING` e devolve `repetida`:
   * uma pessoa, uma linha.
   *
   * Com dois ids diferentes pra mesma passagem (era assim: um `novoId()` no
   * `entradaId` e outro dentro de `validarLocal`) o `ON CONFLICT` nunca
   * dispara. Medido contra o servidor: uma mesa de 4 lida uma vez virou
   * **8 pessoas** no relatório de público, e o cliente apareceu no painel
   * "entradas repetidas" como se tivesse fraudado a catraca. Nada lança
   * exceção, nada aparece no console — só o número fica errado.
   */
  const idPassagem = novoId()
  try {
    if (!online.value) {
      ultima.value = validarLocal(c, idPassagem, consultar)
      // "Tentar de novo na próxima leitura" SEM segurar a fila: a decisão
      // desta pessoa já saiu pela lista, e a volta ao servidor corre por
      // fora. Se a rede voltou, a próxima leitura já vai online — e esta
      // passagem sobe junto, na fila.
      void tentarReconectar()
    } else {
      try {
        ultima.value = await $fetch<Resposta>('/api/checkin', {
          method: 'POST',
          body: { qr: c, eventId: id, gate: gate.value || undefined,
                  apenasConsultar: consultar,
                  entradaId: idPassagem, deviceId: aparelho.value },
        })
        // O retrato do público vem DENTRO da resposta da porta (o mesmo
        // `SQL_PUBLICO` da sincronização), então os três cards do topo andam a
        // cada leitura sem uma segunda ida à rede — que num portão com 4G ruim
        // é justamente o que não dá pra gastar. A consulta ("só conferir") não
        // traz retrato: ela não mexe em nada.
        if (ultima.value?.publico) publico.value = ultima.value.publico
        marcarNaListaDoAparelho(c, ultima.value)
        // Só repinta os contadores quando alguém realmente entrou — recontar a
        // cada leitura recusada bate no banco no pior momento possível.
        if (ultima.value?.ok && !ultima.value.consulta) refresh()
      } catch (e: any) {
        // Só a FALHA DE REDE (sem status, ou o proxy dizendo que não há
        // servidor atrás) vira validação local. O resto é o servidor no ar
        // respondendo erro — e erro não é veredito sobre o ingresso: vira
        // "NÃO LIDO", em cor neutra, com o motivo (ver `respostaDeFalha`).
        if (!falhaDeRede(e)) {
          ultima.value = respostaDeFalha(e)
        } else {
          online.value = false
          // MESMO id da tentativa online: o servidor pode ter gravado antes de
          // a resposta se perder, e é o id que decide se isto é a mesma pessoa
          // ou uma segunda.
          ultima.value = validarLocal(c, idPassagem, consultar)
        }
      }
    }
    if (ultima.value) {
      // Código digitado não tem a assinatura do QR (ADM-25): quem sabe um código de cabeça — ou o
      // leu de uma lista — entra por ele. A porta não trava (a câmera pode ter quebrado e a fila
      // anda), mas o veredito pede pra conferir o documento de quem está passando.
      ultima.value = { ...ultima.value, digitado: codigoDoQr(c).digitado }
      ultimoBruto.value = c
      historico.value.unshift({ ...ultima.value, codigo: c, quando: new Date() })
      historico.value = historico.value.slice(0, 12)
    }
  } finally {
    if (consultar) apenasConsultar.value = false
    codigo.value = ''
    lendo.value = false
    // nextTick: o input só volta a existir depois do repintar
    nextTick(() => campo.value?.focus())
  }
}

/* ------------------------------------------------------- troca de dia (049) */
/*
 * Dono, 08/10: "e se aparecer alguém com ingresso de sábado pra entrar domingo? ... bloquear, mas se
 * a pessoa quiser entrar, ela faz o pagamento lá na hora, o valor da diferença, e aí ela entra";
 * "lembrando que é Android" e "a internet pode cair".
 *
 * O veredito continua NÃO VALE HOJE. Embaixo, "Cobrar diferença e liberar": o porteiro escolhe o
 * tipo de hoje (o irmão do comprado já vem marcado), como a pessoa pagou, e confirma o valor que
 * recebeu. Com rede, quem decide é o servidor (preço de agora); sem rede, o aparelho faz a MESMA conta
 * com a lista baixada, libera e a troca sobe na fila com o MESMO id da passagem — reenviar não cobra
 * duas vezes. Enquanto o painel está aberto a câmera pausa: a leitura seguinte não pode apagar a
 * cobrança no meio.
 */
const ultimoBruto = ref('')
const trocaAberta = ref(false)
const trocaTipo = ref<string | null>(null)
const trocaForma = ref<FormaDeTroca | null>(null)
const trocando = ref(false)
const trocaErro = ref('')
/**
 * Dono, 08/10: "leu o ingresso tem que perguntar ... sempre que for dia diferente tem que ter
 * certeza" — até sem diferença (o de R$ 40 entrando no dia de R$ 30). O liberar abre a pergunta; só o
 * "Sim" grava. Uma pergunta por toque: trocar o tipo ou a forma fecha a pergunta.
 */
const trocaPerguntando = ref(false)
const perguntaDaTroca = computed(() => {
  const r = ultima.value
  const o = opcaoDaTroca.value
  if (!r?.troca || !o) return null
  const doIngresso = fraseDosDiasDeUso(r.diasDeUso) || 'outro dia'
  const hoje = r.troca.hoje ? rotuloDoDiaDeUso(r.troca.hoje) : 'hoje'
  const quantas = r.combo ? trocaQuantas.value : 1
  const pessoas = quantas > 1 ? `${quantas} pessoas deste combo: ` : ''
  const cobranca = o.diferencaCents > 0
    ? `cobrar ${reaisDaTroca(o.diferencaCents * quantas)} (${trocaForma.value ? ROTULO_DA_FORMA[trocaForma.value].toLowerCase() : '—'})`
    : 'sem cobrança — a diferença não é devolvida'
  return { doIngresso, hoje, quantas, cobranca: (pessoas + cobranca).replace(/^./, (c) => c.toUpperCase()) }
})
const opcaoDaTroca = computed(() =>
  ultima.value?.troca?.opcoes.find((o) => o.tipoId === trocaTipo.value) ?? null)
const podeTrocar = computed(() => {
  const r = ultima.value
  return !!r && !!r.foraDoDia && !r.consulta && !!r.troca
})

watch(ultima, (r, antes) => {
  // a resposta nova de uma troca recusada (409 com a conta nova) mantém o painel aberto
  if (r && antes && r.troca && antes.troca && r !== antes && r.foraDoDia && antes.foraDoDia && trocaAberta.value) {
    if (!r.troca.opcoes.some((o) => o.tipoId === trocaTipo.value)) trocaTipo.value = r.troca.opcoes[0]?.tipoId ?? null
    return
  }
  trocaAberta.value = false
  trocaPerguntando.value = false
  trocaForma.value = null
  trocaErro.value = ''
  trocaTipo.value = r?.troca?.opcoes[0]?.tipoId ?? null
})
watch([trocaTipo, trocaForma], () => { trocaPerguntando.value = false })

function abrirTroca() {
  trocaErro.value = ''
  trocaAberta.value = true
}
/** o primeiro toque em liberar só pergunta; o "Sim" é que grava */
function perguntarTroca() {
  const opcao = opcaoDaTroca.value
  if (!opcao || trocando.value) return
  if (opcao.diferencaCents > 0 && !trocaForma.value) { trocaErro.value = 'Escolha como a pessoa pagou a diferença.'; return }
  trocaErro.value = ''
  trocaPerguntando.value = true
}
function fecharTroca() {
  trocaPerguntando.value = false
  trocaAberta.value = false
  trocaForma.value = null
  trocaErro.value = ''
}

/** libera pelo aparelho, sem rede: a mesma marca da leitura offline, com a troca na fila */
function trocarSemRede(r0: Resposta, idPassagem: string, opcao: OpcaoDeTroca, forma: FormaDeTroca,
                       parte?: number): boolean {
  const bruto = ultimoBruto.value
  const t = ingressoLocalDe(bruto, parte)
  if (!t) { trocaErro.value = 'Este ingresso não está na lista do aparelho — chame o supervisor.'; return false }
  if (t.status === 'usado' || t.status === 'cancelado' || t.usadoAqui) {
    trocaErro.value = t.status === 'cancelado' ? 'Ingresso cancelado — não dá pra liberar.'
      : 'Este ingresso já passou por este aparelho — não cobre de novo.'
    return false
  }
  const em = new Date().toISOString()
  t.usadoAqui = { em, gate: gate.value || null }
  fila.value = [...fila.value, { id: idPassagem, qr: bruto.trim(), gate: gate.value || null, em, offline: true,
                                 troca: { tipoId: opcao.tipoId, forma, cobradoCents: opcao.diferencaCents,
                                          tipoNome: opcao.nome }, ...(parte ? { parte } : {}) }]
  guardar(CHAVE_FILA, fila.value)
  guardarLista()
  ultima.value = {
    local: true, ok: true, resultado: 'ok',
    mensagem: opcao.diferencaCents > 0
      ? `Liberado com troca de dia — diferença paga (${ROTULO_DA_FORMA[forma]}) · sem rede`
      : 'Liberado com troca de dia — sem diferença · sem rede',
    pessoas: t.pessoas, ingresso: r0.ingresso,
    trocaFeita: { tipo: opcao.nome, cobradoCents: opcao.diferencaCents, forma },
    ...(comboLocal(t) ? { combo: comboLocal(t) } : {}),
  }
  void tentarReconectar()
  return true
}

async function confirmarTroca() {
  const r0 = ultima.value
  const opcao = opcaoDaTroca.value
  if (!r0?.troca || !opcao || trocando.value || !trocaPerguntando.value) return
  trocaPerguntando.value = false
  const forma: FormaDeTroca | null = opcao.diferencaCents > 0 ? trocaForma.value : 'sem_diferenca'
  if (!forma) { trocaErro.value = 'Escolha como a pessoa pagou a diferença.'; return }
  trocaErro.value = ''
  trocando.value = true
  // combo (050): cada pessoa é um ingresso — a troca roda parte por parte, cada uma com o seu id
  const partes: (number | undefined)[] = !r0.combo ? [undefined]
    : partesDaTroca.value.length ? partesDaTroca.value.slice(0, trocaQuantas.value) : [r0.combo.seq]
  let feitas = 0
  let ultimaResp: Resposta | null = null
  try {
    for (const parte of partes) {
      // UM id pra passagem e pra troca, criado antes de saber se vai ter rede (mesmo motivo do `ler`)
      const idPassagem = novoId()
      if (!online.value || r0.local) {
        if (!trocarSemRede(r0, idPassagem, opcao, forma, parte)) break
        ultimaResp = ultima.value
        feitas++
        continue
      }
      try {
        const resp = await $fetch<Resposta>('/api/portaria/troca-de-dia', {
          method: 'POST',
          body: { id: idPassagem, qr: ultimoBruto.value, eventId: id, tipoId: opcao.tipoId, forma,
                  cobradoCents: opcao.diferencaCents, gate: gate.value || undefined, deviceId: aparelho.value,
                  ...(parte ? { parteDoCombo: parte } : {}) },
        })
        ultimaResp = { ...resp, ingresso: r0.ingresso }
        if (resp?.publico) publico.value = resp.publico
        marcarNaListaDoAparelho(ultimoBruto.value, ultimaResp, parte)
        feitas++
      } catch (e: any) {
        if (falhaDeRede(e)) {
          // MESMO id: se o servidor gravou antes de a resposta se perder, a fila volta "repetida"
          online.value = false
          if (!trocarSemRede(r0, idPassagem, opcao, forma, parte)) break
          ultimaResp = ultima.value
          feitas++
        } else {
          const nova = e?.data?.data?.troca
          if (nova && !feitas) ultima.value = { ...r0, troca: nova }
          trocaErro.value = e?.data?.statusMessage || e?.statusMessage || 'Não deu pra liberar agora. Tente de novo.'
          break
        }
      }
    }
    if (feitas && ultimaResp) {
      ultima.value = feitas === 1 ? ultimaResp : {
        ...ultimaResp,
        mensagem: `${feitas} pessoas deste combo liberadas com troca de dia`
          + (ultimaResp.local ? ' · sem rede' : ''),
        pessoas: feitas,
        trocaFeita: { tipo: opcao.nome, cobradoCents: opcao.diferencaCents * feitas, forma },
      }
      if (!ultima.value.local) refresh()
      historico.value.unshift({ ...ultima.value, codigo: ultimoBruto.value, quando: new Date() })
      historico.value = historico.value.slice(0, 12)
      if (feitas < partes.length && !trocaErro.value) {
        trocaErro.value = `Só ${feitas} de ${partes.length} foram liberadas — leia o ingresso de novo.`
      }
    }
  } finally {
    trocando.value = false
  }
}

/* ------------------------------------------------------------- combo (050) */
/*
 * Dono, 08/10: "tem que aparecer os 10, porque ele vai invalidando, ingresso por ingresso ... saber
 * esse combo aqui, 9 pessoas foram, 1 não foi". Cada pessoa do combo é um ingresso. O grupo que chega
 * com UM celular (ou com o print do QR antigo) não trava a fila: lido um, a porta mostra quantos do
 * combo faltam e "Entrar mais pessoas deste combo" libera as outras partes, uma a uma, cada uma
 * com o seu id — com rede pelo `/api/checkin`, sem rede pela lista do aparelho.
 */
const comboAberto = ref(false)
const comboQuantas = ref(1)
const comboEntrando = ref(false)
const comboErro = ref('')
/** as partes do combo que ainda não entraram, a lida primeiro */
const partesQueFaltam = computed(() => (ultima.value?.combo?.partes ?? [])
  .filter((p) => p.status === 'valido').map((p) => p.seq))
const resumoDoCombo = computed(() => {
  const c = ultima.value?.combo
  if (!c) return null
  const entraram = c.partes.filter((p) => p.status === 'usado').length
  return { seq: c.seq, tamanho: c.tamanho, entraram, faltam: c.partes.filter((p) => p.status === 'valido').length }
})
const podeEntrarMais = computed(() => {
  const r = ultima.value
  return !!r?.combo && !r.consulta && !r.foraDoDia && (r.resultado === 'ok' || r.resultado === 'ja_usado')
    && partesQueFaltam.value.length > 0
})
/** troca de dia de combo: as partes que ainda valem, a lida primeiro */
const partesDaTroca = computed(() => {
  const c = ultima.value?.combo
  if (!c) return []
  const validas = c.partes.filter((p) => p.status === 'valido').map((p) => p.seq)
  return [...validas.filter((s) => s === c.seq), ...validas.filter((s) => s !== c.seq)]
})
const trocaQuantas = ref(1)
watch(ultima, () => {
  comboAberto.value = false
  comboErro.value = ''
  comboQuantas.value = partesQueFaltam.value.length || 1
  trocaQuantas.value = 1
})

function mudarQuantas(alvo: 'combo' | 'troca', passo: number) {
  if (alvo === 'combo') {
    comboQuantas.value = Math.min(partesQueFaltam.value.length, Math.max(1, comboQuantas.value + passo))
  } else {
    trocaQuantas.value = Math.min(Math.max(1, partesDaTroca.value.length), Math.max(1, trocaQuantas.value + passo))
    trocaPerguntando.value = false
  }
}

async function entrarMaisDoCombo() {
  const r0 = ultima.value
  if (!r0?.combo || comboEntrando.value) return
  const bruto = ultimoBruto.value
  const partes = partesQueFaltam.value.slice(0, comboQuantas.value)
  comboEntrando.value = true
  comboErro.value = ''
  let liberadas = 0
  let recusadas = 0
  let ultimaResp: Resposta | null = null
  try {
    for (const parte of partes) {
      const idPassagem = novoId()
      let r: Resposta
      if (!online.value) {
        r = validarLocal(bruto, idPassagem, false, parte)
      } else {
        try {
          r = await $fetch<Resposta>('/api/checkin', {
            method: 'POST',
            body: { qr: bruto, eventId: id, gate: gate.value || undefined, apenasConsultar: false,
                    entradaId: idPassagem, deviceId: aparelho.value, parteDoCombo: parte },
          })
          if (r?.publico) publico.value = r.publico
          marcarNaListaDoAparelho(bruto, r, parte)
        } catch (e: any) {
          if (!falhaDeRede(e)) { comboErro.value = respostaDeFalha(e).mensagem; break }
          online.value = false
          // MESMO id da tentativa online (ver `ler`)
          r = validarLocal(bruto, idPassagem, false, parte)
        }
      }
      ultimaResp = r
      if (r.ok) liberadas++
      else recusadas++
    }
    if (ultimaResp) {
      ultima.value = {
        ...ultimaResp,
        ok: liberadas > 0, resultado: liberadas > 0 ? 'ok' : ultimaResp.resultado,
        mensagem: liberadas > 0
          ? `Mais ${liberadas} ${liberadas === 1 ? 'pessoa' : 'pessoas'} deste combo liberada${liberadas === 1 ? '' : 's'}`
            + (recusadas ? ` · ${recusadas} recusada${recusadas === 1 ? '' : 's'} (já usadas ou fora da lista)` : '')
            + (ultimaResp.local ? ' · sem rede' : '')
          : ultimaResp.mensagem,
        pessoas: liberadas, ingresso: r0.ingresso,
      }
      if (liberadas && !ultima.value.local) refresh()
      historico.value.unshift({ ...ultima.value, codigo: bruto, quando: new Date() })
      historico.value = historico.value.slice(0, 12)
      ultimoBruto.value = bruto
    }
    if (liberadas) void tentarReconectar()
  } finally {
    comboEntrando.value = false
  }
}

/* ------------------------------------------------------------------ câmera */

/** Trocar de modo lembra a escolha do aparelho: quem opera com o celular abre já na câmera. */
function escolherModo(camera: boolean) {
  modoCamera.value = camera
  try { localStorage.setItem('dt_modo_leitura', camera ? 'camera' : 'campo') } catch { /* aba anônima */ }
  if (camera) destravarSom()
  else nextTick(() => campo.value?.focus())
}

/** A leitura da câmera entra pelo MESMO `ler()` do campo: uma decisão só. */
async function lerDaCamera(texto: string) {
  if (lendo.value) return
  codigo.value = texto
  await ler()
}

let som: AudioContext | null = null
/** Criado num toque (a troca de modo): o iOS só libera áudio depois de um gesto. */
function destravarSom() {
  try { som ??= new AudioContext(); void som.resume() } catch { /* sem áudio: sobram a cor e a vibração */ }
}

/**
 * Com a câmera o operador olha pro QR, não pra tela: o veredito precisa ser ouvido e sentido.
 * A consulta tem o seu som (dois toques curtos, tom do meio): o bipe agudo do PODE ENTRAR numa
 * consulta dizia "entrou" sem ninguém ter entrado (ADM-03).
 */
function avisar(ok: boolean, consulta = false) {
  navigator.vibrate?.(consulta ? [40, 60, 40] : ok ? 60 : [140, 70, 140])
  if (!som) return
  try {
    const osc = som.createOscillator()
    const ganho = som.createGain()
    osc.frequency.value = consulta ? 520 : ok ? 880 : 220
    ganho.gain.value = 0.15
    osc.connect(ganho)
    ganho.connect(som.destination)
    osc.start()
    osc.stop(som.currentTime + (ok ? 0.12 : 0.35))
  } catch { /* ignora */ }
}

/** Conta leituras: duas respostas iguais seguidas precisam repintar o veredito da câmera. */
const leituraN = ref(0)
watch(ultima, (r) => {
  if (!r) return
  leituraN.value++
  if (modoCamera.value) avisar(r.ok, !!r.consulta)
})

/** O veredito em cima da própria imagem da câmera — o mesmo texto e a mesma cor do cartão grande. */
const vereditoCamera = computed(() => {
  const r = ultima.value
  if (!r) return null
  return {
    chave: leituraN.value,
    titulo: tituloDoVeredito(r),
    detalhe: [r.ingresso?.titular ?? r.titular, r.mensagem].filter(Boolean).join(' · '),
    classe: classeDoVeredito(r),
  }
})

/* ------------------------------------------------------------ sincronização */

const ultimoEnvio = ref<{ aplicadas: number; repetidas: number; conflitos: number;
                          recusadas: number; cancelados: number } | null>(null)

/**
 * Quantas passagens cabem num envio.
 *
 * O servidor recusa remessa acima de `LIMITE_FILA` (500, em
 * `server/utils/catraca.ts`) e a recusa é **400** — e 400 não tira nada da
 * fila. Mandando a fila inteira de uma vez, o portão que passou a manhã sem
 * rede trava de vez: todo envio volta 400, a fila nunca esvazia, e a tela diz
 * "atualize a página", que não resolve nada. Medido nesta instalação:
 * 501 itens = HTTP 400, 500 itens = HTTP 200.
 *
 * Abaixo do teto de propósito: quem escrever `LIMITE_FILA = 400` amanhã não
 * quebra o portão.
 */
const LOTE_FILA = 400

async function sincronizar({ comLista = false } = {}) {
  if (sincronizando.value) return
  sincronizando.value = true
  if (comLista) baixando.value = true
  // Limpo aqui e não no fim: um aviso levantado DURANTE a sincronização (cota
  // do navegador cheia, lista truncada) tem que sobreviver ao sucesso do
  // envio. Antes o aviso nunca era apagado e uma falha de dez segundos atrás
  // ficava na tela o evento inteiro.
  avisoLocal.value = ''
  // Pelo mesmo motivo do aviso acima: o relógio torto de DEZ minutos atrás não
  // pode ficar na tela o evento inteiro depois de o aparelho ser acertado.
  avisoRelogio.value = null
  const soma = { aplicadas: 0, repetidas: 0, conflitos: 0, recusadas: 0, cancelados: 0 }
  let baixarAgora = comLista
  try {
    // Uma volta por remessa, até a fila esvaziar. `comLista` só na primeira:
    // baixar 20 mil ingressos a cada remessa é o que transforma rede ruim em
    // rede parada.
    for (;;) {
      const enviada = fila.value.slice(0, LOTE_FILA)
      const antes = fila.value.length

      const r = await $fetch<any>('/api/portaria/sincronizar', {
        method: 'POST',
        body: { eventId: id, deviceId: aparelho.value, fila: enviada, comLista: baixarAgora },
      })
      online.value = true
      baixarAgora = false

      // Tira da fila exatamente o que o servidor confirmou ter recebido. O que
      // não voltou fica pra próxima — perder uma passagem aqui é perder uma
      // pessoa do relatório de público, e ninguém descobre depois.
      const respondidos = new Set<string>((r.itens ?? []).map((i: any) => i.id))
      fila.value = fila.value.filter((p) => !respondidos.has(p.id))
      guardar(CHAVE_FILA, fila.value)

      // O resumo é a soma de TODAS as remessas: o operador leu "1 registrada"
      // e tinha 900 na fila — o número da última remessa mente sobre o envio.
      for (const k of Object.keys(soma) as (keyof typeof soma)[]) {
        soma[k] += Number(r.resumo?.[k] ?? 0)
      }
      ultimoEnvio.value = { ...soma }
      publico.value = r.publico
      conflitos.value = r.conflitos ?? []

      // O relógio do aparelho. Somado entre as remessas: uma fila de 900
      // passagens vira três envios, e mostrar só o último diria "3 passagens
      // com hora errada" quando foram 900.
      if (r.relogio) {
        avisoRelogio.value = avisoRelogio.value
          ? { ...avisoRelogio.value,
              passagens: avisoRelogio.value.passagens + Number(r.relogio.passagens ?? 0) }
          : { passagens: Number(r.relogio.passagens ?? 0),
              dispositivo: r.relogio.dispositivo ?? null,
              motivo: r.relogio.motivo,
              piorEnviado: r.relogio.piorEnviado ?? null }
      }

      if (r.lista) {
        // A lista nova não pode apagar o que este aparelho marcou e ainda não
        // sincronizou: sem isto, baixar a lista no meio do apagão devolveria ao
        // estado "válido" um ingresso que já passou por aqui.
        //
        // A lista nova vem com OUTRO sal: a marca de cada passagem pendente é achada na lista
        // velha pela chave velha e levada pra chave nova (os dias do passaporte vão junto).
        const salNovo: string | null = r.lista.sal ?? null
        const marcas = new Map<string, Pick<IngressoLocal, 'usadoAqui' | 'diasAqui'>>()
        for (const pend of fila.value) {
          const cod = codigoDoQr(pend.qr).codigo
          const velho = mapa.value.get(chaveLocal(cod))
          if (velho) marcas.set(chaveLocal(cod, salNovo), { usadoAqui: velho.usadoAqui, diasAqui: velho.diasAqui })
        }
        lista.value = r.lista.ingressos.map((i: IngressoLocal) => {
          const marca = marcas.get(i.chave ?? i.codigo ?? '')
          return marca ? { ...i, ...marca } : i
        })
        salDaLista.value = salNovo
        listaEm.value = r.lista.geradaEm
        tiposDaTroca.value = Array.isArray(r.lista.tiposDaTroca) ? r.lista.tiposDaTroca : []

        // O servidor corta a lista em 20 mil e MARCA o corte. Sem ler essa
        // marca, o tablet ficaria recusando ingresso bom no apagão sem que
        // ninguém soubesse por quê — a falha muda de sempre.
        //
        // Lida ANTES de guardar: a marca vai pro localStorage na mesma gravação
        // da lista que ela descreve. Guardar primeiro escreveria a lista nova
        // com a marca da lista anterior.
        listaTruncada.value = Boolean(r.lista.truncada)
        guardarLista()
        if (r.lista.truncada) {
          avisoLocal.value = `A lista parou em ${lista.value.length} ingressos e este evento `
            + 'tem mais que isso. Sem rede, quem ficou de fora da lista será recusado — '
            + 'não opere este portão offline.'
        }
      }

      // Sai quando a fila acabou. O `>= antes` é o freio contra girar pra
      // sempre se uma remessa voltar 200 sem responder pelos itens dela.
      if (!fila.value.length || fila.value.length >= antes) break
    }
    refresh()
  } catch (e: any) {
    if (falhaDeRede(e)) online.value = false
    else {
      // O servidor respondeu — a rede está de pé, mesmo que ele tenha dito
      // não. Continuar "offline" aqui era o leitor preso no modo sem rede
      // até alguém recarregar a página.
      online.value = true
      avisoLocal.value = statusDaFalha(e) === 401
        ? 'Sua sessão expirou — entre de novo para sincronizar e continuar lendo.'
        : e?.data?.statusMessage || 'Não foi possível sincronizar agora.'
    }
  } finally {
    sincronizando.value = false
    baixando.value = false
  }
}

/* ------------------------------------------------------------------- visual */

// `CLASSE` (a cor de cada resultado) mora no <script> de cima, junto do título.

const prontoParaApagao = computed(() =>
  lista.value.length > 0 && swPronto.value === 'sim')

const quando = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : ''

/** 0,5% e não "0.5%" — e sem casa decimal quando não precisa */
const pct = (v: number) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 })

useHead({
  title: 'Leitor de entrada',
  // "Adicionar à tela inicial" / "Instalar app": abre em tela cheia, com o ícone da Portaria
  link: [
    { rel: 'manifest', href: '/portaria.webmanifest' },
    { rel: 'apple-touch-icon', href: '/brand/apple-touch-icon-portaria.png' },
  ],
  meta: [
    { name: 'apple-mobile-web-app-capable', content: 'yes' },
    { name: 'mobile-web-app-capable', content: 'yes' },
    { name: 'apple-mobile-web-app-title', content: 'Portaria' },
    { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
  ],
})
</script>

<template>
  <!--
    NO CELULAR, O CAMPO E O VEREDITO VÊM PRIMEIRO (ADM-24). Em 375 px, KPIs, faixas de aviso, fila
    e sincronização vinham antes do campo: o operador rolava a cada leitura e o foco escapava.
    Abaixo de `lg` a página vira coluna e cabeçalho, abas, leitura e veredito levam
    `max-lg:order-first` (ficam na ordem do HTML entre si, acima de todo o resto); o estado da rede
    aparece numa linha curta dentro do cartão de leitura. No computador nada muda de lugar.
  -->
  <div class="max-lg:flex max-lg:flex-col" data-parte="leitor-pagina">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5 max-lg:order-first max-lg:py-3">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">{{ naPortaria && nomeNaPortaria ? nomeNaPortaria : 'Leitor de entrada' }}</h1>
        <p class="mt-1 text-tinta-suave max-lg:hidden">
          Leia o QR ou digite o código. O campo já fica no foco — pode apontar o leitor.
        </p>
      </div>
      <!-- o botão de histórico saiu: virou aba logo abaixo, e dois caminhos
           pro mesmo lugar na mesma altura da tela só fazem o operador
           hesitar -->
    </div>

    <div class="max-lg:order-first">
      <AbasSecao v-if="!naPortaria" :evento-id="id" />
    </div>

    <!-- Faixa de estado da rede. Fica no topo e é a primeira coisa que o
         operador vê: trabalhar offline sem saber que está offline é como o
         erro vira discussão na porta. -->
    <div class="card mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
      <span class="flex items-center gap-2 font-semibold"
            :class="online ? 'text-ok' : 'text-alerta'">
        <span class="h-2.5 w-2.5 rounded-full" :class="online ? 'bg-ok' : 'bg-alerta'" />
        {{ online ? 'Conectado' : 'Sem rede — validando pela lista do aparelho' }}
      </span>
      <span v-if="!online" class="text-sm text-tinta-suave" data-parte="reconexao">
        tentando o servidor a cada {{ RETENTAR_MS / 1000 }} s
        <template v-if="ultimaTentativa">(última às {{ ultimaTentativa.toLocaleTimeString('pt-BR') }})</template>
        ·
        <button type="button" class="font-semibold text-acao underline" :disabled="sincronizando"
                @click="tentarReconectar()">
          tentar agora
        </button>
      </span>

      <span class="text-sm text-tinta-suave">
        Aparelho <strong class="font-mono text-tinta">{{ aparelho }}</strong>
      </span>

      <span class="text-sm text-tinta-suave">
        Lista:
        <strong class="text-tinta">{{ lista.length }}</strong> ingressos
        <template v-if="listaEm"> · baixada {{ quando(listaEm) }}</template>
        <template v-else> · <span class="text-erro">nunca baixada</span></template>
      </span>

      <span class="text-sm" :class="fila.length ? 'font-semibold text-alerta' : 'text-tinta-suave'">
        Fila para enviar: {{ fila.length }}
      </span>

      <span class="flex-1" />

      <button type="button" class="btn-secundario py-1.5 text-sm"
              :disabled="sincronizando" @click="sincronizar({ comLista: true })">
        {{ baixando ? 'Baixando…' : 'Baixar lista' }}
      </button>
      <button type="button" class="btn-secundario py-1.5 text-sm"
              :disabled="sincronizando || !fila.length" @click="sincronizar()">
        {{ sincronizando ? 'Enviando…' : `Enviar fila (${fila.length})` }}
      </button>
    </div>

    <p v-if="avisoLocal" class="faixa-erro mt-3">{{ avisoLocal }}</p>

    <p v-else-if="!prontoParaApagao" class="faixa-aviso mt-3">
      <strong>Este aparelho ainda não aguenta ficar sem rede.</strong>
      <template v-if="!lista.length"> Toque em “Baixar lista” enquanto há sinal.</template>
      <template v-if="swPronto !== 'sim'">
        A tela só reabre offline em endereço seguro (https) — em rede aberta, não feche a aba.
      </template>
    </p>

    <!-- Relógio do aparelho fora da janela do evento. Fica GRANDE e em cima
         porque o estrago é silencioso: a passagem entra do mesmo jeito (a
         pessoa passou), mas com a hora do servidor — e o operador precisa
         saber qual tablet acertar antes que a noite inteira vá embora assim. -->
    <div v-if="avisoRelogio" class="card mt-3 bg-alerta-claro ring-alerta/50">
      <p class="rotulo-kpi text-alerta">
        Relógio errado em {{ avisoRelogio.passagens }} passagem(ns)
        <template v-if="avisoRelogio.dispositivo">
          do aparelho <span class="font-mono">{{ avisoRelogio.dispositivo }}</span>
        </template>
      </p>
      <p class="mt-1 text-sm text-tinta-corpo">
        {{ avisoRelogio.motivo }}<template v-if="avisoRelogio.piorEnviado">
          — a pior marcava <strong>{{ quando(avisoRelogio.piorEnviado) }}</strong></template>.
        As entradas foram registradas com a <strong>hora do servidor</strong>; ninguém ficou de
        fora da contagem. Acerte a data e a hora desse aparelho antes do próximo apagão.
      </p>
    </div>

    <!-- O número que o PRODUTOR precisa ver, e que ninguém tinha: quantas
         meias deste evento chegam na porta sem dizer por quê. Ele existe
         porque a saída certa para o ingresso antigo NÃO é inventar um motivo
         — backfill chutado vira rastro falso, que é pior que rastro faltando.
         Então conta-se quantos ficaram sem e mostra-se o número. -->
    <div v-if="meiasDoEvento.semMotivo" class="card mt-3 bg-alerta-claro ring-alerta/50">
      <p class="rotulo-kpi text-alerta">
        {{ meiasDoEvento.semMotivo }} de {{ meiasDoEvento.total }}
        meia(s)-entrada(s) deste evento sem motivo registrado
      </p>
      <p class="mt-1 text-sm text-tinta-corpo">
        Nesses ingressos ninguém perguntou se o direito é de estudante, idoso, PCD, ID Jovem
        ou professor — a compra é anterior à exigência, ou foi feita no balcão. A portaria vai
        pedir o documento genérico e conferir com o supervisor; nenhum motivo foi inventado
        para eles.
        <template v-if="meiasDoEvento.parcial">
          <strong>A contagem está parcial</strong> — a lista deste aparelho foi cortada no teto
          do servidor e não cobre o evento inteiro.
        </template>
      </p>
    </div>

    <p v-if="ultimoEnvio" class="mt-3 text-sm text-tinta-suave">
      Último envio: {{ ultimoEnvio.aplicadas }} registrada(s),
      {{ ultimoEnvio.repetidas }} repetida(s),
      <span :class="ultimoEnvio.conflitos ? 'font-semibold text-alerta' : ''">
        {{ ultimoEnvio.conflitos }} em conflito</span>,
      <span :class="ultimoEnvio.recusadas ? 'font-semibold text-erro' : ''">
        {{ ultimoEnvio.recusadas }} recusada(s)</span>.
    </p>

    <!-- O contador da porta — o que o operador olha de relance: quantos já foram
         validados e quantos faltam. Sai do MESMO retrato (`publico`) dos cards
         abaixo, nunca de uma conta feita aqui, pelo motivo do comentário deles. -->
    <div class="card mt-4 max-lg:hidden" data-parte="contador">
      <div class="flex flex-wrap items-end gap-x-10 gap-y-3">
        <div>
          <p class="rotulo-kpi">Validados</p>
          <p class="numero-kpi mt-1 text-ok">{{ publico ? publico.ingressos : '—' }}</p>
        </div>
        <div>
          <p class="rotulo-kpi">Faltam validar</p>
          <p class="numero-kpi mt-1">{{ publico ? publico.faltam : '—' }}</p>
        </div>
        <p v-if="publico" class="pb-0.5 text-sm text-tinta-suave">
          de {{ publico.aptos }} ingressos · {{ pct(publico.comparecimentoPct) }}%
          <template v-if="fila.length"> · +{{ fila.length }} lido(s) sem rede, ainda não enviado(s)</template>
        </p>
      </div>
      <div v-if="publico" class="mt-3 h-2.5 overflow-hidden rounded-full bg-ink-100"
           role="progressbar" aria-label="Ingressos validados"
           :aria-valuenow="publico.ingressos" aria-valuemin="0" :aria-valuemax="publico.aptos">
        <div class="h-full rounded-full bg-success-600 transition-[width] duration-300"
             :style="{ width: `${publico.aptos ? Math.min(100, (publico.ingressos / publico.aptos) * 100) : 0}%` }" />
      </div>
    </div>

    <!-- Os três primeiros cards saem do MESMO objeto (`publico`), que sai de
         uma consulta só. Antes um contava o livro de passagens e os outros
         dois o carimbo do ingresso, e a tela exibia "2 dentro" ao lado de
         "0 entraram" e "0%". "—" nos três quando ainda não houve conversa com
         o servidor: não saber é honesto, discordar não. O quarto card é outra
         pergunta — ele conta LEITURA, não pessoa, e por isso vem do log do
         leitor mesmo. -->
    <div class="mt-4 grid gap-3 sm:grid-cols-4">
      <div class="card">
        <p class="rotulo-kpi">Pessoas dentro</p>
        <p class="numero-kpi mt-1">{{ publico ? publico.pessoas : '—' }}</p>
        <p v-if="publico" class="mt-1 text-xs text-tinta-fraca">
          em {{ publico.entradas }} passagem(ns)
          <template v-if="publico.offline"> · {{ publico.offline }} sem rede</template>
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Já entraram</p>
        <p class="numero-kpi mt-1">{{ publico ? publico.ingressos : '—' }}</p>
        <p v-if="publico" class="mt-1 text-xs text-tinta-fraca">
          de {{ publico.aptos }} ingressos aptos
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Comparecimento</p>
        <p class="numero-kpi mt-1">{{ publico ? `${pct(publico.comparecimentoPct)}%` : '—' }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">ingressos que passaram na porta</p>
      </div>
      <div v-if="data" class="card">
        <p class="rotulo-kpi">Recusadas</p>
        <p class="numero-kpi mt-1" :class="data.resumo.recusadas ? 'text-erro' : ''">
          {{ data.resumo.recusadas }}
        </p>
        <p class="mt-1 text-xs text-tinta-fraca">{{ data.resumo.leituras }} leituras no total</p>
      </div>
      <!-- O log do leitor é rota de /admin e o papel `portaria` leva 403 nela
           — medido: quem opera este leitor NUNCA vê o card de recusadas. Em
           vez de um "—" com desculpa, o quarto card passa a mostrar o número
           que a portaria tem direito de ver e de fato precisa: quantas
           passagens foram decididas sem rede e ainda vão ser conferidas. -->
      <div v-else class="card">
        <p class="rotulo-kpi">Passagens sem rede</p>
        <p class="numero-kpi mt-1">{{ publico ? publico.offline : '—' }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          validadas pela lista do aparelho e conferidas depois
        </p>
      </div>
    </div>

    <!-- NO CELULAR: os dois números da porta numa faixa curta ACIMA da câmera (o que o porteiro olha
         de relance, como no app do Funz). Curta de propósito: o veredito ainda nasce dentro da tela
         (ADM-24). Mesmo retrato `publico` do contador grande, que no celular fica escondido. -->
    <div class="card mt-2 px-4 py-3 lg:hidden max-lg:order-first" data-parte="contador-curto">
      <div class="flex items-baseline justify-between gap-3">
        <p class="text-sm font-semibold text-tinta-suave">
          Validados <span class="titulo ml-1 text-2xl font-semibold tabular-nums text-ok">{{ publico ? publico.ingressos : '—' }}</span>
        </p>
        <p class="text-right text-sm font-semibold text-tinta-suave">
          Faltam <span class="titulo ml-1 text-2xl font-semibold tabular-nums text-tinta">{{ publico ? publico.faltam : '—' }}</span>
        </p>
      </div>
      <div v-if="publico" class="mt-2 h-2 overflow-hidden rounded-full bg-ink-100" aria-hidden="true">
        <div class="h-full rounded-full bg-success-600 transition-[width] duration-300"
             :style="{ width: `${publico.aptos ? Math.min(100, (publico.ingressos / publico.aptos) * 100) : 0}%` }" />
      </div>
    </div>

    <div class="card mt-4 max-lg:order-first" data-parte="cartao-leitura">
      <!-- a rede em uma linha, só no celular: o cartão grande de estado desceu pra baixo do veredito -->
      <p class="mb-3 flex items-center gap-2 text-sm font-semibold lg:hidden"
         :class="online ? 'text-ok' : 'text-alerta'" data-parte="rede-curta">
        <span class="h-2.5 w-2.5 shrink-0 rounded-full" :class="online ? 'bg-ok' : 'bg-alerta'" />
        {{ online ? 'Conectado' : 'Sem rede — validando pela lista do aparelho' }}
        <span v-if="fila.length" class="font-normal text-alerta">· {{ fila.length }} na fila</span>
      </p>
      <div class="mb-4 inline-flex rounded-xl bg-ink-100 p-1" role="group" aria-label="Modo de leitura">
        <button type="button" class="rounded-lg px-4 py-2 text-sm font-semibold"
                :class="!modoCamera ? 'bg-white text-tinta shadow-card' : 'text-tinta-suave'"
                :aria-pressed="!modoCamera" @click="escolherModo(false)">
          Leitor / código
        </button>
        <button type="button" class="rounded-lg px-4 py-2 text-sm font-semibold"
                :class="modoCamera ? 'bg-white text-tinta shadow-card' : 'text-tinta-suave'"
                :aria-pressed="modoCamera" @click="escolherModo(true)">
          Câmera
        </button>
      </div>
      <LeitorCamera v-if="modoCamera" class="mb-4" :pausada="lendo || trocaAberta || comboAberto" :veredito="vereditoCamera"
                    @ler="lerDaCamera" />
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="ler">
        <div class="min-w-[280px] flex-1">
          <label for="cod" class="rotulo">Código do ingresso</label>
          <input id="cod" ref="campo" v-model="codigo" autocomplete="off"
                 :inputmode="modoCamera ? 'none' : undefined"
                 class="campo font-mono text-lg tracking-wider"
                 placeholder="CON-XXXX-XXXX ou leitura do QR">
        </div>
        <div class="w-40" :class="maisOpcoes ? '' : 'max-lg:hidden'">
          <label for="gate" class="rotulo">Portão</label>
          <input id="gate" v-model="gate" class="campo" placeholder="Norte, VIP…">
        </div>
        <button type="submit" class="btn-primario h-[42px] px-8" :disabled="lendo || !codigo.trim()">
          {{ lendo ? 'Lendo…' : 'Ler' }}
        </button>
      </form>
      <p v-if="avisoCodigo" class="mt-2 text-sm font-semibold text-alerta" role="alert"
         data-parte="aviso-codigo">
        {{ avisoCodigo }}
      </p>
      <!-- "Só conferir" vale UMA leitura e desliga sozinho (ADM-03). Ligado, a faixa roxa diz
           com todas as letras que ninguém está entrando — o verde fica só pra quem entra. -->
      <button type="button" class="mt-3 min-h-[44px] text-sm font-semibold text-acao lg:hidden"
              :aria-expanded="maisOpcoes" data-parte="mais-opcoes" @click="maisOpcoes = !maisOpcoes">
        {{ maisOpcoes ? 'Menos opções' : 'Mais opções (portão, só conferir)' }}
      </button>
      <label class="mt-3 flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl px-3 text-sm font-semibold"
             :class="[apenasConsultar ? 'bg-grape-600 text-white' : 'bg-fundo-cinza text-tinta-suave',
                      maisOpcoes || apenasConsultar ? '' : 'max-lg:hidden']"
             data-parte="so-conferir">
        <input v-model="apenasConsultar" type="checkbox" class="h-5 w-5 accent-grape-600">
        Só conferir a próxima leitura (não marca entrada)
      </label>
      <p v-if="apenasConsultar" class="mt-2 rounded-xl bg-grape-50 px-3 py-2 text-sm font-semibold text-grape-700"
         role="status" data-parte="modo-consulta">
        MODO CONSULTA — a próxima leitura NÃO deixa ninguém entrar. Desliga sozinho depois dela.
      </p>
    </div>

    <!-- No celular o veredito é uma folha fixa embaixo, por cima da câmera (como o app do Funz): nasce
         SEMPRE dentro da tela, sem rolar (ADM-24), e "OK, próximo" tira ela da frente. -->
    <div v-if="ultima && !vereditoFechado"
         class="mt-4 rounded-card px-6 py-8 text-center entra-resposta max-lg:order-first
                max-lg:fixed max-lg:inset-x-2 max-lg:bottom-2 max-lg:z-40 max-lg:mt-0 max-lg:max-h-[75dvh]
                max-lg:overflow-y-auto max-lg:px-4 max-lg:py-6 max-lg:shadow-2xl"
         :class="classeDoVeredito(ultima)" data-parte="cartao-veredito">
      <!-- "Só conferir" agora responde mesmo fora do horário da sessão (o
           cliente que chega cedo é quem ainda dá tempo de mandar buscar o
           documento em casa). Então o veredito da consulta deixa de ser
           sempre "VÁLIDO": quando o horário não chegou, ele diz isso. Fixar
           "VÁLIDO" aqui faria a tela contradizer a própria mensagem logo
           abaixo. -->
      <!-- O título sai de `tituloDoVeredito`, o mesmo da câmera. "Só
           conferir" de um ingresso já usado agora diz BARRADO (a consulta
           passou a responder por todos os ramos sem gravar leitura); "AINDA
           NÃO" fica só pro horário que não chegou. -->
      <p class="titulo text-4xl font-semibold" data-parte="veredito">
        {{ tituloDoVeredito(ultima) }}
      </p>
      <p class="mt-2 text-lg opacity-95">{{ ultima.mensagem }}</p>
      <!-- Código digitado não tem a assinatura do QR (ADM-25): a porta não trava, mas pede o
           documento de quem passa. Logo abaixo do título: no celular, o resto do cartão fica
           abaixo da dobra. -->
      <p v-if="(ultima.digitado || ultima.qrAntigo) && ultima.ok && !ultima.consulta"
         class="mx-auto mt-3 max-w-md rounded-xl bg-white/20 px-3 py-2 text-lg font-semibold"
         data-parte="codigo-digitado">
        {{ ultima.qrAntigo ? 'QR de antes da troca de chave: confira o documento' : 'Digitado à mão: confira o documento' }}
      </p>
      <p v-if="ultima.entrarDeNovo" class="mt-3">
        <a :href="naPortaria ? '/portaria' : `/entrar?de=${encodeURIComponent(`/admin/evento/${id}/validacao`)}`"
           class="inline-block rounded-xl bg-white px-4 py-2 font-semibold text-tinta">
          Entrar de novo
        </a>
      </p>
      <p v-if="ultima.ingresso" class="mt-3 text-lg">
        <strong>{{ ultima.ingresso.titular || 'sem nome' }}</strong>
        · {{ ultima.ingresso.setor }} · {{ ultima.ingresso.lote }}
        <template v-if="ultima.ingresso.tipo"> · {{ ultima.ingresso.tipo }}</template>
        <span v-if="ultima.ingresso.fidelidade" class="selo-ok ml-1 align-middle" data-parte="fidelidade-portaria">
          {{ ultima.ingresso.fidelidade.nome }} · {{ ultima.ingresso.fidelidade.consumacaoPct }}% na consumação
        </span>
      </p>
      <p v-else-if="ultima.titular" class="mt-3 text-lg"><strong>{{ ultima.titular }}</strong></p>
      <p v-if="ultima.pessoas && ultima.pessoas > 1" class="mt-1 text-lg">
        {{ ultima.pessoas }} pessoas nesta entrada
      </p>

      <!-- MEIA-ENTRADA: o pedido de documento, do tamanho de quem lê de
           relance com fila na frente. Fundo branco dentro da faixa colorida
           porque é o que o operador tem que PARAR e ler — o resto do card ele
           só olha a cor. Sem isto a tela dizia "Meia-entrada" no nome do tipo
           e o operador ficava adivinhando qual papel pedir (migração 015).

           DOIS blocos, e a diferença é o ponto: com motivo declarado o
           operador confere UM papel; sem motivo ele tem que perguntar qual é o
           caso da pessoa antes de saber o que pedir. Medido antes do conserto:
           os dois casos renderizavam idênticos — mesmo título de 24px, mesmo
           rótulo auxiliar de 12px em #4F6C7C — e a ausência de motivo aparecia
           só como um texto no lugar onde deveria estar o motivo
           ("MEIA-ENTRADA · motivo não declarado na compra"). Com o tablet na
           mão e sol batendo isso é a mesma tela duas vezes. -->

      <!-- 1. com motivo: um papel, nomeado. -->
      <div v-if="ultima.ingresso?.meia?.motivo"
           class="mx-auto mt-4 max-w-xl rounded-card bg-white p-4 text-left text-tinta-corpo">
        <p class="titulo text-2xl font-semibold text-tinta">
          MEIA-ENTRADA · {{ ultima.ingresso.meia.rotulo }}
        </p>
        <p class="titulo mt-3 text-base font-semibold text-tinta-rotulo">Peça este documento</p>
        <p class="text-xl font-semibold leading-snug text-tinta">
          {{ ultima.ingresso.meia.documento }}
        </p>
        <template v-if="ultima.ingresso.meia.numero">
          <!-- sem rede, a lista do aparelho só tem o final do número (ADM-25) -->
          <p class="titulo mt-3 text-base font-semibold text-tinta-rotulo" data-parte="meia-numero-rotulo">
            {{ ultima.ingresso.meia.numero.startsWith('••••') ? 'Final do número declarado na compra'
              : 'Número declarado na compra' }} — confira se bate
          </p>
          <p class="font-mono text-xl font-semibold tracking-wide text-tinta">
            {{ ultima.ingresso.meia.numero }}
          </p>
        </template>
      </div>

      <!-- 2. SEM motivo: o caso que este banco tem de verdade (23 de 23 em
           21/09). Não dá pra nomear o papel, então o aviso muda de natureza —
           deixa de ser "confira este documento" e vira "pergunte primeiro".
           Borda grossa de alerta e título em 30px porque o operador precisa
           reparar que ESTE ingresso é diferente do anterior antes de liberar
           por reflexo. -->
      <div v-else-if="ultima.ingresso?.meia"
           class="mx-auto mt-4 max-w-2xl rounded-card border-4 border-alerta bg-white
                  p-5 text-left text-tinta-corpo">
        <p class="titulo text-3xl font-semibold leading-tight text-alerta">
          MEIA-ENTRADA SEM MOTIVO REGISTRADO
        </p>
        <p class="mt-2 text-xl font-semibold leading-snug text-tinta">
          Peça o documento de estudante, idoso (60+), PCD, ID Jovem ou professor,
          conforme a regra do evento.
        </p>
        <p class="titulo mt-4 text-base font-semibold text-tinta-rotulo">
          O que este ingresso pede
        </p>
        <p class="text-xl font-semibold leading-snug text-tinta">
          {{ ultima.ingresso.meia.documento }}
        </p>
        <p class="mt-3 text-base leading-snug text-tinta-corpo">
          Este ingresso não diz por que tem direito à meia — ninguém perguntou na compra.
          Não é fraude e não é motivo pra barrar sozinho: confira o papel e, na dúvida,
          chame o supervisor.
        </p>
      </div>
      <!-- A recusa útil: além de "já entrou", QUANDO e ONDE. Sem isso a fila
           para com o cliente jurando que não entrou. -->
      <p v-if="ultima.entrouEm" class="mt-1 opacity-90">
        entrou em {{ new Date(ultima.entrouEm).toLocaleString('pt-BR') }}
        <template v-if="ultima.portao"> pelo portão {{ ultima.portao }}</template>
        <template v-if="ultima.operadorEntrada"> · liberado por {{ ultima.operadorEntrada }}</template>
      </p>
      <p v-if="ultima.local" class="mt-2 text-sm opacity-90">
        decidido no aparelho, sem rede — será conferido na sincronização
      </p>

      <!-- troca de dia (049): o que liberou esta pessoa -->
      <p v-if="ultima.trocaFeita" class="mt-3 rounded-lg bg-white/15 px-3 py-2 text-base font-semibold"
         data-parte="troca-feita">
        Troca de dia: {{ ultima.trocaFeita.tipo }} ·
        <template v-if="ultima.trocaFeita.cobradoCents > 0">
          {{ reaisDaTroca(ultima.trocaFeita.cobradoCents) }} em {{ ROTULO_DA_FORMA[ultima.trocaFeita.forma].toLowerCase() }}
        </template>
        <template v-else>sem diferença</template>
      </p>

      <!-- combo (050): cada pessoa é um ingresso — quem do combo já entrou -->
      <p v-if="resumoDoCombo" class="mt-3 rounded-lg bg-white/15 px-3 py-2 text-base font-semibold" data-parte="combo">
        Combo · pessoa {{ resumoDoCombo.seq }} de {{ resumoDoCombo.tamanho }} ·
        {{ resumoDoCombo.entraram }} {{ resumoDoCombo.entraram === 1 ? 'entrou' : 'entraram' }} ·
        faltam {{ resumoDoCombo.faltam }}
      </p>
      <div v-if="podeEntrarMais" class="mt-4 rounded-lg bg-white p-4 text-left text-tinta" data-parte="combo-mais">
        <button v-if="!comboAberto" type="button" class="btn-primario min-h-[52px] w-full text-lg"
                data-parte="abrir-combo-mais" @click="comboAberto = true">
          Entrar mais pessoas deste combo ({{ partesQueFaltam.length }})
        </button>
        <template v-else>
          <p class="text-base font-semibold">Quantas pessoas deste combo estão entrando agora?</p>
          <div class="mt-3 flex items-center justify-center gap-3">
            <button type="button" class="btn-secundario min-h-[52px] min-w-[56px] text-2xl" aria-label="Menos uma"
                    :disabled="comboEntrando || comboQuantas <= 1" data-parte="combo-menos"
                    @click="mudarQuantas('combo', -1)">−</button>
            <span class="min-w-[4ch] text-center text-3xl font-bold tabular-nums" data-parte="combo-quantas">{{ comboQuantas }}</span>
            <button type="button" class="btn-secundario min-h-[52px] min-w-[56px] text-2xl" aria-label="Mais uma"
                    :disabled="comboEntrando || comboQuantas >= partesQueFaltam.length" data-parte="combo-mais-um"
                    @click="mudarQuantas('combo', 1)">+</button>
          </div>
          <p class="mt-1 text-center text-sm text-tinta-suave">de {{ partesQueFaltam.length }} que ainda não entraram</p>
          <p v-if="comboErro" class="mt-3 rounded-[6px] bg-erro-claro px-3 py-2 text-sm font-semibold text-erro"
             role="alert" data-parte="combo-erro">{{ comboErro }}</p>
          <div class="mt-3 grid grid-cols-2 gap-2">
            <button type="button" class="btn-secundario min-h-[52px] text-base" :disabled="comboEntrando"
                    data-parte="cancelar-combo-mais" @click="comboAberto = false">Voltar</button>
            <button type="button" class="btn-primario min-h-[52px] text-base" :disabled="comboEntrando"
                    data-parte="confirmar-combo-mais" @click="entrarMaisDoCombo">
              <template v-if="comboEntrando">Liberando…</template>
              <template v-else>Liberar {{ comboQuantas }}</template>
            </button>
          </div>
        </template>
      </div>

      <!-- troca de dia (049): o ingresso de outro dia entra pagando a diferença -->
      <div v-if="podeTrocar" class="mt-5 rounded-lg bg-white p-4 text-left text-tinta" data-parte="troca-de-dia">
        <template v-if="!ultima.troca!.opcoes.length">
          <p class="text-sm font-semibold">Não há ingresso de hoje com o mesmo número de pessoas para trocar.</p>
          <p class="mt-1 text-sm text-tinta-suave">Venda um ingresso novo no balcão, se a pessoa quiser entrar.</p>
        </template>
        <template v-else-if="!trocaAberta">
          <button type="button" class="btn-primario min-h-[52px] w-full text-lg" data-parte="abrir-troca"
                  @click="abrirTroca">
            Cobrar diferença e liberar
            <template v-if="ultima.troca!.opcoes[0]">
              ({{ ultima.troca!.opcoes[0].diferencaCents ? reaisDaTroca(ultima.troca!.opcoes[0].diferencaCents) : 'sem diferença' }})
            </template>
          </button>
        </template>
        <template v-else>
          <p class="text-sm font-semibold text-tinta-suave">
            Pagou {{ reaisDaTroca(ultima.troca!.pagoCents) }}
            <template v-if="ultima.troca!.pessoas > 1"> · combo de {{ ultima.troca!.pessoas }} pessoas</template>
          </p>
          <p class="mt-3 text-sm font-semibold">Trocar por</p>
          <div class="mt-2 grid gap-2">
            <button v-for="o in ultima.troca!.opcoes" :key="o.tipoId" type="button"
                    class="flex min-h-[52px] items-center justify-between gap-3 rounded-[6px] border-2 px-3 text-left"
                    :class="trocaTipo === o.tipoId ? 'border-acao bg-acao-fraco' : 'border-linha bg-white'"
                    :aria-pressed="trocaTipo === o.tipoId" :data-tipo="o.tipoId"
                    :disabled="trocando" @click="trocaTipo = o.tipoId; trocaErro = ''">
              <span class="min-w-0 font-semibold [overflow-wrap:anywhere]">{{ o.nome }}</span>
              <span class="shrink-0 text-right">
                <span class="block text-lg font-bold tabular-nums">
                  {{ o.diferencaCents ? reaisDaTroca(o.diferencaCents) : 'sem diferença' }}
                </span>
                <span class="block text-xs text-tinta-suave">hoje {{ reaisDaTroca(o.precoCents) }}</span>
              </span>
            </button>
          </div>

          <template v-if="ultima.combo && partesDaTroca.length > 1">
            <p class="mt-4 text-sm font-semibold">Quantas pessoas deste combo trocam</p>
            <div class="mt-2 flex items-center gap-3">
              <button type="button" class="btn-secundario min-h-[52px] min-w-[56px] text-2xl" aria-label="Menos uma"
                      :disabled="trocando || trocaQuantas <= 1" data-parte="troca-menos"
                      @click="mudarQuantas('troca', -1)">−</button>
              <span class="min-w-[4ch] text-center text-3xl font-bold tabular-nums" data-parte="troca-quantas">{{ trocaQuantas }}</span>
              <button type="button" class="btn-secundario min-h-[52px] min-w-[56px] text-2xl" aria-label="Mais uma"
                      :disabled="trocando || trocaQuantas >= partesDaTroca.length" data-parte="troca-mais-um"
                      @click="mudarQuantas('troca', 1)">+</button>
              <span class="text-sm text-tinta-suave">de {{ partesDaTroca.length }}</span>
            </div>
          </template>

          <template v-if="opcaoDaTroca && opcaoDaTroca.diferencaCents > 0">
            <p class="mt-4 text-sm font-semibold">Como pagou</p>
            <div class="mt-2 grid grid-cols-2 gap-2">
              <button v-for="f in FORMAS_DE_TROCA" :key="f" type="button"
                      class="min-h-[52px] rounded-[6px] border-2 px-2 text-base font-semibold"
                      :class="trocaForma === f ? 'border-acao bg-acao text-white' : 'border-linha bg-white text-tinta'"
                      :aria-pressed="trocaForma === f" :data-forma="f"
                      :disabled="trocando" @click="trocaForma = f; trocaErro = ''">
                {{ ROTULO_DA_FORMA[f] }}
              </button>
            </div>
          </template>

          <p v-if="trocaErro" class="mt-3 rounded-[6px] bg-erro-claro px-3 py-2 text-sm font-semibold text-erro"
             role="alert" data-parte="troca-erro">{{ trocaErro }}</p>

          <!-- "tem certeza?" (dono, 08/10): dia diferente SEMPRE pergunta, com ou sem diferença -->
          <div v-if="trocaPerguntando && perguntaDaTroca" class="mt-4 rounded-[6px] border-2 border-alerta bg-alerta-claro p-3"
               role="alertdialog" aria-labelledby="pergunta-troca" data-parte="pergunta-troca">
            <p id="pergunta-troca" class="text-lg font-bold">Tem certeza?</p>
            <p class="mt-1 text-base">
              Este ingresso é de <strong>{{ perguntaDaTroca.doIngresso }}</strong> e hoje é
              <strong>{{ perguntaDaTroca.hoje }}</strong>. Ele entra hoje e <strong>não vale mais</strong> no dia dele.
            </p>
            <p class="mt-1 text-base font-semibold">{{ perguntaDaTroca.cobranca }}</p>
            <div class="mt-3 grid grid-cols-2 gap-2">
              <button type="button" class="btn-secundario min-h-[52px] text-base" :disabled="trocando"
                      data-parte="pergunta-troca-nao" @click="trocaPerguntando = false">
                Voltar
              </button>
              <button type="button" class="btn-primario min-h-[52px] text-base" :disabled="trocando"
                      data-parte="confirmar-troca" @click="confirmarTroca">
                <template v-if="trocando">Liberando…</template>
                <template v-else>Sim, liberar</template>
              </button>
            </div>
          </div>
          <template v-else>
            <button type="button" class="btn-primario mt-4 min-h-[56px] w-full text-lg" data-parte="liberar-troca"
                    :disabled="trocando || !opcaoDaTroca || (opcaoDaTroca.diferencaCents > 0 && !trocaForma)"
                    @click="perguntarTroca">
              <template v-if="trocando">Liberando…</template>
              <template v-else-if="opcaoDaTroca && opcaoDaTroca.diferencaCents > 0">
                Recebi {{ reaisDaTroca(opcaoDaTroca.diferencaCents * (ultima.combo ? trocaQuantas : 1)) }} — liberar
              </template>
              <template v-else>Liberar sem cobrança</template>
            </button>
            <button type="button" class="btn-secundario mt-2 min-h-[48px] w-full" :disabled="trocando"
                    data-parte="cancelar-troca" @click="fecharTroca">
              Não trocar
            </button>
          </template>
        </template>
      </div>
      <button type="button" class="mt-5 min-h-[48px] w-full rounded-lg bg-white/95 text-lg font-semibold text-tinta lg:hidden"
              data-parte="veredito-ok" @click="vereditoFechado = true; nextTick(() => campo?.focus())">
        OK, próximo
      </button>
    </div>

    <div v-if="conflitos.length" class="card mt-4 ring-alerta/50">
      <p class="rotulo-kpi text-alerta">
        {{ conflitos.length }} ingresso(s) entraram mais de uma vez
      </p>
      <ul class="mt-2 space-y-1 text-sm">
        <li v-for="c in conflitos.slice(0, 5)" :key="c.ticketId" class="text-tinta-suave">
          <span class="font-mono text-tinta">{{ c.codigo }}</span>
          — {{ c.passagens }} passagens em {{ c.dispositivos }} aparelho(s)
          <span v-if="c.titular"> · {{ c.titular }}</span>
        </li>
      </ul>
      <NuxtLink :to="`/admin/evento/${id}/validacao/historico`"
                class="mt-2 inline-block text-sm font-semibold text-acao">
        Ver todos no histórico
      </NuxtLink>
    </div>

    <div v-if="historico.length" class="card mt-4 p-0">
      <p class="titulo border-b border-linha px-4 py-3 text-sm font-semibold text-tinta-rotulo">
        Últimas leituras nesta tela
      </p>
      <ul>
        <li v-for="(h, i) in historico" :key="i"
            class="flex items-center gap-3 border-b border-linha px-4 py-2 text-sm last:border-0">
          <span class="w-2.5 h-2.5 shrink-0 rounded-full"
                :class="corDoPonto(h)" />
          <span class="font-mono text-xs text-tinta-suave">{{ h.codigo }}</span>
          <span class="flex-1 text-tinta">{{ h.mensagem }}</span>
          <span v-if="h.local" class="selo-alerta">sem rede</span>
          <span class="text-xs text-tinta-fraca tabular-nums">
            {{ h.quando.toLocaleTimeString('pt-BR') }}
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
/* Sem <Transition>: com a aba em segundo plano o Vue deixa a entrada parada
   em opacidade 0 (o rAF congela) e a resposta some da tela. Animação de
   montagem em CSS puro roda de qualquer jeito. */
@keyframes entra-resposta-kf {
  from { transform: scale(.97); opacity: 0 }
  to   { transform: none;       opacity: 1 }
}
.entra-resposta { animation: entra-resposta-kf .14s ease-out both }
</style>
