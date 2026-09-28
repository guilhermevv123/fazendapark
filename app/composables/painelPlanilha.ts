/**
 * painelPlanilha.ts — dinheiro que a planilha SOMA.
 *
 * `baixarCsv` escreve o texto como vier, e a tela mandava `reais(c)` ("R$ 1.234,56"): o Excel
 * brasileiro abre isso como TEXTO e a coluna não soma (auditoria REL-11). Aqui o valor sai como o
 * Excel em pt-BR lê número — vírgula decimal, sem milhar e sem `R$` (o cabeçalho da coluna diz que
 * é em reais). Conta inteira, sem float: o mesmo cuidado de `centavosParaTexto`.
 */
export function centavosParaPlanilha(cents: number | null | undefined): string {
  const v = Math.round(Number(cents ?? 0))
  if (!Number.isFinite(v)) return ''
  const abs = Math.abs(v)
  return `${v < 0 ? '-' : ''}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`
}
