/**
 * A origem da visita, guardada no navegador (052). Quem chega pelo link do anúncio
 * (`?utm_source=…&utm_campaign=…`, ou com o `fbclid`/`gclid` que a Meta e o Google põem no clique)
 * traz a origem na URL — e a perde no primeiro clique dentro do site. Aqui ela fica guardada por
 * 30 dias e vai junto com o pedido: o relatório diz quanto o tráfego pago vendeu.
 *
 * - **Último toque com informação**: a chegada mais recente que trouxe UTM, clique de anúncio ou
 *   site externo. Voltar digitando o endereço NÃO apaga (quem viu o anúncio segunda e comprou
 *   quarta continua sendo do anúncio).
 * - **Primeiro toque**: a primeira chegada com informação, pra saber quem abriu a porta.
 *
 * Armazenamento bloqueado (aba anônima, app com navegador embutido): fica na memória da aba; nada
 * aqui pode quebrar a compra.
 */
import { origemDaUrl, type Origem } from '~~/server/utils/origem'

const CHAVE = 'dt_origem'
const CHAVE_VISITANTE = 'dt_visitante'
const CHAVE_ABA = 'dt_aba'
const VALIDADE_MS = 30 * 24 * 3600_000
const memoria = new Map<string, string>()

function ler(chave: string, sessao = false): string | null {
  if (import.meta.server) return null
  try {
    const v = (sessao ? sessionStorage : localStorage).getItem(chave)
    if (v != null) return v
  } catch { /* bloqueado: vale a memória */ }
  return memoria.get(chave) ?? null
}
function gravar(chave: string, valor: string, sessao = false) {
  if (import.meta.server) return
  memoria.set(chave, valor)
  try { (sessao ? sessionStorage : localStorage).setItem(chave, valor) } catch { /* fica na memória */ }
}

/** id aleatório (o tablet em http na LAN não tem `crypto.randomUUID`) */
export function idAleatorio(): string {
  let s = Date.now().toString(36)
  while (s.length < 24) s += Math.random().toString(36).slice(2)
  return s.slice(0, 32)
}

export interface OrigemGuardada { ultimo: Origem | null; primeiro: Origem | null }

const vencida = (o: Origem | null | undefined) =>
  !o?.em || Number.isNaN(Date.parse(o.em)) || Date.now() - Date.parse(o.em) > VALIDADE_MS

/** a origem guardada (só a que ainda vale): é o que vai no corpo do checkout */
export function origemGuardada(): OrigemGuardada {
  try {
    const g = JSON.parse(ler(CHAVE) ?? 'null') as OrigemGuardada | null
    return { ultimo: g && !vencida(g.ultimo) ? g.ultimo : null, primeiro: g && !vencida(g.primeiro) ? g.primeiro : null }
  } catch {
    return { ultimo: null, primeiro: null }
  }
}

/** registra a chegada desta URL; devolve a origem DESTA chegada (ou null quando ela não diz nada) */
export function registrarChegada(query: Record<string, unknown>, referencia: string | null, entrada: string): Origem | null {
  const agora = new Date().toISOString()
  const o = origemDaUrl(query, referencia, { entrada, nossoHost: import.meta.client ? location.hostname : null, em: agora })
  if (!o) return null
  const g = origemGuardada()
  gravar(CHAVE, JSON.stringify({ ultimo: o, primeiro: g.primeiro ?? o }))
  return o
}

/** o visitante (navegador) e a aba — uma visita por aba aberta */
export function idsDaVisita(): { visitante: string; aba: string; novaAba: boolean } {
  let visitante = ler(CHAVE_VISITANTE)
  if (!visitante) { visitante = idAleatorio(); gravar(CHAVE_VISITANTE, visitante) }
  let aba = ler(CHAVE_ABA, true)
  const novaAba = !aba
  if (!aba) { aba = idAleatorio(); gravar(CHAVE_ABA, aba, true) }
  return { visitante, aba, novaAba }
}

/** páginas da equipe não contam como visita do público */
export const PAGINA_DA_EQUIPE = /^\/(admin|portaria|entrar|redefinir-senha|consumo)(\/|$)/
