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
