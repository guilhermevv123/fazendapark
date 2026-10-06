/**
 * Página aberta numa versão VELHA do site (dono, 06/10, com o console cheio de 404 e "Failed to
 * fetch dynamically imported module"): cada subida troca os arquivos de /_nuxt/, e a aba que já
 * estava aberta continua pedindo os antigos — que não existem mais. A tela trava pela metade (o
 * Pix "sendo gerado" pra sempre, botão que não responde).
 *
 * O conserto é o que o navegador faria se a pessoa apertasse F5: recarregar UMA vez. Pedido em
 * andamento sobrevive (mora no sessionStorage) e o cartão digitado nunca é guardado, então nada
 * se perde além do que estava sendo digitado. A trava de 20 s impede recarregar em laço se o
 * problema for outro (rede caída, por exemplo).
 */
const CHAVE = 'dt-recarregou-versao-velha'
const MSG = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i

export default defineNuxtPlugin((nuxtApp) => {
  const recarregar = () => {
    try {
      const ultima = Number(sessionStorage.getItem(CHAVE) || 0)
      if (Date.now() - ultima < 20_000) return
      sessionStorage.setItem(CHAVE, String(Date.now()))
    } catch { /* sem sessionStorage: recarrega mesmo assim, o navegador segura o laço */ }
    window.location.reload()
  }
  window.addEventListener('vite:preloadError', (e) => { e.preventDefault(); recarregar() })
  window.addEventListener('unhandledrejection', (e) => {
    if (MSG.test(String((e.reason as any)?.message ?? e.reason ?? ''))) recarregar()
  })
  nuxtApp.hook('app:chunkError', () => recarregar())
})
