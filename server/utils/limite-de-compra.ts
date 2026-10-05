/**
 * limite-de-compra.ts — quantos ingressos cabem numa compra (ordem do dono, 05/10).
 *
 * "Se o cara quiser comprar um milhão, ele compra, de acordo com o tanto de ingresso disponível":
 * quem limita é o ESTOQUE, não uma regra de 6 por compra. O único teto que sobra é técnico — cada
 * ingresso vira um QR anexado no e-mail do pedido (`envio.ts`), e um e-mail com milhares de anexos
 * não chega. Acima disto, a pessoa faz em mais de uma compra.
 *
 * É o padrão de tudo: lote novo (máximo por compra), evento sem teto próprio e a porta do
 * checkout. Mora em `server/utils` pra tela do painel importar o MESMO número.
 */
export const TETO_POR_COMPRA = 500
