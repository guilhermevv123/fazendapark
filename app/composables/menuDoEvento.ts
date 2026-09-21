/**
 * menuDoEvento — a lista de telas do evento, num lugar só.
 *
 * A mesma lista aparece em dois sítios: o menu da lateral e a barra de abas
 * no alto de cada grupo. Antes eram duas cópias, e cópia de lista de telas
 * envelhece do jeito mais silencioso que existe — a tela nova entra numa e
 * não na outra, e ninguém percebe porque as duas continuam funcionando.
 *
 * `nome` é como a lateral chama; `aba` é o rótulo curto da barra de cima,
 * onde o espaço é horizontal e o contexto já está dado pelo grupo.
 */
export interface TelaDoEvento {
  nome: string
  /** rótulo curto pra barra de abas; cai no `nome` quando não tem */
  aba?: string
  para: string
}

export interface GrupoDoEvento {
  nome: string
  icone: string
  para: string
  filhos?: TelaDoEvento[]
}

export function menuDoEvento(eventoId: string): GrupoDoEvento[] {
  const b = `/admin/evento/${eventoId}`
  return [
    { nome: 'Dashboard', icone: 'dashboard', para: `${b}/dashboard` },

    { nome: 'Ingressos', icone: 'ingresso', para: `${b}/ingressos`, filhos: [
      { nome: 'Configurar ingressos', aba: 'Ingressos', para: `${b}/ingressos` },
      { nome: 'Ordenar setores', aba: 'Ordenar setores', para: `${b}/ingressos/ordenar` },
      { nome: 'Passaportes / Grupos', aba: 'Passaportes', para: `${b}/ingressos/passaportes` },
      { nome: 'Códigos promocionais', aba: 'Códigos promocionais', para: `${b}/ingressos/cupons` },
      { nome: 'Promoters / Divulgadores', aba: 'Promoters', para: `${b}/ingressos/promoters` },
      { nome: 'Cortesias', para: `${b}/ingressos/cortesias` },
    ] },

    { nome: 'Vendas', icone: 'vendas', para: `${b}/vendas`, filhos: [
      { nome: 'Pedidos', para: `${b}/vendas` },
      { nome: 'Participantes', para: `${b}/vendas/participantes` },
      { nome: 'Ingressos transferidos', aba: 'Transferidos', para: `${b}/vendas/transferencias` },
    ] },

    { nome: 'Bilheteria', icone: 'bilheteria', para: `${b}/pdv`, filhos: [
      { nome: 'Pontos de venda', aba: 'Pontos de venda', para: `${b}/pdv` },
      { nome: 'Balcão', aba: 'Balcão', para: `${b}/pdv/vender` },
      { nome: 'Conferência de caixa', aba: 'Caixa', para: `${b}/pdv/caixa` },
    ] },

    { nome: 'Relatórios', icone: 'relatorio', para: `${b}/relatorios`, filhos: [
      { nome: 'Visão geral', para: `${b}/relatorios` },
      { nome: 'Vendas por lote', para: `${b}/relatorios/lotes` },
      { nome: 'Extrato', para: `${b}/relatorios/extrato` },
    ] },

    { nome: 'Validação e acessos', icone: 'validacao', para: `${b}/validacao`, filhos: [
      { nome: 'Leitor de entrada', aba: 'Leitor', para: `${b}/validacao` },
      { nome: 'Histórico de leituras', aba: 'Histórico', para: `${b}/validacao/historico` },
    ] },

    { nome: 'Financeiro', icone: 'financeiro', para: `${b}/financeiro`, filhos: [
      { nome: 'Transferências', para: `${b}/financeiro` },
      { nome: 'Borderô', para: `${b}/financeiro/bordero` },
    ] },

    { nome: 'Configurações', icone: 'config', para: `${b}/configuracoes` },
    { nome: 'Mapa de Assentos', icone: 'mapa', para: `${b}/assentos` },
    { nome: 'Suporte', icone: 'suporte', para: '/admin/suporte' },
  ]
}
