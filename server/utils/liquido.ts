/**
 * Quanto do dinheiro é do produtor — e onde esse dinheiro está.
 *
 * São DUAS perguntas diferentes e por muito tempo foram tratadas como uma.
 * A primeira ("quanto é dele") virava relatório; a segunda ("quanto dá pra
 * transferir") virava dinheiro saindo da conta da plataforma.
 *
 * ## 1. Quanto é do produtor
 *
 * Existia copiada em cinco lugares, todas escrevendo `face_cents −
 * refunded_cents`. Só acerta quando a taxa foi repassada ao comprador e
 * ninguém usou cupom — que é exatamente o caso do seed, então nenhum teste
 * ficava vermelho. Dois casos comuns quebram:
 *
 * - **Taxa absorvida** (padrão do balcão): o comprador paga a face redonda e
 *   a taxa sai do produtor. A face inteira nunca foi dele.
 * - **Cupom**: o abatimento sai do bolso do produtor, mas a face continua cheia.
 *
 * E não dá pra decidir lendo `fee_mode_online` / `fee_mode_pos`: o modo muda
 * com o tempo e vale dali pra frente. No evento semeado o MESMO canal de
 * bilheteria tem 10 pedidos que repassaram a taxa e 3 que absorveram —
 * qualquer modo que se escolha erra dez ou três. O que aconteceu está no
 * pedido; a configuração só diz o que vai acontecer no próximo.
 *
 *     líquido = total_cents − platform_cents − refunded_cents
 *
 * | modo      | total       | platform | líquido     |
 * |-----------|-------------|----------|-------------|
 * | repassar  | face + taxa | taxa     | face        |
 * | absorver  | face        | taxa     | face − taxa |
 *
 * **`estornado_parcial` conta.** O webhook grava esse status quando o
 * comprador é reembolsado em parte, e o valor devolvido já está em
 * `refunded_cents`. Filtrar só por `'pago'` fazia o pedido INTEIRO sumir da
 * conta: um estorno de R$ 20 tirava os R$ 850 do pedido do saldo do
 * produtor. Quem fica de fora é só o estorno TOTAL, onde não sobrou líquido
 * nenhum a apurar.
 *
 * ## 2. Onde o dinheiro está
 *
 * Essa é a pergunta que o teto do saque precisa responder, e a resposta não
 * é o líquido. Venda no balcão em dinheiro nunca passou pela plataforma: o
 * operador contou as notas e elas estão na gaveta do produtor. Somar isso no
 * "disponível para transferência" faz a plataforma pagar do próprio caixa um
 * dinheiro que ela nunca recebeu.
 *
 * A régua NÃO é o canal nem a forma de pagamento — é `asaas_payment_id`.
 * Medido no banco: existe `bilheteria + pix` COM cobrança no Asaas (o
 * comprador pagou o QR da plataforma) e `bilheteria + pix` SEM (pagou na
 * chave do próprio produtor). Mesma forma, mesmo canal, bolsos diferentes.
 * Só o gateway sabe, e ele deixa o rastro no pedido.
 */

/** pedidos que ainda têm líquido a apurar — estorno TOTAL não tem */
const VIVOS = `status IN ('pago','estornado_parcial')`

/**
 * A mesma régua, pronta pra entrar num `WHERE` de relatório.
 *
 * Toda consulta que SOMA DINHEIRO precisa usar esta, e não `status = 'pago'`:
 * um recorte por `'pago'` no `WHERE` derruba o pedido com estorno parcial
 * antes de qualquer `FILTER` chegar nele, e aí o relatório mostra um total e
 * o borderô mostra outro. Contagens de "quantos pedidos fecharam" podem
 * continuar em `'pago'` — ali a pergunta é outra.
 *
 *     WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')}
 */
export const PEDIDO_VIVO = (prefixo = '') => `${prefixo}${VIVOS}`

/**
 * O que é do produtor, venha o dinheiro de onde vier. Serve pra relatório,
 * borderô e extrato — NÃO serve de teto pra saque.
 *
 * `prefixo` é o alias da tabela quando a consulta tem JOIN (`'o.'`).
 */
export const SQL_LIQUIDO = (prefixo = '') =>
  `COALESCE(SUM(${prefixo}total_cents - ${prefixo}platform_cents - ${prefixo}refunded_cents)
            FILTER (WHERE ${prefixo}${VIVOS}), 0)::bigint`

/**
 * A parte que está NA PLATAFORMA, e portanto a única que ela pode
 * transferir. É este o teto do saque.
 */
export const SQL_LIQUIDO_GATEWAY = (prefixo = '') =>
  `COALESCE(SUM(${prefixo}total_cents - ${prefixo}platform_cents - ${prefixo}refunded_cents)
            FILTER (WHERE ${prefixo}${VIVOS}
                      AND ${prefixo}asaas_payment_id IS NOT NULL), 0)::bigint`

/**
 * A parte que JÁ ESTÁ COM O PRODUTOR — dinheiro contado na gaveta, pix na
 * chave dele. Nunca entra no disponível; aparece na tela com esse nome, pra
 * ninguém achar que sumiu.
 */
export const SQL_LIQUIDO_DIRETO = (prefixo = '') =>
  `COALESCE(SUM(${prefixo}total_cents - ${prefixo}platform_cents - ${prefixo}refunded_cents)
            FILTER (WHERE ${prefixo}${VIVOS}
                      AND ${prefixo}asaas_payment_id IS NULL), 0)::bigint`

/** a mesma conta pra uma linha já carregada */
export function liquidoDoPedido(p: {
  totalCents: number; taxaPlataformaCents: number; estornadoCents?: number
}): number {
  return p.totalCents - p.taxaPlataformaCents - (p.estornadoCents ?? 0)
}
