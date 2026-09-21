/**
 * POST /api/admin/evento/:id/cancelar — o dia em que não vai ter evento, e o
 * dia em que o comprador desiste.
 *
 * Duas coisas na mesma rota porque as duas terminam no mesmo lugar: dinheiro
 * voltando. A remarcação — que é o caminho em que o dinheiro FICA — mora na
 * rota irmã (`remarcar.post.ts`).
 *
 *   { escopo: 'evento', motivo }               → o evento inteiro cai
 *   { escopo: 'pedido', pedidoId, motivo? }    → só esta compra volta atrás
 *
 * ## O evento inteiro
 *
 * Três efeitos, e eles só valem juntos:
 *   1. o evento vira 'cancelado' — a página pública para de vender na hora;
 *   2. TODO ingresso válido morre — senão a portaria continua deixando entrar
 *      num evento que não existe (o leitor olha o ingresso, não o evento);
 *   3. cada pedido vivo vira uma linha na fila de estorno.
 *
 * O passo 3 é `INSERT ... SELECT`, uma instrução só, e não um laço chamando o
 * gateway pedido a pedido: um evento de parque tem milhares de pedidos pagos e
 * esse laço não termina dentro de uma requisição. Quem conversa com o banco é
 * o trabalhador de fundo (`utils/cancelamento.ts`), com nova tentativa e
 * espera crescente. A requisição só grava a intenção — e a grava inteira ou
 * nenhuma, porque tudo acontece no mesmo commit.
 *
 * **Cancelar duas vezes não devolve em dobro.** O `UNIQUE (order_id)` da fila
 * recusa a segunda linha do mesmo pedido, então disparar de novo (porque um
 * pagamento entrou depois, porque alguém clicou duas vezes) só alcança quem
 * ficou de fora na primeira vez. É de propósito que a rota aceite o segundo
 * disparo em vez de responder 409: pagamento que cai depois do cancelamento
 * precisa de alguém pra varrer, e esse alguém é este botão.
 *
 * ## A desistência do comprador (CDC art. 49)
 *
 * Sete dias de arrependimento na compra pela internet, enquanto faltarem mais
 * de sete dias pro evento. É o assunto nº 1 das reclamações contra ticketeira
 * no Procon e não existia caminho nenhum aqui. A regra mora em
 * `utils/cancelamento.ts` (`avaliarArrependimento`) porque a TELA precisa
 * dizer, antes do clique, por que está ou não disponível — e a rota precisa
 * recusar com a mesma frase. Quando a regra mora dentro da rota, a tela copia,
 * e a cópia envelhece.
 *
 * Aqui o estoque VOLTA (o evento continua de pé e o lugar é revendável), o que
 * não acontece no cancelamento do evento inteiro.
 */
import { z } from 'zod'
import { q1, tx } from '../../../../utils/db'
import {
  SQL_CANCELA_EVENTO, SQL_ENFILEIRA_ESTORNO_DE_UM_PEDIDO, SQL_ENFILEIRA_ESTORNO_DO_EVENTO,
  SQL_MATA_INGRESSOS_DO_EVENTO, SQL_MATA_INGRESSOS_DO_PEDIDO, SQL_TRAVA_EVENTO,
  avaliarArrependimento, devolverEstoqueDoPedido, resumoDaFila,
} from '../../../../utils/cancelamento'

const Entrada = z.discriminatedUnion('escopo', [
  z.object({
    escopo: z.literal('evento'),
    /** obrigatório: o comprador vai ler este texto no e-mail e na página */
    motivo: z.string().trim().min(3).max(200),
  }),
  z.object({
    escopo: z.literal('pedido'),
    pedidoId: z.string().uuid(),
    motivo: z.string().trim().min(3).max(200).optional(),
  }),
])

const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default defineEventHandler(async (event) => {
  const eventId = getRouterParam(event, 'id')!
  const sessao = (event.context as any).sessao
  if (!sessao?.usuarioId) {
    throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })
  }

  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Diga o que está sendo cancelado e por quê (o motivo precisa de pelo menos 3 letras).',
      data: p.error.flatten(),
    })
  }

  return p.data.escopo === 'evento'
    ? cancelarEvento(eventId, p.data.motivo, sessao)
    : desistirDaCompra(eventId, p.data.pedidoId, p.data.motivo ?? null, sessao)
})

/* ----------------------------------------------------------- o evento todo */

async function cancelarEvento(
  eventId: string, motivo: string, sessao: { usuarioId: string; nome?: string },
) {
  const feito = await tx(async (c) => {
    const { rows: eventos } = await c.query(SQL_TRAVA_EVENTO, [eventId])
    const ev = eventos[0]
    if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

    // A virada é condicional: zero linhas quer dizer que ele já estava
    // cancelado. Não é erro — segue para varrer quem ficou de fora.
    const virou = await c.query(SQL_CANCELA_EVENTO, [eventId, motivo])
    const jaEstava = virou.rowCount === 0

    // Os ingressos morrem ANTES da fila de propósito: a devolução do dinheiro
    // demora (é conversa com banco), e nesse meio tempo ninguém pode entrar.
    const mortos = await c.query(SQL_MATA_INGRESSOS_DO_EVENTO, [eventId])

    const { rows: atos } = await c.query(
      `INSERT INTO event_cancellations
         (org_id, event_id, kind, reason, previous_status,
          previous_starts_at, previous_ends_at, by_user)
       VALUES ($1,$2,'cancelado',$3,$4,$5,$6,$7)
       RETURNING id`,
      [ev.org_id, eventId, motivo, ev.status, ev.starts_at, ev.ends_at, sessao.usuarioId])
    const atoId = atos[0].id

    // UMA instrução para milhares de pedidos. `ON CONFLICT DO NOTHING` sobre o
    // UNIQUE (order_id): quem já estava na fila não entra de novo.
    const { rows: fila } = await c.query(
      SQL_ENFILEIRA_ESTORNO_DO_EVENTO, [eventId, atoId, 'evento_cancelado', sessao.usuarioId])
    const aDevolverCents = fila.reduce((s: number, l: any) => s + Number(l.amount_cents), 0)

    await c.query(
      `UPDATE event_cancellations
          SET orders_swept = $2, refund_cents = $3, tickets_killed = $4
        WHERE id = $1`,
      [atoId, fila.length, aDevolverCents, mortos.rowCount ?? 0])

    await c.query(
      `INSERT INTO audit_log (org_id, user_id, entity, entity_id, action, after)
       VALUES ($1,$2,'evento',$3,'evento_cancelado',$4::jsonb)`,
      [ev.org_id, sessao.usuarioId, eventId, JSON.stringify({
        evento: ev.name, motivo, jaEstava,
        ingressosCancelados: mortos.rowCount ?? 0,
        pedidosNaFila: fila.length, aDevolverCents, por: sessao.nome ?? null,
      })])

    return {
      nome: ev.name as string,
      jaEstava,
      ingressosCancelados: mortos.rowCount ?? 0,
      pedidosNaFila: fila.length,
      aDevolverCents,
    }
  })

  const fila = await resumoDaFila(eventId)

  return {
    ok: true,
    escopo: 'evento' as const,
    evento: feito.nome,
    jaEstava: feito.jaEstava,
    ingressosCancelados: feito.ingressosCancelados,
    pedidosNaFila: feito.pedidosNaFila,
    aDevolverCents: feito.aDevolverCents,
    fila,
    aviso: recado(feito, fila),
  }
}

/**
 * O que acontece agora, em uma frase. Quem cancela um evento quer saber duas
 * coisas: quem parou de poder entrar, e quando o dinheiro volta.
 */
function recado(
  f: { jaEstava: boolean; ingressosCancelados: number; pedidosNaFila: number; aDevolverCents: number },
  fila: { naMaoCents: number },
): string {
  if (f.jaEstava && !f.pedidosNaFila && !f.ingressosCancelados) {
    return 'Este evento já estava cancelado e não havia mais nada a devolver.'
  }
  const partes = [
    `${f.ingressosCancelados} ingresso(s) invalidado(s)`,
    `${f.pedidosNaFila} pedido(s) na fila de devolução, somando ${brl(f.aDevolverCents)}`,
  ]
  if (fila.naMaoCents > 0) {
    partes.push(`${brl(fila.naMaoCents)} foram vendas que não passaram pela plataforma `
      + '(dinheiro no guichê, pix na sua chave): essa parte quem devolve é você')
  }
  return partes.join('. ') + '. A devolução sai em segundo plano — acompanhe nesta tela.'
}

/* --------------------------------------------------- a desistência de um só */

async function desistirDaCompra(
  eventId: string, pedidoId: string, motivo: string | null,
  sessao: { usuarioId: string; nome?: string },
) {
  // O id do pedido vem no CORPO → cerca própria, antes de qualquer escrita. O
  // middleware de tenant só cerca o `:id` da URL; sem este `event_id = $2` um
  // login qualquer cancelaria a compra de outra produtora sabendo o uuid dela.
  const pedido = await q1<any>(
    `SELECT o.id, o.code, o.org_id, o.channel, o.status, o.total_cents, o.refunded_cents,
            o.paid_at, o.created_at, o.asaas_payment_id,
            e.name AS evento, e.starts_at, e.status AS evento_status
       FROM orders o
       JOIN events e ON e.id = o.event_id
      WHERE o.id = $1 AND o.event_id = $2`, [pedidoId, eventId])
  if (!pedido) throw createError({ statusCode: 404, statusMessage: 'Compra não encontrada' })

  // Evento cancelado não tem "desistência": tem devolução de todo mundo, e ela
  // já está na fila. Deixar passar por aqui errava duas coisas em silêncio —
  // o lugar voltava pra prateleira de um evento que não vai acontecer (o
  // cancelamento em massa deixa o estoque quieto DE PROPÓSITO, pra não apagar
  // do relatório o quanto foi vendido até ele cair), e a devolução entrava com
  // `reason = 'arrependimento'` em vez de `'evento_cancelado'`. Essa coluna
  // existe porque o relatório do Procon pergunta por esse recorte: arrependimento
  // é direito do consumidor, cancelamento é falha do fornecedor.
  //
  // O caso comum estava protegido por acidente (o pedido já estava na fila e o
  // `ON CONFLICT` derrubava a transação). Quem furava era o pix que caiu DEPOIS
  // do cancelamento e ainda não tinha sido varrido — justamente o caso que esta
  // rota documenta como motivo pra aceitar o disparo repetido.
  if (pedido.evento_status === 'cancelado') {
    throw createError({
      statusCode: 409,
      statusMessage: 'Este evento foi cancelado e a devolução é de todas as compras — '
        + 'ela sai sozinha, em segundo plano. Se esta compra ainda não apareceu na lista, '
        + 'dispare o cancelamento do evento de novo: ele varre quem pagou depois.',
    })
  }

  const aDevolverCents = Number(pedido.total_cents) - Number(pedido.refunded_cents)
  const veredicto = avaliarArrependimento({
    canal: pedido.channel,
    status: pedido.status,
    // a contagem corre da COMPRA; sem pagamento confirmado, do pedido
    compradoEm: pedido.paid_at ?? pedido.created_at,
    eventoComecaEm: pedido.starts_at,
    aDevolverCents,
  })
  if (!veredicto.disponivel) {
    throw createError({ statusCode: 409, statusMessage: veredicto.motivo })
  }

  const feito = await tx(async (c) => {
    // Trava a linha do pedido antes de decidir qualquer coisa: dois cliques no
    // mesmo botão são dois pedidos chegando juntos.
    const { rows } = await c.query(
      `SELECT id, status FROM orders WHERE id = $1 FOR UPDATE`, [pedidoId])
    if (!rows[0]) throw createError({ statusCode: 404, statusMessage: 'Compra não encontrada' })

    // Ingresso que JÁ ENTROU não volta atrás: a pessoa usou o parque.
    const { rows: usados } = await c.query(
      `SELECT count(*)::int AS n FROM tickets
        WHERE order_id = $1 AND (status = 'usado' OR checked_in_at IS NOT NULL)`, [pedidoId])
    if (usados[0].n > 0) {
      throw createError({
        statusCode: 409,
        statusMessage: `${usados[0].n} ingresso(s) desta compra já entraram no parque. `
          + 'Não dá para desistir depois de usar — o acerto é com o gerente.',
      })
    }

    const mortos = await c.query(SQL_MATA_INGRESSOS_DO_PEDIDO, [pedidoId])

    // O evento continua de pé: o lugar volta pra prateleira e pode ser vendido
    // de novo. (No cancelamento do evento inteiro isso NÃO acontece — lá o
    // estoque é deixado como está, porque ninguém vai vender mais nada.)
    await devolverEstoqueDoPedido(c, pedidoId)

    const { rows: fila } = await c.query(
      SQL_ENFILEIRA_ESTORNO_DE_UM_PEDIDO,
      [pedidoId, 'arrependimento', null, sessao.usuarioId])
    if (!fila.length) {
      // `ON CONFLICT DO NOTHING` não gravou: já existe estorno pra este pedido.
      // Rolar atrás é o certo — os ingressos acima voltam a valer.
      throw createError({
        statusCode: 409,
        statusMessage: 'Esta compra já tem uma devolução em andamento.',
      })
    }

    await c.query(
      `INSERT INTO audit_log (org_id, user_id, entity, entity_id, action, after)
       VALUES ($1,$2,'order',$3,'compra_desistida',$4::jsonb)`,
      [pedido.org_id, sessao.usuarioId, pedidoId, JSON.stringify({
        pedido: pedido.code, evento: pedido.evento, canal: pedido.channel,
        aDevolverCents, ingressos: mortos.rowCount ?? 0,
        motivo: motivo ?? 'arrependimento (CDC art. 49)',
        prazoAte: veredicto.prazoAte, por: sessao.nome ?? null,
      })])

    return {
      estornoId: fila[0].id as string,
      valorCents: Number(fila[0].amount_cents),
      ingressos: mortos.rowCount ?? 0,
    }
  })

  return {
    ok: true,
    escopo: 'pedido' as const,
    pedido: pedido.code,
    estornoId: feito.estornoId,
    valorCents: feito.valorCents,
    ingressosCancelados: feito.ingressos,
    prazoAte: veredicto.prazoAte,
    aviso: pedido.asaas_payment_id
      ? `Devolução de ${brl(feito.valorCents)} pedida ao banco. O dinheiro volta para o comprador em alguns dias.`
      : `Esta compra não passou pela plataforma: devolva ${brl(feito.valorCents)} ao comprador. `
        + 'Os ingressos já foram invalidados.',
  }
}
