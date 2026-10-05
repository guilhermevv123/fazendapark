/**
 * A parte do "Volte Mais" (037) que é só TEXTO e regra, sem banco nem servidor: o tipo do programa,
 * o padrão de fábrica e o regulamento. Mora separada de `fidelidade.ts` porque a TELA também usa —
 * o regulamento muda ao vivo enquanto o dono mexe nas regras, e o texto que ele lê é o mesmo que o
 * cliente vai ler (uma função, não duas).
 */
export type ProgramaDeFidelidade = {
  id: string; org_id: string; nome: string; ativo: boolean
  /** null = sem limite: TODAS as próximas visitas (042, "permanente") */
  desconto_bps: number; retornos: number | null; prazo_dias: number | null; ingressos_por_compra: number
  conta_visita: 'entrada' | 'compra'; dias_semana: number[]; vale_feriado: boolean; eventos_fora: string[]
  vale_visita_anterior: boolean; consumacao_bps: number
  /** cupom de consumação (042): quantos carimbos por visita, ou vale o dia todo depois do 1º */
  consumacao_usos: number; consumacao_dia_todo: boolean
  /** vigencia_fim null = por tempo indeterminado (042) */
  vigencia_inicio: string | null; vigencia_fim: string | null; regulamento: string | null
}

/**
 * O programa de fábrica: DESLIGADO e sem início — ninguém ganha desconto até o dono ligar. O
 * formato é o que o dono pediu em 05/10: permanente (sem limite de retornos, sem data de fim),
 * 50% na entrada, 10% na consumação com 1 carimbo por visita.
 */
export const PROGRAMA_DE_FIDELIDADE_PADRAO: Omit<ProgramaDeFidelidade, 'id' | 'org_id'> = {
  nome: 'Volte Mais', ativo: false, desconto_bps: 5000, retornos: null, prazo_dias: null, ingressos_por_compra: 1,
  conta_visita: 'entrada', dias_semana: [0, 1, 2, 3, 4, 5, 6], vale_feriado: true, eventos_fora: [],
  vale_visita_anterior: false, consumacao_bps: 1000, consumacao_usos: 1, consumacao_dia_todo: false,
  vigencia_inicio: null, vigencia_fim: null, regulamento: null,
}

/** O programa é permanente? (sem limite de retornos E sem data de fim) */
export const fidelidadePermanente = (p: Pick<ProgramaDeFidelidade, 'retornos' | 'vigencia_fim'>) => p.retornos == null && !p.vigencia_fim

const pct = (bps: number) => `${(bps / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`
const dataBR = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : '')
const NOME_DO_DIA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']

/** O regulamento que sai pronto das regras (CDC art. 30–31: o limite aparece ANTES do pagamento). */
export function regulamentoDaFidelidade(p: ProgramaDeFidelidade, nomeDoParque = 'Conquista Park'): string {
  const dias = p.dias_semana.length === 7 ? 'qualquer dia de funcionamento'
    : p.dias_semana.slice().sort().map((d) => NOME_DO_DIA[d]).join(', ')
  const vigencia = p.vigencia_fim
    ? `1. Vigência: de ${dataBR(p.vigencia_inicio)} a ${dataBR(p.vigencia_fim)}.`
    : `1. Vigência: a partir de ${dataBR(p.vigencia_inicio)}, por tempo indeterminado. O ${nomeDoParque} pode encerrar o programa avisando no site com 30 dias de antecedência; compra já feita mantém o desconto.`
  const quantos = p.retornos == null
    ? `${pct(p.desconto_bps)} de desconto no ingresso em todas as próximas visitas`
    : `${p.retornos} ${p.retornos === 1 ? 'retorno' : 'retornos'} com ${pct(p.desconto_bps)} de desconto no ingresso`
  const consumo = p.consumacao_dia_todo
    ? 'o cupom vale o dia todo depois de ativado no caixa'
    : p.consumacao_usos === 1 ? 'o cupom é usado 1 vez por visita' : `o cupom pode ser usado ${p.consumacao_usos} vezes na visita`
  const linhas = [
    `${p.nome} — ${nomeDoParque}`,
    vigencia,
    `2. Quem participa: pessoa com conta no site do ${nomeDoParque}, identificada pelo CPF. O benefício é pessoal e intransferível.`,
    `3. Como ganha: depois da primeira visita${p.conta_visita === 'entrada' ? ' (entrada registrada na portaria)' : ' (compra paga)'} com ingresso inteiro pago`
      + `${p.vale_visita_anterior ? '' : ' dentro da vigência'}, o titular ganha ${quantos}.`,
    `4. Em cada retorno, o desconto vale para ${p.ingressos_por_compra === 1 ? '1 ingresso (o do titular)' : `até ${p.ingressos_por_compra} ingressos da mesma compra`}, comprados no site com a conta do titular.`,
    p.prazo_dias ? `5. Prazo: a visita com desconto precisa acontecer em até ${p.prazo_dias} dias depois da primeira visita${p.vigencia_fim ? ', e dentro da vigência' : ''}.` : (p.vigencia_fim ? '5. Prazo: a visita com desconto precisa acontecer dentro da vigência.' : ''),
    `6. Dias: vale em ${dias}${p.vale_feriado ? ', e nos feriados nacionais' : '; não vale em feriados nacionais'}${p.eventos_fora.length ? '; eventos especiais indicados no site não participam' : ''}.`,
    '7. Não acumula com meia-entrada nem com cupom: no ingresso de meia-entrada vale a meia (que já é metade do preço).',
    '8. Compra cancelada, expirada ou reembolsada devolve o retorno; o desconto não é convertido em dinheiro.',
    p.consumacao_bps > 0 ? `9. No dia do retorno, o titular tem ${pct(p.consumacao_bps)} de desconto na consumação dentro do parque: mostre o cupom de consumação (no ingresso e no e-mail) e um documento com foto no caixa, que confere e dá baixa; ${consumo}. Vale só no dia da visita, depois da entrada na portaria.` : '',
  ].filter(Boolean)
  // a cláusula que não se aplica some (ex.: prazo no permanente) — a numeração segue sem buraco
  return linhas.map((l, i) => (i === 0 ? l : l.replace(/^\d+\. /, `${i}. `))).join('\n')
}
