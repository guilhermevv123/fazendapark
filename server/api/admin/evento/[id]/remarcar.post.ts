/**
 * POST /api/admin/evento/:id/remarcar — o evento não acontece HOJE, mas vai
 * acontecer.
 *
 * É o caminho em que o dinheiro FICA. O outro — o dia em que não vai ter
 * evento — é a rota irmã (`cancelar.post.ts`).
 *
 *   { escopo: 'evento', comecaEm, terminaEm, motivo, prazoEscolhaDias? }
 *   { escopo: 'pedido', pedidoId, escolha: 'remarcar' | 'reembolso' }
 *
 * ## Adiar não é cancelar e vender de novo
 *
 * O ingresso continua VÁLIDO: ninguém precisa comprar outra vez, e por isso
 * nenhum ingresso é tocado aqui. O que muda é a data do evento — e, junto com
 * ela, a das sessões. Esse "junto" é a parte que passa despercebida: num
 * parque as sessões são diárias, e adiar só o evento deixaria cada ingresso
 * amarrado a uma sessão do dia que não vai existir. O cabeçalho diria "vale na
 * data nova" e o leitor da portaria recusaria com "fora da sessão" no dia
 * certo. As sessões andam pelo MESMO deslocamento do evento.
 *
 * ## A escolha é do comprador
 *
 * Estornar todo mundo de saída devolve dinheiro pra quem ia no dia novo assim
 * mesmo — e mata a bilheteria do produtor num evento que vai acontecer. Não
 * estornar ninguém obriga a pessoa a uma data que ela não comprou. Então o
 * adiamento abre um PRAZO em que cada comprador diz o que quer: ficar com o
 * ingresso na data nova, ou receber o dinheiro de volta. Quem não responde
 * fica com o ingresso — e é por isso que o prazo é gravado e mostrado antes,
 * não depois.
 *
 * O prazo nunca passa do início da data nova: escolher "quero meu dinheiro"
 * com o portão aberto não é escolha, é fila no guichê.
 */
import { z } from 'zod'
import { q1, tx } from '../../../../utils/db'
import { PEDIDO_VIVO } from '../../../../utils/liquido'
import {
  SQL_ADIA_EVENTO, SQL_DESLOCA_SESSOES, SQL_ENFILEIRA_ESTORNO_DE_UM_PEDIDO,
  SQL_MATA_INGRESSOS_DO_PEDIDO, SQL_TRAVA_EVENTO, devolverEstoqueDoPedido,
} from '../../../../utils/cancelamento'

/** Quanto tempo o comprador tem pra escolher, quando ninguém disser outro. */
const PRAZO_PADRAO_DIAS = 7

const Entrada = z.discriminatedUnion('escopo', [
  z.object({
    escopo: z.literal('evento'),
    comecaEm: z.string().datetime({ offset: true }),
    terminaEm: z.string().datetime({ offset: true }),
    /** obrigatório: o comprador vai ler este texto ao escolher */
    motivo: z.string().trim().min(3).max(200),
    prazoEscolhaDias: z.number().int().min(1).max(60).optional(),
  }),
  z.object({
    escopo: z.literal('pedido'),
    pedidoId: z.string().uuid(),
    escolha: z.enum(['remarcar', 'reembolso']),
  }),
])

const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

const dataHora = (d: Date | string) =>
  new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

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
      statusMessage: 'Diga a data nova e o motivo do adiamento (o motivo precisa de pelo menos 3 letras).',
      data: p.error.flatten(),
    })
  }

  return p.data.escopo === 'evento'
    ? adiarEvento(eventId, p.data, sessao)
    : registrarEscolha(eventId, p.data.pedidoId, p.data.escolha, sessao)
})

/* ---------------------------------------------------------------- adiar */

async function adiarEvento(
  eventId: string,
  d: { comecaEm: string; terminaEm: string; motivo: string; prazoEscolhaDias?: number },
  sessao: { usuarioId: string; nome?: string },
) {
  const novoInicio = new Date(d.comecaEm)
  const novoFim = new Date(d.terminaEm)

  if (novoFim.getTime() < novoInicio.getTime()) {
    throw createError({
      statusCode: 422,
      statusMessage: 'O fim do evento não pode ser antes do início.',
    })
  }
  if (novoInicio.getTime() <= Date.now()) {
    throw createError({
      statusCode: 422,
      statusMessage: 'A data nova precisa estar no futuro — adiar para uma data que já passou '
        + 'deixaria o ingresso válido para um dia que não vai acontecer.',
    })
  }

  const feito = await tx(async (c) => {
    const { rows: eventos } = await c.query(SQL_TRAVA_EVENTO, [eventId])
    const ev = eventos[0]
    if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

    if (ev.status === 'cancelado') {
      throw createError({
        statusCode: 409,
        statusMessage: 'Este evento foi cancelado e os ingressos já foram invalidados. '
          + 'Remarcar agora devolveria validade a ingresso que já está sendo estornado — '
          + 'crie um evento novo.',
      })
    }

    const inicioAtual = new Date(ev.starts_at)
    if (novoInicio.getTime() === inicioAtual.getTime()) {
      throw createError({
        statusCode: 422,
        statusMessage: `Esta já é a data do evento (${dataHora(inicioAtual)}). Nada a remarcar.`,
      })
    }

    // O prazo da escolha nunca passa do início da data nova.
    const prazoDias = d.prazoEscolhaDias ?? PRAZO_PADRAO_DIAS
    const limite = new Date(Date.now() + prazoDias * 86_400_000)
    const prazo = limite.getTime() > novoInicio.getTime() ? novoInicio : limite

    const { rows: adiados } = await c.query(
      SQL_ADIA_EVENTO,
      [eventId, novoInicio.toISOString(), novoFim.toISOString(), prazo.toISOString(), d.motivo])
    if (!adiados.length) {
      throw createError({ statusCode: 409, statusMessage: 'Não foi possível remarcar este evento.' })
    }

    // As sessões andam junto, pelo MESMO deslocamento — em milissegundos, que
    // é a precisão que o JavaScript enxerga da coluna. Arredondar pra segundo
    // faz a sessão parar a meio segundo de distância do evento, e "a mesma
    // data" deixa de ser a mesma data pra qualquer comparação exata.
    //
    // Intervalo absoluto, e não "14 dias": somar dias a uma sessão que
    // atravessa mudança de fuso moveria o horário dela.
    const deslocamentoMs = novoInicio.getTime() - inicioAtual.getTime()
    const { rows: sessoes } = await c.query(
      SQL_DESLOCA_SESSOES, [eventId, `${deslocamentoMs} milliseconds`])

    // Quantas pessoas isso alcança, e quanto dinheiro está em jogo se todas
    // pedirem de volta. `PEDIDO_VIVO()`, nunca `status = 'pago'`: pedido com
    // estorno parcial ainda tem comprador com ingresso na mão.
    const { rows: alcance } = await c.query(
      `SELECT count(*)::int AS pedidos,
              COALESCE(SUM(o.total_cents - o.refunded_cents), 0)::bigint AS soma
         FROM orders o
        WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')} AND o.total_cents > o.refunded_cents`,
      [eventId])

    const { rows: validos } = await c.query(
      `SELECT count(*)::int AS n FROM tickets WHERE event_id = $1 AND status = 'valido'`,
      [eventId])

    const { rows: atos } = await c.query(
      `INSERT INTO event_cancellations
         (org_id, event_id, kind, reason, previous_status,
          previous_starts_at, previous_ends_at, new_starts_at, new_ends_at,
          choice_deadline, orders_swept, refund_cents, tickets_killed, by_user)
       VALUES ($1,$2,'adiado',$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12)
       RETURNING id`,
      [ev.org_id, eventId, d.motivo, ev.status, ev.starts_at, ev.ends_at,
       novoInicio.toISOString(), novoFim.toISOString(), prazo.toISOString(),
       alcance[0].pedidos, Number(alcance[0].soma), sessao.usuarioId])

    await c.query(
      `INSERT INTO audit_log (org_id, user_id, entity, entity_id, action, after)
       VALUES ($1,$2,'evento',$3,'evento_adiado',$4::jsonb)`,
      [ev.org_id, sessao.usuarioId, eventId, JSON.stringify({
        evento: ev.name, motivo: d.motivo,
        de: ev.starts_at, para: novoInicio.toISOString(),
        sessoesMovidas: sessoes.length, prazoEscolha: prazo.toISOString(),
        ingressosValidos: validos[0].n, por: sessao.nome ?? null,
      })])

    return {
      adiamentoId: atos[0].id as string,
      nome: ev.name as string,
      de: ev.starts_at as string,
      para: adiados[0].starts_at as string,
      terminaEm: adiados[0].ends_at as string,
      compradoNaDataAntiga: adiados[0].postponed_from as string,
      prazoEscolha: prazo.toISOString(),
      sessoesMovidas: sessoes.length,
      ingressosValidos: validos[0].n as number,
      pedidosAlcancados: alcance[0].pedidos as number,
      emJogoCents: Number(alcance[0].soma),
    }
  })

  return {
    ok: true,
    escopo: 'evento' as const,
    ...feito,
    aviso: `${feito.ingressosValidos} ingresso(s) continuam valendo, agora em `
      + `${dataHora(feito.para)}. Até ${dataHora(feito.prazoEscolha)} cada comprador pode `
      + `pedir o dinheiro de volta em vez da data nova — são ${feito.pedidosAlcancados} `
      + `compra(s), ${brl(feito.emJogoCents)} no total. Quem não responder fica com o ingresso.`,
  }
}

/* -------------------------------------------------- a escolha do comprador */

async function registrarEscolha(
  eventId: string, pedidoId: string, escolha: 'remarcar' | 'reembolso',
  sessao: { usuarioId: string; nome?: string },
) {
  // O adiamento mais recente é o que vale: um evento pode ser adiado duas
  // vezes, e a escolha da primeira vez não responde pela segunda data.
  const ato = await q1<any>(
    `SELECT id, choice_deadline, new_starts_at, reason
       FROM event_cancellations
      WHERE event_id = $1 AND kind = 'adiado'
      ORDER BY at DESC LIMIT 1`, [eventId])
  if (!ato) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Este evento não foi adiado — não há escolha a registrar.',
    })
  }
  if (ato.choice_deadline && new Date(ato.choice_deadline).getTime() < Date.now()) {
    throw createError({
      statusCode: 409,
      statusMessage: `O prazo para escolher terminou em ${dataHora(ato.choice_deadline)}. `
        + 'O ingresso vale na data nova.',
    })
  }

  // Cerca própria: o id do pedido vem no corpo, e o middleware só cerca a URL.
  const pedido = await q1<any>(
    `SELECT o.id, o.code, o.org_id, o.status, o.total_cents, o.refunded_cents,
            o.asaas_payment_id
       FROM orders o WHERE o.id = $1 AND o.event_id = $2`, [pedidoId, eventId])
  if (!pedido) throw createError({ statusCode: 404, statusMessage: 'Compra não encontrada' })

  const feito = await tx(async (c) => {
    await c.query(`SELECT id FROM orders WHERE id = $1 FOR UPDATE`, [pedidoId])

    // ---- a escolha só é reversível ENQUANTO nada aconteceu
    //
    // 'reembolso' não é intenção: ele já matou o ingresso, já devolveu o lugar
    // pra prateleira e já botou o pedido na fila. Deixar voltar pra 'remarcar'
    // depois disso trocava a linha da escolha e respondia "Ingressos mantidos:
    // valem em <data>. Nada foi cobrado nem devolvido." — com o ingresso
    // cancelado e o dinheiro a caminho. A pessoa ia pro parque acreditando na
    // frase. Nenhuma exceção, nenhum log, 200 na cara.
    //
    // Desfazer de verdade não serve: o lugar já voltou pra prateleira e pode
    // ter sido vendido pra outra pessoa, e o dinheiro pode já ter saído. Então
    // a rota recusa — e diz o que está acontecendo, com o valor, pra quem
    // atende resolver no telefone.
    const { rows: jaNaFila } = await c.query(
      `SELECT status, amount_cents FROM refund_jobs WHERE order_id = $1`, [pedidoId])
    if (jaNaFila.length) {
      const j = jaNaFila[0]
      const andamento = j.status === 'estornado' || j.status === 'na_mao'
        ? 'já foi devolvido'
        : j.status === 'falhou'
          ? 'falhou e está esperando alguém mandar de novo'
          : 'está em andamento'
      throw createError({
        statusCode: 409,
        statusMessage: `A devolução desta compra ${andamento} `
          + `(${brl(Number(j.amount_cents))}) e os ingressos já foram invalidados. `
          + 'Não dá para voltar atrás por aqui: se o comprador quer a data nova, '
          + 'ele precisa comprar de novo.',
      })
    }

    // A escolha pode mudar enquanto o prazo corre e o dinheiro não saiu. O
    // UNIQUE (cancellation_id, order_id) é o que impede duas respostas
    // conflitantes da mesma pessoa pro mesmo adiamento.
    await c.query(
      `INSERT INTO event_postpone_choices (cancellation_id, order_id, choice, by_user)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (cancellation_id, order_id)
       DO UPDATE SET choice = EXCLUDED.choice, at = now(), by_user = EXCLUDED.by_user`,
      [ato.id, pedidoId, escolha, sessao.usuarioId])

    if (escolha === 'remarcar') {
      await c.query(
        `INSERT INTO audit_log (org_id, user_id, entity, entity_id, action, after)
         VALUES ($1,$2,'order',$3,'adiamento_aceito',$4::jsonb)`,
        [pedido.org_id, sessao.usuarioId, pedidoId, JSON.stringify({
          pedido: pedido.code, novaData: ato.new_starts_at, por: sessao.nome ?? null,
        })])
      return { escolha, valorCents: 0, ingressos: 0, estornoId: null as string | null }
    }

    // ---- reembolso: o ingresso morre e o dinheiro entra na fila
    const { rows: usados } = await c.query(
      `SELECT count(*)::int AS n FROM tickets
        WHERE order_id = $1 AND (status = 'usado' OR checked_in_at IS NOT NULL)`, [pedidoId])
    if (usados[0].n > 0) {
      throw createError({
        statusCode: 409,
        statusMessage: `${usados[0].n} ingresso(s) desta compra já foram usados. `
          + 'Não dá para devolver o dinheiro deles.',
      })
    }

    const mortos = await c.query(SQL_MATA_INGRESSOS_DO_PEDIDO, [pedidoId])
    // O evento vai acontecer: o lugar volta pra prateleira e é revendável.
    await devolverEstoqueDoPedido(c, pedidoId)

    const { rows: fila } = await c.query(
      SQL_ENFILEIRA_ESTORNO_DE_UM_PEDIDO,
      [pedidoId, 'evento_adiado', ato.id, sessao.usuarioId])
    if (!fila.length) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Esta compra já tem uma devolução em andamento.',
      })
    }

    await c.query(
      `INSERT INTO audit_log (org_id, user_id, entity, entity_id, action, after)
       VALUES ($1,$2,'order',$3,'adiamento_recusado',$4::jsonb)`,
      [pedido.org_id, sessao.usuarioId, pedidoId, JSON.stringify({
        pedido: pedido.code, aDevolverCents: Number(fila[0].amount_cents),
        ingressos: mortos.rowCount ?? 0, por: sessao.nome ?? null,
      })])

    return {
      escolha,
      valorCents: Number(fila[0].amount_cents),
      ingressos: mortos.rowCount ?? 0,
      estornoId: fila[0].id as string,
    }
  })

  return {
    ok: true,
    escopo: 'pedido' as const,
    pedido: pedido.code,
    ...feito,
    aviso: feito.escolha === 'remarcar'
      ? `Ingressos mantidos: valem em ${dataHora(ato.new_starts_at)}. Nada foi cobrado nem devolvido.`
      : pedido.asaas_payment_id
        ? `Devolução de ${brl(feito.valorCents)} pedida ao banco. Os ingressos foram invalidados.`
        : `Esta compra não passou pela plataforma: devolva ${brl(feito.valorCents)} ao comprador. `
          + 'Os ingressos já foram invalidados.',
  }
}
