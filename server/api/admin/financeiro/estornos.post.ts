/**
 * POST /api/admin/financeiro/estornos — o "tentar de novo" da fila de
 * devolução, do lado de quem está com o comprador no telefone.
 *
 * A reserva da fila (`SQL_RESERVA_ESTORNO`) sempre prometeu, em comentário,
 * que "pedido por id fura a espera: o financeiro apertando tentar de novo está
 * com o cliente na linha". A promessa não tinha quem a cumprisse dos dois
 * lados: a condição nem alcançava a linha em 'falhou' (corrigido lá), e do
 * lado de fora **não existia rota nenhuma** que passasse um id pra
 * `processarUmEstorno`. Quem estourasse `max_attempts` ficava com o dinheiro
 * preso pra sempre, visível na tela e inalcançável por qualquer botão.
 *
 * ## Quem pode
 *
 * `/api/admin/financeiro` está classificado como área "dinheiro" em
 * `utils/papeis.ts` (`AREA_DA_RAIZ`), e o prefixo vale pros caminhos abaixo
 * dele: master e financeiro entram, operação e portaria não. É de propósito —
 * quem aperta este botão manda dinheiro sair da conta.
 *
 * ## A cerca de organização
 *
 * O `middleware/02.tenant` só cerca `/api/admin/evento/:id` e
 * `/api/admin/pedido/:id`, que têm o id do recurso na URL. Aqui o id vem no
 * CORPO, então a cerca é desta rota: a linha da fila só é aceita se o
 * `org_id` dela for o da SESSÃO. Sem isso, um financeiro de uma produtora
 * mandaria a plataforma devolver o dinheiro de outra.
 */
import { z } from 'zod'
import { processarUmEstorno } from '../../../utils/cancelamento'
import { autorDaRequisicao, registrarAuditoria } from '../../../utils/auditoria'
import { q, q1 } from '../../../utils/db'

const Entrada = z.object({
  /** uma devolução específica — o botão "tentar de novo" da linha */
  estornoId: z.string().uuid().nullish(),
  /** ou um empurrão na fila inteira, quando o trabalhador de fundo está atrás */
  limite: z.number().int().min(1).max(50).optional(),
})

const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default defineEventHandler(async (event) => {
  const orgId = (event.context as any).sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })

  const p = Entrada.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!p.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Não entendi o pedido. Mande a devolução que você quer tentar de novo.',
    })
  }

  // ------------------------------------------------------- uma linha só
  if (p.data.estornoId) {
    const linha = await q1<any>(
      `SELECT j.id, j.status, j.amount_cents, j.attempts, j.max_attempts, j.last_error,
              o.code AS pedido
         FROM refund_jobs j
         JOIN orders o ON o.id = j.order_id
        WHERE j.id = $1 AND j.org_id = $2`, [p.data.estornoId, orgId])
    // Mesma resposta pra "não existe" e "não é sua": dizer qual dos dois é
    // conta pro vizinho que a linha existe.
    if (!linha) {
      throw createError({ statusCode: 404, statusMessage: 'Devolução não encontrada' })
    }
    if (linha.status === 'estornado' || linha.status === 'na_mao') {
      throw createError({
        statusCode: 409,
        statusMessage: linha.status === 'estornado'
          ? `A devolução de ${brl(Number(linha.amount_cents))} do pedido ${linha.pedido} `
            + 'já foi feita — não há o que tentar de novo.'
          : `O pedido ${linha.pedido} não passou pela plataforma (dinheiro no guichê, pix na `
            + 'chave do produtor): quem devolve é a produtora, na mão.',
      })
    }

    const r = await processarUmEstorno(`financeiro:${orgId.slice(0, 8)}`, p.data.estornoId)
    if (!r) {
      // A reserva não alcançou a linha. Hoje só sobra um caso: ela está na mão
      // de um trabalhador AGORA (status 'estornando' há menos de 5 minutos), e
      // furar essa carência é o jeito de mandar o dinheiro duas vezes.
      throw createError({
        statusCode: 409,
        statusMessage: 'Esta devolução está sendo processada neste momento. '
          + 'Espere cinco minutos e tente de novo — insistir agora arrisca devolver em dobro.',
      })
    }

    await registrarAuditoria({
      autor: autorDaRequisicao(event),
      entidade: 'estorno', entidadeId: r.id, acao: 'tentar_de_novo',
      antes: { status: linha.status, tentativas: linha.attempts, erro: linha.last_error },
      depois: { status: r.status, valorCents: r.valorCents, erro: r.erro ?? null },
    }).catch(() => { /* auditoria não pode derrubar a devolução */ })

    return {
      ok: r.ok,
      estorno: r,
      aviso: r.ok
        ? (r.adotado
            ? `O dinheiro desta devolução (${brl(r.valorCents)}) já tinha saído numa tentativa `
              + 'anterior: o registro foi fechado sem mandar de novo.'
            : `${brl(r.valorCents)} devolvidos ao comprador do pedido ${linha.pedido}.`)
        : r.erro,
    }
  }

  // -------------------------------------------------- um empurrão na fila
  //
  // A varredura é da PRODUTORA de quem apertou, e não do processo.
  //
  // `processarFilaDeEstorno()` drena a fila inteira: é o certo pro trabalhador
  // de fundo, que não tem dono. Aqui tem — e sem cerca, medido logado como
  // dono da Fazenda Park, esta rota com corpo vazio **executou a devolução de
  // R$ 550,00 de uma produtora vizinha** (pedido dela para 'estornado') e
  // devolveu na resposta o id do pedido e o valor dela. Dinheiro de terceiro
  // saindo por um clique de quem não é dono dele, e sem auditoria nenhuma
  // (este ramo não registra autor).
  //
  // A cerca é a seleção daqui; a reserva continua sendo a atômica de sempre
  // (`SQL_RESERVA_ESTORNO`, por id), que é quem impede dois trabalhadores de
  // pegarem a mesma linha e quem segura a carência de 5 minutos de quem está
  // sendo processado agora. O recorte repete de propósito só o que a fila
  // automática faz — 'na_fila' com a espera cumprida, mais o resgate do que
  // ficou preso — e **não** alcança 'falhou': essa linha é por id, com gente
  // olhando, senão erro permanente vira laço contra o gateway.
  const daCasa = await q<{ id: string }>(
    `SELECT id FROM refund_jobs
      WHERE org_id = $1
        AND ( (status = 'na_fila' AND available_at <= now())
           OR (status = 'estornando' AND claimed_at < now() - interval '5 minutes') )
      ORDER BY available_at
      LIMIT $2`, [orgId, p.data.limite ?? 20])

  const feitos: Awaited<ReturnType<typeof processarUmEstorno>>[] = []
  for (const linha of daCasa) {
    const r = await processarUmEstorno(`fila:${orgId.slice(0, 8)}`, linha.id)
    if (r) feitos.push(r)
  }
  const ruins = feitos.filter((f) => !f!.ok)
  return {
    ok: true,
    processados: feitos.length,
    comFalha: ruins.length,
    estornos: feitos,
    aviso: feitos.length
      ? `${feitos.length - ruins.length} devolução(ões) concluída(s)`
        + (ruins.length ? `, ${ruins.length} com falha: ${ruins[0]!.erro}` : '')
      : 'Não havia devolução esperando na fila.',
  }
})
