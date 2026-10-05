/**
 * Cartão de crédito na tela de pagamento (dono, 05/10): a conta pura — bandeira, dígito verificador,
 * tamanho, código de segurança e validade. Sem DOM e sem rede: a tela (`CartaoDeCredito.vue`) e os
 * testes usam as mesmas funções, e o servidor confere de novo antes de mandar pro Asaas.
 *
 * Bandeira pelo começo do número (BIN). A ORDEM importa: Elo e Hipercard usam faixas que também
 * começam com 4, 5 e 6 — testadas antes de Visa, Mastercard e Discover, senão um Elo de BIN 4011 78
 * vira "Visa" e o banco recusa. As faixas são as públicas das bandeiras (as mesmas das bibliotecas
 * de checkout); bandeira não reconhecida não bloqueia: quem decide no fim é o Asaas.
 *
 * NUNCA guardar o número: nada aqui grava em storage, manda pra log ou sai do navegador — quem
 * envia é a tela, uma vez, no pagamento.
 */

export type IdDaBandeira = 'elo' | 'hipercard' | 'amex' | 'diners' | 'discover' | 'jcb' | 'mastercard' | 'visa'

export interface Bandeira {
  id: IdDaBandeira
  nome: string
  /** tamanhos válidos do número, em dígitos */
  tamanhos: number[]
  /** dígitos do código de segurança */
  cvv: number
  /** como o número é agrupado no cartão (4-4-4-4; Amex 4-6-5; Diners 4-6-4) */
  grupos: number[]
  /** o nome curto do selo dentro do campo (o completo não cabe ao lado do número) */
  curto?: string
}

const BANDEIRAS: { b: Bandeira; bin: RegExp }[] = [
  {
    b: { id: 'elo', nome: 'Elo', tamanhos: [16], cvv: 3, grupos: [4, 4, 4, 4] },
    bin: /^(4011(78|79)|43(1274|8935)|45(1416|7393|763[12])|50(4175|6699|67[0-7]\d|9000)|627780|63(6297|6368)|650(03[0-35-9]|04\d|05[01]|4(0[5-9]|[3-8]\d|9\d)|5([0-2]\d|3[0-8])|9([2-6]\d|7[0-8])|541|700|720|901)|651652|655000|655021)/,
  },
  {
    b: { id: 'hipercard', nome: 'Hipercard', tamanhos: [13, 16, 19], cvv: 3, grupos: [4, 4, 4, 4, 3] },
    bin: /^(606282|637095|637568|637599|637609|637612|3841(0|4|6)0)/,
  },
  { b: { id: 'amex', nome: 'American Express', curto: 'Amex', tamanhos: [15], cvv: 4, grupos: [4, 6, 5] }, bin: /^3[47]/ },
  { b: { id: 'diners', nome: 'Diners Club', curto: 'Diners', tamanhos: [14, 16], cvv: 3, grupos: [4, 6, 4] }, bin: /^3(0[0-5]|[68])/ },
  { b: { id: 'jcb', nome: 'JCB', tamanhos: [16, 17, 18, 19], cvv: 3, grupos: [4, 4, 4, 4, 3] }, bin: /^35(2[89]|[3-8])/ },
  {
    b: { id: 'discover', nome: 'Discover', tamanhos: [16, 19], cvv: 3, grupos: [4, 4, 4, 4, 3] },
    bin: /^(6011|65|64[4-9]|622(12[6-9]|1[3-9]\d|[2-8]\d\d|9[01]\d|92[0-5]))/,
  },
  {
    b: { id: 'mastercard', nome: 'Mastercard', tamanhos: [16], cvv: 3, grupos: [4, 4, 4, 4] },
    bin: /^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/,
  },
  { b: { id: 'visa', nome: 'Visa', tamanhos: [13, 16, 19], cvv: 3, grupos: [4, 4, 4, 4, 3] }, bin: /^4/ },
]

/** Só os dígitos, com teto (19 é o maior número de cartão que existe). */
export function soDigitosDoCartao(v: unknown, max = 19): string {
  return String(v ?? '').replace(/\D/g, '').slice(0, max)
}

/** A bandeira pelo começo do número; `null` enquanto não dá pra saber (ou se não é conhecida). */
export function bandeiraDoCartao(numero: string): Bandeira | null {
  const d = soDigitosDoCartao(numero)
  if (!d) return null
  return BANDEIRAS.find((x) => x.bin.test(d))?.b ?? null
}

/** Dígito verificador (Luhn / módulo 10): pega número digitado errado ANTES de ir ao banco. */
export function luhnValido(numero: string): boolean {
  const d = soDigitosDoCartao(numero)
  if (d.length < 12) return false
  let soma = 0
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i])
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9 }
    soma += n
  }
  return soma % 10 === 0
}

/** O número com os espaços da bandeira ("4111 1111 1111 1111"; Amex "3782 822463 10005"). */
export function numeroAgrupado(numero: string): string {
  const d = soDigitosDoCartao(numero)
  const grupos = bandeiraDoCartao(d)?.grupos ?? [4, 4, 4, 4, 3]
  const partes: string[] = []
  let i = 0
  for (const g of grupos) {
    if (i >= d.length) break
    partes.push(d.slice(i, i + g)); i += g
  }
  if (i < d.length) partes.push(d.slice(i))
  return partes.join(' ')
}

/** Quantos dígitos o número pode ter, pra o campo parar de aceitar no fim. */
export function tamanhoMaximoDoNumero(numero: string): number {
  const b = bandeiraDoCartao(numero)
  return b ? Math.max(...b.tamanhos) : 19
}

export interface DadosDoCartao {
  numero: string
  titular: string
  mes: string   // "01".."12"
  ano: string   // "2026"
  cvv: string
}

export interface ConferenciaDoCartao {
  bandeira: Bandeira | null
  numero: string | null   // a frase do erro, ou null quando está certo
  titular: string | null
  validade: string | null
  cvv: string | null
  ok: boolean
}

/** Mês/ano ainda válidos? O cartão vale até o ÚLTIMO dia do mês impresso. */
export function validadeEmDia(mes: string, ano: string, agora = new Date()): boolean {
  const m = Number(mes), a = Number(ano)
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(a) || a < 2000) return false
  const hojeAno = agora.getFullYear(), hojeMes = agora.getMonth() + 1
  return a > hojeAno || (a === hojeAno && m >= hojeMes)
}

/** A conferência inteira, com a frase de cada campo — é o que a tela mostra embaixo do campo. */
export function conferirCartao(c: DadosDoCartao, agora = new Date()): ConferenciaDoCartao {
  const d = soDigitosDoCartao(c.numero)
  const bandeira = bandeiraDoCartao(d)
  const tamanhos = bandeira?.tamanhos ?? [13, 14, 15, 16, 17, 18, 19]

  let numero: string | null = null
  if (!d) numero = 'Digite o número do cartão.'
  else if (!tamanhos.includes(d.length)) {
    numero = bandeira
      ? `Cartão ${bandeira.nome} tem ${tamanhos.join(' ou ')} dígitos.`
      : 'Número de cartão incompleto.'
  } else if (!luhnValido(d)) numero = 'Confira o número: algum dígito está errado.'

  const nome = String(c.titular ?? '').trim()
  const titular = nome.length < 3 || !/\s/.test(nome) ? 'Nome como está impresso no cartão (nome e sobrenome).' : null

  const validade = !c.mes || !c.ano ? 'Escolha o mês e o ano.'
    : !validadeEmDia(c.mes, c.ano, agora) ? 'Este cartão está vencido.' : null

  const precisa = bandeira?.cvv ?? 3
  const cv = soDigitosDoCartao(c.cvv, 4)
  const cvv = !cv ? 'Digite o código de segurança.'
    : bandeira ? (cv.length !== precisa ? `O código do ${bandeira.nome} tem ${precisa} dígitos.` : null)
    : (cv.length < 3 ? 'O código tem 3 ou 4 dígitos.' : null)

  return { bandeira, numero, titular, validade, cvv, ok: !numero && !titular && !validade && !cvv }
}

/** O número na frente do cartão: só os 4 primeiros e os 4 últimos aparecem; o meio vira •. */
export function numeroNaFrenteDoCartao(numero: string): string[] {
  const d = soDigitosDoCartao(numero)
  const amex = bandeiraDoCartao(d)?.id === 'amex'
  const total = Math.max(amex ? 15 : 16, d.length)
  // a ponta final é o último GRUPO impresso: 4 dígitos; no Amex (4-6-5), 5 — senão o ponto
  // entrava no meio do último grupo ("•0005")
  const fim = amex ? 5 : 4
  return Array.from({ length: total }, (_, i) => {
    if (i >= d.length) return '#'
    return i >= 4 && i < total - fim ? '•' : d[i]!
  })
}
