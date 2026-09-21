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
export function baixarCsv(nome: string, cabecalho: string[], linhas: (string | number)[][]) {
  const escapa = (c: string | number) => `"${String(c ?? '').replace(/"/g, '""')}"`
  const csv = [cabecalho, ...linhas]
    .map((r) => r.map(escapa).join(';'))
    .join('\r\n')

  const url = URL.createObjectURL(
    new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = nome.endsWith('.csv') ? nome : `${nome}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
