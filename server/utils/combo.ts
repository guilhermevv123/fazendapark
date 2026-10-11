/**
 * Combo vira N ingressos, um por pessoa (050). Dono, 08/10: "tem que aparecer os 10, porque ele vai
 * invalidando ingresso por ingresso ... saber esse combo aqui, 9 pessoas foram, 1 não foi".
 *
 * Quem decide se um item emite partes é o TIPO (`ticket_types.admits`, 048) — a mesa de 4 do setor
 * (`sectors.admits`) segue um ingresso só, com 4 pessoas. O estoque continua por unidade.
 */

/** quantos ingressos UMA unidade do tipo emite: o combo de 10 emite 10; o resto, 1 */
export function partesPorUnidade(admitsDoTipo: unknown): number {
  const n = Math.floor(Number(admitsDoTipo))
  return Number.isFinite(n) && n >= 2 && n <= 100 ? n : 1
}

/**
 * Pessoas de UM ingresso, em SQL: a coluna do ingresso (parte de combo = 1), senão o tipo, senão o
 * setor. Pede `t` = tickets, `tt` = ticket_types (LEFT JOIN) e `s` = sectors no FROM.
 */
export const SQL_PESSOAS_DO_INGRESSO = 'COALESCE(t.people, tt.admits, s.admits, 1)'

/**
 * A UNIDADE vendida de um ingresso, em SQL: as partes de um combo são uma unidade só (a do estoque,
 * `lots.sold`). Pra contar vendas por ingresso: `count(DISTINCT ${SQL_UNIDADE_DO_INGRESSO})`.
 * Pede `t` = tickets no FROM (ou troque o prefixo com `unidadeDoIngresso('k')`).
 */
export const SQL_UNIDADE_DO_INGRESSO = 'COALESCE(t.combo_group, t.id)'
export const unidadeDoIngresso = (alias: string) => `COALESCE(${alias}.combo_group, ${alias}.id)`

/** "pessoa 3 de 10" — o rótulo da parte no ingresso, no PDF e na porta */
export function rotuloDaParte(seq: unknown, tamanho: unknown): string | null {
  const k = Number(seq), n = Number(tamanho)
  return Number.isInteger(k) && Number.isInteger(n) && n >= 2 && k >= 1 && k <= n ? `pessoa ${k} de ${n}` : null
}

/**
 * QR do COMBO INTEIRO (portaria, 10/10): "um QR Code só pra ler os 10, só que lá explicando que é
 * combo de 10 ... quando lê, lê automaticamente tudo". O ingresso mostra, além dos N QRs (um por
 * pessoa, pra quem chega separado), UM QR do grupo: o código de uma parte + `-COMBO`, assinado como
 * qualquer código. Lido na porta, entram de uma vez todas as partes que ainda não entraram — cada
 * uma continua sendo o seu ingresso, com a sua passagem no livro ("9 de 10 entraram" segue valendo).
 */
export const SUFIXO_DO_COMBO_INTEIRO = '-COMBO'

/** o código que vai no QR do combo inteiro, a partir do código de uma parte */
export const codigoDoComboInteiro = (codigoDaParte: string) => `${codigoDaParte}${SUFIXO_DO_COMBO_INTEIRO}`

/** "ING-ABCD-EFGH-COMBO" → "ING-ABCD-EFGH"; qualquer outro código → null */
export function parteDoComboInteiro(codigo: unknown): string | null {
  const c = String(codigo ?? '').trim().toUpperCase()
  return c.length > SUFIXO_DO_COMBO_INTEIRO.length && c.endsWith(SUFIXO_DO_COMBO_INTEIRO)
    ? c.slice(0, -SUFIXO_DO_COMBO_INTEIRO.length) : null
}

export interface ParteNoPedido {
  id: string; code: string; status: string
  combo_group?: string | null; combo_seq?: number | string | null; combo_size?: number | string | null
  /** transferida pra outra pessoa (aceita): é do destinatário, não entra pelo QR do grupo */
  transferido?: boolean
}

export interface ComboNoPedido {
  grupo: string
  /** pessoas do combo (as partes emitidas) */
  tamanho: number
  /** partes que o QR do grupo ainda leva pra dentro: válidas, de quem comprou */
  restam: number
  /** a parte cujo código vai dentro do QR do grupo (a de menor número que ainda vale) */
  ticketId: string
  codigoDaParte: string
  /** o código impresso debaixo do QR do grupo: `<código da parte>-COMBO` */
  codigo: string
  /** o ingresso da lista ANTES do qual o cartão do combo aparece (o primeiro do grupo) */
  antesDe: string
}

/**
 * Os combos de um pedido que ganham o QR do grupo: os que ainda levam 2 ou mais pessoas pra
 * dentro (com 1 só, o QR da pessoa já resolve). `partes` na ordem em que o ingresso as mostra.
 */
export function combosDoPedido(partes: ParteNoPedido[]): ComboNoPedido[] {
  const porGrupo = new Map<string, ParteNoPedido[]>()
  for (const t of partes) {
    if (!t.combo_group) continue
    const g = porGrupo.get(t.combo_group) ?? []
    g.push(t)
    porGrupo.set(t.combo_group, g)
  }
  const saida: ComboNoPedido[] = []
  for (const [grupo, g] of porGrupo) {
    const vivas = g.filter((t) => t.status === 'valido' && !t.transferido)
      .sort((a, b) => Number(a.combo_seq) - Number(b.combo_seq))
    if (vivas.length < 2) continue
    const base = vivas[0]!
    saida.push({ grupo, tamanho: Number(g[0]!.combo_size ?? g.length) || g.length, restam: vivas.length,
                 ticketId: base.id, codigoDaParte: base.code, codigo: codigoDoComboInteiro(base.code),
                 antesDe: g[0]!.id })
  }
  return saida
}
