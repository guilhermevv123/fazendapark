// @vitest-environment happy-dom
/**
 * A tabela que vira cartão no celular (base.css `tabela-cartoes` + plugin). O que a régua garante
 * (dono, 08/10: "tenho que passar por lado"): cada célula leva o título da SUA coluna, contando
 * colspan; a célula com rótulo posto à mão fica como está; a coluna "Ações" fica sem rótulo (os
 * botões ganham a largura do cartão); e a linha que muda (recarregou, expandiu) é rotulada de novo.
 */
import { beforeAll, describe, expect, it } from 'vitest'

// o plugin é um arquivo do Nuxt: fora dele, `defineNuxtPlugin` só devolve a função
let rotular: (t: HTMLTableElement) => void
beforeAll(async () => {
  ;(globalThis as any).defineNuxtPlugin ??= (f: any) => f
  rotular = (await import('../plugins/tabela-cartoes.client')).rotular
})

function tabela(html: string) {
  const t = document.createElement('table')
  t.className = 'tabela-cartoes'
  t.innerHTML = html
  document.body.appendChild(t)
  return t
}
const rotulos = (tr: Element) => Array.from(tr.querySelectorAll(':scope > td')).map((c) => c.getAttribute('data-rotulo'))
const linha = (t: HTMLTableElement, i: number) => t.querySelectorAll('tbody > tr')[i]!

describe('rótulos da tabela-cartão', () => {
  it('cada célula ganha o título da coluna; colspan junta e fica sem rótulo', () => {
    const t = tabela(`
      <thead><tr><th></th><th>Lote</th><th colspan="2">Valor</th><th>Ações</th></tr></thead>
      <tbody>
        <tr><td>›</td><td>1º lote</td><td>R$ 20</td><td>face</td><td>✎</td></tr>
        <tr><td></td><td colspan="4">cota da meia</td></tr>
      </tbody>`)
    rotular(t)
    expect(rotulos(linha(t, 0))).toEqual(['', 'Lote', 'Valor', 'Valor', ''])
    expect(rotulos(linha(t, 1))).toEqual(['', ''])
  })

  it('rótulo posto à mão não é trocado; linha nova ganha rótulo na passada seguinte', () => {
    const t = tabela(`
      <thead><tr><th>Lote</th><th>Vendido + Pendente</th></tr></thead>
      <tbody><tr><td data-rotulo="">Inteira</td><td>530</td></tr></tbody>`)
    rotular(t)
    expect(rotulos(linha(t, 0))).toEqual(['', 'Vendido + Pendente'])
    const nova = document.createElement('tr')
    for (const texto of ['Meia', '0']) nova.appendChild(document.createElement('td')).textContent = texto
    t.querySelector('tbody')!.appendChild(nova)
    rotular(t)
    expect(rotulos(linha(t, 1))).toEqual(['Lote', 'Vendido + Pendente'])
  })
})
