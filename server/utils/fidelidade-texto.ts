/**
 * A parte do "Volte Mais" (037) que é só TEXTO e regra, sem banco nem servidor: o tipo do programa,
 * o padrão de fábrica e o regulamento. Mora separada de `fidelidade.ts` porque a TELA também usa —
 * o regulamento muda ao vivo enquanto o dono mexe nas regras, e o texto que ele lê é o mesmo que o
 * cliente vai ler (uma função, não duas).
 */
export type ProgramaDeFidelidade = {
  id: string; org_id: string; nome: string; ativo: boolean
  desconto_bps: number; retornos: number; prazo_dias: number | null; ingressos_por_compra: number
  conta_visita: 'entrada' | 'compra'; dias_semana: number[]; vale_feriado: boolean; eventos_fora: string[]
  vale_visita_anterior: boolean; consumacao_bps: number
  vigencia_inicio: string | null; vigencia_fim: string | null; regulamento: string | null
}

/** O programa de fábrica: DESLIGADO e sem vigência — ninguém ganha desconto até o dono ligar. */
export const PROGRAMA_DE_FIDELIDADE_PADRAO: Omit<ProgramaDeFidelidade, 'id' | 'org_id'> = {
  nome: 'Volte Mais', ativo: false, desconto_bps: 5000, retornos: 2, prazo_dias: 90, ingressos_por_compra: 1,
  conta_visita: 'entrada', dias_semana: [0, 1, 2, 3, 4, 5, 6], vale_feriado: true, eventos_fora: [],
  vale_visita_anterior: false, consumacao_bps: 1000, vigencia_inicio: null, vigencia_fim: null, regulamento: null,
}

const pct = (bps: number) => `${(bps / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`
const dataBR = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : '')
const NOME_DO_DIA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']

/** O regulamento que sai pronto das regras (CDC art. 30–31: o limite aparece ANTES do pagamento). */
export function regulamentoDaFidelidade(p: ProgramaDeFidelidade, nomeDoParque = 'Conquista Park'): string {
  const dias = p.dias_semana.length === 7 ? 'qualquer dia de funcionamento'
    : p.dias_semana.slice().sort().map((d) => NOME_DO_DIA[d]).join(', ')
  const linhas = [
    `${p.nome} — ${nomeDoParque}`,
    `1. Vigência: de ${dataBR(p.vigencia_inicio)} a ${dataBR(p.vigencia_fim)}.`,
    `2. Quem participa: pessoa com conta no site do ${nomeDoParque}, identificada pelo CPF. O benefício é pessoal e intransferível.`,
    `3. Como ganha: depois da primeira visita${p.conta_visita === 'entrada' ? ' (entrada registrada na portaria)' : ' (compra paga)'} com ingresso inteiro pago`
      + `${p.vale_visita_anterior ? '' : ' dentro da vigência'}, o titular ganha ${p.retornos} ${p.retornos === 1 ? 'retorno' : 'retornos'} com ${pct(p.desconto_bps)} de desconto no ingresso.`,
    `4. Em cada retorno, o desconto vale para ${p.ingressos_por_compra === 1 ? '1 ingresso (o do titular)' : `até ${p.ingressos_por_compra} ingressos da mesma compra`}, comprados no site com a conta do titular.`,
    p.prazo_dias ? `5. Prazo: a visita com desconto precisa acontecer em até ${p.prazo_dias} dias depois da primeira visita, e dentro da vigência.` : '5. Prazo: a visita com desconto precisa acontecer dentro da vigência.',
    `6. Dias: vale em ${dias}${p.vale_feriado ? ', e nos feriados nacionais' : '; não vale em feriados nacionais'}${p.eventos_fora.length ? '; eventos especiais indicados no site não participam' : ''}.`,
    '7. Não acumula com meia-entrada nem com cupom: no ingresso de meia-entrada vale a meia (que já é metade do preço).',
    '8. Compra cancelada, expirada ou reembolsada devolve o retorno; o desconto não é convertido em dinheiro.',
    p.consumacao_bps > 0 ? `9. No dia do retorno, o titular tem ${pct(p.consumacao_bps)} de desconto na consumação dentro do parque, apresentando o ingresso e um documento com foto no caixa.` : '',
  ].filter(Boolean)
  return linhas.join('\n')
}
