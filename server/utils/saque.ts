/**
 * O teto do saque — a trava e a conta, numa linha só.
 *
 * Isto existe pelo mesmo motivo que `utils/caixa.ts`: um teste sequencial
 * NÃO prova serialização. O primeiro teste de concorrência que escrevi aqui
 * disparava dois pedidos com `Promise.all` e ficava verde mesmo com o
 * `FOR UPDATE` removido da rota — dois `fetch` simultâneos não chegam juntos
 * ao servidor de dev, então o primeiro já tinha gravado quando o segundo leu.
 * Um teste assim dá a garantia que ele não tem, que é pior do que não ter
 * teste.
 *
 * Com a trava e a conta aqui, o teste abre DUAS conexões do pool e força a
 * ordem na mão — e a rota executa exatamente estas mesmas linhas.
 *
 * ## Por que travar o EVENTO e não a tabela de saques
 *
 * O teto é "líquido do evento menos o já comprometido". Travar os saques
 * existentes não segura nada: dois pedidos simultâneos num evento sem
 * nenhum saque não têm linha nenhuma pra travar, e os dois passam. A linha
 * do evento sempre existe, então é ela que serializa.
 */
import type { PoolClient } from 'pg'
import { SQL_LIQUIDO_DIRETO, SQL_LIQUIDO_GATEWAY } from './liquido'

/**
 * Trava a linha do evento até o fim da transação.
 *
 * Quem chega em segundo lugar fica esperando aqui e só lê o saldo depois que
 * o primeiro gravou (ou desistiu). A rota NÃO faz nenhuma checagem de saldo
 * antes desta chamada, de propósito: uma pré-checagem resolveria o caso
 * enfileirado e esconderia a ausência da trava do próprio teste.
 */
export const SQL_TRAVA_EVENTO = `
  SELECT id, org_id, name, ends_at
    FROM events
   WHERE id = $1
   FOR UPDATE`

/**
 * Quanto ainda dá pra tirar, já com a trava na mão.
 *
 * O teto é o líquido **que passou pelo gateway** — só esse dinheiro está na
 * plataforma pra ser transferido. O que foi pago direto ao produtor (notas
 * na gaveta, pix na chave dele) vem separado e rotulado, pra ninguém achar
 * que sumiu: ele já o tem.
 *
 * `comprometido` inclui o que está apenas `solicitada`: contar só o
 * concluído deixaria dois pedidos passarem, cada um enxergando o saldo
 * inteiro como seu.
 */
export async function saldoParaSaque(c: PoolClient, eventoId: string): Promise<{
  /** na plataforma, esperando transferência */
  gatewayCents: number
  /** já com o produtor — nunca entra no disponível */
  diretoCents: number
  comprometidoCents: number
  disponivelCents: number
}> {
  const { rows: vs } = await c.query(
    `SELECT ${SQL_LIQUIDO_GATEWAY()} AS gateway,
            ${SQL_LIQUIDO_DIRETO()}  AS direto
       FROM orders WHERE event_id = $1`, [eventoId])
  const { rows: ts } = await c.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS comprometido
       FROM payouts
      WHERE event_id = $1 AND status IN ('solicitada','processando','concluida')`,
    [eventoId])

  const gatewayCents = Number(vs[0].gateway)
  const diretoCents = Number(vs[0].direto)
  const comprometidoCents = Number(ts[0].comprometido)
  return {
    gatewayCents, diretoCents, comprometidoCents,
    disponivelCents: gatewayCents - comprometidoCents,
  }
}

const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

/**
 * A recusa explica onde está o dinheiro que o produtor está vendo.
 *
 * Sem a segunda frase, quem vendeu R$ 2.000 no balcão lê "não há saldo" com
 * o borderô abrindo R$ 2.000 na tela ao lado e abre chamado achando que o
 * sistema perdeu a venda.
 */
export function recusaDeSaque(disponivelCents: number, diretoCents = 0): string {
  const base = disponivelCents <= 0
    ? 'Não há saldo disponível para transferir neste evento.'
    : `Disponível para transferência: ${brl(disponivelCents)}.`
  return diretoCents > 0
    ? `${base} Os ${brl(diretoCents)} recebidos direto (dinheiro no balcão ou pix na sua chave) já estão com você e não passam pela plataforma.`
    : base
}
