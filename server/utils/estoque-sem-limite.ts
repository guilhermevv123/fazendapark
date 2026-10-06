/**
 * Ingresso SEM limite de quantidade (dono, 06/10: "esse sistema não vai ter isso de quantidade, vai
 * ser infinito; o lote só fecha se a pessoa quiser").
 *
 * "Sem limite" é a quantidade máxima que o sistema já aceita (1.000.000), e não `NULL`: o motor de
 * estoque (reserva atômica, CHECK sold+reserved<=quantity, faxina de carrinho, giro de lote) segue
 * igual e testado — só nunca chega no teto. O que muda é a TELA: todo lugar que mostra quantidade,
 * "disponível", ocupação ou % passa por aqui e diz "Sem limite" em vez de "999.950 de 1.000.000".
 *
 * O lote fecha à mão: ✓/✗ na linha do lote (visível) ou "Fecha em" (data). A cota legal de meia
 * (40% da quantidade) vira 400.000 — na prática, meia sem limite, que a Lei 12.933 permite (ela
 * garante o mínimo de 40%; não obriga a limitar).
 */
export const ESTOQUE_SEM_LIMITE = 1_000_000

/**
 * Quantidade OU "disponível" de lote/tipo sem limite (o legado com número de verdade continua
 * aparecendo). Corta na metade do teto porque o disponível de um lote sem limite cai de 1.000.000
 * a cada venda (999.999 depois da primeira) — e nenhum evento de verdade passa de 500 mil lugares.
 */
export function estoqueSemLimite(quantidade: number | null | undefined): boolean {
  return quantidade != null && Number(quantidade) >= ESTOQUE_SEM_LIMITE / 2
}

/** "Sem limite" ou o número, pra tela */
export function quantidadeNaTela(quantidade: number | null | undefined): string {
  if (quantidade == null) return '—'
  return estoqueSemLimite(quantidade) ? 'Sem limite' : Number(quantidade).toLocaleString('pt-BR')
}
