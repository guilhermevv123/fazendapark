/**
 * Pra onde o login manda a pessoa depois de entrar (`/entrar?de=…`).
 *
 * Só destino DESTA casa: `?de=https://outro.site` transformaria a tela de login num
 * redirecionador aberto — prato feito pra phishing ("entre no painel do parque" que termina num
 * site falso). A checagem antiga (`começa com / e não com //`) deixava passar `/\outro.site`: o
 * navegador lê a barra invertida como barra, e o `navigateTo` recusava o destino externo LANÇANDO
 * erro — a tela dizia "Não foi possível entrar." com a sessão já criada (auditoria 27/09, B27).
 *
 * A régua agora é a do próprio navegador: resolve o destino contra a origem da página e só aceita
 * se a origem continuar a mesma. Qualquer outra coisa vira `/admin`, sem erro na tela.
 */
export const DESTINO_PADRAO = '/admin'

export function destinoDoLogin(de: unknown, origem: string): string {
  if (typeof de !== 'string' || !de.trim()) return DESTINO_PADRAO
  const cru = de.trim()
  // controle (tab, quebra de linha, NUL) nunca faz parte de um caminho de verdade
  if (/[\u0000-\u001f\u007f]/.test(cru)) return DESTINO_PADRAO
  if (!cru.startsWith('/') || cru.startsWith('//') || cru.startsWith('/\\')) return DESTINO_PADRAO
  let url: URL
  try {
    url = new URL(cru, origem)
  } catch {
    return DESTINO_PADRAO
  }
  if (url.origin !== new URL(origem).origin) return DESTINO_PADRAO
  return `${url.pathname}${url.search}${url.hash}` || DESTINO_PADRAO
}
