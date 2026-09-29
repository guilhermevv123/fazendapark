/**
 * gratis.ts — a regra do ingresso grátis no site (28/09, pedido do dono): UM por CPF em cada
 * evento. Módulo puro (sem banco): a vitrine trava o "+" com o mesmo número que o checkout confere.
 */

/** Quantos ingressos grátis cada CPF leva por evento, somando todos os tipos grátis. */
export const GRATIS_POR_CPF = 1
