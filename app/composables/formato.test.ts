import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  centavosDigitados, centavosParaTexto, dataHoraSegundo, deCampoDataHora,
  diaDaSemana, diaLocal, diaLocalMais, paraCampoDataHora,
  paraCentavos, paraData, primeiroDiaDoMes, reais,
} from './formato'

/**
 * As duas travas que este arquivo segura, e por que elas existem.
 *
 * As duas classes de erro que moravam espalhadas pelas telas não lançam
 * exceção e não sujam o console. Um teste que só confere `1 + 1` de dia
 * "normal" (meio-dia, valor redondo) fica verde com o bug inteiro no lugar —
 * é por isso que cada caso abaixo é escolhido no horário e no valor em que o
 * bug aparece.
 */

/* ======================================================== fuso =========== */

describe('diaLocal — que dia é hoje, no fuso de quem olha', () => {
  afterEach(() => { vi.useRealTimers() })

  it('às 23h30 "hoje" continua sendo hoje (toISOString jogaria pra amanhã)', () => {
    // O construtor com números é sempre hora LOCAL: 21/09/2026, 23h30 no fuso
    // de quem roda o teste. É o horário em que o parque está vendendo.
    const noite = new Date(2026, 8, 21, 23, 30, 0)

    expect(diaLocal(noite)).toBe('2026-09-21')

    // E a armadilha, provada no mesmo instante: a oeste de UTC o
    // `toISOString()` já está no dia seguinte. Se este segundo `expect`
    // parar de valer, é porque a máquina saiu do fuso do parque — e aí o
    // primeiro `expect` deixa de exercitar o bug.
    if (noite.getTimezoneOffset() >= 31) {
      expect(noite.toISOString().slice(0, 10)).toBe('2026-09-22')
      expect(diaLocal(noite)).not.toBe(noite.toISOString().slice(0, 10))
    }
  })

  it('sem argumento, lê o relógio local — 21h do dia do evento', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 11, 21, 0, 0)) // 11/10/2026, 21h local
    expect(diaLocal()).toBe('2026-10-11')
    expect(diaLocalMais(-6)).toBe('2026-10-05') // "7 dias" = hoje + os 6 de trás
    expect(primeiroDiaDoMes()).toBe('2026-10-01')
  })

  it('a virada do mês e do ano às 23h59 não adianta um dia', () => {
    expect(diaLocal(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31')
    expect(diaLocal(new Date(2026, 8, 30, 22, 10, 0))).toBe('2026-09-30')
  })
})

describe('paraData — ler data do servidor sem escorregar de dia', () => {
  it('"2026-09-21" é dia de calendário, nasce à meia-noite LOCAL', () => {
    const d = paraData('2026-09-21')!
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(8)
    expect(d.getDate()).toBe(21)
    expect(d.getHours()).toBe(0)
    // ida e volta fechada: o que entrou como dia 21 volta como dia 21
    expect(diaLocal(d)).toBe('2026-09-21')
  })

  it('timestamp com fuso passa direto (é instante, não dia de calendário)', () => {
    const d = paraData('2026-09-07T03:00:00.000Z')!
    expect(d.getTime()).toBe(Date.parse('2026-09-07T03:00:00.000Z'))
  })

  it('vazio e lixo viram null em vez de Invalid Date na tela', () => {
    expect(paraData(null)).toBeNull()
    expect(paraData('')).toBeNull()
    expect(paraData('nao é data')).toBeNull()
  })
})

/* ==================================================== centavos =========== */

describe('reais ↔ centavos — ida e volta sem perder centavo', () => {
  // Valores escolhidos pelo que quebra, não por serem bonitos:
  //  - 29, 57, 58, 113, 114: em float, `parseFloat('0.29') * 100` é
  //    28.999999999999996 — quem corta em vez de arredondar perde 1 centavo
  //    justo nesses;
  //  - 2727: a face real do lote de R$ 30,00 da Fazenda Park;
  //  - 1_370_575: o faturamento do evento semeado, com ponto de milhar;
  //  - 99_999_999: o teto de 11 dígitos do campo.
  const VALORES = [
    0, 1, 9, 10, 29, 57, 58, 99, 100, 113, 114, 815, 2727, 3000, 4999,
    9990, 10_000, 12_345, 99_999, 100_000, 123_456, 1_370_575, 99_999_999,
    -500, -123_456,
  ]

  it('centavos → texto → centavos devolve o mesmo inteiro', () => {
    for (const c of VALORES) {
      expect(paraCentavos(centavosParaTexto(c)), `texto de ${c}`).toBe(c)
      expect(paraCentavos(reais(c)), `reais de ${c}`).toBe(c)
    }
  })

  it('a conta não passa por float — onde o float come 1 centavo, aqui não come', () => {
    // `Number.parseFloat('0.29') * 100` é 28.999999999999996. Quem trunca em
    // vez de arredondar (o `(c / 100).toFixed(2)` de ida e volta das telas
    // antigas) devolve 28 e some com um centavo por linha.
    for (const c of [29, 57, 58, 113, 114]) {
      const emReais = c / 100
      expect(Math.trunc(emReais * 100), `float trunca ${c}`).toBe(c - 1)
      // o caminho inteiro não tem onde perder: divisão e resto de inteiro
      expect(paraCentavos(centavosParaTexto(c)), `centavos de ${c}`).toBe(c)
    }
  })

  it('a máscara formata o que se espera ler no balcão', () => {
    expect(centavosParaTexto(815)).toBe('8,15')
    expect(centavosParaTexto(0)).toBe('0,00')
    expect(centavosParaTexto(5)).toBe('0,05')
    expect(centavosParaTexto(1_370_575)).toBe('13.705,75')
    expect(reais(2727)).toBe('R$ 27,27')
    expect(reais(-500)).toBe('R$ -5,00')
  })

  it('o R$ sai com espaço NORMAL, não com o espaço fino do toLocaleString', () => {
    // `toLocaleString('pt-BR', { style: 'currency' })` separa com U+00A0, e aí
    // duas strings idênticas na tela não são iguais na comparação.
    expect(reais(3000)).toBe('R$ 30,00')
    expect(reais(3000)).not.toContain(' ')
    expect((3000 / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }))
      .toContain(' ')
  })

  it('valor não finito grita em vez de virar R$ 0,00', () => {
    // Era o que acontecia quando "1.200,00" batia num replace(',', '.') e
    // virava NaN no caminho do fundo de troco.
    expect(reais(Number.NaN)).toBe('R$ ?')
    expect(reais(Number.POSITIVE_INFINITY)).toBe('R$ ?')
  })
})

describe('paraCentavos — o que o operador digita de verdade', () => {
  it('lê pt-BR com ponto de milhar e vírgula decimal', () => {
    expect(paraCentavos('1.234,56')).toBe(123_456)
    expect(paraCentavos('1234,56')).toBe(123_456)
    expect(paraCentavos('R$ 1.234,56')).toBe(123_456)
    expect(paraCentavos('R$ 1.234,56')).toBe(123_456)
    expect(paraCentavos('8,15')).toBe(815)
    expect(paraCentavos('8,5')).toBe(850)
    expect(paraCentavos('200')).toBe(20_000)
  })

  it('parseFloat pararia na vírgula e comeria os centavos — aqui não', () => {
    // `parseFloat('1234,56')` devolve 1234: R$ 1.234,00 no lugar de
    // R$ 1.234,56. Meia dúzia de vendas assim e o caixa fecha torto.
    expect(Math.round(Number.parseFloat('1234,56') * 100)).toBe(123_400)
    expect(paraCentavos('1234,56')).toBe(123_456)
    expect(paraCentavos('1234,56')).not.toBe(Math.round(Number.parseFloat('1234,56') * 100))
  })

  it('"500.00" do teclado numérico é R$ 500,00, não R$ 50.000,00', () => {
    // O `replace(/\./g, '')` das telas antigas fazia exatamente isso: a
    // conferência de caixa passava a esperar cem vezes o que tem na gaveta.
    expect(paraCentavos('500.00')).toBe(50_000)
    expect(Number(String('500.00').replace(/\./g, '').replace(',', '.')) * 100).toBe(5_000_000)
    expect(paraCentavos('8.15')).toBe(815)
  })

  it('"1.200" em pt-BR é mil e duzentos', () => {
    expect(paraCentavos('1.200')).toBe(120_000)
    expect(paraCentavos('1.234.567')).toBe(123_456_700)
    // e o replace(',', '.') sozinho, que era o do fundo de troco, dava NaN
    expect(Number(String('1.200,00').replace(',', '.'))).toBeNaN()
    expect(paraCentavos('1.200,00')).toBe(120_000)
  })

  it('terceira casa decimal arredonda meio pra cima, como o resto do sistema', () => {
    expect(paraCentavos('0,005')).toBe(1)
    expect(paraCentavos('0,004')).toBe(0)
    expect(paraCentavos('27,275')).toBe(2728)
  })

  it('campo vazio e lixo valem zero, não NaN', () => {
    expect(paraCentavos('')).toBe(0)
    expect(paraCentavos('R$')).toBe(0)
    expect(paraCentavos('abc')).toBe(0)
  })
})

describe('centavosDigitados — a máscara ao digitar do CampoMoeda', () => {
  it('cada tecla empurra o inteiro de centavos', () => {
    let texto = ''
    const teclas = ['8', '1', '5']
    const vistos: number[] = []
    for (const t of teclas) {
      const centavos = centavosDigitados(texto + t)
      texto = centavosParaTexto(centavos)
      vistos.push(centavos)
    }
    expect(vistos).toEqual([8, 81, 815])
    expect(texto).toBe('8,15')
  })

  it('digitar em cima do texto já formatado não perde o milhar', () => {
    // "1.234,56" + "7" → 12.345,67 — o ponto de milhar não pode virar dígito
    expect(centavosDigitados('1.234,567')).toBe(1_234_567)
    expect(centavosParaTexto(1_234_567)).toBe('12.345,67')
  })

  it('trava no teto de dígitos em vez de virar número absurdo', () => {
    expect(centavosDigitados('999999999999999')).toBe(99_999_999_999)
  })
})

/* ============================================ as telas não fazem na mão === */

/**
 * As duas contas acima só valem se as telas passarem por elas. Esta trava é
 * o que impede a cópia de voltar: a classe de bug deste item não é "a função
 * está errada", é "cada tela tem a sua".
 *
 * A lista é fechada de propósito — são as telas que este passo consertou.
 * As de fora (auditoria, extrato, ingressos, evento/novo, configuracoes,
 * financeiro do evento) ainda têm cópia própria e estão relatadas.
 */
const TELAS = [
  'app/pages/admin/index.vue',
  'app/pages/admin/financeiro.vue',
  'app/pages/admin/evento/[id]/dashboard.vue',
  'app/pages/admin/evento/[id]/relatorios/index.vue',
  'app/pages/admin/evento/[id]/vendas/index.vue',
  'app/pages/admin/evento/[id]/vendas/participantes.vue',
  'app/pages/admin/evento/[id]/vendas/transferencias.vue',
  'app/pages/admin/evento/[id]/pdv/index.vue',
  'app/pages/admin/evento/[id]/pdv/caixa.vue',
  'app/pages/admin/evento/[id]/pdv/vender.vue',
]

const leia = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')

/**
 * Só o CÓDIGO da tela — comentário fora.
 *
 * Os comentários que explicam o conserto citam o defeito pelo nome
 * (`toISOString`, `replace(/\./g, '')`), e sem tirá-los a trava acusaria a
 * própria explicação. Pior: pra calar o alarme alguém apagaria o comentário,
 * que é justamente a parte que impede o bug de voltar.
 */
function codigoDe(rel: string): string {
  const linhas = leia(rel).split('\n')
  let bloco = false
  let html = false
  const limpas: string[] = []

  for (const bruta of linhas) {
    let linha = bruta

    if (bloco) {
      const fim = linha.indexOf('*/')
      if (fim < 0) continue
      linha = linha.slice(fim + 2)
      bloco = false
    }
    if (html) {
      const fim = linha.indexOf('-->')
      if (fim < 0) continue
      linha = linha.slice(fim + 3)
      html = false
    }

    const abreBloco = linha.indexOf('/*')
    if (abreBloco >= 0 && linha.indexOf('*/', abreBloco) < 0) {
      linha = linha.slice(0, abreBloco)
      bloco = true
    }
    const abreHtml = linha.indexOf('<!--')
    if (abreHtml >= 0 && linha.indexOf('-->', abreHtml) < 0) {
      linha = linha.slice(0, abreHtml)
      html = true
    }

    // `//` de comentário, não o de `https://`
    const barras = linha.search(/(^|[^:])\/\//)
    if (barras >= 0) linha = linha.slice(0, linha.indexOf('//', barras))

    limpas.push(linha)
  }
  return limpas.join('\n')
}

describe('as telas consertadas não refazem a conta na mão', () => {
  it('nenhuma chama toISOString — é ele que vira amanhã às 21h', () => {
    const culpadas = TELAS.filter((t) => codigoDe(t).includes('toISOString'))
    expect(culpadas).toEqual([])
  })

  it('nenhuma divide centavo por 100 pra formatar', () => {
    // `(c / 100).toLocaleString`, `(c / 100).toFixed` e afins
    const culpadas = TELAS.filter((t) => /\/\s*100\s*\)\s*\.to(Locale|Fixed)/.test(codigoDe(t)))
    expect(culpadas).toEqual([])
  })

  it('nenhuma reinterpreta texto em reais no envio (parseFloat / Number * 100)', () => {
    const culpadas = TELAS.filter((t) => {
      const src = codigoDe(t)
      return /parseFloat/.test(src)
        || /Number\(String\([^)]*\)[^)]*\)\s*\*\s*100/.test(src)
        || /\.replace\(\/\\\.\/g,\s*''\)/.test(src)
    })
    expect(culpadas).toEqual([])
  })

  it('nenhuma usa input type="number" pra dinheiro', () => {
    const culpadas = TELAS.filter((t) => /type="number"/.test(codigoDe(t)))
    expect(culpadas).toEqual([])
  })

  /**
   * A METADE DE VOLTA do erro de um dia — a que passava batido.
   *
   * A trava do `toISOString` acima só pega o lado da IDA (Date → string).
   * O lado da VOLTA é `new Date('2026-09-07')`: data pura nasce à meia-noite
   * UTC, que no fuso do parque é 06/09 às 21h, e a tela imprime o dia
   * ANTERIOR. Era exatamente assim que quatro destas telas formatavam data
   * antes deste passo (`new Date(d.dia).toLocaleDateString('pt-BR')`), e é
   * para isso que `paraData` existe.
   *
   * Sem esta trava, devolver aquela linha ao lugar deixava a suíte inteira
   * VERDE — medido por mutação. `new Date()` sem argumento continua valendo:
   * ali a pergunta é "que horas são agora", não "que dia é esta string".
   */
  it('nenhuma monta Date a partir de string — new Date("2026-09-07") é ontem aqui', () => {
    const culpadas = TELAS.filter((t) => /new\s+Date\(\s*[^)\s]/.test(codigoDe(t)))
    expect(culpadas).toEqual([])
  })

  it('nenhuma formata data na mão (toLocaleDate/TimeString, dateStyle, timeStyle)', () => {
    // `toLocaleString('pt-BR')` cru sobre NÚMERO segue liberado (é o separador
    // de milhar de contagem e de porcentagem); o que não pode voltar é a
    // formatação de DATA tela a tela.
    const culpadas = TELAS.filter((t) =>
      /toLocale(Date|Time)String|Intl\.DateTimeFormat|dateStyle|timeStyle/.test(codigoDe(t)))
    expect(culpadas).toEqual([])
  })

  it('nenhuma remonta o R$ na mão — é de lá que vem o espaço fino', () => {
    // `style: 'currency'` reintroduz o U+00A0 que `reais` existe pra evitar.
    const culpadas = TELAS.filter((t) =>
      /style:\s*'currency'|style:\s*"currency"|Intl\.NumberFormat/.test(codigoDe(t)))
    expect(culpadas).toEqual([])
  })

  it('e a lista de telas existe de verdade (guarda contra caminho torto)', () => {
    for (const t of TELAS) {
      expect(leia(t).length, t).toBeGreaterThan(100)
      // o stripper não pode engolir a tela inteira: se engolir, as travas
      // acima passam a testar string vazia e ficam verdes por acidente
      expect(codigoDe(t).replace(/\s/g, '').length, `${t} sem comentário`)
        .toBeGreaterThan(leia(t).replace(/\s/g, '').length / 3)
    }
  })
})

/* ======================= as cinco telas que sobraram (furo C) ============ */

/**
 * As cinco telas que ainda calculavam dia com `toISOString()`.
 *
 * Cada caso abaixo roda num INSTANTE FIXO, às 23h de America/Sao_Paulo — o
 * horário em que o parque está vendendo e o único em que o defeito aparece.
 * Ao meio-dia todos esses testes ficam verdes com o bug inteiro no lugar; é
 * por isso que o fuso e a hora são forçados, e não herdados da máquina.
 *
 * Cada caso roda a conta ANTIGA junto com a nova e prova que as duas dão
 * respostas diferentes. Sem isso, o teste diria "a nova está certa" sem
 * nunca ter mostrado que a velha estava errada.
 */
describe('as cinco telas de data — 23h em America/Sao_Paulo', () => {
  const fusoOriginal = process.env.TZ
  const devolverFuso = () => {
    if (fusoOriginal === undefined) delete process.env.TZ
    else process.env.TZ = fusoOriginal
  }

  /**
   * Roda `caso` num fuso e num instante fixos.
   *
   * O `Date` do relógio de parede nasce DEPOIS do `process.env.TZ`, e não
   * antes: `new Date(2026, 8, 21, 23, 30)` é hora LOCAL, então construído no
   * fuso da máquina ele vira outro instante. Foi o que aconteceu na primeira
   * versão deste helper — as 23h viraram 20h30 e o caso passou a não exercitar
   * mais nada.
   */
  function em(tz: string, parede: [number, number, number, number, number], caso: () => void) {
    process.env.TZ = tz
    const [ano, mes, dia, hora, minuto] = parede
    const quando = new Date(ano, mes, dia, hora, minuto, 0)
    vi.useFakeTimers()
    vi.setSystemTime(quando)
    try { caso() } finally {
      vi.useRealTimers()
      devolverFuso()
    }
  }

  /** 21/09/2026 às 23h30 no fuso do parque. Em UTC já é dia 22. */
  const NOITE: [number, number, number, number, number] = [2026, 8, 21, 23, 30]

  afterEach(() => { vi.useRealTimers(); devolverFuso() })

  it('a máquina está mesmo às 23h de um fuso a oeste — senão nada disto testa', () => {
    em('America/Sao_Paulo', NOITE, () => {
      const agora = new Date()
      expect(agora.getHours()).toBe(23)
      expect(agora.getTimezoneOffset()).toBe(180)        // UTC−3
      expect(agora.toISOString().slice(0, 10)).toBe('2026-09-22') // ← o dia errado
    })
  })

  /* --------------------------------------------------- admin/auditoria.vue */

  it('auditoria: os atalhos de período pegam HOJE, não amanhã', () => {
    em('America/Sao_Paulo', NOITE, () => {
      // é o que `faixaDo()` da tela devolve agora
      expect(diaLocal()).toBe('2026-09-21')
      expect(diaLocalMais(-1)).toBe('2026-09-20')
      expect(diaLocalMais(-6)).toBe('2026-09-15')
      expect(primeiroDiaDoMes()).toBe('2026-09-01')
      // e a conta que estava espalhada pelas telas, no MESMO instante:
      expect(new Date().toISOString().slice(0, 10)).toBe('2026-09-22')
    })
  })

  it('auditoria: o carimbo de "quem mexeu" não imprime o dia anterior', () => {
    em('America/Sao_Paulo', NOITE, () => {
      // dia de calendário vindo do banco (::date vira "YYYY-MM-DD" no JSON)
      expect(dataHoraSegundo('2026-09-21')).toBe('21/09/2026 00:00:00')
      // o `new Date(d).toLocaleString(...)` que a tela fazia, no mesmo valor:
      expect(new Date('2026-09-21').toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', year: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })).toContain('20/09/26') // ← véspera, e é a prova de quem mexeu
      // instante completo continua sendo o instante, no fuso de quem lê
      expect(dataHoraSegundo('2026-09-22T02:30:07.000Z')).toBe('21/09/2026 23:30:07')
    })
  })

  /* ------------------------------------------- admin/evento/novo.vue ------ */

  it('evento novo: uma sessão por dia, sem dia a mais nem a menos', () => {
    em('America/Sao_Paulo', NOITE, () => {
      const inicio = paraData('2026-10-17')!
      const ultimo = diaLocal(paraData('2026-10-19')!)
      const dias: string[] = []
      for (let i = 0; i <= 60; i++) {
        const dia = diaLocalMais(i, inicio)
        if (dia > ultimo) break
        dias.push(dia)
      }
      expect(dias).toEqual(['2026-10-17', '2026-10-18', '2026-10-19'])
      expect(diaDaSemana('2026-10-17')).toBe('sábado')
    })
  })

  it('evento novo: num fuso adiantado o laço antigo nascia um dia atrás', () => {
    // O laço velho ancorava ao meio-dia (`new Date(data + 'T12:00')`) e cortava
    // com `toISOString()`. No Brasil o meio-dia local ainda cai no mesmo dia em
    // UTC — o remendo escondia o defeito. Em Kiritimati (UTC+14) não esconde.
    em('Pacific/Kiritimati', [2026, 9, 17, 23, 30], () => {
      const velho = new Date('2026-10-17T12:00').toISOString().slice(0, 10)
      expect(velho).toBe('2026-10-16')                     // ← a véspera
      expect(diaLocal(paraData('2026-10-17')!)).toBe('2026-10-17')
      expect(diaLocal(paraData('2026-10-17')!)).not.toBe(velho)
    })
  })

  it('evento novo: data + hora digitadas viram o instante certo', () => {
    em('America/Sao_Paulo', NOITE, () => {
      // 17/10 às 21h no parque = 18/10 00h em UTC
      expect(deCampoDataHora('2026-10-17T21:00')).toBe('2026-10-18T00:00:00.000Z')
      // e sem hora nenhuma o `new Date` cru cairia na véspera às 21h
      expect(new Date('2026-10-17').toISOString()).toBe('2026-10-17T00:00:00.000Z')
      expect(paraData('2026-10-17')!.getHours()).toBe(0)
      expect(paraData('2026-10-17')!.getDate()).toBe(17)
    })
  })

  /* ---------- evento/[id]/configuracoes.vue · ingressos/{index,cupons}.vue */

  it('cupom e lote: o campo mostra a hora que a pessoa marcou, não a de UTC', () => {
    em('America/Sao_Paulo', NOITE, () => {
      // o cupom/lote começa 20/09 às 21h no parque; no banco é 21/09 00h UTC
      const doBanco = '2026-09-21T00:00:00.000Z'
      expect(paraCampoDataHora(doBanco)).toBe('2026-09-20T21:00')
      // a conta que as duas telas faziam, no MESMO valor:
      expect(new Date(doBanco).toISOString().slice(0, 16)).toBe('2026-09-21T00:00')
      expect(paraCampoDataHora(doBanco))
        .not.toBe(new Date(doBanco).toISOString().slice(0, 16))
    })
  })

  it('cupom e lote: abrir o formulário e salvar sem tocar não mexe na hora', () => {
    // Este é o estrago de verdade do defeito acima: o operador abre pra mudar
    // o nome, clica em salvar, e o cupom anda TRÊS HORAS — para dentro da
    // noite de venda. A volta tem que devolver o mesmo instante.
    em('America/Sao_Paulo', NOITE, () => {
      for (const iso of [
        '2026-09-21T00:00:00.000Z', '2026-09-20T23:59:00.000Z',
        '2026-12-31T02:00:00.000Z', '2026-01-01T03:00:00.000Z',
      ]) {
        expect(deCampoDataHora(paraCampoDataHora(iso)), `ida e volta de ${iso}`).toBe(iso)
        // e o caminho velho NÃO devolvia o mesmo instante
        expect(new Date(new Date(iso).toISOString().slice(0, 16)).toISOString())
          .not.toBe(iso)
      }
    })
  })

  it('campo vazio continua vazio — nem "Invalid Date" nem dia inventado', () => {
    em('America/Sao_Paulo', NOITE, () => {
      expect(paraCampoDataHora(null)).toBe('')
      expect(paraCampoDataHora('')).toBe('')
      expect(deCampoDataHora('')).toBeNull()
      expect(deCampoDataHora(null)).toBeNull()
      expect(deCampoDataHora('nao é data')).toBeNull()
    })
  })
})

/**
 * A trava de fonte das cinco telas.
 *
 * Os casos acima provam que o formatador único acerta. Esta lista prova que
 * as telas PASSAM por ele — é a diferença entre "a função está certa" e "cada
 * tela tem a sua", que é a classe de bug deste projeto inteiro.
 *
 * Lista separada da de cima porque as regras são outras: estas cinco têm
 * `input type="number"` em campo de PORCENTAGEM (desconto em bps, taxa em
 * bps), que não é dinheiro e é legítimo.
 */
const TELAS_DE_DATA = [
  'app/pages/admin/auditoria.vue',
  'app/pages/admin/evento/novo.vue',
  'app/pages/admin/evento/[id]/configuracoes.vue',
  'app/pages/admin/evento/[id]/ingressos/cupons.vue',
  'app/pages/admin/evento/[id]/ingressos/index.vue',
]

describe('as cinco telas passam pelo formatador único', () => {
  it('nenhuma chama toISOString — é ele que vira amanhã às 21h', () => {
    expect(TELAS_DE_DATA.filter((t) => codigoDe(t).includes('toISOString'))).toEqual([])
  })

  it('nenhuma formata data na mão (toLocaleDate/TimeString, dateStyle, timeStyle)', () => {
    expect(TELAS_DE_DATA.filter((t) =>
      /toLocale(Date|Time)String|Intl\.DateTimeFormat|dateStyle|timeStyle/.test(codigoDe(t))))
      .toEqual([])
  })

  /**
   * O `toLocaleString` sozinho escapava das duas regras acima — e era
   * exatamente ele que a auditoria usava (`new Date(d).toLocaleString('pt-BR',
   * { day, month, year, hour, minute, second })`). Medido por mutação:
   * devolvendo aquela linha, esta lista continuava VERDE.
   *
   * O `toLocaleString` cru sobre NÚMERO segue liberado: é o separador de
   * milhar de contagem e de porcentagem, e essas telas têm os dois.
   */
  it('nem pelo toLocaleString: Date que vira texto na mão não passa', () => {
    const culpadas = TELAS_DE_DATA.filter((t) => {
      const src = codigoDe(t)
      return /new\s+Date\([^)]*\)\s*\.toLocale/.test(src)
        || /toLocaleString\([^)]*\{[^}]*\b(day|month|year|weekday|hour|minute|second)\s*:/.test(src)
    })
    expect(culpadas).toEqual([])
  })

  it('nenhuma remonta o R$ na mão — é de lá que vem o espaço fino', () => {
    expect(TELAS_DE_DATA.filter((t) =>
      /style:\s*'currency'|style:\s*"currency"|Intl\.NumberFormat/.test(codigoDe(t))))
      .toEqual([])
  })

  it('e as cinco existem de verdade, com código dentro', () => {
    for (const t of TELAS_DE_DATA) {
      expect(leia(t).length, t).toBeGreaterThan(100)
      expect(codigoDe(t).replace(/\s/g, '').length, `${t} sem comentário`)
        .toBeGreaterThan(leia(t).replace(/\s/g, '').length / 3)
    }
  })
})
