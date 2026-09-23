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
import { podeAbrirPagina, type Papel } from '~~/server/utils/papeis'

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
      { nome: 'Sessões / Datas', aba: 'Sessões', para: `${b}/ingressos/sessoes` },
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
    // "Mapa de Assentos" saiu do menu (22/09): o checkout, a vitrine, o
    // balcão e a emissão ignoram `seats` — o produtor desenhava o mapa e o
    // comprador nunca escolhia lugar, então o menu prometia uma coisa que a
    // venda não faz. A página continua em `${b}/assentos` pelo endereço; ela
    // volta pro menu quando o checkout passar a escolher lugar.
    { nome: 'Suporte', icone: 'suporte', para: '/admin/suporte' },
  ]
}

/**
 * A PRIMEIRA tela do menu do evento que este papel abre — aonde leva o clique
 * no evento na lista (`pages/admin/index.vue`). Mesma régua da lateral
 * (`podeAbrirPagina`), percorrendo o menu na ordem em que ele aparece.
 *
 * Antes o clique ia sempre pro `/dashboard`, que é área de dinheiro: quem é
 * da operação caía numa tela em branco (403). Sem papel conhecido ainda, fica
 * no dashboard, que é a primeira tela de quem abre tudo.
 */
export function primeiraTelaDoEvento(eventoId: string, papel: Papel | null): string {
  const grupos = menuDoEvento(eventoId)
  if (papel) {
    for (const g of grupos) {
      const telas = g.filhos?.length ? g.filhos.map((f) => f.para) : [g.para]
      const aberta = telas.find((para) => podeAbrirPagina(papel, para))
      if (aberta) return aberta
    }
  }
  return grupos[0]!.para
}
