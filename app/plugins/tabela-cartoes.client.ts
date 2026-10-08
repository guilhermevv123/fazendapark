/**
 * Rótulo das células pra `table.tabela-cartoes` (base.css): no celular a tabela vira cartão, e
 * cada célula mostra o título da sua coluna ao lado do valor. O título está no <thead>; aqui ele é
 * copiado pra `data-rotulo` de cada célula pela posição (contando colspan).
 *
 * Célula com `data-rotulo` posto à mão fica como está (`data-rotulo=""` = sem rótulo, largura
 * toda). Célula que junta colunas (colspan > 1) fica sem rótulo — não é de coluna nenhuma.
 *
 * Observa o documento porque as linhas mudam depois de montar (recarregar, expandir lote,
 * paginar). Agenda com setTimeout, não requestAnimationFrame: rAF congela com a aba escondida.
 */
const MARCA = 'data-rotulo-auto'

export function rotular(tabela: HTMLTableElement) {
  // querySelectorAll, não tHead.rows/tBodies/cells: o mesmo caminho em todo navegador (e no happy-dom)
  const linhasDoCab = tabela.querySelectorAll(':scope > thead > tr')
  const cab = linhasDoCab[linhasDoCab.length - 1]
  if (!cab) return
  const titulos: string[] = []
  for (const th of Array.from(cab.querySelectorAll<HTMLTableCellElement>(':scope > th, :scope > td'))) {
    let t = (th.textContent ?? '').replace(/\s+/g, ' ').trim()
    // a coluna dos botões não precisa de rótulo: a fila de ícones ganha a largura toda do cartão
    if (/^a[cç][oõ]es$/i.test(t)) t = ''
    for (let i = 0; i < (Number(th.getAttribute('colspan')) || 1); i++) titulos.push(t)
  }
  for (const linha of Array.from(tabela.querySelectorAll(':scope > tbody > tr, :scope > tfoot > tr'))) {
    let col = 0
    for (const cel of Array.from(linha.querySelectorAll<HTMLTableCellElement>(':scope > td, :scope > th'))) {
      const span = Number(cel.getAttribute('colspan')) || 1
      const manual = cel.hasAttribute('data-rotulo') && !cel.hasAttribute(MARCA)
      if (!manual) {
        const rotulo = span > 1 ? '' : (titulos[col] ?? '')
        if (cel.getAttribute('data-rotulo') !== rotulo) cel.setAttribute('data-rotulo', rotulo)
        if (!cel.hasAttribute(MARCA)) cel.setAttribute(MARCA, '')
      }
      col += span
    }
  }
}

export default defineNuxtPlugin(() => {
  let agendado: ReturnType<typeof setTimeout> | null = null
  const passar = () => {
    agendado = null
    for (const t of Array.from(document.querySelectorAll<HTMLTableElement>('table.tabela-cartoes'))) rotular(t)
  }
  const agendar = () => { if (!agendado) agendado = setTimeout(passar, 30) }
  const obs = new MutationObserver((mudancas) => {
    // o próprio setAttribute do rótulo não reagenda (é atributo, e só childList/characterData importam)
    if (mudancas.some((m) => m.type === 'childList' || m.type === 'characterData')) agendar()
  })
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
  agendar()
})
