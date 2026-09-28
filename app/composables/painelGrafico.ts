/**
 * painelGrafico.ts — a série e a escala dos gráficos do painel da organização.
 *
 * Os gráficos de "Vendas por dia" (Visão geral) e "Entrada por mês" (Financeiro) eram `<div>` com
 * altura proporcional, e três defeitos moravam neles (auditoria REL-03, FIN-01, FIN-08):
 *
 *   1. **dia sem venda sumia do eixo** — a série só tinha os dias com pedido, e três vendas em
 *      setembro e uma em novembro desenhavam quatro barras coladas, como se fossem dias seguidos;
 *   2. **o rótulo saía do mês ANTERIOR** — o servidor mandava o instante (`…T03:00:00.000Z`) e o
 *      navegador o lia no fuso DELE: em Manaus (-04) o 1º de setembro virava 31 de agosto. Agora o
 *      ponto é a CHAVE do calendário do parque (`AAAA-MM-DD`, texto) e vira data local por
 *      `paraData` — o mesmo dia pra qualquer navegador;
 *   3. **muitos dias vazavam do cartão** — 90 barras de 6 px não cabem em 375 px. Acima de ~2
 *      meses a série agrupa por semana; acima de ~6 meses, por mês.
 *
 * Tudo puro, sem tela: o componente `painel/GraficoBarras.vue` só desenha o que sai daqui.
 */
import { paraData } from './formato'
import { somarDiasNoCalendario } from './painelPeriodo'

export type Passo = 'dia' | 'semana' | 'mes'

/** até 2 meses: um ponto por dia; até ~6 meses: por semana; mais que isso: por mês */
export function escolherPasso(de: string, ate: string): Passo {
  const dias = Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000) + 1
  if (dias <= 62) return 'dia'
  if (dias <= 182) return 'semana'
  return 'mes'
}

/** o dia que ABRE o balde: o próprio dia, a segunda-feira da semana, ou o dia 1º do mês */
export function inicioDoBalde(dia: string, passo: Passo): string {
  if (passo === 'dia') return dia
  if (passo === 'mes') return `${dia.slice(0, 7)}-01`
  const d = new Date(`${dia}T12:00:00Z`)
  const desdeSegunda = (d.getUTCDay() + 6) % 7
  return somarDiasNoCalendario(dia, -desdeSegunda)
}

function proximoBalde(inicio: string, passo: Passo): string {
  if (passo === 'dia') return somarDiasNoCalendario(inicio, 1)
  if (passo === 'semana') return somarDiasNoCalendario(inicio, 7)
  const [a, m] = inicio.split('-').map(Number) as [number, number]
  return m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`
}

export type PontoDaSerie = { chave: string } & Record<string, number | string>

/**
 * A série CONTÍNUA de `de` a `até`: todo balde aparece, o vazio com zero. `campos` são os números
 * que se somam dentro de cada balde (cobrado, líquido, pedidos…). Ponto fora do período é ignorado.
 */
export function serieContinua(
  pontos: ({ dia: string } & Record<string, any>)[],
  de: string, ate: string, passo: Passo, campos: string[],
): PontoDaSerie[] {
  const baldes = new Map<string, PontoDaSerie>()
  for (let b = inicioDoBalde(de, passo); b <= ate; b = proximoBalde(b, passo)) {
    const vazio: PontoDaSerie = { chave: b }
    for (const c of campos) vazio[c] = 0
    baldes.set(b, vazio)
    if (baldes.size > 2000) break // trava de sanidade: período absurdo não trava o navegador
  }
  for (const p of pontos ?? []) {
    const dia = String(p.dia ?? '').slice(0, 10)
    if (!dia || dia < de || dia > ate) continue
    const alvo = baldes.get(inicioDoBalde(dia, passo))
    if (!alvo) continue
    for (const c of campos) alvo[c] = Number(alvo[c]) + Number(p[c] ?? 0)
  }
  return [...baldes.values()]
}

/** Um número "redondo" pra linha de grade: 1, 2, 2,5 ou 5 vezes uma potência de 10. */
function redondo(v: number): number {
  if (v <= 0) return 1
  const potencia = 10 ** Math.floor(Math.log10(v))
  const f = v / potencia
  const passo = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return passo * potencia
}

/** Três linhas de grade e o topo do eixo, sempre ≥ o maior valor (a barra nunca estoura). */
export function escalaDoEixo(maior: number): { topo: number; linhas: number[] } {
  const passo = redondo(Math.max(maior, 1) / 3)
  return { topo: passo * 3, linhas: [passo, passo * 2, passo * 3] }
}

/**
 * "R$ 950", "R$ 12,5 mil", "R$ 1,2 mi" — pro eixo e pro rótulo curto. Só rótulo: a conta é em
 * inteiro (décimos arredondados), e o valor exato continua no toque/hover da barra.
 */
export function reaisCompacto(centavos: number): string {
  const sinal = centavos < 0 ? '-' : ''
  const reais = Math.round(Math.abs(centavos) / 100)
  const decimo = (inteiroDeDecimos: number, sufixo: string) => {
    const i = Math.floor(inteiroDeDecimos / 10)
    const r = inteiroDeDecimos % 10
    return `${sinal}R$ ${i.toLocaleString('pt-BR')}${r ? `,${r}` : ''} ${sufixo}`
  }
  if (reais < 1000) return `${sinal}R$ ${reais}`
  if (reais < 1_000_000) return decimo(Math.round(reais / 100), 'mil')
  return decimo(Math.round(reais / 100_000), 'mi')
}

const MES_LONGO = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto',
  'setembro', 'outubro', 'novembro', 'dezembro']

/**
 * O rótulo do eixo. Lê a CHAVE como dia de calendário (`paraData`, meia-noite LOCAL) — nunca como
 * instante UTC, que é o que trocava setembro por agosto em navegador fora do fuso do parque.
 * No passo mensal o ano aparece no primeiro ponto e em todo janeiro.
 */
export function rotuloDoPonto(chave: string, passo: Passo, primeiro = false): string {
  const d = paraData(chave.slice(0, 10))
  if (!d) return chave
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  if (passo !== 'mes') return `${dd}/${mm}`
  const mes = d.toLocaleDateString('pt-BR', { month: 'short' })
  return primeiro || d.getMonth() === 0 ? `${mes} ${d.getFullYear()}` : mes
}

/** O ponto por extenso, pro toque/hover: "sáb., 21/09", "semana de 15/09", "setembro de 2026". */
export function detalheDoPonto(chave: string, passo: Passo): string {
  const d = paraData(chave.slice(0, 10))
  if (!d) return chave
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  if (passo === 'mes') return `${MES_LONGO[d.getMonth()]} de ${d.getFullYear()}`
  if (passo === 'semana') return `semana de ${dd}/${mm}`
  return `${d.toLocaleDateString('pt-BR', { weekday: 'short' })}, ${dd}/${mm}/${d.getFullYear()}`
}

/** Quais índices ganham rótulo no eixo: no máximo `cabem`, espaçados, sempre o primeiro. */
export function indicesComRotulo(total: number, cabem: number): Set<number> {
  const s = new Set<number>()
  if (total <= 0) return s
  const passo = Math.max(1, Math.ceil(total / Math.max(1, cabem)))
  for (let i = 0; i < total; i += passo) s.add(i)
  // o último ponto entra quando não fica espremido contra o rótulo anterior
  const ultimo = total - 1
  if (!s.has(ultimo) && ultimo % passo >= Math.ceil(passo / 2)) s.add(ultimo)
  return s
}

/** Variação contra o período anterior, em pontos percentuais inteiros; `null` sem base pra comparar. */
export function variacao(atual: number, anterior: number | null | undefined): number | null {
  if (anterior === null || anterior === undefined || anterior <= 0) return null
  return Math.round(((atual - anterior) / anterior) * 100)
}
