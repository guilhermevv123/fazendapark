/**
 * painelFoco.ts — o que todo painel por cima da tela (a gaveta do menu no celular, o
 * `<ModalLateral>`) precisa fazer e não fazia (auditoria NAV-05):
 *
 *   · TRAVAR a rolagem do fundo enquanto está aberto — senão o dedo que rola o formulário rola a
 *     lista atrás, e ao fechar a pessoa está noutro lugar da página;
 *   · PRENDER o Tab dentro do painel — senão o foco anda pelos links de trás, invisíveis sob o véu,
 *     e o Enter seguinte navega pra fora com o formulário aberto;
 *   · devolver o foco a quem abriu, ao fechar.
 *
 * A trava de rolagem é CONTADA: gaveta aberta e um painel por cima dela, fechar um não pode soltar
 * a rolagem que o outro ainda segura.
 */

let travas = 0

export function travarRolagem() {
  if (typeof document === 'undefined') return
  if (travas++ === 0) document.documentElement.style.overflow = 'hidden'
}

export function soltarRolagem() {
  if (typeof document === 'undefined' || travas === 0) return
  if (--travas === 0) document.documentElement.style.overflow = ''
}

/** quantas travas estão de pé (pro teste conferir que abrir e fechar se anulam) */
export const travasDeRolagem = () => travas

const FOCAVEIS = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',')

export function focaveis(raiz: HTMLElement): HTMLElement[] {
  return [...raiz.querySelectorAll<HTMLElement>(FOCAVEIS)]
    .filter((el) => !el.closest('[inert]') && !el.closest('[aria-hidden="true"]'))
}

/**
 * No `keydown` do Tab: do último volta pro primeiro (e o Shift+Tab do primeiro vai pro último);
 * foco que já escapou pra fora do painel é puxado de volta pra dentro.
 */
export function prenderTab(raiz: HTMLElement | null | undefined, e: KeyboardEvent) {
  if (!raiz || e.key !== 'Tab') return
  const lista = focaveis(raiz)
  if (!lista.length) { e.preventDefault(); return }
  const primeiro = lista[0]!
  const ultimo = lista[lista.length - 1]!
  const ativo = document.activeElement as HTMLElement | null
  const dentro = !!ativo && raiz.contains(ativo)
  if (e.shiftKey && (!dentro || ativo === primeiro)) { e.preventDefault(); ultimo.focus() }
  else if (!e.shiftKey && (!dentro || ativo === ultimo)) { e.preventDefault(); primeiro.focus() }
}
