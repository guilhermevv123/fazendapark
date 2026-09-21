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
 *
 * As duas se apoiam: a venda pega o lock da linha do turno antes de gravar, e
 * o fechamento pega o mesmo lock. Quem chegar segundo espera o primeiro
 * terminar e enxerga o estado já mudado — em vez dos dois lerem "aberto" no
 * mesmo instante e um gravar dinheiro num turno que o outro acabou de fechar.
 */
import type { PoolClient } from 'pg'

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

export interface ContagemDoTurno {
  /** fundo de troco com que o turno abriu */
  aberturaCents: number
  /** vendas pagas em espécie neste turno */
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
    `SELECT opening_float_cents FROM pos_shifts WHERE id = $1`, [shiftId])
  const aberturaCents = Number(t[0]?.opening_float_cents ?? 0)

  const { rows: formas } = await c.query(
    `SELECT o.payment_method AS forma,
            count(*)::int            AS pedidos,
            COALESCE(SUM(o.total_cents), 0)::bigint AS total,
            COALESCE(SUM(o.change_cents), 0)::bigint AS troco
       FROM orders o
      WHERE o.pos_shift_id = $1 AND o.status = 'pago'
      GROUP BY o.payment_method`, [shiftId])

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

  const { rows: ing } = await c.query(
    `SELECT count(*)::int AS n FROM tickets t
       JOIN orders o ON o.id = t.order_id
      WHERE o.pos_shift_id = $1`, [shiftId])

  return {
    aberturaCents,
    dinheiroCents,
    eletronicoCents,
    sangriaCents,
    suprimentoCents,
    // o troco já saiu de `total_cents`: o pedido guarda o que foi cobrado, não
    // o que a pessoa entregou. Somar o recebido e descontar o troco daria o
    // mesmo número por um caminho mais longo e mais fácil de errar.
    esperadoCents: aberturaCents + dinheiroCents + suprimentoCents - sangriaCents,
    pedidos: porForma.reduce((s, f) => s + f.pedidos, 0),
    ingressos: Number(ing[0]?.n ?? 0),
    porForma,
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
