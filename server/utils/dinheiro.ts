/**
 * dinheiro.ts — toda conta de valor do sistema passa por aqui.
 *
 * Duas regras inegociáveis:
 *   1. Centavo é INTEIRO. Nenhuma função deste arquivo aceita ou devolve float
 *      de reais. `29.90` em ponto flutuante é 29.899999999999999 e uma
 *      bilheteria que soma isso 10 mil vezes fecha o caixa errado.
 *   2. Percentual é BASIS POINT (bps). 10% = 1000 bps. Inteiro pelo mesmo
 *      motivo: 0.1 não existe exato em binário.
 *
 * O vocabulário (e a confusão que ele resolve):
 *   face      → valor do ingresso, o que o produtor fatura
 *   plataforma→ a taxa de conveniência; existe SEMPRE, some é quem paga
 *   fee       → a parte da taxa cobrada DO COMPRADOR (0 se absorvida)
 *   total     → o que sai do bolso do comprador
 */

export type ModoTaxa = 'repassar' | 'absorver'

/** Arredonda pro centavo mais próximo, meio pra cima, sem passar por float. */
export function arredonda(numerador: number, denominador: number): number {
  if (denominador === 0) throw new Error('divisão por zero em arredonda()')
  const neg = (numerador < 0) !== (denominador < 0)
  const n = Math.abs(numerador)
  const d = Math.abs(denominador)
  const r = Math.floor((n * 2 + d) / (d * 2))
  return neg ? -r : r
}

/** Taxa da plataforma sobre um valor de face. */
export function taxaPlataforma(faceCents: number, feeBps: number): number {
  inteiro(faceCents, 'faceCents')
  inteiro(feeBps, 'feeBps')
  if (faceCents === 0) return 0 // gratuito não paga taxa
  return arredonda(faceCents * feeBps, 10_000)
}

export interface Precificado {
  faceCents: number
  /** cobrado do comprador */
  feeCents: number
  /** receita da plataforma, quem quer que tenha pago */
  platformCents: number
  /** o que o comprador paga */
  totalCents: number
  /** o que sobra pro produtor antes de custo de adquirente */
  produtorCents: number
}

/**
 * Preço de UMA unidade.
 *
 * repassar → comprador paga face + taxa;  produtor recebe face
 * absorver → comprador paga face;         produtor recebe face − taxa
 */
export function precificar(faceCents: number, feeBps: number, modo: ModoTaxa): Precificado {
  inteiro(faceCents, 'faceCents')
  if (faceCents < 0) throw new Error('faceCents negativo')
  const platformCents = taxaPlataforma(faceCents, feeBps)
  const repassa = modo === 'repassar'
  const feeCents = repassa ? platformCents : 0
  return {
    faceCents,
    feeCents,
    platformCents,
    totalCents: faceCents + feeCents,
    produtorCents: faceCents - (repassa ? 0 : platformCents),
  }
}

/**
 * O inverso: "quero que o comprador pague exatamente R$ 30,00" → qual o valor
 * de face?  Na Zig isso é conta de cabeça do produtor (foi assim que a Fazenda
 * Park chegou no lote de R$ 27,27 pra o cliente pagar 30 redondo). Aqui é
 * função, e a gente devolve o valor EXATO quando existe.
 *
 * Devolve o maior face cuja precificação não passa do total desejado, e diz
 * se bateu exatamente. Sem isso o produtor escolhe 27,28 e o cliente paga
 * 30,01 — que é feio na tela e some com a venda por impulso.
 */
export function faceParaTotal(totalDesejadoCents: number, feeBps: number, modo: ModoTaxa): {
  faceCents: number
  exato: boolean
  resultado: Precificado
} {
  inteiro(totalDesejadoCents, 'totalDesejadoCents')
  if (modo === 'absorver') {
    // comprador paga a face; então a face É o total desejado
    const resultado = precificar(totalDesejadoCents, feeBps, modo)
    return { faceCents: totalDesejadoCents, exato: true, resultado }
  }
  // repassar: total = face + round(face*bps/10000). Chuta e ajusta — a função
  // é monótona, então no máximo 2 passos de correção resolvem.
  let face = arredonda(totalDesejadoCents * 10_000, 10_000 + feeBps)
  const total = (f: number) => f + taxaPlataforma(f, feeBps)
  while (total(face) > totalDesejadoCents && face > 0) face--
  while (total(face + 1) <= totalDesejadoCents) face++
  const resultado = precificar(face, feeBps, modo)
  return { faceCents: face, exato: resultado.totalCents === totalDesejadoCents, resultado }
}

/** Preço de um tipo de ingresso (meia = desconto sobre a face do lote). */
export function faceComDesconto(faceLoteCents: number, descontoBps: number): number {
  inteiro(descontoBps, 'descontoBps')
  if (descontoBps === 0) return faceLoteCents
  if (descontoBps >= 10_000) return 0
  return faceLoteCents - arredonda(faceLoteCents * descontoBps, 10_000)
}

export interface LinhaPedido {
  quantidade: number
  faceUnitCents: number
}

export interface TotalPedido {
  faceCents: number
  feeCents: number
  platformCents: number
  discountCents: number
  totalCents: number
  produtorCents: number
  linhas: Array<Precificado & { quantidade: number; subtotalCents: number }>
}

/**
 * Soma o pedido inteiro.
 *
 * Arredonda POR UNIDADE e depois multiplica — não o contrário. Se arredondasse
 * o total, 3 ingressos de face 3333 com 10% dariam taxa 1000 no agregado e 333×3
 * = 999 na hora de bater com o extrato: um centavo órfão que ninguém acha.
 */
export function somarPedido(
  linhas: LinhaPedido[],
  feeBps: number,
  modo: ModoTaxa,
  desconto?: { kind: 'percentual' | 'fixo'; value: number },
): TotalPedido {
  const detalhe = linhas.map((l) => {
    if (!Number.isInteger(l.quantidade) || l.quantidade <= 0) {
      throw new Error('quantidade precisa ser inteiro positivo')
    }
    const p = precificar(l.faceUnitCents, feeBps, modo)
    return { ...p, quantidade: l.quantidade, subtotalCents: p.totalCents * l.quantidade }
  })

  const faceCents = detalhe.reduce((s, d) => s + d.faceCents * d.quantidade, 0)
  const feeCents = detalhe.reduce((s, d) => s + d.feeCents * d.quantidade, 0)
  const platformCents = detalhe.reduce((s, d) => s + d.platformCents * d.quantidade, 0)
  const bruto = faceCents + feeCents

  // Desconto incide sobre a face, nunca sobre a taxa — senão o cupom come a
  // receita da plataforma sem ninguém decidir isso.
  let discountCents = 0
  if (desconto) {
    discountCents = desconto.kind === 'percentual'
      ? arredonda(faceCents * desconto.value, 10_000)
      : desconto.value
    if (discountCents > faceCents) discountCents = faceCents
    if (discountCents < 0) discountCents = 0
  }

  return {
    faceCents,
    feeCents,
    platformCents,
    discountCents,
    totalCents: bruto - discountCents,
    produtorCents: faceCents - discountCents - (modo === 'absorver' ? platformCents : 0),
    linhas: detalhe,
  }
}

/** Formata centavos pra exibição. Só na borda — nunca no meio de conta. */
export function reais(cents: number): string {
  inteiro(cents, 'cents')
  return (cents / 100).toLocaleString('pt-BR', {
    style: 'currency', currency: 'BRL', minimumFractionDigits: 2,
  })
}

/** Lê "R$ 1.234,56" / "1234,56" / "1234.56" e devolve centavos. */
export function paraCentavos(texto: string | number): number {
  if (typeof texto === 'number') {
    if (!Number.isFinite(texto)) throw new Error('valor não finito')
    return Math.round(texto * 100)
  }
  const limpo = String(texto).replace(/[^\d,.-]/g, '').trim()
  if (!limpo) return 0
  // pt-BR: ponto é milhar, vírgula é decimal
  const normal = limpo.includes(',')
    ? limpo.replace(/\./g, '').replace(',', '.')
    : limpo
  const n = Number(normal)
  if (!Number.isFinite(n)) throw new Error(`valor inválido: ${texto}`)
  return Math.round(n * 100)
}

function inteiro(v: number, nome: string) {
  if (!Number.isInteger(v)) throw new Error(`${nome} precisa ser inteiro (recebeu ${v})`)
}
