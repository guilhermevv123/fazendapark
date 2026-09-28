/**
 * GET /api/admin/eventos — lista de eventos com o resumo que a listagem mostra.
 *
 * As somas vêm de subconsulta lateral por evento, não de um JOIN com GROUP BY
 * na tabela toda: com 3 eventos dá no mesmo, com 300 a diferença é a tela
 * abrir ou não.
 *
 * O `WHERE e.org_id` não é detalhe: sem ele esta rota listava o evento de
 * TODO cliente da instalação — nome, local, data e faturamento — pra
 * qualquer login. O recorte vem da sessão, nunca de parâmetro.
 *
 * O `cobrado` da linha recortava por `status = 'pago'` e por isso o evento com
 * estorno parcial aparecia aqui menor do que no próprio painel dele: o pedido
 * inteiro sumia por causa da devolução de uma parte. A régua agora é
 * `PEDIDO_VIVO()`, de `utils/liquido.ts`, e o líquido — o que sobra pro
 * produtor — vem junto pela mesma `SQL_LIQUIDO()` do borderô e dos
 * financeiros. Lista e detalhe têm que dizer o mesmo número.
 */
import { q } from '../../utils/db'
import { CANAL_CORTESIA } from '../../utils/emissao'
import { PEDIDO_VIVO, SQL_LIQUIDO } from '../../utils/liquido'
import { papelPode, type Papel } from '../../utils/papeis'

export default defineEventHandler(async (event) => {
  const orgId = (event.context as any).sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })

  /*
   * Quem vê o CAIXA de cada evento. A lista é área `evento_ver` (operação abre, pra achar o evento
   * que vai configurar), mas cobrado, líquido e contagem de pedidos são `dinheiro` — e iam inteiros
   * pra operação, inclusive embutidos no HTML do SSR (auditoria EVT-02). Aqui a consulta nem soma
   * dinheiro pra quem não pode ver: o campo não existe na resposta, não é só a tela que esconde.
   * O papel é o que o `middleware/03.papel.ts` acabou de ler do banco.
   */
  const papel = (event.context as any).papel as Papel | undefined
  const veDinheiro = !!papel && papelPode(papel, 'dinheiro')

  const linhas = await q<any>(
    `SELECT e.id, e.name, e.slug, e.status, e.starts_at, e.ends_at,
            e.venue_name, e.city, e.state, e.thumb_url, o.name AS organizacao,
            ${veDinheiro ? 'v.cobrado, v.liquido, v.pedidos, v.ingressos,' : ''}
            est.quantidade, est.vendidos, cor.cortesias
       FROM events e
       JOIN organizations o ON o.id = e.org_id
       ${veDinheiro ? `LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(ord.total_cents),0)::bigint AS cobrado,
                ${SQL_LIQUIDO('ord.')} AS liquido,
                COUNT(*)::int AS pedidos,
                COALESCE(SUM((SELECT SUM(quantity) FROM order_items WHERE order_id = ord.id)),0)::int AS ingressos
           FROM orders ord WHERE ord.event_id = e.id AND ${PEDIDO_VIVO('ord.')}
       ) v ON true` : ''}
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(l.quantity),0)::int AS quantidade,
                COALESCE(SUM(l.sold),0)::int AS vendidos
           FROM lots l JOIN sectors s ON s.id = l.sector_id WHERE s.event_id = e.id
       ) est ON true
       -- Cortesia também entra em lots.sold (a rota de cortesia baixa o estoque), então "vendidos"
       -- sem este recorte somava convite com venda (EVT-13). Conta ingresso de pé, na MESMA régua
       -- que o estoque usa: cortesia cancelada devolveu o lugar.
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS cortesias
           FROM tickets t JOIN orders oc ON oc.id = t.order_id
          WHERE oc.event_id = e.id AND oc.channel = '${CANAL_CORTESIA}' AND t.status <> 'cancelado'
       ) cor ON true
      WHERE e.org_id = $1
      ORDER BY e.starts_at DESC NULLS LAST, e.created_at DESC`, [orgId])

  return linhas.map((e) => {
    const vendidos = Number(e.vendidos ?? 0)
    const cortesias = Math.min(Number(e.cortesias ?? 0), vendidos)
    return {
      id: e.id, nome: e.name, slug: e.slug, status: e.status,
      inicio: e.starts_at, fim: e.ends_at,
      local: e.venue_name, cidade: e.city, estado: e.state, thumb: e.thumb_url,
      organizacao: e.organizacao,
      ...(veDinheiro ? {
        cobradoCents: Number(e.cobrado ?? 0),
        // o mesmo líquido do borderô e dos dois financeiros deste evento
        liquidoCents: Number(e.liquido ?? 0),
        pedidos: Number(e.pedidos ?? 0),
        ingressos: Number(e.ingressos ?? 0),
      } : {}),
      // `vendidos` segue sendo o que o lote marca (pago + cortesia de pé), pra quem já lia assim;
      // a barra da lista mostra `pagos` e marca a cortesia à parte
      estoque: {
        total: Number(e.quantidade ?? 0), vendidos,
        cortesias, pagos: vendidos - cortesias,
      },
    }
  })
})
