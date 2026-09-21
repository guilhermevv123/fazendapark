/**
 * POST /api/admin/financeiro/entregas — leva a entrega pendurada até o fim.
 *
 * O consumidor da fila roda sozinho (`garantirWorkerDoWebhook()`, que sobe na
 * rota do webhook), mas ele espera a carência e obedece ao teto de tentativas.
 * Esta rota é o "tentar agora" de quem está olhando pro dinheiro que falta:
 * com `id`, fura a carência e o teto — o teto existe pra uma entrega quebrada
 * não queimar o gateway pra sempre, não pra impedir uma pessoa de tentar.
 *
 * Quem pode: `/api/admin/financeiro` é área "dinheiro" (`AREA_DA_RAIZ`, em
 * `utils/papeis.ts`) — master e financeiro. Reprocessar uma entrega EMITE
 * ingresso e mexe em `refunded_cents`; não é botão de operação.
 *
 * A cerca de organização é daqui, porque o id vem no corpo e o
 * `middleware/02.tenant` só cerca o que tem id na URL. A entrega ÓRFÃ (sem
 * pedido, logo sem organização) só o master alcança: ela é justamente a que
 * pode pertencer a qualquer um.
 */
import { z } from 'zod'
import { reprocessarEntregasPendentes } from '../../../utils/asaas'
import { autorDaRequisicao, registrarAuditoria } from '../../../utils/auditoria'
import { q1 } from '../../../utils/db'

const Entrada = z.object({
  /** uma entrega específica — o botão "tentar agora" da linha */
  id: z.string().uuid().nullish(),
  /** ou um empurrão na varredura inteira */
  limite: z.number().int().min(1).max(100).optional(),
})

export default defineEventHandler(async (event) => {
  const orgId = (event.context as any).sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })
  const ehMaster = (event.context as any).papel === 'master'

  const p = Entrada.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Não entendi qual entrega reprocessar.' })
  }

  // ------------------------------------------------------- uma entrega só
  if (p.data.id) {
    const linha = await q1<any>(
      `SELECT pe.id, pe.event_name, pe.attempts, pe.error, pe.processed_at,
              pe.order_id, o.org_id, o.code AS pedido
         FROM payment_events pe
         LEFT JOIN orders o ON o.id = pe.order_id
        WHERE pe.id = $1 AND pe.provider = 'asaas'`, [p.data.id])

    // "Não existe" e "não é sua" respondem igual: separar conta pro vizinho
    // que a linha existe.
    const minha = linha && (linha.org_id === orgId || (ehMaster && !linha.order_id))
    if (!minha) throw createError({ statusCode: 404, statusMessage: 'Entrega não encontrada' })
    if (linha.processed_at) {
      return {
        ok: true, jaEstava: true,
        aviso: `Esta entrega já tinha sido processada${linha.pedido ? ` (pedido ${linha.pedido})` : ''}.`,
      }
    }

    // `carenciaMin: 0` + `id` = sem espera e sem teto. É o ponto da rota.
    const [r] = await reprocessarEntregasPendentes({ id: p.data.id, carenciaMin: 0, limite: 1 })
    if (!r) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Esta entrega não está mais pendente — recarregue a lista.',
      })
    }

    await registrarAuditoria({
      autor: autorDaRequisicao(event),
      entidade: 'entrega_gateway', entidadeId: r.id, acao: 'reprocessar',
      antes: { evento: linha.event_name, tentativas: Number(linha.attempts ?? 0), erro: linha.error },
      depois: { resolvido: r.resolvido, pedidoId: r.pedidoId, erro: r.erro },
    }).catch(() => { /* auditoria não pode derrubar o reprocessamento */ })

    return {
      ok: r.ok,
      entrega: r,
      aviso: r.resolvido
        ? `Entrega ${r.evento} aplicada agora.`
        : `Não deu baixa: ${r.erro ?? 'sem motivo registrado'}`,
    }
  }

  // ---------------------------------------------------- a varredura inteira
  // O que esta chamada faz é antecipar o minuto do trabalhador de fundo — e a
  // carência e o teto de tentativas continuam valendo.
  //
  // A cerca vai junto. O trabalhador de fundo varre tudo porque é do PROCESSO
  // e não tem dono; aqui tem: é uma pessoa de UMA produtora apertando o
  // botão. Sem `orgId` aqui, medido logado como dono da Fazenda Park, esta
  // rota com corpo vazio devolveu a entrega pendurada da produtora VIZINHA —
  // id do pedido dela, erro dela — e teria aplicado o efeito no dinheiro
  // dela. Reprocessar EMITE ingresso e mexe em `refunded_cents`.
  const feitos = await reprocessarEntregasPendentes({
    limite: p.data.limite ?? 50, orgId, ehMaster,
  })
  const presas = feitos.filter((r) => !r.resolvido)
  return {
    ok: true,
    processadas: feitos.length,
    resolvidas: feitos.length - presas.length,
    presas: presas.length,
    entregas: feitos,
    aviso: feitos.length
      ? `${feitos.length - presas.length} entrega(s) aplicada(s)`
        + (presas.length ? `, ${presas.length} ainda sem baixa: ${presas[0].erro}` : '')
      : 'Nenhuma entrega esperando (ou todas ainda dentro da carência).',
  }
})
