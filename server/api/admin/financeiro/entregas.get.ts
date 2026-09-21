/**
 * GET /api/admin/financeiro/entregas — as entregas do gateway que ficaram
 * penduradas: o Asaas avisou, a plataforma registrou, e o efeito não aconteceu.
 *
 * Uma linha de `payment_events` com `processed_at IS NULL` é dinheiro que o
 * gateway já mexeu e o nosso banco ainda não sabe. O caso que mais dói é o
 * estorno parcial que chega sem valor no payload: a rota falha alto de
 * propósito (melhor não gravar do que gravar número inventado), o pedido segue
 * 'pago' com `refunded_cents = 0`, e o líquido — que é `total − taxa −
 * devolvido` — conta como nosso um dinheiro que já voltou pro comprador.
 *
 * Até agora ninguém lia essa coluna pra AGIR: a tela de reconciliação mostra
 * `processado: false` no meio do extrato e não tem botão; e como o webhook
 * responde 200 (correto — 500 faria o Asaas retentar pra sempre), o gateway
 * também não reentrega. Esta rota é o olho, `entregas.post.ts` é a mão, e
 * `garantirWorkerDoWebhook()` é quem faz sozinho de minuto em minuto.
 *
 * Cercada por organização aqui dentro: o `middleware/02.tenant` só cerca o que
 * tem id na URL (`/evento/:id`, `/pedido/:id`). O `LEFT JOIN orders` é de
 * propósito — a entrega órfã (a que nem achou pedido, que é justamente a mais
 * suspeita) some num `JOIN`, e essas aparecem pro master.
 */
import { q } from '../../../utils/db'
import {
  MAX_REPROCESSOS, SQL_ENTREGAS_PENDENTES_TODAS, reaisParaCentavos,
} from '../../../utils/asaas'

export default defineEventHandler(async (event) => {
  const sessao = (event.context as any).sessao
  const orgId = sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })

  // A lista é SEMPRE da organização da sessão — master aqui é dono de uma
  // produtora, não da plataforma. O que o master vê a mais é a entrega ÓRFÃ
  // (sem pedido, e por isso sem organização): é a que ninguém mais consegue
  // enxergar, e a que costuma ser o webhook apontado pro ambiente errado.
  //
  // O papel vem do `middleware/03.papel.ts`, que já leu o BANCO nesta
  // requisição (nunca do corpo, nunca do `role` legado da sessão).
  const ehMaster = (event.context as any).papel === 'master'
  const limite = Math.min(Math.max(Number(getQuery(event).limite ?? 100) || 100, 1), 300)

  const linhas = await q<any>(SQL_ENTREGAS_PENDENTES_TODAS, [orgId, ehMaster, limite])

  return {
    // `total` é quantas EXISTEM; `mostrando` é quantas couberam no limite.
    // Devolver o tamanho da página com nome de total é a tela dizendo "100
    // penduradas" com 400 na fila — e ninguém descobre olhando.
    total: Number(linhas[0]?.total_geral ?? 0),
    mostrando: linhas.length,
    // O teto existe pra uma entrega quebrada não queimar o gateway pra sempre;
    // quem passou dele precisa de gente olhando, não de mais uma retentativa.
    tetoDeTentativas: MAX_REPROCESSOS,
    entregas: linhas.map((l) => ({
      id: l.id,
      evento: l.event_name,
      chave: l.gateway_event_id,
      cobranca: l.external_id,
      pedidoId: l.order_id,
      pedido: l.pedido_code,
      pedidoStatus: l.pedido_status,
      eventoId: l.event_id,
      // Em centavos, como todo dinheiro da casa. O payload do Asaas fala em
      // reais com ponto ("129.90"), então a conversão é aqui e não na tela —
      // e é a `reaisParaCentavos` de sempre, não uma segunda multiplicação
      // por 100 escrita à mão (é assim que as duas começam a divergir).
      valorCents: reaisParaCentavos(l.valor),
      tentativas: Number(l.attempts ?? 0),
      esgotada: Number(l.attempts ?? 0) >= MAX_REPROCESSOS,
      erro: l.error,
      chegouEm: l.created_at,
      orfa: !l.order_id,
    })),
  }
})
