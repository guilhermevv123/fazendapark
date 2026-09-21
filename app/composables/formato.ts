/**
 * formato.ts — como data e dinheiro viram texto na tela, num lugar só.
 *
 * Duas classes de erro moravam copiadas tela a tela, e as duas são caladas:
 * não lançam exceção, não sujam o console, não deixam teste vermelho. Só
 * aparecem no número errado que alguém lê às 21h.
 *
 * ## 1. `toISOString()` pra descobrir "que dia é hoje"
 *
 * Ele converte pra UTC ANTES de cortar. O parque vende à noite: às 21h de
 * Brasília o `slice(0, 10)` já devolve AMANHÃ. O botão "Hoje" do dashboard
 * passava a pedir o dia seguinte e a tela mostrava a noite de venda vazia,
 * justo no dia do evento. Quem calcula dia de calendário usa `diaLocal`.
 *
 * A armadilha tem ida e volta: `new Date('2026-09-21')` (data pura, sem hora)
 * nasce à meia-noite UTC, que no fuso do parque é dia 20 às 21h — o mesmo erro
 * de um dia, no sentido contrário. Quem lê data do servidor usa `paraData`.
 *
 * ## 2. Valor em reais convertido com `parseFloat` / `Number(...) * 100`
 *
 * `parseFloat('1234,56')` para na vírgula e devolve `1234`: o troco do balcão
 * sai R$ 1.234,00 no lugar de R$ 1.234,56. E o `replace(/\./g, '')` que as
 * telas usavam pra tirar o ponto de milhar transforma "500.00" em `50000` —
 * a conferência de caixa passa a esperar R$ 50.000,00 de uma gaveta com
 * R$ 500,00.
 *
 * Por isso aqui **não existe float em lugar nenhum** do caminho do dinheiro:
 * os dígitos antes e depois da vírgula são somados como inteiro
 * (`inteiro * 100 + centavos`), e a formatação sai de divisão e resto
 * inteiros (`Math.floor(c / 100)` e `c % 100`), nunca de `c / 100`.
 *
 * Campo onde se digita dinheiro usa `CampoMoeda` (máscara sobre os dígitos,
 * valor inteiro em centavos na saída) — nunca `input type="number"` e nunca
 * texto livre reinterpretado no envio.
 */

const dois = (n: number) => String(n).padStart(2, '0')

/** o que entra no lugar de uma data que não existe */
const VAZIO = '—'

/* ========================================================== data ========= */

/**
 * O dia de calendário de quem está olhando, em `YYYY-MM-DD`.
 *
 * É o formato que as rotas de filtro (`?de=&ate=`) esperam. `getFullYear` /
 * `getMonth` / `getDate` leem o relógio LOCAL — é exatamente por isso que
 * substituem `toISOString().slice(0, 10)`, que lê UTC.
 */
export function diaLocal(d: Date = new Date()): string {
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`
}

/** O mesmo dia, deslocado por `n` dias. Usado pelos atalhos de período. */
export function diaLocalMais(n: number, base: Date = new Date()): string {
  const d = new Date(base)
  d.setDate(d.getDate() + n)
  return diaLocal(d)
}

/** Primeiro dia do mês corrente, em `YYYY-MM-DD` local. */
export function primeiroDiaDoMes(base: Date = new Date()): string {
  return diaLocal(new Date(base.getFullYear(), base.getMonth(), 1))
}

/**
 * Lê o que veio do servidor sem escorregar de dia.
 *
 * `new Date('2026-09-21')` é meia-noite UTC — dia 20 às 21h no fuso do parque.
 * Data sem hora é dia de calendário e nasce à meia-noite LOCAL. Timestamp com
 * fuso (`...T03:00:00.000Z`) passa direto, que é o certo: ali o instante é
 * conhecido e o navegador o mostra no fuso de quem lê.
 */
export function paraData(v: string | number | Date | null | undefined): Date | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v === 'string') {
    const soData = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim())
    if (soData) {
      return new Date(Number(soData[1]), Number(soData[2]) - 1, Number(soData[3]))
    }
  }
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

type Entrada = string | number | Date | null | undefined

/** 21/09/2026 */
export function dataCurta(v: Entrada, vazio = VAZIO): string {
  const d = paraData(v)
  return d ? `${dois(d.getDate())}/${dois(d.getMonth() + 1)}/${d.getFullYear()}` : vazio
}

/** 21/09 — pra eixo de gráfico e coluna estreita, onde o ano é ruído */
export function diaMes(v: Entrada, vazio = VAZIO): string {
  const d = paraData(v)
  return d ? `${dois(d.getDate())}/${dois(d.getMonth() + 1)}` : vazio
}

/** 21/09/2026 23:30 */
export function dataHora(v: Entrada, vazio = VAZIO): string {
  const d = paraData(v)
  return d ? `${dataCurta(d)} ${dois(d.getHours())}:${dois(d.getMinutes())}` : vazio
}

/** 21/09 23:30 — a lista de pedidos não tem largura pro ano */
export function diaMesHora(v: Entrada, vazio = VAZIO): string {
  const d = paraData(v)
  return d ? `${diaMes(d)} ${dois(d.getHours())}:${dois(d.getMinutes())}` : vazio
}

/** 21/09/2026 23:30:07 — só onde o segundo decide (auditoria, portaria) */
export function dataHoraSegundo(v: Entrada, vazio = VAZIO): string {
  const d = paraData(v)
  return d ? `${dataHora(d)}:${dois(d.getSeconds())}` : vazio
}

/** 21 de set. de 2026 */
export function dataPorExtenso(v: Entrada, vazio = VAZIO): string {
  const d = paraData(v)
  if (!d) return vazio
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** setembro de 2026 */
export function mesAno(v: Entrada, vazio = VAZIO): string {
  const d = paraData(v)
  return d ? d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }) : vazio
}

/** set. */
export function mesCurto(v: Entrada, vazio = VAZIO): string {
  const d = paraData(v)
  return d ? d.toLocaleDateString('pt-BR', { month: 'short' }) : vazio
}

/** segunda-feira — o título que o passo de sessões do evento novo escreve. */
export function diaDaSemana(v: Entrada, vazio = VAZIO): string {
  const d = paraData(v)
  return d ? d.toLocaleDateString('pt-BR', { weekday: 'long' }) : vazio
}

/* ------------------------------------------ campo <input datetime-local> -- */

/**
 * O que um `<input type="datetime-local">` aceita: `YYYY-MM-DDTHH:mm` no
 * relógio de quem está olhando.
 *
 * As telas faziam isto de dois jeitos, os dois com `toISOString()` no meio:
 *
 *   new Date(iso).toISOString().slice(0, 16)                       // errado
 *   new Date(d.getTime() - off).toISOString().slice(0, 16)         // "certo"
 *
 * O primeiro mostra o horário em UTC: um lote que abre 21h aparece 00h do dia
 * seguinte no campo, e quem salvar sem mexer empurra o lote três horas pra
 * frente sem ter digitado nada. O segundo acerta subtraindo o deslocamento
 * antes de converter — só que ele usa o deslocamento de HOJE pra uma data que
 * pode estar do outro lado de uma mudança de fuso, e é conta de ida e volta
 * pra não sair do lugar.
 *
 * Aqui não há conversão nenhuma: os campos locais do `Date` são lidos direto,
 * que é o mesmo que o navegador vai mostrar.
 */
export function paraCampoDataHora(v: Entrada, vazio = ''): string {
  const d = paraData(v)
  if (!d) return vazio
  return `${diaLocal(d)}T${dois(d.getHours())}:${dois(d.getMinutes())}`
}

/**
 * A volta: o texto do campo (hora LOCAL, sem fuso) vira o instante que o
 * servidor guarda.
 *
 * `new Date('2026-10-17T21:00')` — sem `Z` e sem deslocamento — é hora local
 * por definição da linguagem, então esta é a única direção em que
 * `toISOString()` está certo: aqui o resultado é um INSTANTE, não um dia de
 * calendário. O perigo mora em quem chama: `new Date('2026-10-17')`, sem a
 * hora, nasce meia-noite UTC e volta 21h do dia anterior. Por isso a hora é
 * obrigatória no formato e o vazio devolve `null` em vez de inventar um dia.
 */
export function deCampoDataHora(v: string | null | undefined): string | null {
  if (!v) return null
  const d = new Date(/\d{2}:\d{2}/.test(v) ? v : `${v}T00:00`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/* ====================================================== dinheiro ========= */

/**
 * `1234,56` — a máscara, sem o `R$`.
 *
 * Sai de divisão inteira e resto: `Math.floor(c / 100)` e `c % 100` são
 * exatos pra todo inteiro que cabe num `number`. `(c / 100).toFixed(2)`
 * passa por float e é onde o centavo some.
 */
export function centavosParaTexto(cents: number): string {
  if (!Number.isFinite(cents)) return '?'
  // Centavo é inteiro. Se chegou quebrado, alguém fez conta em float lá atrás:
  // mostrar o mais próximo é melhor que apagar a tela com uma exceção, mas o
  // lugar certo de consertar é na origem.
  const n = Math.round(cents)
  const abs = Math.abs(n)
  const inteiro = Math.floor(abs / 100)
  const resto = abs % 100
  return `${n < 0 ? '-' : ''}${inteiro.toLocaleString('pt-BR')},${dois(resto)}`
}

/**
 * `R$ 1.234,56`.
 *
 * O espaço é um espaço normal, de propósito. O `toLocaleString` com
 * `style: 'currency'` separa o `R$` com espaço fino (U+00A0), e aí duas
 * strings idênticas na tela não são iguais na comparação — armadilha que já
 * custou caro aqui. Valor não finito vira `R$ ?`: número desconhecido tem que
 * gritar, não virar R$ 0,00 silencioso.
 */
export function reais(cents: number): string {
  return `R$ ${centavosParaTexto(cents)}`
}

/**
 * Lê texto em reais e devolve centavos INTEIROS. Sem `parseFloat`, sem
 * `Number(x) * 100` — os dígitos são somados como inteiro.
 *
 * **Esta é a ÚNICA leitura de valor em reais do projeto.** `server/utils/
 * dinheiro.ts` reexporta esta função; não existe uma segunda, e a razão está
 * escrita abaixo.
 *
 * Aceita o que um operador digita ou cola de verdade:
 *   "1.234,56" → 123456   (pt-BR: ponto é milhar, vírgula é decimal)
 *   "R$ 8,15"  → 815
 *   "500.00"   → 50000    (ponto decimal do teclado numérico: grupo final
 *                          com 2 casas não é milhar)
 *   "1.200"    → 120000   (grupo final com 3 casas é milhar — pt-BR)
 *   "1.234.567"→ 123456700
 *   "8,5"      → 850
 *   ""         → 0        (campo vazio é zero, não exceção na cara de quem digita)
 *
 * ## O que "1.200" significa, e por que
 *
 * Mil e duzentos reais — 120000 centavos. Ponto sem vírgula, com o último
 * grupo de TRÊS dígitos, é separador de MILHAR: é assim que o teclado
 * brasileiro, o Excel brasileiro e a tela da Zig escrevem, e é o que o
 * operador do guichê lê. O `Number('1.200')` do JavaScript responde `1.2`
 * porque ele fala en-US, e aí R$ 1.200,00 vira R$ 1,20 — mil vezes menos.
 *
 * Havia DUAS leituras no repositório e elas discordavam exatamente aqui:
 * esta devolvia 120000 e a de `server/utils/dinheiro.ts` devolvia 120;
 * "1.234.567" saía 123456700 de um lado e EXCEÇÃO do outro. A do servidor era
 * quase código morto — e "quase" é o problema: no dia em que alguém a usasse,
 * o mesmo texto mudaria de significado no meio do caminho, sem ninguém ver.
 *
 * A régua é o tamanho do último grupo depois do ponto: 3 dígitos = milhar,
 * qualquer outro tamanho = casa decimal ("500.00" é R$ 500,00; "8.15" é
 * R$ 8,15). A vírgula, quando existe, manda em tudo e o ponto vira milhar.
 *
 * ## Número em vez de texto
 *
 * Aceito, mas é o único ponto do caminho do dinheiro que toca float — e o
 * estrago já aconteceu antes da chamada: `29.90` em binário é
 * 29.899999999999999. Aqui só dá pra arredondar pro centavo mais próximo.
 * Num número o ponto é SEMPRE decimal (não existe `1.200` de milhar em
 * `number`), então esta ponta não passa pela régua de cima. Quem tem o valor
 * em texto passa o texto.
 */
export function paraCentavos(texto: string | number): number {
  if (typeof texto === 'number') {
    if (!Number.isFinite(texto)) throw new Error('valor não finito')
    return Math.round(texto * 100)
  }
  const limpo = String(texto ?? '').replace(/[^\d.,-]/g, '')
  if (!/\d/.test(limpo)) return 0

  const negativo = limpo.trimStart().startsWith('-')
  const corpo = limpo.replace(/-/g, '')

  let inteiro = corpo
  let decimal = ''

  const virgula = corpo.lastIndexOf(',')
  if (virgula >= 0) {
    inteiro = corpo.slice(0, virgula)
    decimal = corpo.slice(virgula + 1)
  } else {
    // Sem vírgula, o ponto é ambíguo. "1.200" em pt-BR é mil e duzentos;
    // "500.00" e "8.5" são o ponto decimal de quem digitou no teclado
    // numérico. A régua é o tamanho do último grupo: 3 dígitos = milhar.
    const grupos = corpo.split('.')
    if (grupos.length === 2 && grupos[1].length !== 3) {
      inteiro = grupos[0]
      decimal = grupos[1]
    }
  }

  const digitosInteiros = inteiro.replace(/\D/g, '')
  const digitosDecimais = decimal.replace(/\D/g, '')

  // soma em inteiro: nada de (reais * 100)
  let cents = Number(digitosInteiros || '0') * 100
    + Number(`${digitosDecimais}00`.slice(0, 2))
  // terceira casa decimal arredonda meio pra cima, como o resto do sistema
  if (digitosDecimais.length > 2 && Number(digitosDecimais[2]) >= 5) cents += 1

  return negativo ? -cents : cents
}

/**
 * Máscara ao digitar: só os dígitos contam, e cada tecla muda o inteiro de
 * centavos. É o contrato do `CampoMoeda` — quem digita "8", "1", "5" quis
 * dizer R$ 8,15, e não passa por texto intermediário nenhum no caminho.
 */
export function centavosDigitados(texto: string, maxDigitos = 11): number {
  const digitos = String(texto ?? '').replace(/\D/g, '').slice(0, maxDigitos)
  return Number(digitos || '0')
}
