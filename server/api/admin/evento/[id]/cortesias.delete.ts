/**
 * DELETE /api/admin/evento/:id/cortesias — cancela uma cortesia.
 *
 * Cancela, não apaga: o ingresso vira 'cancelado' e o estoque volta pra
 * prateleira. Apagar a linha destruiria a prova de que aquele código existiu —
 * e é exatamente esse código que alguém vai apresentar na portaria dizendo que
 * recebeu.
 *
 * Cortesia que JÁ ENTROU não cancela. O estoque dela já virou pessoa dentro do
 * parque; devolver a vaga venderia um lugar que está ocupado.
 *
 * ## Cancelar devolve a COTA junto com o estoque
 *
 * Não tem linha nenhuma aqui pra isso, e é de propósito: a cota é contada em
 * cima de `tickets ... status <> 'cancelado'`, então virar o status devolve a
 * cota pelo mesmo ato que devolve o lugar. Um contador separado
 * (`courtesy_used`) precisaria ser decrementado aqui, e é assim que um
 * contador começa a divergir da realidade — sempre no caminho de exceção, que
 * é o que ninguém testa.
 *
 * ## Por que esta rota NÃO trava o evento
 *
 * A emissão trava a linha do evento pra serializar a cota. O cancelamento não
 * precisa: ele só LIBERA cota. Uma emissão que conte no instante anterior a um
 * cancelamento enxerga uma cortesia a mais e, no pior caso, recusa uma emissão
 * que caberia — erro pro lado seguro, e que some na tentativa seguinte. Travar
 * o evento aqui poria o cancelamento na fila da emissão sem fechar nada.
 *
 * A linha do LOTE, essa sim, é disputada: `UPDATE lots SET sold` espera a
 * emissão terminar, então o estoque nunca desencaixa.
 */
import { z } from 'zod'
import { tx } from '../../../../utils/db'
import { autorDaRequisicao, registrarAuditoria } from '../../../../utils/auditoria'

const Entrada = z.object({ id: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Escolha qual cortesia cancelar.' })
  }
  const autor = autorDaRequisicao(event)

  return await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT t.id, t.code, t.status, t.lot_id, t.ticket_type_id, t.is_courtesy, t.org_id,
              t.holder_name, g.reason, g.requested_by,
              o.code AS pedido, o.channel AS canal
         FROM tickets t
         LEFT JOIN courtesy_grants g ON g.order_id = t.order_id
         LEFT JOIN orders o ON o.id = t.order_id
        WHERE t.id = $1 AND t.event_id = $2
        FOR UPDATE OF t`, [p.data.id, eventoId])
    const ing = rows[0]
    if (!ing) throw createError({ statusCode: 404, statusMessage: 'Ingresso não encontrado' })
    if (!ing.is_courtesy) {
      throw createError({ statusCode: 422, statusMessage: 'Este ingresso não é cortesia. Cancele pelo pedido.' })
    }
    // `is_courtesy` sozinho não prova cortesia: `utils/emissao.ts` marca a
    // coluna em todo ingresso de pedido que fechou em zero (lote de R$ 0,
    // cupom de 100%). Isso é VENDA, com comprador e CPF, e cancelar por aqui
    // devolveria o estoque por fora do caminho do pedido — sem o comprador
    // saber e com a auditoria dizendo "cortesia cancelada".
    if (ing.canal && ing.canal !== 'cortesia') {
      throw createError({
        statusCode: 422,
        statusMessage: `"${ing.code}" saiu do pedido ${ing.pedido}, que é uma venda (só fechou em zero). `
          + `Cancele pelo pedido, não por aqui.`,
      })
    }
    if (ing.status === 'usado') {
      throw createError({ statusCode: 409, statusMessage: `"${ing.code}" já entrou no evento e não pode ser cancelado.` })
    }
    if (ing.status === 'cancelado') return { ok: true, jaEstava: true }

    await c.query(
      `UPDATE tickets SET status = 'cancelado', canceled_at = now() WHERE id = $1`, [ing.id])
    // GREATEST evita que uma dupla chamada empurre o contador pra negativo —
    // o FOR UPDATE acima já serializa, isto é a rede embaixo.
    await c.query(
      `UPDATE lots SET sold = GREATEST(sold - 1, 0) WHERE id = $1`, [ing.lot_id])
    if (ing.ticket_type_id) {
      await c.query(
        `UPDATE ticket_types SET sold = GREATEST(sold - 1, 0) WHERE id = $1`, [ing.ticket_type_id])
    }

    // Pelo helper, na mesma transação do ato: o INSERT solto que existia aqui
    // gravava linha sem `user_id`, e "quem cancelou a cortesia do fulano?"
    // ficava sem resposta. O motivo e quem pediu vão junto porque é o registro
    // da cortesia CANCELADA — depois disso, a emissão só existe no rastro.
    await registrarAuditoria({
      autor,
      entidade: 'ticket',
      entidadeId: ing.id,
      acao: 'cortesia_cancelada',
      antes: { codigo: ing.code, status: ing.status },
      depois: {
        codigo: ing.code,
        status: 'cancelado',
        para: ing.holder_name,
        motivo: ing.reason ?? null,
        pedidaPor: ing.requested_by ?? null,
      },
    }, c)

    return { ok: true, codigo: ing.code }
  })
})
