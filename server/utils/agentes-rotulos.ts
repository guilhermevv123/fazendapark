/**
 * Vocabulário do painel dos agentes — puro (sem banco, sem h3), pra tela e servidor lerem a MESMA
 * tabela, igual a `papeis.ts`.
 *
 * A Sofia (n8n) grava cada turno em `fp_conversas` com a INTENÇÃO que o classificador deu — uma
 * palavra (`duvida_faq`, `quer_comprar`…). Cada intenção cai num agente diferente do fluxo; é
 * isso que responde "qual agente está conversando". Intenção nova que o classificador inventar
 * amanhã não quebra a tela: cai em `agenteDaIntencao` como "Sofia" com o rótulo cru.
 */

export type Canal = 'whatsapp' | 'instagram' | 'grupo' | 'outro'

export interface RotuloDeIntencao {
  /** quem responde esse assunto no fluxo */
  agente: string
  /** o assunto em português de gente */
  assunto: string
  /** cor do selo: o que pede atenção sai em alerta/erro */
  tom: 'ok' | 'neutro' | 'alerta' | 'erro'
}

export const INTENCOES: Record<string, RotuloDeIntencao> = {
  duvida_faq:       { agente: 'Sofia · Dúvidas',       assunto: 'Dúvida',                tom: 'neutro' },
  quer_comprar:     { agente: 'Sofia · Vendas',        assunto: 'Quer comprar',          tom: 'ok' },
  info_incompleta:  { agente: 'Sofia · Qualificação',  assunto: 'Faltou informação',     tom: 'neutro' },
  reclamacao:       { agente: 'Sofia · Escuta',        assunto: 'Reclamação',            tom: 'erro' },
  elogio_sugestao:  { agente: 'Sofia · Escuta',        assunto: 'Elogio ou sugestão',    tom: 'ok' },
  caso_especial:    { agente: 'Sofia · Caso especial', assunto: 'Caso especial',         tom: 'alerta' },
  achados_perdidos: { agente: 'Equipe (humano)',       assunto: 'Objeto ou pessoa perdida', tom: 'erro' },
  // pessoa perdida, afogamento, ferimento, mal súbito, violência, furto — o detector de urgência
  // (27/09) responde o roteiro de socorro na hora e avisa a equipe, por cima da trava de humano
  urgencia:         { agente: 'Sofia · Urgência',      assunto: 'Urgência (equipe avisada)', tom: 'erro' },
  follow_up:        { agente: 'Follow-up automático',  assunto: 'Retomada de conversa',  tom: 'neutro' },
  fora_de_escopo:   { agente: 'Sofia · Fora do tema',  assunto: 'Fora do tema',          tom: 'neutro' },
  parceria_spam:    { agente: 'Filtro de parcerias',   assunto: 'Parceria ou spam',      tom: 'neutro' },
}

export function rotuloDaIntencao(intencao: string | null | undefined): RotuloDeIntencao {
  const chave = String(intencao ?? '').trim()
  return INTENCOES[chave] ?? { agente: 'Sofia', assunto: chave ? chave.replace(/_/g, ' ') : 'Sem rótulo', tom: 'neutro' }
}

/**
 * O canal sai do formato do identificador, a mesma régua da API do n8n: WhatsApp é 55 + DDD +
 * número (12 ou 13 dígitos), grupo termina em `@g.us`, Instagram é o id numérico longo da Meta.
 */
export function canalDoContato(contato: string | null | undefined): Canal {
  const c = String(contato ?? '')
  if (c.endsWith('@g.us')) return 'grupo'
  if (/^55\d{10,11}$/.test(c)) return 'whatsapp'
  if (/^\d{14,20}$/.test(c)) return 'instagram'
  return 'outro'
}

export const ROTULO_DO_CANAL: Record<Canal, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  grupo: 'Grupo',
  outro: 'Outro',
}

/** O contato pode ir pra URL/consulta? Mesma régua da API do n8n (que também confere). */
export function contatoValido(contato: string): boolean {
  return /^[0-9A-Za-z@._-]{5,64}$/.test(contato)
}

/** (73) 99826-0963 pra WhatsApp; id do Instagram sai como veio. */
export function contatoLegivel(contato: string, mascarar = false): string {
  if (canalDoContato(contato) !== 'whatsapp') return mascarar ? contato.slice(0, 4) + '…' + contato.slice(-4) : contato
  const n = contato.slice(2)
  const ddd = n.slice(0, 2), resto = n.slice(2)
  const meio = resto.length === 9 ? `${resto.slice(0, 5)}-${resto.slice(5)}` : `${resto.slice(0, 4)}-${resto.slice(4)}`
  if (!mascarar) return `(${ddd}) ${meio}`
  return `(${ddd}) ${meio.slice(0, 2)}•••-${meio.slice(-4)}`
}

export const SITUACAO_DO_RESUMO: Record<string, { texto: string; tom: RotuloDeIntencao['tom'] }> = {
  resolvido: { texto: 'Resolvido', tom: 'ok' },
  aguardando_cliente: { texto: 'Esperando o cliente', tom: 'neutro' },
  precisa_equipe: { texto: 'Precisa da equipe', tom: 'erro' },
  venda_encaminhada: { texto: 'Venda encaminhada', tom: 'ok' },
  sem_resposta: { texto: 'Ficou sem resposta', tom: 'alerta' },
}

export const SENTIMENTO: Record<string, string> = {
  positivo: 'Satisfeito',
  neutro: 'Neutro',
  negativo: 'Insatisfeito',
  irritado: 'Irritado',
}
