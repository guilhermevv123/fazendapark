/**
 * fusoHorario.ts — a hora "de parede" digitada num FUSO ESCOLHIDO vira o instante que o servidor
 * guarda.
 *
 * O assistente de criar evento pergunta o fuso no passo 5 (Bahia, Manaus, Rio Branco, Noronha) e
 * gravava o fuso — mas convertia início, término, encerramento e expiração do lote pelo relógio do
 * NAVEGADOR (`deCampoDataHora`). Evento em Manaus criado de um computador em Ubatã: "20:00" virava
 * 20:00 da Bahia, e a vitrine de Manaus mostrava 19:00 (auditoria EVT-03). Aqui a conta é no fuso
 * pedido, sem depender de onde a pessoa está.
 *
 * Sem biblioteca: `Intl.DateTimeFormat` com `timeZone` diz que horas são no fuso num dado instante;
 * a diferença pro UTC é o deslocamento. Uma segunda volta acerta o instante perto de troca de
 * horário de verão (o Brasil não tem desde 2019, mas o fuso é texto livre na rota).
 */

const FORMATO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/

/** que horas são no fuso, no instante dado — escrito como se fosse UTC (ms) */
function paredeEm(instante: number, fuso: string): number {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instante))
  const v = (t: string) => Number(partes.find((p) => p.type === t)?.value)
  return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour') % 24, v('minute'), v('second'))
}

/** quanto o fuso está à frente do UTC nesse instante, em ms (Bahia: −3 h = −10.800.000) */
export function deslocamentoDoFuso(instante: number, fuso: string): number {
  return paredeEm(instante, fuso) - Math.floor(instante / 1000) * 1000
}

/** o fuso é um que o navegador conhece? (texto torto derrubaria o `Intl` com RangeError) */
export function fusoValido(fuso: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: fuso }); return true } catch { return false }
}

/**
 * `"2026-10-17T20:00"` (hora de parede em `fuso`) → `"2026-10-18T00:00:00.000Z"` (Manaus, GMT−4).
 * Vazio, incompleto ou fuso desconhecido: `null` — nunca um dia inventado.
 */
export function instanteNoFuso(campo: string | null | undefined, fuso: string): string | null {
  if (!campo) return null
  const m = FORMATO.exec(campo)
  if (!m || !fusoValido(fuso)) return null
  const [a, me, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number]
  const parede = Date.UTC(a, me - 1, d, h, mi)
  if (Number.isNaN(parede)) return null
  // o dia tem que existir: 31/02 rolaria pra março em silêncio
  const conferido = new Date(parede)
  if (conferido.getUTCFullYear() !== a || conferido.getUTCMonth() !== me - 1 || conferido.getUTCDate() !== d) return null
  let t = parede - deslocamentoDoFuso(parede, fuso)
  const t2 = parede - deslocamentoDoFuso(t, fuso)
  if (t2 !== t) t = t2
  return new Date(t).toISOString()
}
