/**
 * Troca de dia na portaria (049) — a régua pura, a MESMA no servidor e no tablet sem rede.
 *
 * Dono, 08/10: "e se aparecer alguém com ingresso de sábado pra entrar domingo? ... bloquear, mas se a
 * pessoa quiser entrar, ela faz o pagamento lá na hora, o valor da diferença, e aí ela entra".
 *
 * O ingresso que não vale hoje (047) continua barrado. A troca oferece os tipos que valem HOJE com o
 * MESMO número de pessoas (combo de 10 só troca por combo de 10 — a catraca conta as pessoas do
 * ingresso que entrou, então trocar por um tipo de outro tamanho deixaria a contagem errada). O tipo
 * "irmão" (mesmo nome sem o dia: "ENTRADA INDIVIDUAL SÁBADO" → "ENTRADA INDIVIDUAL DOMINGO") vem
 * primeiro, marcado como sugerido.
 *
 * Diferença = preço de hoje − o que a pessoa pagou (face, sem taxa), nunca negativa: quem tem o
 * ingresso mais caro entra sem pagar nada e sem receber troco (a portaria não devolve dinheiro).
 */
import { valeNoDiaDeUso } from './dias-de-uso'
import { reais } from './dinheiro'

export interface TipoParaTroca {
  id: string
  nome: string
  /** dias de uso do tipo ('AAAA-MM-DD'); vazio/null = qualquer dia */
  dias: string[] | null
  /** face de hoje (o preço do tipo no lote dele), em centavos */
  faceCents: number
  pessoas: number
  /** o lote do tipo está à venda agora — entre dois tipos iguais, vale o do lote aberto */
  disponivel: boolean
  ordem: number
}

export interface OpcaoDeTroca {
  tipoId: string
  nome: string
  pessoas: number
  precoCents: number
  diferencaCents: number
  /** o mesmo tipo do ingresso, só que de hoje */
  sugerida: boolean
}

export interface IngressoParaTroca {
  /** nome do tipo comprado ("ENTRADA INDIVIDUAL SÁBADO") */
  tipo: string | null
  pessoas: number
  /** quanto a pessoa pagou pela face de UM ingresso, em centavos */
  pagoCents: number
}

export const FORMAS_DE_TROCA = ['dinheiro', 'pix', 'credito', 'debito'] as const
export type FormaDeTroca = typeof FORMAS_DE_TROCA[number] | 'sem_diferenca'
export const ROTULO_DA_FORMA: Record<FormaDeTroca, string> = {
  dinheiro: 'Dinheiro', pix: 'Pix', credito: 'Cartão de crédito', debito: 'Cartão de débito',
  sem_diferenca: 'Sem diferença',
}

const DIA_NO_NOME = /\b(DOMINGO|SEGUNDA|TERCA|QUARTA|QUINTA|SEXTA|SABADO)(\s*-?\s*FEIRA)?\b/g

/** o nome do tipo sem o dia da semana — "COMBO SÁBADO - COMBO 10 PESSOAS" → "COMBO - COMBO 10 PESSOAS" */
export function nomeSemDia(nome: string | null | undefined): string {
  return String(nome ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(DIA_NO_NOME, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
}

/** as opções de troca pra HOJE, a sugerida primeiro; vazio = não há tipo de hoje com as mesmas pessoas */
export function opcoesDeTroca(ingresso: IngressoParaTroca, tipos: TipoParaTroca[], hoje: string): OpcaoDeTroca[] {
  const pessoas = Math.max(1, Number(ingresso.pessoas) || 1)
  const pago = Math.max(0, Math.round(Number(ingresso.pagoCents) || 0))
  const meu = nomeSemDia(ingresso.tipo)
  const melhores = new Map<string, TipoParaTroca>()
  for (const t of tipos) {
    if (Math.max(1, Number(t.pessoas) || 1) !== pessoas) continue
    if (!valeNoDiaDeUso(t.dias, hoje)) continue
    // tipo "qualquer dia" (sem dias) não é troca de dia: é outro produto. Só entra se tiver dia marcado.
    if (!t.dias?.length) continue
    const chave = nomeSemDia(t.nome)
    const atual = melhores.get(chave)
    if (!atual || (t.disponivel && !atual.disponivel)
      || (t.disponivel === atual.disponivel && t.ordem < atual.ordem)) melhores.set(chave, t)
  }
  return [...melhores.entries()]
    .map(([chave, t]) => ({
      tipoId: t.id, nome: t.nome, pessoas,
      precoCents: Math.max(0, Math.round(t.faceCents)),
      diferencaCents: Math.max(0, Math.round(t.faceCents) - pago),
      sugerida: chave === meu && meu !== '',
    }))
    .sort((a, b) => Number(b.sugerida) - Number(a.sugerida)
      || a.diferencaCents - b.diferencaCents || a.nome.localeCompare(b.nome))
}

/**
 * Confere a troca que o porteiro confirmou contra as opções de agora. Com rede, o servidor recusa
 * valor diferente do calculado (o preço pode ter mudado entre a tela abrir e o toque) e devolve a
 * conta nova; sem rede quem decide é o tablet, e o servidor só registra a divergência.
 */
export function conferirTroca(opcoes: OpcaoDeTroca[], tipoId: string, cobradoCents: number, forma: string):
  { ok: true; opcao: OpcaoDeTroca } | { ok: false; erro: string } {
  const opcao = opcoes.find((o) => o.tipoId === tipoId)
  if (!opcao) return { ok: false, erro: 'Este tipo não vale hoje para este ingresso. Leia o ingresso de novo.' }
  if (Math.round(cobradoCents) !== opcao.diferencaCents) {
    return { ok: false, erro: `A diferença agora é ${reaisDaTroca(opcao.diferencaCents)}. Confira e confirme de novo.` }
  }
  if (opcao.diferencaCents === 0 && forma !== 'sem_diferenca') {
    return { ok: false, erro: 'Não há diferença a cobrar: libere sem cobrança.' }
  }
  if (opcao.diferencaCents > 0 && !(FORMAS_DE_TROCA as readonly string[]).includes(forma)) {
    return { ok: false, erro: 'Escolha como a diferença foi paga.' }
  }
  return { ok: true, opcao }
}

/** o R$ da troca é o formatador único da casa (`reais`, espaço normal) — nunca uma cópia */
export const reaisDaTroca = reais
