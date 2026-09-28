/**
 * painelPeriodo.ts — o período dos painéis da organização (Visão geral, Financeiro), num lugar só.
 *
 * Os atalhos são o MESMO vocabulário em toda tela de dinheiro (proposta 10 da auditoria de 27/09):
 * Hoje, 7 dias, 30 dias, Este mês, Mês passado, Este ano e Tudo. A URL leva a CHAVE
 * (`?periodo=30d`), não as datas: o link mandado hoje e aberto amanhã continua dizendo "os últimos
 * 30 dias", e quem decide que dia é hoje é o servidor, no calendário do PARQUE — o navegador de
 * quem abre pode estar em outro fuso (ver `hojeNoFuso` no dashboard do evento).
 *
 * Tudo aqui é conta de CALENDÁRIO sobre `AAAA-MM-DD`, sem passar por fuso: meio-dia UTC como
 * âncora, que nenhum horário de verão desloca pra outro dia. É o mesmo truque de `somarDias` em
 * `evento/[id]/dashboard.get.ts`. O servidor importa este arquivo (como importa `formato.ts`).
 */

export type ChavePeriodo = 'hoje' | '7d' | '30d' | 'mes' | 'mes_passado' | 'ano' | 'tudo'

export const PERIODOS: { chave: ChavePeriodo; rotulo: string }[] = [
  { chave: 'hoje', rotulo: 'Hoje' },
  { chave: '7d', rotulo: '7 dias' },
  { chave: '30d', rotulo: '30 dias' },
  { chave: 'mes', rotulo: 'Este mês' },
  { chave: 'mes_passado', rotulo: 'Mês passado' },
  { chave: 'ano', rotulo: 'Este ano' },
  { chave: 'tudo', rotulo: 'Tudo' },
]

export function ehChavePeriodo(v: unknown): v is ChavePeriodo {
  return typeof v === 'string' && PERIODOS.some((p) => p.chave === v)
}

const FORMATO = /^\d{4}-\d{2}-\d{2}$/

/** `AAAA-MM-DD` que é uma data de verdade (31 de fevereiro não passa). */
export function diaDeCalendario(v: unknown): v is string {
  if (typeof v !== 'string' || !FORMATO.test(v)) return false
  const d = new Date(`${v}T12:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** soma `n` dias a um `AAAA-MM-DD` sem fuso nenhum no caminho */
export function somarDiasNoCalendario(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** quantos dias o período cobre, com as duas pontas */
export function diasNoPeriodo(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000) + 1
}

/**
 * A chave vira `[de, até]` no calendário do parque, dado o dia de HOJE lá.
 * `tudo` não tem ponta: `null` nas duas (quem chama decide o que "desde sempre" quer dizer).
 */
export function faixaDoPeriodo(chave: ChavePeriodo, hoje: string): { de: string | null; ate: string | null } {
  const [a, m] = hoje.split('-').map(Number) as [number, number]
  const doMes = (ano: number, mes: number) => `${ano}-${String(mes).padStart(2, '0')}-01`
  switch (chave) {
    case 'hoje': return { de: hoje, ate: hoje }
    case '7d': return { de: somarDiasNoCalendario(hoje, -6), ate: hoje }
    case '30d': return { de: somarDiasNoCalendario(hoje, -29), ate: hoje }
    case 'mes': return { de: doMes(a, m), ate: hoje }
    case 'mes_passado': {
      const inicio = m === 1 ? doMes(a - 1, 12) : doMes(a, m - 1)
      return { de: inicio, ate: somarDiasNoCalendario(doMes(a, m), -1) }
    }
    case 'ano': return { de: `${a}-01-01`, ate: hoje }
    case 'tudo': return { de: null, ate: null }
  }
}

/** O período de MESMO tamanho imediatamente antes — a régua da comparação ("contra os 30 dias anteriores"). */
export function periodoAnterior(de: string | null, ate: string | null): { de: string; ate: string } | null {
  if (!de || !ate) return null
  const n = diasNoPeriodo(de, ate)
  return { de: somarDiasNoCalendario(de, -n), ate: somarDiasNoCalendario(de, -1) }
}

/** O que há de errado com as datas digitadas — uma frase, ou `null`. */
export function problemaNoPeriodo(de: string | null | undefined, ate: string | null | undefined): string | null {
  if (de && !diaDeCalendario(de)) return 'A data inicial não é uma data válida. Use dia, mês e ano.'
  if (ate && !diaDeCalendario(ate)) return 'A data final não é uma data válida. Use dia, mês e ano.'
  if (de && ate && de > ate) return 'A data inicial vem depois da final. Troque as duas de lugar.'
  return null
}

const dm = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`
const dma = (dia: string) => `${dm(dia)}/${dia.slice(0, 4)}`

/** "27/09", "01/09 a 27/09", "15/12/2025 a 10/01/2026" — o período como a pessoa lê. */
export function rotuloDoPeriodo(de: string | null | undefined, ate: string | null | undefined): string {
  if (!de && !ate) return 'todo o período'
  if (de && !ate) return `desde ${dma(de)}`
  if (!de && ate) return `até ${dma(ate)}`
  if (de === ate) return dma(de!)
  return de!.slice(0, 4) === ate!.slice(0, 4) ? `${dm(de!)} a ${dma(ate!)}` : `${dma(de!)} a ${dma(ate!)}`
}

/** O rótulo do atalho, ou "Período" pra datas digitadas à mão. */
export function nomeDoPeriodo(chave: string | null | undefined): string {
  return PERIODOS.find((p) => p.chave === chave)?.rotulo ?? 'Período'
}

/**
 * O dia de HOJE no calendário de um fuso (`en-CA` escreve `AAAA-MM-DD`). As rotas passam o fuso do
 * parque (`FUSO_DO_BANCO`); `toISOString().slice(0, 10)` cortaria em UTC e às 21h "hoje" viraria
 * amanhã.
 */
export function hojeNoFuso(fuso: string, agora: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(agora)
}

export type RecorteLido = { periodo: ChavePeriodo | null; de: string | null; ate: string | null }

/**
 * Lê `?periodo=` / `?de=` / `?ate=` do jeito que TODA rota de painel entende (Visão geral e
 * Financeiro): data à mão ganha do atalho; o atalho vira `[de, até]` no calendário do parque
 * (`hoje` é o dia de lá); o que está errado volta como UMA frase, pro 400 dizer o porquê.
 * Sem nada na consulta, `{ periodo: null, de: null, ate: null }`: a vida toda — o padrão de cada
 * TELA (30 dias, Tudo) é decisão dela, mandado explícito na URL.
 */
export function lerRecorte(consulta: Record<string, unknown>, hoje: string): { erro: string } | RecorteLido {
  const texto = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
  const de = texto(consulta.de)
  const ate = texto(consulta.ate)
  if (de && !diaDeCalendario(de)) return { erro: 'A data inicial não é uma data válida. Use dia, mês e ano.' }
  if (ate && !diaDeCalendario(ate)) return { erro: 'A data final não é uma data válida. Use dia, mês e ano.' }
  if (de && ate && de > ate) return { erro: 'A data inicial vem depois da final.' }
  const chave = consulta.periodo
  if (chave !== undefined && chave !== null && chave !== '' && !ehChavePeriodo(chave)) {
    return { erro: 'Período desconhecido. Escolha um dos atalhos da tela.' }
  }
  if (de || ate) return { periodo: null, de, ate }
  if (ehChavePeriodo(chave)) return { periodo: chave, ...faixaDoPeriodo(chave, hoje) }
  return { periodo: null, de: null, ate: null }
}
