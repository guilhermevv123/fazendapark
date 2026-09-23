/**
 * baixarCsv — exportação de tabela, num lugar só.
 *
 * Três detalhes que decidem se o arquivo abre certo no Excel brasileiro, e
 * que toda cópia solta desse código acaba perdendo um de cada vez:
 *
 * - **separador `;`** — o Excel em pt-BR usa vírgula como decimal, então com
 *   `,` de separador ele joga a planilha inteira numa coluna só;
 * - **BOM (`﻿`)** — sem ele o Excel lê o arquivo como latin-1 e todo
 *   acento vira caractere quebrado;
 * - **`\r\n`** — quebra de linha que o Excel antigo entende.
 *
 * Número vai como texto já formatado em pt-BR de propósito: o CSV aqui é pra
 * humano ler e conferir, não pra outro sistema importar.
 */
/**
 * Começo de célula que a planilha lê como FÓRMULA (`=`, `+`, `-`, `@`) — e o
 * tab/`\r`, que alguns leitores descartam antes de olhar o resto.
 */
const INICIO_DE_FORMULA = /^[=+\-@\t\r]/

/**
 * Número/dinheiro já formatado pra gente ler ("-12", "-1.234,56",
 * "-R$ 10,00", "+5%"): começa com sinal, mas não tem letra de função nem
 * parêntese — não dá pra montar fórmula perigosa com isso, e prefixar
 * estragaria o valor negativo que o relatório mostra de propósito.
 */
const NUMERO_LEGIVEL = /^[+-]?\s*(R\$\s*)?[\d.,]+\s*%?$/

/**
 * Uma célula do CSV, pronta pra ir entre `;`.
 *
 * **Injeção de fórmula.** Nome de cliente é texto livre no checkout público:
 * `=HYPERLINK("http://…";"clique")` virava link clicável no Excel de quem
 * abre a exportação, e `=cmd|…` é a porta pra coisa pior. Texto que começa
 * como fórmula ganha um `'` na frente, que a planilha trata como "isto é
 * texto". `number` de verdade passa direto — só string é suspeita.
 */
export function celulaCsv(c: string | number | null | undefined): string {
  let t = String(c ?? '')
  if (typeof c === 'string' && INICIO_DE_FORMULA.test(t) && !NUMERO_LEGIVEL.test(t)) t = `'${t}`
  return `"${t.replace(/"/g, '""')}"`
}

export function baixarCsv(nome: string, cabecalho: string[], linhas: (string | number)[][]) {
  const csv = [cabecalho, ...linhas]
    .map((r) => r.map(celulaCsv).join(';'))
    .join('\r\n')

  const url = URL.createObjectURL(
    new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = nome.endsWith('.csv') ? nome : `${nome}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
