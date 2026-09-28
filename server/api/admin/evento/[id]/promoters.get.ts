/**
 * GET /api/admin/evento/:id/promoters — divulgadores e o que cada um vendeu.
 *
 * O número que importa não é quantos links o promoter mandou, é quanto entrou
 * por ele: clique não é venda, e um painel que mostra clique faz o produtor
 * pagar comissão por tráfego.
 *
 * ## A régua é a de Relatórios › "por promoter", palavra por palavra
 *
 * Esta tabela é a que o produtor usa pra PAGAR o divulgador, e respondia outra
 * conta (ADM-01, 27/09):
 *
 * - **`LEFT JOIN order_items` repetia o pedido uma vez por linha de item.**
 *   Pedido de inteira + meia (duas linhas) somava a face DUAS vezes e contava
 *   dois pedidos — faturado, pedidos e comissão em dobro, e o rodapé somando o
 *   valor inflado. Os ingressos agora vêm de um `LATERAL` que soma os itens
 *   DENTRO do pedido, e a face é somada uma vez por pedido.
 * - **`status = 'pago'` derrubava o pedido com estorno parcial inteiro.** A
 *   população agora é `PEDIDO_VIVO()` — a mesma de `relatorios.get.ts`, e a
 *   comissão sai da MESMA face cheia (base da comissão com estorno parcial é
 *   decisão do dono; a devolução vai ao lado, em `estornadoCents`).
 *
 * `podeApagar` usa a régua da rota que apaga (`promoters.delete.ts` conta TODO
 * pedido atribuído, pago ou não): antes a tela contava só os pagos, oferecia
 * "Apagar" pra quem só tinha carrinho expirado e o servidor respondia 409
 * (ADM-38).
 */
import { q, q1 } from '../../../../utils/db'
import { PEDIDO_VIVO } from '../../../../utils/liquido'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const ev = await q1<any>(`SELECT id, name, slug FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const linhas = await q<any>(
    `SELECT p.id, p.name, p.email, p.phone, p.code, p.commission_bps, p.active, p.created_at,
            COALESCE(v.pedidos, 0)::int      AS pedidos,
            COALESCE(v.face, 0)::bigint      AS faturado,
            COALESCE(v.estornado, 0)::bigint AS estornado,
            COALESCE(v.ingressos, 0)::int    AS ingressos,
            (SELECT count(*)::int FROM orders t WHERE t.promoter_id = p.id) AS atribuidos
       FROM promoters p
       LEFT JOIN LATERAL (
         SELECT count(*)::int                         AS pedidos,
                SUM(o.face_cents)::bigint             AS face,
                SUM(o.refunded_cents)::bigint         AS estornado,
                SUM(COALESCE(oi.n, 0))::int           AS ingressos
           FROM orders o
           LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS n
                                FROM order_items WHERE order_id = o.id) oi ON true
          WHERE o.promoter_id = p.id AND o.event_id = p.event_id AND ${PEDIDO_VIVO('o.')}
       ) v ON true
      WHERE p.event_id = $1
      ORDER BY faturado DESC, p.name`, [id])

  return {
    evento: { id: ev.id, nome: ev.name, slug: ev.slug },
    promoters: linhas.map((p) => {
      const faturado = Number(p.faturado)
      return {
        id: p.id, nome: p.name, email: p.email, telefone: p.phone, codigo: p.code,
        comissaoBps: Number(p.commission_bps), ativo: p.active,
        pedidos: p.pedidos, ingressos: p.ingressos,
        faturadoCents: faturado,
        estornadoCents: Number(p.estornado),
        // A comissão é calculada sobre a FACE, não sobre o total: a taxa de
        // serviço não é receita do produtor, e comissionar em cima dela é
        // pagar percentual sobre dinheiro que nunca entrou.
        comissaoCents: Math.round((faturado * Number(p.commission_bps)) / 10_000),
        link: `/e/${ev.slug}?promoter=${encodeURIComponent(p.code)}`,
        // quantos pedidos a rota de apagar enxerga — inclusive carrinho que não pagou
        pedidosAtribuidos: Number(p.atribuidos),
        podeApagar: Number(p.atribuidos) === 0,
      }
    }),
  }
})
