/**
 * Quanto do dinheiro é do produtor — a conta, num lugar só.
 *
 * Existia copiada em cinco: borderô, financeiro do evento, criação de
 * transferência, financeiro da plataforma e extrato. Todas escreviam
 * `face_cents - refunded_cents`, e todas erravam junto — inclusive a que
 * decide QUANTO PODE SAIR, o que faz desta uma conta que move dinheiro de
 * verdade, não um número de relatório.
 *
 * ## Por que a face não serve
 *
 * `face - estornado` só acerta quando a taxa foi repassada ao comprador e
 * ninguém usou cupom. Dois casos comuns quebram isso:
 *
 * - **Taxa absorvida** (`fee_mode` = `absorver`, o padrão do balcão): o
 *   comprador paga a face redonda e a taxa sai do produtor. A face inteira
 *   nunca foi dele.
 * - **Cupom de desconto**: o abatimento sai do bolso do produtor, mas a face
 *   dos ingressos continua cheia.
 *
 * ## Por que não dá pra olhar a configuração
 *
 * A tentação é ler `fee_mode_online` / `fee_mode_pos` e decidir a partir
 * dali. Não funciona: o modo muda com o tempo e vale só dali pra frente. No
 * evento semeado, o MESMO canal de bilheteria tem 10 pedidos que repassaram
 * a taxa e 3 que a absorveram — qualquer modo que se escolha erra dez ou
 * três pedidos. O que aconteceu está gravado no pedido; a configuração só
 * diz o que vai acontecer no próximo.
 *
 * ## A conta
 *
 *     líquido = total_cents − platform_cents − refunded_cents
 *
 * `total_cents` é o que foi cobrado do comprador (o banco garante
 * `total = face + fee − desconto`), `platform_cents` é o que a plataforma
 * retém. Sai certo nos dois modos sem consultar nada:
 *
 * | modo      | total       | platform | líquido          |
 * |-----------|-------------|----------|------------------|
 * | repassar  | face + taxa | taxa     | face             |
 * | absorver  | face        | taxa     | face − taxa      |
 *
 * E com cupom o desconto já saiu dentro do `total`, como tem que sair.
 */

/**
 * A expressão SQL, pra somar dentro de uma consulta.
 *
 * `prefixo` é o alias da tabela quando a consulta tem JOIN (`'o.'`). Só
 * conta pedido `pago`: rascunho e expirado nunca viraram dinheiro, e
 * estornado já está dentro de `refunded_cents` do próprio pedido pago.
 */
export const SQL_LIQUIDO = (prefixo = '') =>
  `COALESCE(SUM(${prefixo}total_cents - ${prefixo}platform_cents - ${prefixo}refunded_cents)
            FILTER (WHERE ${prefixo}status = 'pago'), 0)::bigint`

/** a mesma conta pra uma linha já carregada — usada nos cortes do extrato */
export function liquidoDoPedido(p: {
  totalCents: number; taxaPlataformaCents: number; estornadoCents?: number
}): number {
  return p.totalCents - p.taxaPlataformaCents - (p.estornadoCents ?? 0)
}
