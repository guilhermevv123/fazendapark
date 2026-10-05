/**
 * portariaOffline.ts — o que a tela de EVENTOS da portaria (`/portaria`) sabe fazer sem internet
 * (dono, 05/10: "estar preparado para todas as variáveis").
 *
 * O leitor (`/portaria/<id>`) já guarda no aparelho a lista de ingressos e a fila de passagens de
 * UM evento (`dt_portaria_lista_<id>`, `dt_portaria_fila_<id>`). Faltava a tela de cima:
 *
 *  · abrir SEM internet e mostrar os eventos (guardados da última vez que teve rede);
 *  · não pedir login de novo só porque o servidor não respondeu (quem diz "saiu" é o servidor);
 *  · mostrar, por evento, se o aparelho está pronto pra ficar sem internet e quantas leituras
 *    estão esperando a rede;
 *  · e SUBIR SOZINHA a fila de TODOS os eventos quando a rede volta — antes a fila só subia com o
 *    leitor daquele evento aberto, e o porteiro que fechava o app levava a fila no bolso pra casa.
 *
 * As chaves do localStorage são as MESMAS do leitor: um lugar só pra cada coisa.
 */

export const CHAVE_EVENTOS = 'dt_portaria_eventos'
export const CHAVE_LOGADO = 'dt_portaria_logado'
const PREFIXO_FILA = 'dt_portaria_fila_'
const PREFIXO_LISTA = 'dt_portaria_lista_'
/** a mesma régua do leitor: lista com mais de 15 min, com rede, desce de novo */
const LOTE = 400

function ler<T>(chave: string, padrao: T): T {
  try {
    const cru = localStorage.getItem(chave)
    return cru ? JSON.parse(cru) as T : padrao
  } catch { return padrao }
}
function gravar(chave: string, valor: unknown) {
  try { localStorage.setItem(chave, JSON.stringify(valor)) } catch { /* cota cheia ou aba anônima */ }
}

/* ------------------------------------------------------------ eventos */

export type EventoGuardado = { id: string; nome: string; inicio: string; fim: string | null
  validados: number; faltam: number; aptos: number; comparecimentoPct: number }

export function guardarEventosDaPortaria(eventos: EventoGuardado[]) {
  gravar(CHAVE_EVENTOS, { em: new Date().toISOString(), eventos })
}
export function eventosGuardadosDaPortaria(): { em: string; eventos: EventoGuardado[] } | null {
  return ler(CHAVE_EVENTOS, null)
}

/* ------------------------------------------------------------- sessão */

/** O servidor disse que HÁ sessão: o aparelho lembra (só pra não mostrar login sem rede). */
export function lembrarLoginDaPortaria(nome: string) {
  gravar(CHAVE_LOGADO, { nome, em: new Date().toISOString() })
}
/** O servidor disse que NÃO há sessão (ou a pessoa saiu): esquece. */
export function esquecerLoginDaPortaria() {
  try { localStorage.removeItem(CHAVE_LOGADO) } catch { /* nada */ }
}
export function loginLembradoDaPortaria(): { nome: string; em: string } | null {
  return ler(CHAVE_LOGADO, null)
}

/* ----------------------------------------------- situação de cada evento */

export type SituacaoOffline = {
  /** quantos ingressos a lista guardada tem (0 = este aparelho não abriu o leitor com rede) */
  ingressos: number
  listaEm: string | null
  /** passagens lidas sem rede e ainda não enviadas */
  pendentes: number
}

export function situacaoOfflineDoEvento(id: string): SituacaoOffline {
  const lista = ler<{ em?: string; ingressos?: unknown[] } | null>(`${PREFIXO_LISTA}${id}`, null)
  const fila = ler<unknown[]>(`${PREFIXO_FILA}${id}`, [])
  return { ingressos: lista?.ingressos?.length ?? 0, listaEm: lista?.em ?? null, pendentes: fila.length }
}

/** Os eventos com fila parada neste aparelho — inclusive os que já sumiram da lista de abertos. */
export function filasPendentesDaPortaria(): { eventoId: string; pendentes: number }[] {
  const saida: { eventoId: string; pendentes: number }[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const chave = localStorage.key(i)
      if (!chave?.startsWith(PREFIXO_FILA)) continue
      const n = ler<unknown[]>(chave, []).length
      if (n) saida.push({ eventoId: chave.slice(PREFIXO_FILA.length), pendentes: n })
    }
  } catch { /* sem localStorage */ }
  return saida
}

/* ---------------------------------------------------------- sincronizar */

export type ResultadoDaSincronia = {
  enviadas: number
  conflitos: number
  /** o servidor respondeu 401: a sessão acabou e a fila espera o login */
  semSessao: boolean
  /** falhou por rede: tenta de novo depois */
  semRede: boolean
}

/**
 * Sobe a fila de todos os eventos, no MESMO formato do leitor (`/api/portaria/sincronizar`,
 * remessas de 400, tira da fila só o que o servidor confirmou). Não baixa lista — isso é do
 * leitor, que sabe juntar as marcas. Uma passagem enviada duas vezes (leitor aberto em outra aba)
 * volta "repetida" pelo id: uma pessoa, uma linha.
 */
export async function sincronizarFilasDaPortaria(deviceId: string): Promise<ResultadoDaSincronia> {
  const r: ResultadoDaSincronia = { enviadas: 0, conflitos: 0, semSessao: false, semRede: false }
  for (const { eventoId } of filasPendentesDaPortaria()) {
    const chave = `${PREFIXO_FILA}${eventoId}`
    for (;;) {
      const fila = ler<{ id: string }[]>(chave, [])
      if (!fila.length) break
      try {
        const resp = await $fetch<any>('/api/portaria/sincronizar', {
          method: 'POST', body: { eventId: eventoId, deviceId, fila: fila.slice(0, LOTE), comLista: false },
        })
        const respondidos = new Set<string>((resp?.itens ?? []).map((i: any) => i.id))
        // relida AGORA: o leitor pode ter gravado uma passagem nova enquanto a remessa viajava
        const atual = ler<{ id: string }[]>(chave, [])
        const resto = atual.filter((p) => !respondidos.has(p.id))
        gravar(chave, resto)
        r.enviadas += atual.length - resto.length
        r.conflitos += Number(resp?.resumo?.conflitos ?? 0)
        if (resto.length >= atual.length) break   // o servidor não respondeu por nada: não gira em vão
      } catch (e: any) {
        const status = Number(e?.statusCode ?? e?.status ?? e?.response?.status ?? 0)
        if (status === 401) r.semSessao = true
        else if (!status || status >= 502) r.semRede = true
        return r
      }
    }
  }
  return r
}

/** O id do aparelho — o mesmo que o leitor cria e usa (`dt_portaria_aparelho`). */
export function aparelhoDaPortaria(): string {
  try {
    let id = localStorage.getItem('dt_portaria_aparelho') ?? ''
    if (!id) {
      id = Math.random().toString(16).slice(2, 10)
      localStorage.setItem('dt_portaria_aparelho', id)
    }
    return id
  } catch { return 'sem-memoria' }
}
