/**
 * equipe-da-plataforma.ts — quem configura o RECEBIMENTO (Asaas e Mercado Pago) de uma organização.
 *
 * Ordem do dono (05/10): o cliente não cola chave de API nenhuma — "quem vai fazer isso é a gente,
 * internamente". A divisão fica: cartão (crédito e débito) pelo Asaas, Pix pelo Mercado Pago.
 *
 * A equipe é uma lista no ambiente do servidor, `EQUIPE_DA_PLATAFORMA`, separada por vírgula:
 *   · e-mail inteiro (`guilherme@exemplo.com`) — aquela pessoa;
 *   · `@dominio` (`@exemplo.com`) — todo e-mail daquele domínio.
 * Vazia ou ausente: NINGUÉM mexe no recebimento pelo painel (fecha, não abre). O papel continua
 * valendo por cima: além de estar na lista, a pessoa precisa ser master da organização.
 */
export function listaDaEquipeDaPlataforma(): string[] {
  return String(process.env.EQUIPE_DA_PLATAFORMA ?? '')
    .split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)
}

export function ehDaEquipeDaPlataforma(email: string | null | undefined): boolean {
  const e = String(email ?? '').trim().toLowerCase()
  if (!e.includes('@')) return false
  const dominio = e.slice(e.lastIndexOf('@'))
  return listaDaEquipeDaPlataforma().some((item) => (item.startsWith('@') ? item === dominio : item === e))
}
