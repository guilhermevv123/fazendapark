/**
 * O tablet da comanda trabalhando SEM internet (055).
 *
 * Com rede, o tablet guarda a cada poucos segundos uma cópia do que precisa (cardápio,
 * pontos, e as contas abertas com a pulseira de cada uma). Sem rede, ele usa essa cópia:
 * lê a pulseira, mostra o nome do cliente e o total APROXIMADO, e o pedido vai pra uma FILA
 * guardada no próprio tablet (localStorage: sobrevive a recarregar, travar, acabar a bateria).
 *
 * Quando a rede volta, a fila sobe sozinha, na ordem em que foi feita. Cada pedido leva um
 * `idLocal` criado aqui: o servidor grava cada um UMA vez, por mais que o tablet reenvie.
 * Pedido só sai da fila quando o servidor responde que gravou (ou que já tinha gravado).
 *
 * Abrir conta precisa de rede (é a confirmação do contato que segura a cobrança).
 */
import { ref } from 'vue'

const CHAVE_ESTADO = 'dt_comanda_estado'
const CHAVE_FILA = 'dt_comanda_fila'
const CHAVE_APARELHO = 'dt_comanda_aparelho'
const CHAVE_PROBLEMAS = 'dt_comanda_problemas'

export interface ItemDoCardapio { id: string; categoriaId: string; nome: string; icone?: string | null; precoCents: number; maior18: boolean; esgotado: boolean }
export interface ContaGuardada { id: string; numero: number; nome: string; responsavelNome: string; limiteCents: number; menorDeIdade: boolean; totalCents: number; pulseira: string | null }
export interface EstadoDoTablet {
  agora: string
  eu: { nome: string; nivel: 'atendente' | 'caixa' | 'gerente'; master: boolean }
  config: { ativo: boolean; limitePadraoCents: number; atendenteFechaConta: boolean; minutosParaDesfazer: number; avisoContaAltaCents: number; exigeCodigoWhatsapp: boolean }
  pontos: { id: string; nome: string; categorias: string[] | null }[]
  categorias: { id: string; nome: string; icone?: string | null }[]
  itens: ItemDoCardapio[]
  contas: ContaGuardada[]
}

export interface PedidoNaFila {
  pedido: {
    idLocal: string; uid?: string | null; comandaId?: string | null; itens: { itemId: string; quantidade: number }[]
    mesa?: string | null; cliente?: string | null; observacao?: string | null; pontoId?: string | null; feitoEm: string; semInternet: true
  }
  nome: string
  valorCents: number
  resumo: string
  tentativas: number
}

export interface ProblemaDaFila { pedido: PedidoNaFila; mensagem: string; em: string }

function ler<T>(chave: string, padrao: T): T {
  try {
    const t = localStorage.getItem(chave)
    return t ? (JSON.parse(t) as T) : padrao
  } catch { return padrao }
}
function gravar(chave: string, v: unknown) {
  try { localStorage.setItem(chave, JSON.stringify(v)) } catch { /* cheio: a tela avisa pela fila */ }
}

/** Identidade deste tablet (vai no cabeçalho `x-aparelho` e no `idLocal`). */
export function aparelho(): string {
  let a = ''
  try { a = localStorage.getItem(CHAVE_APARELHO) ?? '' } catch { /* modo anônimo */ }
  if (!a) {
    a = 'tab-' + Math.random().toString(36).slice(2, 8)
    try { localStorage.setItem(CHAVE_APARELHO, a) } catch { /* segue sem gravar */ }
  }
  return a
}

export function novoIdLocal(): string {
  const r = crypto?.getRandomValues ? Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('') : Math.random().toString(16).slice(2, 14)
  return `${aparelho()}-${Date.now().toString(36)}-${r}`
}

export const estadoGuardado = () => ler<EstadoDoTablet | null>(CHAVE_ESTADO, null)
export const guardarEstado = (e: EstadoDoTablet) => gravar(CHAVE_ESTADO, e)
export const filaDoTablet = () => ler<PedidoNaFila[]>(CHAVE_FILA, [])
export const problemasDaFila = () => ler<ProblemaDaFila[]>(CHAVE_PROBLEMAS, [])

export function enfileirar(p: PedidoNaFila) {
  const fila = filaDoTablet()
  if (!fila.some((f) => f.pedido.idLocal === p.pedido.idLocal)) fila.push(p)
  gravar(CHAVE_FILA, fila)
}

export function descartarProblema(idLocal: string) {
  gravar(CHAVE_PROBLEMAS, problemasDaFila().filter((p) => p.pedido.pedido.idLocal !== idLocal))
}

/** A conta (da cópia guardada) a que a pulseira aponta — o que se mostra sem internet. */
export function contaDaPulseiraGuardada(uid: string): ContaGuardada | null {
  const e = estadoGuardado()
  return e?.contas.find((c) => c.pulseira === uid) ?? null
}

/** `$fetch` com a identidade do tablet e um tempo máximo (rede ruim ≠ rede ausente). */
export function chamar<T>(url: string, opcoes: Record<string, any> = {}): Promise<T> {
  return $fetch<T>(url, {
    timeout: 8000,
    retry: 0,
    ...opcoes,
    headers: {
      'x-aparelho': aparelho(),
      ...(opcoes.headers ?? {}),
    },
  }) as Promise<T>
}

/** Foi falta de rede (e não uma recusa do servidor)? Aí o pedido vai pra fila. */
export function ehFaltaDeRede(e: any): boolean {
  const status = Number(e?.statusCode ?? e?.status ?? e?.response?.status ?? 0)
  return !status || status >= 502 || e?.name === 'FetchError' && !e?.response
}

export function mensagemDoErro(e: any, padrao = 'Não deu certo. Tente de novo.'): string {
  return e?.data?.statusMessage || e?.data?.message || e?.statusMessage || padrao
}

/* ------------------------------------------------------------------ sincronia */

export const online = ref(true)
export const pendentes = ref(0)
export const problemas = ref(0)
export const ultimaSincronia = ref<string | null>(null)
/** a última cópia boa do estado (da rede ou, sem rede, a guardada no tablet) */
export const estado = ref<EstadoDoTablet | null>(null)
/** a tela pede a largura toda (cardápio): a faixa de cima acompanha; nas outras fica no meio, alinhada */
export const faixaLarga = ref(false)
/**
 * As telas estão rodando no app Android do tablet (`app-tablet/`), não no painel do site: lá não
 * existe `/admin` nem `/entrar` (o app tem o login dele, com o e-mail e a senha do sistema).
 */
export const noAppDoTablet = ref(false)
let rodando = false

/**
 * Sobe a fila (se houver) e baixa a cópia nova. Chamado a cada poucos segundos pelo layout.
 * Devolve o estado novo, ou `null` se não houve rede.
 */
export async function sincronizar(): Promise<EstadoDoTablet | null> {
  if (rodando) return null
  rodando = true
  try {
    const fila = filaDoTablet()
    if (fila.length) {
      const r = await chamar<{ resultados: any[] }>('/api/comandas/pedidos', { method: 'POST', body: { pedidos: fila.map((f) => f.pedido) } })
      const porId = new Map(r.resultados.map((x) => [x.idLocal, x]))
      // Relê a fila DEPOIS da resposta: enquanto o POST esperava (até 8 s), o atendente pode ter
      // guardado pedido novo — gravar a cópia antiga apagaria esse pedido. Só sai da fila quem
      // teve resposta; o resto (inclusive o que entrou agora) fica.
      const enviados = new Set(fila.map((f) => f.pedido.idLocal))
      const restam: PedidoNaFila[] = []
      const recusados: ProblemaDaFila[] = []
      for (const f of filaDoTablet()) {
        const res = porId.get(f.pedido.idLocal)
        if (res?.ok) continue
        if (res && !res.ok) {
          // o servidor RECUSOU (não é falta de rede): sai da fila e vai pra lista de problemas,
          // que a tela mostra até alguém resolver — nunca some calado
          recusados.push({ pedido: f, mensagem: res.mensagem, em: new Date().toISOString() })
          continue
        }
        restam.push(enviados.has(f.pedido.idLocal) ? { ...f, tentativas: f.tentativas + 1 } : f)
      }
      gravar(CHAVE_FILA, restam)
      if (recusados.length) gravar(CHAVE_PROBLEMAS, [...problemasDaFila(), ...recusados])
    }
    const novo = await chamar<EstadoDoTablet>('/api/comandas/estado', { query: { pendentes: filaDoTablet().length } })
    guardarEstado(novo)
    estado.value = novo
    online.value = true
    ultimaSincronia.value = new Date().toISOString()
    return novo
  } catch (e: any) {
    if (ehFaltaDeRede(e)) {
      online.value = false
      estado.value = estado.value ?? estadoGuardado()
    } else throw e
    return null
  } finally {
    pendentes.value = filaDoTablet().length
    problemas.value = problemasDaFila().length
    rodando = false
  }
}
