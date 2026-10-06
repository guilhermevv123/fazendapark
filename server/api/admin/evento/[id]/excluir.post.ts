/**
 * POST /api/admin/evento/:id/excluir — tira o evento da lista (dono, 06/10, menu ⋮ da lista).
 *
 * Não apaga linha (046): pedidos, ingressos, estornos e o caixa continuam — o contador, o extrato
 * do gateway e quem comprou dependem deles. O evento some da lista de Eventos e o link público
 * passa a dar 404. `{ desfazer: true }` traz de volta.
 *
 * Só fora de venda: `ativo` e `adiado` ainda têm gente com ingresso valendo. Esses se cancelam
 * antes (Configurações → Cancelar evento, que devolve o dinheiro) — excluir não pode ser o atalho
 * que esconde um evento com público esperando.
 */
import { z } from 'zod'
import { tx } from '../../../../utils/db'
import { autorDaRequisicao, registrarAuditoria } from '../../../../utils/auditoria'

const EM_VENDA = new Set(['ativo', 'adiado'])

const Entrada = z.object({ desfazer: z.literal(true).optional() }).default({})

export default defineEventHandler(async (event) => {
  const eventId = getRouterParam(event, 'id')!
  const sessao = (event.context as any).sessao
  if (!sessao?.orgId) throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })
  const p = Entrada.safeParse((await readBody(event).catch(() => null)) ?? {})
  if (!p.success) throw createError({ statusCode: 400, statusMessage: 'Pedido inválido' })
  const desfazer = !!p.data.desfazer

  return tx(async (c) => {
    const { rows } = await c.query(
      `SELECT id, name, status, excluido_em FROM events WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [eventId, sessao.orgId])
    const ev = rows[0]
    if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

    if (!desfazer && EM_VENDA.has(ev.status)) {
      throw createError({
        statusCode: 409,
        statusMessage: ev.status === 'ativo'
          ? 'Este evento está à venda. Cancele ou encerre o evento antes de excluir.'
          : 'Este evento está adiado e tem ingressos valendo. Cancele o evento antes de excluir.',
      })
    }
    // repetir o clique não é erro: já estava como pedido
    if (!desfazer === !!ev.excluido_em) return { ok: true, excluido: !desfazer }

    await c.query(
      desfazer
        ? `UPDATE events SET excluido_em = NULL, excluido_por = NULL WHERE id = $1`
        : `UPDATE events SET excluido_em = now(), excluido_por = $2 WHERE id = $1`,
      desfazer ? [eventId] : [eventId, sessao.usuarioId])
    await registrarAuditoria({
      autor: autorDaRequisicao(event),
      entidade: 'evento',
      entidadeId: eventId,
      acao: desfazer ? 'exclusao_desfeita' : 'excluido',
      depois: { evento: ev.name, status: ev.status },
    }, c)
    return { ok: true, excluido: !desfazer }
  })
})
