/**
 * retencao.ts — quando o dinheiro do ingresso fica disponível pro produtor.
 *
 * Mora sozinho porque três lugares precisam da MESMA resposta: a tela do
 * financeiro (que mostra "retido até X"), a rota que aceita o pedido de saque
 * (que recusa antes da data) e o borderô (que separa o que já é sacável).
 * Quando essa regra vive dentro de uma das três, as outras duas copiam — e a
 * cópia envelhece: a tela diz "liberado" e o saque responde 409.
 *
 * A regra: o dinheiro libera DIAS_DE_RETENCAO dias depois do FIM do evento.
 * Não da venda. Antes do evento acontecer, cancelamento significa devolver
 * tudo, e o dinheiro precisa estar em pé pra isso — quem libera antes devolve
 * do próprio bolso quando o evento não acontece.
 */
export const DIAS_DE_RETENCAO = 2

/** Trecho SQL que calcula a data de liberação a partir de uma coluna de fim. */
export const SQL_LIBERA_EM = (coluna = 'ends_at') =>
  `${coluna} + interval '${DIAS_DE_RETENCAO} days'`

/** Mesmo cálculo em JS, pra quem já tem a data em mãos. */
export function liberaEm(fimDoEvento: Date | string): Date {
  const d = new Date(fimDoEvento)
  d.setDate(d.getDate() + DIAS_DE_RETENCAO)
  return d
}

export function jaLiberou(fimDoEvento: Date | string, agora = new Date()): boolean {
  return agora >= liberaEm(fimDoEvento)
}
