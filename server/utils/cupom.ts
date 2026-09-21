/**
 * cupom.ts — a régua do cupom, num lugar só.
 *
 * O cupom é o ponto do checkout em que o dinheiro escapa sem ninguém ver. A
 * tela valida, o servidor confia, e aí o mesmo código roda duas mil vezes numa
 * madrugada: nenhuma exceção, nenhum teste vermelho, só um fechamento de mês
 * R$ 18 mil menor. Por isso tudo aqui é refeito NO SERVIDOR, com a linha do
 * cupom travada, mesmo que a tela já tenha dito que o código é bom.
 *
 * ## Por que a contagem NÃO sai de `promo_codes.uses`
 *
 * `uses` é um número que alguém soma e alguém subtrai, e ele já nasce torto em
 * três caminhos que existem hoje:
 *
 *  - o checkout soma 1 na hora de criar o pedido; se o pedido expira sem
 *    pagamento, ninguém subtrai — o cupom "gasta" um uso que não virou venda;
 *  - o cancelamento subtrai (`GREATEST(uses - 1, 0)`), então o placar anda pros
 *    dois lados por caminhos diferentes;
 *  - a tela de edição do cupom grava a linha inteira: um UPDATE desatento zera
 *    o placar e o cupom esgotado volta a valer pra sempre.
 *
 * Quem sabe quantas vezes o cupom foi usado é `orders`: cada pedido guarda o
 * `promo_code_id` e o cliente guarda o CPF. **A trava lê de lá.** `uses`
 * continua sendo gravado porque as telas do painel mostram ele — mas ele é
 * PLACAR, não é trava. Trava que mora num contador é trava que some no dia em
 * que o contador for corrigido na mão.
 *
 * ## A trava vem antes da decisão
 *
 * `SQL_TRAVA_CUPOM` pega a linha do cupom com `FOR UPDATE` ANTES de contar.
 * Contar primeiro e travar depois passa em teste sequencial e não serializa
 * nada: dois compradores leem "usado 0 de 1" no mesmo milissegundo e os dois
 * gravam. Num cupom de 100% isso é o ingresso saindo de graça duas vezes.
 */
import type { PoolClient } from 'pg'
import { somarPedido, type LinhaPedido, type ModoTaxa, type TotalPedido } from './dinheiro'

/**
 * Pedido que ocupa vaga — conta pro limite de uso do cupom e pro teto por CPF.
 *
 * **Não é a mesma pergunta de `PEDIDO_VIVO()` (utils/liquido.ts) e as duas não
 * podem ser unificadas.** Lá a pergunta é "tem dinheiro a apurar"; aqui é
 * "está segurando uma vaga". Pedido aguardando pagamento não tem líquido
 * nenhum e ocupa vaga (senão o cambista abre trinta carrinhos e paga o que
 * sobrar). Estorno TOTAL e cancelamento são compra desfeita: devolvem a vaga,
 * que é a mesma regra que `devolverEstoqueDoPedido` já aplica ao placar.
 *
 * `chargeback` e `disputa` ficam DENTRO de propósito: ali o dinheiro voltou
 * sem o comprador desistir, e devolver o uso do cupom seria premiar quem
 * contestou a compra com um cupom novo em folha.
 */
export const PEDIDO_EM_PE = [
  'aguardando_pagamento', 'em_analise', 'pago', 'estornado_parcial', 'chargeback', 'disputa',
] as const

/**
 * A linha do cupom, travada. Fica como constante — e não escrita dentro da
 * função — porque o teste de concorrência força a ordem das duas conexões
 * rodando EXATAMENTE este statement. Teste que escreve o próprio `FOR UPDATE`
 * prova que o Postgres trava, não que o resgate trava.
 */
export const SQL_TRAVA_CUPOM = `
  SELECT id, code, kind, value, max_uses, max_per_customer, max_discount_cents,
         starts_at, ends_at, active, lot_ids
    FROM promo_codes
   WHERE event_id = $1 AND upper(code) = upper($2)
   FOR UPDATE`

/**
 * Cupom recusado, com o recado pronto pro comprador.
 *
 * `status` separa duas conversas diferentes: 409 é "acabou / fechou / você já
 * usou" (o mundo mudou), 422 é "esse código não serve pra este pedido" (o dado
 * não vale). A tela trata os dois igual hoje, mas quem lê log de madrugada
 * não.
 */
export class CupomRecusado extends Error {
  constructor(
    public readonly recado: string,
    public readonly motivo: string,
    public readonly status: 409 | 422 = 409,
  ) {
    super(recado)
    this.name = 'CupomRecusado'
  }
}

export interface Cupom {
  id: string
  codigo: string
  kind: 'percentual' | 'fixo'
  /** percentual → bps (1000 = 10%); fixo → centavos */
  value: number
  /** teto de desconto em centavos; null = sem teto */
  maxDiscountCents: number | null
}

/** Data em horário do evento. `toISOString()` aqui viraria "amanhã" às 21h. */
export function emData(d: Date | string, fuso = 'America/Bahia'): string {
  return new Date(d).toLocaleString('pt-BR', {
    timeZone: fuso, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export interface ResgateDeCupom {
  eventId: string
  codigo: string
  /** CPF só de dígitos — é ele que responde "um uso por pessoa" */
  documento: string
  /** lotes que estão neste pedido, pra checar a restrição por lote */
  lotIdsDoPedido: string[]
  fuso?: string
  agora?: Date
}

/**
 * Valida e RESERVA o uso do cupom dentro da transação do pedido.
 *
 * Chamar SEMPRE dentro de `tx()`, e sempre DEPOIS de `reservar()` — a ordem
 * importa: o checkout e o balcão pegam a linha do lote antes da linha do
 * cupom, e duas transações que peguem os mesmos dois recursos em ordens
 * opostas travam uma na outra pra sempre.
 *
 * O "reserva" acontece por consequência: a trava segura a linha até o COMMIT,
 * e o pedido gravado no meio já entra na contagem de quem estiver esperando.
 */
export async function resgatarCupom(c: PoolClient, r: ResgateDeCupom): Promise<Cupom> {
  const agora = r.agora ?? new Date()
  const codigo = r.codigo.trim().toUpperCase()

  const { rows } = await c.query(SQL_TRAVA_CUPOM, [r.eventId, codigo])
  const p = rows[0]
  if (!p) {
    throw new CupomRecusado(
      `Não encontramos o cupom ${codigo} neste evento. Confira as letras e tente de novo.`,
      'inexistente', 422)
  }
  if (!p.active) {
    throw new CupomRecusado(`O cupom ${codigo} não está mais valendo.`, 'inativo')
  }
  if (p.starts_at && new Date(p.starts_at) > agora) {
    throw new CupomRecusado(
      `O cupom ${codigo} só começa a valer em ${emData(p.starts_at, r.fuso)}.`, 'cedo_demais')
  }
  if (p.ends_at && new Date(p.ends_at) < agora) {
    throw new CupomRecusado(
      `O cupom ${codigo} venceu em ${emData(p.ends_at, r.fuso)}.`, 'vencido')
  }
  if (p.lot_ids?.length) {
    const vale = r.lotIdsDoPedido.every((id) => p.lot_ids.includes(id))
    if (!vale) {
      throw new CupomRecusado(
        `O cupom ${codigo} não vale para os ingressos que você escolheu. `
        + 'Ele só serve para alguns lotes deste evento.', 'lote_de_fora', 422)
    }
  }

  // ---- a contagem, lida do banco --------------------------------------
  // LEFT JOIN de propósito: venda de balcão sai sem cliente cadastrado e
  // mesmo assim gastou um uso do cupom. Com JOIN normal ela sumiria da conta
  // em silêncio e o cupom de 20 usos venderia 40.
  const { rows: contas } = await c.query(
    `SELECT count(*)::int                                      AS usos,
            count(*) FILTER (WHERE cu.document = $2)::int      AS usos_da_pessoa
       FROM orders o
       LEFT JOIN customers cu ON cu.id = o.customer_id
      WHERE o.promo_code_id = $1
        AND o.status = ANY($3::text[])`,
    [p.id, r.documento, PEDIDO_EM_PE as unknown as string[]])
  const usos = Number(contas[0]?.usos ?? 0)
  const usosDaPessoa = Number(contas[0]?.usos_da_pessoa ?? 0)

  if (p.max_uses != null && usos >= Number(p.max_uses)) {
    throw new CupomRecusado(
      `O cupom ${codigo} chegou ao limite de ${p.max_uses} usos e não vale mais. `
      + 'A compra sem o cupom continua valendo.', 'esgotado')
  }
  const porPessoa = Number(p.max_per_customer ?? 1)
  if (usosDaPessoa >= porPessoa) {
    throw new CupomRecusado(
      porPessoa === 1
        ? `Este CPF já usou o cupom ${codigo}. Ele vale uma vez por pessoa.`
        : `Este CPF já usou o cupom ${codigo} ${usosDaPessoa} vezes — o limite é ${porPessoa} por pessoa.`,
      'uma_vez_por_pessoa')
  }

  return {
    id: p.id,
    codigo: p.code,
    kind: p.kind,
    value: Number(p.value),
    maxDiscountCents: p.max_discount_cents == null ? null : Number(p.max_discount_cents),
  }
}

/**
 * Soma o pedido com o cupom aplicado — e com o teto de desconto respeitado.
 *
 * O teto (`max_discount_cents`) é o que separa "20% de desconto" de "20% de
 * desconto até R$ 30". Sem ele, um cupom feito pra um ingresso de R$ 60 vira
 * R$ 400 de abatimento no dia em que alguém comprar dez camarotes — e o
 * desconto sai inteiro do bolso do produtor.
 *
 * A conta em si continua em `somarPedido` (utils/dinheiro.ts). Aqui não se
 * refaz aritmética de dinheiro: quando o desconto passa do teto, o pedido é
 * somado DE NOVO com o teto como valor fixo. Duas chamadas só no caso raro, e
 * nenhuma fórmula duplicada.
 */
export function aplicarCupom(
  linhas: LinhaPedido[], feeBps: number, modo: ModoTaxa, cupom: Cupom | null,
): TotalPedido {
  if (!cupom) return somarPedido(linhas, feeBps, modo)

  let total = somarPedido(linhas, feeBps, modo, { kind: cupom.kind, value: cupom.value })
  const teto = cupom.maxDiscountCents
  if (teto != null && total.discountCents > teto) {
    total = somarPedido(linhas, feeBps, modo, { kind: 'fixo', value: teto })
  }

  // Rede. Se disparar é bug NOSSO, não do comprador: melhor 500 e nenhum
  // pedido do que gravar uma linha em que o desconto comeu mais que a face
  // (total negativo = a plataforma devendo dinheiro pra quem comprou).
  if (total.discountCents < 0 || total.discountCents > total.faceCents || total.totalCents < 0) {
    throw new Error(
      `desconto fora da faixa: desconto ${total.discountCents}, face ${total.faceCents}, `
      + `total ${total.totalCents}`)
  }
  return total
}
