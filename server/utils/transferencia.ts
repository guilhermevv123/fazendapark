/**
 * transferencia.ts — as regras de passar um ingresso adiante.
 *
 * O que decide se uma transferência pode sair não é a tela, é o estado do
 * ingresso. Três recusas que parecem detalhe e não são:
 *
 * - **ingresso que já entrou não transfere.** Depois do check-in a pessoa
 *   está lá dentro; passar o nome adiante seria vender a entrada de novo;
 * - **ingresso cancelado não transfere.** Não vale nada, e transferir daria
 *   ao destinatário a impressão de ter recebido algo;
 * - **uma pendente por vez.** O banco já garante com índice único, mas a
 *   recusa aqui é a que diz o porquê pra quem está na tela.
 *
 * A janela de aceite existe porque transferência parada é ingresso em limbo:
 * quem mandou acha que já passou, quem recebeu esqueceu de abrir o link, e
 * na porta aparecem os dois. Vencida, volta pra quem era.
 */
import { randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'

/** dias que o link de aceite fica de pé */
export const DIAS_PARA_ACEITAR = 7

export type MotivoRecusa =
  | 'desligada' | 'usado' | 'cancelado' | 'pendente' | 'mesma_pessoa' | 'inexistente'

export const RECUSA: Record<MotivoRecusa, string> = {
  desligada: 'Este evento não permite transferência de ingressos. '
    + 'Ligue em Configurações do evento para liberar.',
  usado: 'Este ingresso já entrou no evento — não dá pra passar adiante depois da entrada.',
  cancelado: 'Ingresso cancelado não pode ser transferido.',
  pendente: 'Este ingresso já tem uma transferência aguardando aceite. '
    + 'Cancele a anterior antes de enviar outra.',
  mesma_pessoa: 'O destinatário é a mesma pessoa que já é titular do ingresso.',
  inexistente: 'Ingresso não encontrado neste evento.',
}

/** Token do link de aceite. Opaco: não dá pra adivinhar a partir do código do ingresso. */
export function gerarToken(): string {
  return 'tr_' + randomBytes(18).toString('base64url')
}

export function venceEm(agora = new Date()): Date {
  return new Date(agora.getTime() + DIAS_PARA_ACEITAR * 24 * 3600_000)
}

/** E-mail comparável: a mesma pessoa escrevendo com outra caixa não é outra pessoa. */
export function mesmoEmail(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * O aceite. Mora aqui pra que o teste rode exatamente esta instrução.
 *
 * A condição `status = 'aguardando'` é a trava contra dois aceites no mesmo
 * instante — dois cliques, ou o toque repetido no celular com rede ruim. A
 * checagem que a rota faz antes resolve o caso em fila e ESCONDE esta: com a
 * condição arrancada, o teste que aceita duas vezes em sequência continua
 * verde, porque o segundo aceite morre na checagem prévia sem chegar no
 * UPDATE. Só o teste de duas conexões vê a diferença.
 */
export const SQL_ACEITA_TRANSFERENCIA = `
  UPDATE ticket_transfers
     SET status = 'concluido', accepted_at = now()
   WHERE id = $1 AND status = 'aguardando'
   RETURNING id`

/**
 * Vence as transferências que ninguém aceitou.
 *
 * Só mexe em `ticket_transfers` — o ingresso nunca saiu do titular, então
 * não há nada pra devolver. E é justamente isso que destrava o dono: com a
 * pendente vencida, o índice único libera e ele consegue mandar de novo,
 * pra outra pessoa ou pro mesmo e-mail escrito certo.
 */
export async function expirarTransferencias(c: PoolClient, limite = 500): Promise<number> {
  const { rowCount } = await c.query(
    `UPDATE ticket_transfers SET status = 'expirado'
      WHERE id IN (
        SELECT id FROM ticket_transfers
         WHERE status = 'aguardando'
           AND expires_at IS NOT NULL AND expires_at <= now()
         ORDER BY expires_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)`, [limite])
  return rowCount ?? 0
}

export const STATUS_LEGIVEL: Record<string, string> = {
  aguardando: 'Aguardando',
  concluido: 'Concluído',
  cancelado: 'Cancelado',
  expirado: 'Expirado',
}
