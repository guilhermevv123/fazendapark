/**
 * POST /api/admin/evento/:id/pdv/cancelamento — desfaz uma venda do balcão.
 *
 * O guichê vendia e não desfazia. Quantidade digitada errada, cliente que
 * desiste com a nota ainda na mão, cobrança passada no cartão errado: não
 * existia caminho no sistema, então o conserto virava papel. O operador
 * devolvia o dinheiro, anotava num caderno, e de manhã o caixa fechava com
 * uma falta que ninguém sabia explicar.
 *
 * Cancelar não é apagar. São QUATRO efeitos que só valem juntos:
 *
 *   1. o ingresso morre — senão a pessoa entra com um ingresso devolvido;
 *   2. o estoque volta — senão o lote "esgota" com ingresso que ninguém tem;
 *   3. o dinheiro sai da conferência do turno — senão a sobra/falta mente;
 *   4. o estorno é pedido ao gateway, quando a venda passou por ele.
 *
 * Por isso tudo o que é banco acontece num commit só, e a chamada ao Asaas
 * fica FORA dele: rede de terceiro dentro de transação segura o lock da linha
 * do turno pelo tempo do timeout do outro lado, e aí a fila inteira do guichê
 * para (é a mesma ordem que o checkout usa).
 *
 * ## A ordem entre o banco e o gateway
 *
 * Primeiro o banco, depois o gateway — e não o contrário. Se o estorno
 * saísse primeiro e o processo morresse antes do commit, o cliente ficaria
 * com o dinheiro E com um ingresso válido na mão. Do jeito que está, a falha
 * possível é o oposto: ingresso já invalidado e estorno por reenviar, que
 * fica gravado com esse nome na linha do cancelamento e aparece na tela do
 * operador em vez de virar exceção que ninguém lê.
 */
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { q, q1, tx } from '../../../../../utils/db'
import {
  FORMA_LEGIVEL, SQL_CANCELA_VENDA_PDV, SQL_TRAVA_INGRESSOS_DA_VENDA,
  SQL_TRAVA_TURNO_ABERTO, type FormaPdv,
} from '../../../../../utils/caixa'
import { estornar, type ConfigAsaas } from '../../../../../utils/asaas'

const Entrada = z.object({
  pedidoId: z.string().uuid(),
  /** obrigatório: cancelamento sem motivo transforma auditoria em adivinhação */
  motivo: z.string().trim().min(3).max(200),
})

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
      statusMessage: 'Diga qual venda e por que está sendo cancelada (pelo menos 3 letras).',
      data: p.error.flatten(),
    })
  }
  const d = p.data

  // O id do pedido vem no CORPO → cerca própria, antes de qualquer escrita. O
  // middleware de tenant só cerca o `:id` da URL; sem este `event_id = $2` um
  // login qualquer cancelaria a venda de outra produtora sabendo o uuid dela.
  //
  // LEFT JOIN de propósito nos dois lados: venda online não tem turno, e JOIN
  // comum faria ela sumir da consulta e virar "venda não encontrada" — a
  // mensagem errada pro operador, que ficaria procurando um pedido que existe.
  const pedido = await q1<any>(
    `SELECT o.id, o.code, o.org_id, o.channel, o.status, o.total_cents,
            o.payment_method, o.pos_shift_id, o.asaas_payment_id, o.promo_code_id,
            t.status AS turno_status, t.closed_at, p.name AS ponto
       FROM orders o
       LEFT JOIN pos_shifts t ON t.id = o.pos_shift_id
       LEFT JOIN pos_terminals p ON p.id = t.terminal_id
      WHERE o.id = $1 AND o.event_id = $2`, [d.pedidoId, eventId])
  if (!pedido) throw createError({ statusCode: 404, statusMessage: 'Venda não encontrada' })

  if (!pedido.pos_shift_id) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Esta venda não saiu de um guichê. Cancelamento de venda pela internet sai pelo financeiro.',
    })
  }

  const feito = await tx(async (c) => {
    // 1. o caixa precisa estar ABERTO — a mesma instrução que a venda usa.
    //
    // Cancelar num turno fechado é mudar uma conferência já assinada: o
    // `closing_expected_cents` foi congelado com esta venda dentro, e tirar o
    // dinheiro da gaveta agora deixa o fechamento de ontem mentindo pros dois
    // lados. Quando o caixa já fechou, quem desfaz é o financeiro, com
    // estorno — não o guichê.
    const turno = await c.query(SQL_TRAVA_TURNO_ABERTO, [pedido.pos_shift_id])
    if (turno.rowCount !== 1) {
      throw createError({
        statusCode: 409,
        statusMessage: `O caixa desta venda (${pedido.ponto ?? 'guichê'}) já foi fechado. Peça o estorno ao financeiro.`,
      })
    }

    // 2. trava as linhas dos ingressos ANTES de decidir. É o que serializa
    //    com a porta: ou a entrada acontece inteira antes (e o passo 3 recusa
    //    o cancelamento), ou ela chega depois e encontra o ingresso cancelado.
    await c.query(SQL_TRAVA_INGRESSOS_DA_VENDA, [pedido.id])

    // 3. a trava do cancelamento, em UMA instrução: não cancela duas vezes e
    //    não cancela quem já entrou. Nenhuma checagem antes, de propósito.
    const cancelada = await c.query(SQL_CANCELA_VENDA_PDV, [pedido.id])
    if (cancelada.rowCount !== 1) throw await explicarRecusa(c, pedido.id)
    const o = cancelada.rows[0]

    // 4. os ingressos morrem. 'usado' não é tocado — mas aqui já não existe
    //    nenhum: a trava acima não teria deixado passar.
    const mortos = await c.query(
      `UPDATE tickets SET status = 'cancelado', canceled_at = now()
        WHERE order_id = $1 AND status = 'valido'
        RETURNING id`, [pedido.id])

    // 5. o estoque volta pra prateleira. Ordem determinística pelo id do lote
    //    pelo mesmo motivo da reserva: dois cancelamentos pegando os mesmos
    //    dois lotes em ordens opostas travam um no outro pra sempre.
    const { rows: itens } = await c.query(
      `SELECT lot_id, ticket_type_id, quantity
         FROM order_items WHERE order_id = $1
        ORDER BY lot_id`, [pedido.id])
    for (const i of itens) {
      // GREATEST porque o estoque é contagem, não histórico: se um caminho
      // antigo já tiver devolvido, é melhor parar no zero do que ficar
      // negativo e quebrar o CHECK do lote pra todo mundo que vender depois.
      await c.query(`UPDATE lots SET sold = GREATEST(sold - $2, 0) WHERE id = $1`,
        [i.lot_id, i.quantity])
      if (i.ticket_type_id) {
        await c.query(`UPDATE ticket_types SET sold = GREATEST(sold - $2, 0) WHERE id = $1`,
          [i.ticket_type_id, i.quantity])
      }
    }

    // cupom usado numa venda desfeita não foi usado: devolve o uso, senão uma
    // tarde de erro de digitação queima um cupom de 100 usos.
    if (pedido.promo_code_id) {
      await c.query(`UPDATE promo_codes SET uses = GREATEST(uses - 1, 0) WHERE id = $1`,
        [pedido.promo_code_id])
    }

    // 6. o rastro. `from_drawer` é o que faz a conferência do turno contar
    //    certo: só a venda em espécie tira nota da gaveta.
    const saiuDaGaveta = o.payment_method === 'dinheiro'
    const precisaGateway = !!o.asaas_payment_id
    const registro = await c.query(
      `INSERT INTO pos_sale_cancellations
         (org_id, event_id, order_id, shift_id, amount_cents, payment_method,
          from_drawer, tickets_canceled, reason, gateway_refund, by_user)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [pedido.org_id, eventId, pedido.id, o.pos_shift_id, Number(o.total_cents),
       o.payment_method, saiuDaGaveta, mortos.rowCount, d.motivo,
       precisaGateway ? 'pendente' : 'nao_aplica', sessao.usuarioId])

    await c.query(
      `INSERT INTO audit_log (org_id, user_id, entity, entity_id, action, after)
       VALUES ($1,$2,'order',$3,'venda_balcao_cancelada',$4::jsonb)`,
      [pedido.org_id, sessao.usuarioId, pedido.id, JSON.stringify({
        pedido: o.code, ponto: pedido.ponto, forma: o.payment_method,
        totalCents: Number(o.total_cents), ingressos: mortos.rowCount,
        saiuDaGaveta, motivo: d.motivo, por: sessao.nome ?? null,
      })])

    return {
      cancelamentoId: registro.rows[0].id,
      pedido: o.code,
      orgId: pedido.org_id,
      turnoId: o.pos_shift_id,
      totalCents: Number(o.total_cents),
      forma: o.payment_method as FormaPdv | null,
      asaasPaymentId: o.asaas_payment_id as string | null,
      ingressos: mortos.rowCount ?? 0,
      saiuDaGaveta,
    }
  })

  // ------------------------------------------- 7. o gateway, fora do commit
  const estorno = feito.asaasPaymentId
    ? await pedirEstorno(feito.cancelamentoId, feito.orgId, feito.asaasPaymentId, feito.totalCents)
    : { status: 'nao_aplica' as const, erro: null as string | null }

  return {
    ok: true,
    pedido: feito.pedido,
    totalCents: feito.totalCents,
    forma: feito.forma,
    ingressosCancelados: feito.ingressos,
    saiuDaGaveta: feito.saiuDaGaveta,
    estorno: estorno.status,
    estornoErro: estorno.erro,
    aviso: aviso(feito, estorno),
  }
})

/**
 * O que o operador precisa fazer AGORA, em uma frase.
 *
 * Cada caminho termina num lugar diferente do mundo físico: a nota sai da
 * gaveta pela mão dele, o estorno do gateway sai sozinho, e a maquininha que
 * não é da plataforma só ele pode cancelar. Não dizer qual é o caso deixa a
 * venda desfeita no sistema e cobrada no cliente.
 */
function aviso(
  f: { saiuDaGaveta: boolean; totalCents: number; forma: string | null; asaasPaymentId: string | null },
  e: { status: string; erro: string | null },
): string {
  if (e.status === 'falhou') {
    return `Ingressos invalidados, mas o estorno de ${brl(f.totalCents)} não saiu (${e.erro}). Avise o financeiro para reenviar.`
  }
  if (f.saiuDaGaveta) {
    return `Devolva ${brl(f.totalCents)} em dinheiro ao cliente. A gaveta já está sendo contada sem esta venda.`
  }
  if (e.status === 'solicitado' || e.status === 'simulado') {
    return `Estorno de ${brl(f.totalCents)} pedido ao banco. O dinheiro volta para o cliente em alguns dias.`
  }
  // Sem cobrança na plataforma: o dinheiro nunca passou por aqui, então
  // ninguém devolve por aqui. Quem tem que agir é o operador, na maquininha
  // dele ou na chave pix dele — e se ninguém disser isso, o cliente fica com
  // a venda cancelada no sistema e a cobrança de pé no cartão.
  if (f.forma === 'pix') {
    return `Esta venda em pix não passou pela plataforma: devolva ${brl(f.totalCents)} na chave do cliente.`
  }
  const forma = f.forma ? (FORMA_LEGIVEL[f.forma as FormaPdv] ?? f.forma) : 'a cobrança'
  return `Esta venda em ${forma.toLowerCase()} não passou pela plataforma: cancele o comprovante de ${brl(f.totalCents)} na maquininha.`
}

/**
 * Pede o estorno ao Asaas e grava o que aconteceu na linha do cancelamento.
 *
 * Nunca derruba o cancelamento: o ingresso já está inválido e a pessoa já não
 * entra. Falha aqui é dinheiro a devolver, e dinheiro a devolver precisa de
 * nome e de lugar — não de um 500 que some do log em duas horas.
 */
async function pedirEstorno(
  cancelamentoId: string, orgId: string, paymentId: string, totalCents: number,
): Promise<{ status: 'solicitado' | 'falhou' | 'simulado'; erro: string | null }> {
  let status: 'solicitado' | 'falhou' | 'simulado' = 'solicitado'
  let erro: string | null = null

  // cobrança de mentira (gateway simulado, PAGAMENTO_SIMULADO=1) não tem o que
  // estornar — e o prefixo `sim_` é justamente o que deixa isso auditável.
  if (paymentId.startsWith('sim_')) {
    status = 'simulado'
  } else {
    const org = await q1<any>(
      `SELECT asaas_api_key, asaas_env, asaas_wallet FROM organizations WHERE id = $1`, [orgId])
    const cfg: ConfigAsaas = {
      apiKey: org?.asaas_api_key, environment: org?.asaas_env, walletId: org?.asaas_wallet,
    }
    if (!cfg.apiKey) {
      status = 'falhou'
      erro = 'esta loja está sem o Asaas configurado'
    } else {
      try {
        await estornar(cfg, paymentId, totalCents)
      } catch (e: any) {
        status = 'falhou'
        erro = e?.message ?? String(e)
      }
    }
  }

  await q(
    `UPDATE pos_sale_cancellations SET gateway_refund = $2, gateway_error = $3 WHERE id = $1`,
    [cancelamentoId, status, erro])
  return { status, erro }
}

/**
 * Por que a trava recusou — perguntado DEPOIS dela, nunca antes.
 *
 * Fazer esta leitura antes do UPDATE condicional seria a pré-checagem que já
 * escondeu três travas neste sistema: o segundo pedido morreria aqui, o teste
 * ficaria verde e o `AND status = 'pago'` poderia ser arrancado sem ninguém
 * notar. Aqui ela só existe pra transformar `rowCount = 0` numa frase que o
 * operador entende com fila na frente.
 */
async function explicarRecusa(c: PoolClient, orderId: string) {
  const { rows } = await c.query(
    `SELECT o.status, o.total_cents, o.refunded_cents,
            count(t.id) FILTER (WHERE t.status = 'usado' OR t.checked_in_at IS NOT NULL)::int AS entraram,
            count(t.id)::int AS ingressos
       FROM orders o
       LEFT JOIN tickets t ON t.order_id = o.id
      WHERE o.id = $1
      GROUP BY o.id, o.status`, [orderId])
  const r = rows[0]
  if (!r) return createError({ statusCode: 404, statusMessage: 'Venda não encontrada' })

  if (Number(r.entraram) > 0) {
    return createError({
      statusCode: 409,
      statusMessage: `${r.entraram} de ${r.ingressos} ingresso(s) desta venda já entraram no parque. Não dá para cancelar — o acerto é com o gerente.`,
    })
  }
  /*
   * Devolução PARCIAL não é venda cancelada, e dizer que é manda o operador
   * embora com a informação errada.
   *
   * Isto era `r.status?.startsWith('estornado')`, que casa os dois status de
   * uma vez. A frase só ficou alcançável quando a lista de vendas do turno
   * passou a mostrar pedido vivo (antes o `WHERE status = 'pago'` escondia o
   * parcial da tela, e com ele o botão): medido num pedido de R$ 935,00 com
   * R$ 20,00 devolvidos, o guichê oferecia "Cancelar R$ 935,00" e a recusa
   * respondia "Esta venda já foi cancelada" — com R$ 915,00 ainda na gaveta e
   * o cliente na frente. Não há estorno em dobro, o dano é a frase.
   *
   * O guichê continua sem poder mexer: o que já foi devolvido saiu pelo
   * gateway, e o acerto do que sobrou é do financeiro. Mas a recusa agora diz
   * o que de fato aconteceu, e quanto.
   */
  if (r.status === 'estornado_parcial') {
    const devolvido = Number(r.refunded_cents ?? 0)
    const naGaveta = Math.max(Number(r.total_cents ?? 0) - devolvido, 0)
    return createError({
      statusCode: 409,
      statusMessage: `Esta venda NÃO foi cancelada: ${brl(devolvido)} já foram devolvidos ao `
        + `cliente e ${brl(naGaveta)} continuam com a produtora. O guichê não desfaz venda `
        + 'com devolução no meio — quem acerta o que sobrou é o financeiro.',
    })
  }
  if (r.status !== 'pago') {
    return createError({
      statusCode: 409,
      statusMessage: r.status === 'cancelado' || r.status === 'estornado'
        ? 'Esta venda já foi cancelada.'
        : `Esta venda está como "${r.status}" e não pode ser cancelada no guichê.`,
    })
  }
  return createError({ statusCode: 409, statusMessage: 'Não foi possível cancelar esta venda.' })
}
