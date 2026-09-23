/**
 * caixa.ts — as regras do dinheiro que entra pela mão, não pelo gateway.
 *
 * Duas instruções deste arquivo são travas de verdade, e moram aqui pelo mesmo
 * motivo das outras duas do sistema (catraca e aceite de transferência): o
 * teste precisa rodar EXATAMENTE a linha que a rota roda. Instrução copiada
 * pro teste envelhece sozinha e o teste passa a provar outra coisa.
 *
 * Trava 1 — `SQL_TRAVA_TURNO_ABERTO`: nenhuma venda entra em caixa fechado.
 * Trava 2 — `SQL_FECHA_TURNO`: nenhum caixa fecha duas vezes.
 * Trava 3 — `SQL_CANCELA_VENDA_PDV`: nenhuma venda é cancelada duas vezes, e
 *           nenhuma venda cujo ingresso já entrou no parque é cancelada.
 *
 * As três se apoiam: a venda pega o lock da linha do turno antes de gravar, o
 * fechamento pega o mesmo lock, e o cancelamento pega os dois (turno e
 * pedido). Quem chegar segundo espera o primeiro terminar e enxerga o estado
 * já mudado — em vez dos dois lerem "aberto" no mesmo instante e um gravar
 * dinheiro num turno que o outro acabou de fechar.
 */
import type { PoolClient } from 'pg'
import { PEDIDO_VIVO } from './liquido'

export type FormaPdv = 'dinheiro' | 'debito' | 'credito' | 'pix'

export const FORMAS_PDV: FormaPdv[] = ['dinheiro', 'debito', 'credito', 'pix']

export const FORMA_LEGIVEL: Record<FormaPdv, string> = {
  dinheiro: 'Dinheiro',
  debito: 'Cartão de débito',
  credito: 'Cartão de crédito',
  pix: 'Pix',
}

/**
 * Pega o turno E o trava, na mesma instrução.
 *
 * O `AND status = 'aberto'` é a trava inteira. Sem ele a consulta devolve o
 * turno fechado e a venda grava normalmente: o dinheiro entra numa gaveta que
 * já foi contada, e a diferença só aparece no dia seguinte, sem ninguém
 * conseguir dizer de onde veio.
 *
 * A rota de venda NÃO confere o status antes de chamar isto, de propósito.
 * Uma checagem prévia resolveria o caso em fila e esconderia esta linha — foi
 * exatamente o que aconteceu duas vezes neste sistema (catraca e aceite), com
 * o teste continuando verde depois de arrancar a condição do UPDATE.
 */
export const SQL_TRAVA_TURNO_ABERTO = `
  SELECT id, org_id, event_id, terminal_id, operator_id, opening_float_cents
    FROM pos_shifts
   WHERE id = $1 AND status = 'aberto'
   FOR UPDATE`

/**
 * Fecha o caixa. Condicional pelo mesmo motivo do aceite de transferência:
 * dois toques no botão, ou o gerente fechando pelo painel no mesmo segundo em
 * que o operador fecha pelo guichê. O segundo tem que encontrar rowCount 0 e
 * ouvir "já foi fechado", não gravar outra contagem por cima da primeira.
 */
export const SQL_FECHA_TURNO = `
  UPDATE pos_shifts
     SET status = 'fechado', closed_at = now(), closed_by = $2,
         closing_counted_cents = $3, closing_expected_cents = $4, note = $5
   WHERE id = $1 AND status = 'aberto'
   RETURNING id`

/**
 * Desfaz a venda do balcão — e carrega as duas travas do cancelamento na
 * MESMA instrução, pelo mesmo motivo das de cima: o teste roda esta linha.
 *
 * `status = 'pago'` é o "não cancela duas vezes". Sem ele, o segundo toque no
 * botão (ou o gerente cancelando pelo painel no mesmo segundo que o operador
 * cancela pelo guichê) grava outro cancelamento por cima: `refunded_cents`
 * vira o dobro, o estorno é pedido duas vezes ao gateway e o estoque volta
 * duas vezes pra prateleira — o lote passa a ter mais ingresso do que existe.
 *
 * O `NOT EXISTS` dos ingressos usados é o "a pessoa já está lá dentro". Ela
 * passou na catraca, tomou banho de piscina, comeu no parque: devolver o
 * dinheiro agora é prejuízo a cobrar, não venda desfeita. E, pior, o ingresso
 * cancelado sumiria do relatório de quem entrou.
 *
 * Quem chama precisa ter travado as linhas dos ingressos ANTES (com
 * `SQL_TRAVA_INGRESSOS_DA_VENDA`), senão uma entrada no portão cabe entre o
 * `NOT EXISTS` daqui e o cancelamento dos ingressos logo abaixo.
 *
 * Não confere status antes de propósito: uma pré-checagem resolveria o caso em
 * fila e esconderia esta linha do teste — o erro cometido três vezes neste
 * sistema (catraca, aceite de transferência e fechamento de caixa).
 */
export const SQL_CANCELA_VENDA_PDV = `
  UPDATE orders o
     SET status = 'cancelado', canceled_at = now(),
         refunded_at = now(), refunded_cents = o.total_cents
   WHERE o.id = $1
     AND o.status = 'pago'
     AND NOT EXISTS (SELECT 1 FROM tickets t
                      WHERE t.order_id = o.id
                        AND (t.status = 'usado' OR t.checked_in_at IS NOT NULL))
   RETURNING o.id, o.code, o.total_cents, o.payment_method,
             o.asaas_payment_id, o.pos_shift_id, o.org_id`

/**
 * Trava as linhas dos ingressos da venda até o fim da transação.
 *
 * É o que serializa o cancelamento com a PORTA. A catraca grava com
 * `... WHERE id = $1 AND status = 'valido'` (ver utils/catraca.ts): com as
 * linhas travadas aqui, ou a entrada acontece inteira antes (e o
 * cancelamento vê `usado` e recusa), ou ela chega depois e encontra
 * `cancelado` (e recusa a entrada). Sem esta linha existe o meio termo: o
 * cancelamento lê "válido", a catraca marca "usado", e a pessoa entra com uma
 * venda que acabou de ser estornada.
 */
export const SQL_TRAVA_INGRESSOS_DA_VENDA = `
  SELECT id, status, checked_in_at
    FROM tickets
   WHERE order_id = $1
   FOR UPDATE`

/**
 * Quando termina o DIA de cada lote — a última sessão em que ele vale.
 *
 * O dia do lote é o de `lot_sessions` quando ele tem (passaporte, lote de
 * vários dias), e o do setor quando não tem (modelo antigo). Com vários dias,
 * vale o ÚLTIMO: enquanto sobrar um dia pela frente o lote ainda tem uso.
 * `NULL` = lote sem dia nenhum, que continua vendendo como sempre vendeu.
 *
 * Mora aqui porque o catálogo do balcão e a venda precisam da MESMA régua:
 * catálogo que mostra um lote que a venda recusa é botão que só dá erro.
 */
export const SQL_FIM_DO_DIA_DO_LOTE = `
  SELECT l.id AS lot_id,
         COALESCE(
           (SELECT max(es.ends_at) FROM lot_sessions ls
              JOIN event_sessions es ON es.id = ls.session_id
             WHERE ls.lot_id = l.id),
           (SELECT es.ends_at FROM sectors s
              JOIN event_sessions es ON es.id = s.session_id
             WHERE s.id = l.sector_id)
         ) AS fim_do_dia
    FROM lots l
   WHERE l.id = ANY($1::uuid[])`

/**
 * Anulação de movimento da gaveta — um registro NOVO, de sinal contrário.
 *
 * Sangria digitada errada (R$ 500 em vez de R$ 50) não pode ser apagada: o
 * rastro de quem mexeu na gaveta é justamente o que a conferência de caixa
 * existe pra guardar. Então a correção é outro movimento, do tipo oposto e do
 * mesmo valor, que carrega na frente do motivo a marca de QUAL movimento ele
 * anula. A soma dos dois dá zero e o esperado volta a bater.
 *
 * A marca vive no `reason` porque `pos_cash_movements` não tem coluna de
 * vínculo (e criar uma pede migração). O formato é fixo e só este arquivo o
 * escreve e o lê.
 */
const PREFIXO_ANULACAO = '[anula '

export function motivoDeAnulacao(movimentoId: string, motivo: string): string {
  return `${PREFIXO_ANULACAO}${movimentoId}] ${motivo.trim()}`
}

/** O id do movimento que esta linha anula, ou `null` se ela é um movimento comum. */
export function anulaQual(reason: string | null | undefined): string | null {
  if (!reason?.startsWith(PREFIXO_ANULACAO)) return null
  const fim = reason.indexOf(']')
  return fim > 0 ? reason.slice(PREFIXO_ANULACAO.length, fim) : null
}

/** O motivo sem a marca técnica — o que a tela mostra. */
export function motivoLegivel(reason: string | null | undefined): string | null {
  if (!anulaQual(reason)) return reason ?? null
  return reason!.slice(reason!.indexOf(']') + 1).trim() || null
}

/**
 * Quais pedidos entram na conta do turno, e com quanto — `$2` é o
 * `closed_at` do turno (NULL enquanto está aberto).
 *
 * Aberto: pedido vivo, pelo que sobrou depois das devoluções (a regra de
 * sempre). Fechado: MAIS o pedido cancelado depois do fechamento, pelo total
 * cheio — a devolução dele saiu por fora do caixa e não pode reescrever uma
 * conferência que já foi assinada.
 */
const CANCELADO_DEPOIS = `($2::timestamptz IS NOT NULL AND o.canceled_at > $2::timestamptz)`
export const SQL_CONTA_NO_TURNO = `(${PEDIDO_VIVO('o.')} OR ${CANCELADO_DEPOIS})`
export const SQL_NA_GAVETA_DO_TURNO =
  `(o.total_cents - CASE WHEN ${CANCELADO_DEPOIS} THEN 0 ELSE o.refunded_cents END)`

export interface ContagemDoTurno {
  /** fundo de troco com que o turno abriu */
  aberturaCents: number
  /** vendas em espécie que ainda estão de pé neste turno */
  dinheiroCents: number
  /** vendas em cartão e pix — não estão na gaveta, mas estão no faturamento */
  eletronicoCents: number
  sangriaCents: number
  suprimentoCents: number
  /** o que DEVE estar na gaveta agora */
  esperadoCents: number
  pedidos: number
  ingressos: number
  porForma: { forma: string; pedidos: number; totalCents: number }[]
  /** notas que voltaram pra mão do cliente em cancelamento de venda em espécie */
  devolvidoDinheiroCents: number
  /** cancelamento de venda em cartão/pix — volta pelo gateway, não pela gaveta */
  devolvidoEletronicoCents: number
  cancelamentos: {
    id: string
    pedido: string
    totalCents: number
    saiuDaGaveta: boolean
    forma: string | null
    ingressos: number
    motivo: string
    estorno: string
    em: string
    por: string | null
  }[]
}

/**
 * O que o sistema acha que tem na gaveta.
 *
 * Só dinheiro vivo entra na conta do esperado — cartão e pix aparecem à parte
 * porque o operador não vai contá-los na mão. Misturar os dois é o erro que
 * faz toda conferência acusar uma falta do tamanho exato das vendas em cartão.
 */
export async function contarTurno(c: PoolClient, shiftId: string): Promise<ContagemDoTurno> {
  const { rows: t } = await c.query(
    `SELECT opening_float_cents, closed_at FROM pos_shifts WHERE id = $1`, [shiftId])
  const aberturaCents = Number(t[0]?.opening_float_cents ?? 0)
  // Caixa fechado é conferência ASSINADA. Venda cancelada depois do
  // fechamento (pelo financeiro, ver `cancelar.post.ts`) devolveu o dinheiro
  // FORA desta gaveta — então aqui ela continua contando como estava na hora
  // do fechamento. Sem isto o extrato de ontem passava a dizer "vendeu menos"
  // ao lado do esperado congelado, e a diferença de caixa mentia sozinha.
  const fechouEm: Date | null = t[0]?.closed_at ?? null

  // `PEDIDO_VIVO` no lugar de `status = 'pago'`, e `- refunded_cents` no lugar
  // do total cheio. São a mesma decisão vista de dois lados: o que está na
  // gaveta é o que entrou MENOS o que voltou pra mão do cliente. Recortar por
  // 'pago' derrubaria o pedido inteiro num estorno parcial — R$ 20 devolvidos
  // apagando uma venda de R$ 850 da conferência.
  const { rows: formas } = await c.query(
    `SELECT o.payment_method AS forma,
            count(*)::int AS pedidos,
            COALESCE(SUM(${SQL_NA_GAVETA_DO_TURNO}), 0)::bigint AS total
       FROM orders o
      WHERE o.pos_shift_id = $1 AND ${SQL_CONTA_NO_TURNO}
      GROUP BY o.payment_method`, [shiftId, fechouEm])

  let dinheiroCents = 0
  let eletronicoCents = 0
  const porForma = formas.map((f: any) => {
    const total = Number(f.total)
    if (f.forma === 'dinheiro') dinheiroCents += total
    else eletronicoCents += total
    return { forma: f.forma ?? 'outro', pedidos: Number(f.pedidos), totalCents: total }
  })

  const { rows: mov } = await c.query(
    `SELECT kind, COALESCE(SUM(amount_cents), 0)::bigint AS total
       FROM pos_cash_movements WHERE shift_id = $1 GROUP BY kind`, [shiftId])
  const sangriaCents = Number(mov.find((m: any) => m.kind === 'sangria')?.total ?? 0)
  const suprimentoCents = Number(mov.find((m: any) => m.kind === 'suprimento')?.total ?? 0)

  // Ingresso cancelado não conta como emitido: ele não existe mais pra
  // portaria, e contar mantém na tela um número que a catraca já não aceita.
  const { rows: ing } = await c.query(
    `SELECT count(*)::int AS n FROM tickets t
       JOIN orders o ON o.id = t.order_id
      WHERE o.pos_shift_id = $1
        AND (t.status <> 'cancelado'
             OR ($2::timestamptz IS NOT NULL AND t.canceled_at > $2::timestamptz))`,
    [shiftId, fechouEm])

  // O rastro dos cancelamentos deste turno. Serve pra TELA, não pra conta:
  // ver logo abaixo por que somar isto no esperado seria contar duas vezes.
  // LEFT JOIN no usuário porque `by_user` some quando a conta é apagada — e
  // JOIN comum faria o cancelamento inteiro desaparecer da conferência.
  const { rows: canc } = await c.query(
    `SELECT k.id, k.amount_cents, k.from_drawer, k.payment_method, k.tickets_canceled,
            k.reason, k.gateway_refund, k.at, o.code AS pedido, u.name AS por
       FROM pos_sale_cancellations k
       JOIN orders o ON o.id = k.order_id
       LEFT JOIN users u ON u.id = k.by_user
      WHERE k.shift_id = $1
      ORDER BY k.at DESC`, [shiftId])

  let devolvidoDinheiroCents = 0
  let devolvidoEletronicoCents = 0
  for (const k of canc) {
    if (k.from_drawer) devolvidoDinheiroCents += Number(k.amount_cents)
    else devolvidoEletronicoCents += Number(k.amount_cents)
  }

  return {
    aberturaCents,
    dinheiroCents,
    eletronicoCents,
    sangriaCents,
    suprimentoCents,
    // o troco já saiu de `total_cents`: o pedido guarda o que foi cobrado, não
    // o que a pessoa entregou. Somar o recebido e descontar o troco daria o
    // mesmo número por um caminho mais longo e mais fácil de errar.
    //
    // E `devolvidoDinheiroCents` NÃO entra aqui: a venda cancelada já saiu de
    // `dinheiroCents` (deixou de ser um pedido vivo). Subtrair de novo tiraria
    // o valor duas vezes e o fechamento acusaria uma falta do tamanho exato do
    // cancelamento — com a gaveta certinha. O número aparece na tela como
    // informação, nomeado, pra ninguém procurar a venda que "sumiu".
    esperadoCents: aberturaCents + dinheiroCents + suprimentoCents - sangriaCents,
    pedidos: porForma.reduce((s, f) => s + f.pedidos, 0),
    ingressos: Number(ing[0]?.n ?? 0),
    porForma,
    devolvidoDinheiroCents,
    devolvidoEletronicoCents,
    cancelamentos: canc.map((k: any) => ({
      id: k.id,
      pedido: k.pedido,
      totalCents: Number(k.amount_cents),
      saiuDaGaveta: k.from_drawer,
      forma: k.payment_method,
      ingressos: Number(k.tickets_canceled),
      motivo: k.reason,
      estorno: k.gateway_refund,
      em: k.at,
      por: k.por,
    })),
  }
}

/** Diferença de fechamento, do jeito que o gerente lê. */
export function quebra(contadoCents: number, esperadoCents: number) {
  const d = contadoCents - esperadoCents
  return {
    diferencaCents: d,
    situacao: d === 0 ? 'bate' : d > 0 ? 'sobra' : 'falta',
  } as const
}
