/**
 * GET /api/admin/evento/:id/cortesias — ingressos dados, a pedido de quem, e
 * quanto ainda cabe.
 *
 * Cortesia é a categoria que some do relatório e reaparece na portaria. O
 * número de cortesia emitida precisa ficar no mesmo lugar em que se emite,
 * senão o produtor descobre que deu 400 entradas de graça olhando a fila.
 *
 * Esta rota responde as quatro perguntas do rastro, e elas vêm de dois lugares
 * diferentes de propósito:
 *
 *   - **pra quem foi** — do ingresso (`tickets.holder_*`), porque é por pessoa;
 *   - **por que, a pedido de quem, autorizada por quem, quando** — da emissão
 *     (`courtesy_grants`), porque é a mesma para as 40 cortesias da imprensa.
 *
 * O caminho entre os dois é `tickets.order_id`, e o JOIN é **LEFT**: as
 * cortesias anteriores à migração 017 não têm emissão registrada, e um JOIN
 * comum faria elas sumirem da tela inteira. Uma cortesia que a tela não mostra
 * é uma entrada de graça que ninguém sabe que existe — exatamente o defeito
 * que esta tela existe pra fechar. Elas aparecem com o rastro vazio, que é a
 * verdade sobre elas.
 *
 * ## O que esta lista NÃO mostra: venda que fechou em zero
 *
 * `is_courtesy` é marcado por `utils/emissao.ts` em todo ingresso de pedido
 * que deu zero — lote de R$ 0, cupom de 100%. Recortar só pela marca punha
 * comprador de verdade nesta tela como "cortesia, motivo não registrado",
 * inflava o "deixou de faturar" e fazia a faixa de aviso mentir ("emitidas
 * antes de motivo virar obrigatório" numa venda de hoje). Pior: o número
 * daqui era o número que a rota de emissão usava pra recusar, então a venda
 * gratuita comia a cota da imprensa.
 *
 * O recorte é `eCortesiaMesmo()`, o MESMO da rota de emissão e do gatilho da
 * 017 — o que a rota de cortesia emitiu (`orders.channel = 'cortesia'`) mais
 * o ingresso sem pedido. Venda gratuita continua visível onde ela é: em
 * Vendas e em Participantes.
 */
import { q, q1 } from '../../../../utils/db'
import { eCortesiaMesmo } from './cortesias.post'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const ev = await q1<any>(
    `SELECT id, name, courtesy_quota FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const ingressos = await q<any>(
    `SELECT t.id, t.code, t.status, t.holder_name, t.holder_email, t.holder_document,
            t.issued_at, t.checked_in_at,
            s.name AS setor, l.name AS lote, tt.name AS tipo,
            o.code AS pedido, o.id AS pedido_id,
            g.reason, g.requested_by, g.authorized_email, g.authorized_name,
            g.created_at AS emitida_em, g.unit_face_cents
       FROM tickets t
       JOIN sectors s ON s.id = t.sector_id
       JOIN lots    l ON l.id = t.lot_id
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN orders o ON o.id = t.order_id
       LEFT JOIN courtesy_grants g ON g.order_id = t.order_id
      WHERE t.event_id = $1 AND t.is_courtesy = true AND ${eCortesiaMesmo('t')}
      ORDER BY t.issued_at DESC
      LIMIT 500`, [id])

  // O resumo é contado no banco, não somando a lista: a lista tem LIMIT e um
  // total tirado dela mentiria assim que passasse de 500 cortesias.
  //
  // `valor_dado` usa a face CONGELADA na emissão quando ela existe. Ler o
  // preço de hoje faria a conta do que já foi dado mudar sozinha na virada de
  // lote, meses depois, sem ninguém ter emitido cortesia nenhuma. Nas linhas
  // antigas (sem emissão registrada) só existe o preço de hoje, e é ele que
  // entra — o COALESCE deixa isso explícito em vez de esconder num JOIN.
  const resumo = await q1<any>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE t.status <> 'cancelado')::int AS ocupando,
            count(*) FILTER (WHERE t.status = 'usado')::int      AS usados,
            count(*) FILTER (WHERE t.status = 'cancelado')::int  AS cancelados,
            count(*) FILTER (WHERE g.id IS NULL)::int            AS sem_rastro,
            COALESCE(SUM(COALESCE(g.unit_face_cents, l.price_cents))
                     FILTER (WHERE t.status <> 'cancelado'), 0)::bigint AS valor_dado
       FROM tickets t
       JOIN lots l ON l.id = t.lot_id
       LEFT JOIN courtesy_grants g ON g.order_id = t.order_id
      WHERE t.event_id = $1 AND t.is_courtesy = true AND ${eCortesiaMesmo('t')}`, [id])

  // Só lote com estoque pode receber cortesia — e a tela precisa saber quanto
  // sobrou pra não oferecer o que não existe. `cortesias` aqui conta o mesmo
  // que a rota de emissão conta sob a trava (cancelada devolve a cota), pra
  // que o número da tela e o número que recusa a emissão sejam o mesmo.
  const lotes = await q<any>(
    `SELECT l.id, l.name, l.price_cents, l.quantity, l.sold, l.reserved,
            l.courtesy_quota,
            s.name AS setor, s.id AS setor_id,
            (SELECT count(*)::int FROM tickets t
              WHERE t.lot_id = l.id AND t.is_courtesy AND t.status <> 'cancelado'
                AND ${eCortesiaMesmo('t')}) AS cortesias
       FROM lots l JOIN sectors s ON s.id = l.sector_id
      WHERE s.event_id = $1
      ORDER BY s.sort_order, l.sort_order`, [id])

  const cotaEvento: number | null = ev.courtesy_quota === null ? null : Number(ev.courtesy_quota)

  return {
    evento: { id: ev.id, nome: ev.name },
    cota: {
      /** null = sem teto. Zero é um teto de verdade: "aqui não se dá cortesia". */
      eventoCota: cotaEvento,
      eventoUsadas: resumo.ocupando,
      eventoRestam: cotaEvento === null ? null : cotaEvento - resumo.ocupando,
    },
    resumo: {
      total: resumo.total, usados: resumo.usados, cancelados: resumo.cancelados,
      ocupando: resumo.ocupando,
      /** emitidas antes de motivo/quem pediu virarem obrigatórios */
      semRastro: resumo.sem_rastro,
      valorDadoCents: Number(resumo.valor_dado),
    },
    lotes: lotes.map((l) => ({
      id: l.id, nome: l.name, setor: l.setor, setorId: l.setor_id,
      faceCents: Number(l.price_cents),
      disponivel: l.quantity - l.sold - l.reserved,
      cota: l.courtesy_quota === null ? null : Number(l.courtesy_quota),
      cortesias: l.cortesias,
      cotaRestam: l.courtesy_quota === null ? null : Number(l.courtesy_quota) - l.cortesias,
    })),
    ingressos: ingressos.map((t) => ({
      id: t.id, codigo: t.code, status: t.status,
      nome: t.holder_name, email: t.holder_email, documento: t.holder_document,
      emitidoEm: t.issued_at, entrouEm: t.checked_in_at,
      setor: t.setor, lote: t.lote, tipo: t.tipo,
      pedido: t.pedido, pedidoId: t.pedido_id,
      // o rastro; null nas cortesias anteriores à 017
      motivo: t.reason,
      pedidaPor: t.requested_by,
      autorizadaPor: t.authorized_name || t.authorized_email || null,
      autorizadaPorEmail: t.authorized_email,
      autorizadaEm: t.emitida_em,
      faceCents: t.unit_face_cents === null || t.unit_face_cents === undefined
        ? null : Number(t.unit_face_cents),
    })),
  }
})
