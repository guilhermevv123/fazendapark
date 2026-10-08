/**
 * pessoas-do-tipo.ts — quantas PESSOAS um ingresso do tipo leva (048).
 *
 * Dono, 08/10: o combo "é um ingresso que conta como 10, 15" — e a catraca e o painel contavam 1. A
 * coluna é `ticket_types.admits` (NULL = a do setor). Arquivo PURO: a tela usa a sugestão pelo nome,
 * o servidor usa o teto, e a conta da porta é SQL (`COALESCE(tt.admits, s.admits)` em `catraca.ts`).
 */

/** o teto da coluna (CHECK da 048) */
export const MAX_PESSOAS_DO_TIPO = 100

/**
 * O número de pessoas que o NOME do tipo diz: "COMBO 10 PESSOAS" → 10, "COMBO SEXTA - COMBO 15" → 15,
 * "Mesa p/ 4 pessoas" → 4. Nome sem número de pessoas → `null` (é só sugestão: quem grava é o Salvar).
 */
export function pessoasPeloNome(nome: string | null | undefined): number | null {
  const n = String(nome ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
  const m = n.match(/\b(\d{1,3})\s*(?:PESSOAS?|PAX)\b/) ?? n.match(/\bCOMBO\s*(?:DE\s*)?(\d{1,3})\b/)
  const v = m ? Number(m[1]) : NaN
  return Number.isInteger(v) && v >= 2 && v <= MAX_PESSOAS_DO_TIPO ? v : null
}

/** "conta 10 pessoas" — o selo da lista; `null` quando o tipo segue o setor */
export function seloDePessoas(pessoas: number | null | undefined): string | null {
  const v = Number(pessoas)
  return Number.isInteger(v) && v > 1 ? `conta ${v} pessoas` : null
}
