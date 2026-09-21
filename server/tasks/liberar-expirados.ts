/**
 * Tarefa de fundo: devolve pra prateleira o ingresso de carrinho abandonado.
 *
 * `liberarExpirados` existia, estava testada e **ninguém chamava** — o
 * defeito que não aparece em teste nenhum porque a função passa em todos.
 * Em produção o efeito é lento e caro: cada PIX não pago segura o lugar pra
 * sempre, `lots.reserved` só sobe, e o evento mostra "esgotado" com a casa
 * pela metade. No painel da Zig o abandono batia 57%.
 *
 * Roda de minuto em minuto. Pode rodar em várias instâncias ao mesmo tempo:
 * a varredura usa `FOR UPDATE SKIP LOCKED`, então duas cópias dividem a fila
 * em vez de brigar pela mesma linha.
 *
 * Só fala quando fez alguma coisa. Log de "0 liberados" a cada minuto entope
 * o diário e esconde o dia em que liberar 300 de uma vez seria o aviso de
 * que algo quebrou no pagamento.
 */
import { liberarExpirados } from '../utils/estoque'
import { expirarTransferencias } from '../utils/transferencia'
import { tx } from '../utils/db'

export default defineTask({
  meta: {
    name: 'liberar-expirados',
    description: 'Expira pedidos vencidos, devolve estoque e vence transferências paradas',
  },
  async run() {
    const liberados = await tx((c) => liberarExpirados(c))
    if (liberados > 0) {
      console.log(`[estoque] ${liberados} pedido(s) vencido(s) — estoque devolvido`)
    }

    // Transferência parada também tranca: o índice único deixa uma pendente
    // por ingresso, então enquanto a antiga não vence o dono não consegue
    // mandar de novo — nem pro mesmo e-mail escrito certo.
    const vencidas = await tx((c) => expirarTransferencias(c))
    if (vencidas > 0) {
      console.log(`[transferencia] ${vencidas} venceram sem aceite`)
    }

    return { result: { liberados, vencidas } }
  },
})
