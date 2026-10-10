/**
 * O `sessionStorage` da aba, com rede de segurança (10/10/2026).
 *
 * Navegador com cookies/armazenamento bloqueado, aba com a cota cheia ou
 * navegador embutido de app LANÇA erro ao mexer no `sessionStorage`. O clique em
 * "Pagar" da vitrine gravava o carrinho sem `try`: o erro matava o clique em
 * silêncio e o comprador ficava parado na vitrine (relato de cliente, 10/10 —
 * reproduzido com `setItem` falhando). No pagamento, o mesmo erro logo depois do
 * checkout deixava o pedido criado e a tela no "deu erro".
 *
 * Com o `sessionStorage` funcionando, tudo é exatamente como antes (inclusive o
 * F5). Só quando a gravação FALHA o valor fica numa cópia em memória da aba — a
 * ida da vitrine pro pagamento é navegação dentro do app (a página não
 * recarrega), então a memória chega lá.
 */
const naoGravou = new Map<string, string>()

export function lerDaAba(chave: string): string | null {
  if (import.meta.server) return null
  if (naoGravou.has(chave)) return naoGravou.get(chave) ?? null
  try { return sessionStorage.getItem(chave) } catch { return null }
}

export function gravarNaAba(chave: string, valor: string): void {
  if (import.meta.server) return
  try {
    sessionStorage.setItem(chave, valor)
    naoGravou.delete(chave)
  } catch {
    naoGravou.set(chave, valor)
    // o valor velho que ficou lá não pode ressuscitar depois de um F5
    try { sessionStorage.removeItem(chave) } catch { /* armazenamento bloqueado: fica só a memória */ }
  }
}

export function apagarDaAba(chave: string): void {
  if (import.meta.server) return
  naoGravou.delete(chave)
  try { sessionStorage.removeItem(chave) } catch { /* armazenamento bloqueado: a memória já saiu */ }
}
