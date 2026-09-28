/**
 * Tarefa de fundo do Pix do Mercado Pago — separada da `liberar-expirados` de propósito.
 *
 * Tudo aqui é pergunta a um terceiro pela rede. Dentro da tarefa de minuto, MP lento (8 s por
 * pergunta, dezenas de Pix) seguraria atrás dele a devolução do estoque, o cancelamento das
 * cobranças do Asaas e a expiração das transferências — e o runner do Nitro não começa a rodada
 * seguinte de uma tarefa com a anterior viva. Em tarefa própria as duas rodam lado a lado (o cron
 * dispara as tarefas do minuto juntas), e o MP fora atrasa só o MP.
 *
 * A rodada tem prazo (`PRAZO_DA_RODADA_MS`, repartido entre as etapas), e cada varredura para na
 * primeira falha passageira: com o MP fora, os Pix seguintes ouviriam o mesmo não. Cada etapa por
 * si, como na de minuto (`varrer`): a que cai não leva as outras.
 *
 * Sem Mercado Pago ligado em organização nenhuma, as três consultas voltam vazias e a tarefa não
 * faz uma chamada de rede sequer.
 */
import { varrer, type Etapa } from './liberar-expirados'
import { cancelarPixVencidos, reprocessarFatosMp, varrerPixEsperando } from '../utils/mercadopago'

/** O teto da rodada inteira. Fica abaixo do minuto com folga pra a última pergunta terminar. */
export const PRAZO_DA_RODADA_MS = 40_000

/** As etapas da rodada que começa `inicio` (ms de relógio). */
export function etapasDoMp(inicio = Date.now()): Etapa[] {
  return [
    {
      // A rede de baixo do webhook: aviso perdido ou painel mal configurado não deixam ninguém
      // sem ingresso — o Pix pago aparece aqui no minuto seguinte.
      nome: 'pix do mercado pago esperando',
      rodar: async () => (await varrerPixEsperando({ ate: inicio + 20_000 }))
        .filter((d) => d.ok && (d.fatos ?? 0) > 0).length,
      falar: (n) => `[mercadopago] ${n} Pix com novidade aplicada (pago, cancelado ou estornado)`,
    },
    {
      // O MP NÃO expira o Pix no vencimento (só marca 30 dias depois): o QR do pedido que caiu
      // continuaria pagável. Cancelar aqui fecha a porta; o pago no vão é aplicado na hora.
      nome: 'pix do mercado pago vencido',
      rodar: async () => {
        const r = await cancelarPixVencidos({ ate: inicio + 32_000 })
        const falhas = r.filter((x) => !x.ok).length
        if (falhas) console.warn(`[mercadopago] ${falhas} Pix vencido(s) com erro ao fechar (ver audit_log do pedido)`)
        return r.length - falhas
      },
      falar: (n) => `[mercadopago] Pix de reserva vencida: ${n} fechado(s)`,
    },
    {
      // Fato do MP sem baixa (pago sem lugar, banco piscando, devolução a confirmar): pergunta ao
      // MP de novo, com a mesma carência crescente e o mesmo teto do reprocessador do Asaas.
      nome: 'pix do mercado pago pendurado',
      rodar: async () => (await reprocessarFatosMp({ ate: inicio + PRAZO_DA_RODADA_MS }))
        .filter((d) => d.ok && !d.pendurado && (d.fatos ?? 0) > 0).length,
      falar: (n) => `[mercadopago] ${n} Pix pendurado(s) resolvido(s)`,
    },
  ]
}

export default defineTask({
  meta: {
    name: 'mercadopago-pix',
    description: 'Pergunta ao Mercado Pago pelos Pix esperando, fecha o Pix de reserva vencida e '
      + 'reprocessa o que ficou pendurado — com prazo por rodada, sem segurar a tarefa de minuto',
  },
  async run() {
    return { result: await varrer(etapasDoMp()) }
  },
})
