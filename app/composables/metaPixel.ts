/**
 * Meta Pixel (Facebook/Instagram Ads) — só nas páginas de quem COMPRA.
 *
 * O código-base é carregado por `plugins/meta-pixel.client.ts`; aqui moram os eventos que as
 * telas disparam. Três regras:
 *
 * - **Nunca quebra a página.** Bloqueador de anúncio, aba anônima sem armazenamento, pixel
 *   desligado (`NUXT_PUBLIC_META_PIXEL_ID` vazio): tudo cai no `try/catch` e a compra segue.
 * - **Nada de dado pessoal.** Nem CPF, nem e-mail, nem telefone, nem nome: só valor, moeda e
 *   nome do evento.
 * - **Dinheiro em centavos até a borda.** O pixel quer reais; a conversão é aqui e só aqui.
 */

declare global {
  interface Window { fbq?: (...args: unknown[]) => void; _fbq?: unknown }
}

/** Telas da equipe (painel, portaria, comanda, login): o pixel não carrega nem dispara nelas. */
export const ROTA_SEM_PIXEL = /^\/(admin|portaria|painel|comanda|consumo|entrar|redefinir-senha|conectar-whatsapp)(\/|$)/

/** Centavos inteiros → reais com duas casas, como o pixel espera. */
export function reaisDoPixel(cents: unknown): number {
  return Math.round(Number(cents) || 0) / 100
}

/** Dispara um evento padrão do pixel. Sem pixel carregado (bloqueado/desligado), não faz nada. */
export function eventoDoPixel(nome: string, dados: Record<string, unknown> = {}, opcoes?: { eventID: string }) {
  if (!import.meta.client) return
  try {
    if (ROTA_SEM_PIXEL.test(window.location.pathname)) return
    const fbq = window.fbq
    if (typeof fbq !== 'function') return
    if (opcoes) fbq('track', nome, dados, opcoes)
    else fbq('track', nome, dados)
  } catch { /* pixel nunca quebra a compra */ }
}

/**
 * `Purchase` UMA vez por pedido, mesmo com F5 ou com o vigia do Pix voltando a ver "pago".
 * O `eventID` é o que a API de Conversões (CAPI) vai usar no futuro pra não contar em dobro.
 */
export function compraNoPixel(pedidoId: unknown, totalCents: unknown) {
  if (!import.meta.client || !pedidoId) return
  try {
    if (typeof window.fbq !== 'function') return
    const chave = `pixel:purchase:${String(pedidoId)}`
    try { if (window.localStorage.getItem(chave)) return } catch { /* sem armazenamento: dispara */ }
    eventoDoPixel('Purchase', { value: reaisDoPixel(totalCents), currency: 'BRL' }, { eventID: `purchase_${String(pedidoId)}` })
    try { window.localStorage.setItem(chave, '1') } catch { /* sem armazenamento */ }
  } catch { /* pixel nunca quebra a compra */ }
}
