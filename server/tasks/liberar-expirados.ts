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
import { cancelarCobrancasDeExpirados } from '../utils/asaas'
import { expirarTransferencias } from '../utils/transferencia'
import { tx } from '../utils/db'

export default defineTask({
  meta: {
    name: 'liberar-expirados',
    description: 'Expira pedidos vencidos, devolve estoque, cancela a cobrança e vence transferências paradas',
  },
  async run() {
    const liberados = await tx((c) => liberarExpirados(c))
    if (liberados > 0) {
      console.log(`[estoque] ${liberados} pedido(s) vencido(s) — estoque devolvido`)
    }

    // A cobrança do pedido que acabou de cair (aqui ou na reserva sob demanda
    // de `reclamarVencidosDoLote`) é cancelada no gateway DEPOIS do commit:
    // rede de terceiro não segura estoque, e gateway fora não impede a
    // devolução. Falha aqui só vira aviso — a tentativa e o erro ficam no
    // `audit_log` de cada pedido, e o pagamento que escapar é tratado na
    // emissão (reserva refeita, ou pendência visível no painel).
    let cobrancasCanceladas = 0
    try {
      const r = await cancelarCobrancasDeExpirados()
      cobrancasCanceladas = r.filter((x) => x.ok).length
      const falhas = r.length - cobrancasCanceladas
      if (r.length) {
        console.log(`[asaas] cobranças de reserva vencida: ${cobrancasCanceladas} cancelada(s)`
          + (falhas ? `, ${falhas} com erro (ver audit_log do pedido)` : ''))
      }
    } catch (e: any) {
      console.warn(`[asaas] varredura de cobranças vencidas falhou: ${e?.message ?? e}`)
    }

    // Transferência parada também tranca: o índice único deixa uma pendente
    // por ingresso, então enquanto a antiga não vence o dono não consegue
    // mandar de novo — nem pro mesmo e-mail escrito certo.
    const vencidas = await tx((c) => expirarTransferencias(c))
    if (vencidas > 0) {
      console.log(`[transferencia] ${vencidas} venceram sem aceite`)
    }

    return { result: { liberados, vencidas, cobrancasCanceladas } }
  },
})
