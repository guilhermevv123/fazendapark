/**
 * dias-de-uso.ts — em que DIA do evento um tipo de ingresso passa na catraca (047).
 *
 * Dono, 07/10: "o ingresso que o cara tem de sexta, ele tenta passar domingo". O tipo
 * "ENTRADA INDIVIDUAL SEXTA" passava em qualquer dia: a porta só olhava status e sessão, e o
 * evento do parque é um só (sex a seg) com os dias no NOME do tipo. Agora o tipo guarda os dias
 * (`ticket_types.valid_dates`) e a porta compara com o dia de hoje no fuso do evento.
 *
 * Arquivo PURO (sem banco), de propósito: a mesma régua roda na catraca online
 * (`api/checkin.post.ts`), no tablet sem rede (`validacao/index.vue`, pela lista que desce) e na
 * tela do painel que marca os dias. Duas réguas escritas em dois lugares é como a porta online e
 * a offline começam a discordar.
 *
 * Dia = 'AAAA-MM-DD' do calendário no fuso do evento. Sem dias marcados o tipo vale em qualquer
 * dia — é o que mantém tudo o que já foi vendido passando igual até alguém marcar no painel.
 */

const FUSO_PADRAO = 'America/Bahia'
const DIA_RE = /^\d{4}-\d{2}-\d{2}$/

/** O dia do calendário de um instante, no fuso do evento. */
export function diaDeUsoDe(instante: Date | string | number = new Date(), fuso?: string | null): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso || FUSO_PADRAO, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(instante))
}

const SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'] as const

/** 0 = domingo … 6 = sábado, do dia 'AAAA-MM-DD' (meio-dia UTC: nenhum fuso muda o dia). */
function diaDaSemana(dia: string): number {
  return new Date(`${dia}T12:00:00Z`).getUTCDay()
}

/** "sexta 09/10" */
export function rotuloDoDiaDeUso(dia: string): string {
  const [, m, d] = dia.split('-')
  return `${SEMANA[diaDaSemana(dia)]} ${d}/${m}`
}

/** Os dias marcados, limpos: só datas válidas, sem repetir, em ordem. Vazio vira `null`. */
export function limparDiasDeUso(dias: unknown): string[] | null {
  if (!Array.isArray(dias)) return null
  const bons = [...new Set(dias.map((d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10)))
    .filter((d) => DIA_RE.test(d) && !Number.isNaN(new Date(`${d}T12:00:00Z`).getTime())))].sort()
  return bons.length ? bons : null
}

/** Pode passar neste dia? Sem dias marcados, sempre. */
export function valeNoDiaDeUso(dias: string[] | null | undefined, hoje: string): boolean {
  const limpos = limparDiasDeUso(dias)
  return !limpos || limpos.includes(hoje)
}

/** "sexta 09/10" · "sexta 09/10 e sábado 10/10" · "sexta 09/10, sábado 10/10 e domingo 11/10" */
export function fraseDosDiasDeUso(dias: string[] | null | undefined): string {
  const r = (limparDiasDeUso(dias) ?? []).map(rotuloDoDiaDeUso)
  if (r.length <= 1) return r[0] ?? ''
  return `${r.slice(0, -1).join(', ')} e ${r.at(-1)}`
}

/** O recado da porta pro ingresso fora do dia. */
export function mensagemForaDoDiaDeUso(dias: string[] | null | undefined): string {
  const frase = fraseDosDiasDeUso(dias)
  return frase ? `Este ingresso não vale hoje — vale só ${frase}` : 'Este ingresso não vale hoje'
}

export interface DiaDoEvento { dia: string; rotulo: string }

/**
 * Os dias do calendário que o evento cobre, do início ao fim, no fuso dele — as opções que a tela
 * mostra pra marcar. Teto de 62 dias (evento de temporada longa marca por período, não por dia).
 */
export function diasDoEvento(inicio: Date | string | null | undefined, fim: Date | string | null | undefined,
  fuso?: string | null): DiaDoEvento[] {
  if (!inicio) return []
  const primeiro = diaDeUsoDe(inicio, fuso)
  const ultimo = diaDeUsoDe(fim || inicio, fuso)
  const saida: DiaDoEvento[] = []
  let t = new Date(`${primeiro}T12:00:00Z`).getTime()
  const fimT = new Date(`${ultimo}T12:00:00Z`).getTime()
  while (t <= fimT && saida.length < 62) {
    const dia = new Date(t).toISOString().slice(0, 10)
    saida.push({ dia, rotulo: rotuloDoDiaDeUso(dia) })
    t += 86_400_000
  }
  return saida
}

const NOMES_DA_SEMANA: [RegExp, number][] = [
  [/\bDOMINGO\b/, 0], [/\bSEGUNDA\b/, 1], [/\bTERCA\b/, 2], [/\bQUARTA\b/, 3],
  [/\bQUINTA\b/, 4], [/\bSEXTA\b/, 5], [/\bSABADO\b/, 6],
]

/**
 * Os dias do evento que o NOME do tipo cita ("ENTRADA INDIVIDUAL SEXTA" → a sexta do evento). É só
 * a sugestão da tela — quem grava é a pessoa clicando em Salvar (dado nasce no painel, nunca de
 * script). Nome sem dia da semana, ou dia que o evento não tem: nada a sugerir.
 */
export function sugerirDiasDeUsoPeloNome(nome: string | null | undefined, dias: DiaDoEvento[]): string[] {
  const n = String(nome ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
  const semanas = new Set(NOMES_DA_SEMANA.filter(([re]) => re.test(n)).map(([, i]) => i))
  if (!semanas.size) return []
  return dias.filter((d) => semanas.has(diaDaSemana(d.dia))).map((d) => d.dia)
}

/**
 * Confere os dias que chegaram do painel contra o evento. Devolve os limpos (`null` = qualquer dia)
 * ou a frase do que está errado.
 */
export function conferirDiasDeUso(dias: unknown, evento: DiaDoEvento[]):
  { ok: true; dias: string[] | null } | { ok: false; erro: string } {
  const limpos = limparDiasDeUso(dias)
  if (!limpos) return { ok: true, dias: null }
  const doEvento = new Set(evento.map((d) => d.dia))
  const fora = limpos.filter((d) => !doEvento.has(d))
  if (fora.length) {
    return { ok: false, erro: `${fora.map(rotuloDoDiaDeUso).join(', ')} não é dia deste evento. `
      + 'Confira as datas do evento antes de marcar os dias de uso.' }
  }
  return { ok: true, dias: limpos }
}

/* ------------------------------------------------- o prazo da venda online (dono, 09/10) */

/**
 * O dia em que o tipo PARA de vender pelo site: o 1º dia de uso dele; sem dias marcados, o 1º dia
 * do evento. Dono, 09/10: "se o primeiro ingresso é sexta-feira, quinta-feira tem que acabar ...
 * se o próximo evento começa quarta, só pode comprar até terça, quando der meia-noite ... depois
 * é na portaria, presencial". O corte é a meia-noite (fuso do evento) que COMEÇA esse dia.
 */
export function diaDoCorteOnline(dias: unknown, inicioDoEvento: Date | string | null | undefined,
  fuso?: string | null): string | null {
  const marcados = limparDiasDeUso(dias)
  if (marcados) return marcados[0]!
  return inicioDoEvento ? diaDeUsoDe(inicioDoEvento, fuso) : null
}

/** O site ainda vende este tipo agora? Hoje (no fuso do evento) tem que ser ANTES do dia do corte. */
export function vendeOnlineAgora(dias: unknown, inicioDoEvento: Date | string | null | undefined,
  fuso?: string | null, agora: Date = new Date()): boolean {
  const corte = diaDoCorteOnline(dias, inicioDoEvento, fuso)
  return !corte || diaDeUsoDe(agora, fuso) < corte
}

/** "Ingresso de sexta 09/10 agora só na portaria" — a frase do site e do checkout. */
export function recadoDaVendaOnlineEncerrada(dia: string | null): string {
  return dia
    ? `A venda pelo site do ingresso de ${rotuloDoDiaDeUso(dia)} encerrou à meia-noite. Compre na portaria do parque.`
    : 'A venda deste ingresso pelo site encerrou. Compre na portaria do parque.'
}
