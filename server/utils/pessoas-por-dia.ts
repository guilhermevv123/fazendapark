/**
 * Pessoas esperadas em cada dia do evento — pra dimensionar equipe (dono, 08/10: "eu preciso
 * medir quantas pessoas vão vir de acordo com os dias ... pra ver a quantidade de funcionários").
 *
 * Régua: cada ingresso de pé (`valido` ou `usado`) vale as pessoas do tipo (combo de 10 = 10; sem
 * número no tipo, as do setor) e cai nos dias de uso do tipo (047). O ingresso que vale em MAIS
 * de um dia conta em cada um deles — não dá pra saber em qual vem, e equipe se dimensiona pelo
 * pior caso; a tela avisa quando isso acontece. O que não tem dia marcado vai pra "qualquer dia".
 *
 * Pura: o banco entrega os grupos, a tela só desenha.
 */
import { limparDiasDeUso, type DiaDoEvento } from './dias-de-uso'

export interface GrupoDeIngressos {
  /** nome do tipo; `null` = venda sem tipo */
  tipo: string | null
  /** dias de uso do tipo (`valid_dates::text[]`); vazio/null = qualquer dia */
  dias: unknown
  /** pessoas por ingresso (COALESCE(tt.admits, s.admits, 1)) */
  pessoas: number
  ingressos: number
}

export interface TipoNoDia { nome: string; ingressos: number; pessoas: number; porIngresso: number }
export interface PessoasNoDia {
  dia: string
  rotulo: string
  pessoas: number
  ingressos: number
  /** quantas das `pessoas` vêm em combo (ingresso que vale mais de 1) */
  emCombo: number
  /** pessoas que de fato passaram na catraca neste dia */
  entraram: number
  /** há ingresso que vale neste dia E em outro — o número é o máximo possível */
  temIngressoDeVariosDias: boolean
  tipos: TipoNoDia[]
}

export interface PessoasPorDia {
  dias: PessoasNoDia[]
  /** ingresso sem dia marcado: pode vir em qualquer dia */
  qualquerDia: { pessoas: number; ingressos: number; emCombo: number; tipos: TipoNoDia[] }
  /** ingresso marcado pra dia que não é do evento (data do evento mudou depois) */
  foraDoEvento: { pessoas: number; ingressos: number }
}

const nomeDoTipo = (t: string | null) => (t ?? '').trim() || 'Sem tipo'

function somarTipo(lista: TipoNoDia[], g: GrupoDeIngressos) {
  const nome = nomeDoTipo(g.tipo)
  const t = lista.find((x) => x.nome === nome && x.porIngresso === g.pessoas)
  if (t) { t.ingressos += g.ingressos; t.pessoas += g.ingressos * g.pessoas }
  else lista.push({ nome, ingressos: g.ingressos, pessoas: g.ingressos * g.pessoas, porIngresso: g.pessoas })
}
const ordenarTipos = (l: TipoNoDia[]) => l.sort((a, b) => b.pessoas - a.pessoas || a.nome.localeCompare(b.nome))

export function pessoasPorDiaDeUso(
  grupos: GrupoDeIngressos[], diasDoEvento: DiaDoEvento[], entraramPorDia: Record<string, number> = {},
): PessoasPorDia {
  const dias: PessoasNoDia[] = diasDoEvento.map((d) => ({
    dia: d.dia, rotulo: d.rotulo, pessoas: 0, ingressos: 0, emCombo: 0,
    entraram: Number(entraramPorDia[d.dia] ?? 0), temIngressoDeVariosDias: false, tipos: [],
  }))
  const porDia = new Map(dias.map((d) => [d.dia, d]))
  const qualquerDia = { pessoas: 0, ingressos: 0, emCombo: 0, tipos: [] as TipoNoDia[] }
  const foraDoEvento = { pessoas: 0, ingressos: 0 }

  for (const g0 of grupos) {
    const g = { ...g0, pessoas: Math.max(1, Number(g0.pessoas) || 1), ingressos: Number(g0.ingressos) || 0 }
    if (!g.ingressos) continue
    const total = g.ingressos * g.pessoas
    const combo = g.pessoas > 1 ? total : 0
    const marcados = limparDiasDeUso(g.dias) ?? []
    if (!marcados.length) {
      qualquerDia.pessoas += total; qualquerDia.ingressos += g.ingressos; qualquerDia.emCombo += combo
      somarTipo(qualquerDia.tipos, g)
      continue
    }
    const doEvento = marcados.filter((d) => porDia.has(d))
    if (!doEvento.length) { foraDoEvento.pessoas += total; foraDoEvento.ingressos += g.ingressos; continue }
    for (const d of doEvento) {
      const dia = porDia.get(d)!
      dia.pessoas += total; dia.ingressos += g.ingressos; dia.emCombo += combo
      if (doEvento.length > 1) dia.temIngressoDeVariosDias = true
      somarTipo(dia.tipos, g)
    }
  }
  for (const d of dias) ordenarTipos(d.tipos)
  ordenarTipos(qualquerDia.tipos)
  return { dias, qualquerDia, foraDoEvento }
}

/** quantos funcionários pra `pessoas`, a 1 a cada `porFuncionario` (arredonda pra cima); 0 sem régua */
export function funcionariosPara(pessoas: number, porFuncionario: number | null | undefined) {
  const n = Number(porFuncionario)
  if (!Number.isFinite(n) || n <= 0 || pessoas <= 0) return 0
  return Math.ceil(pessoas / n)
}
