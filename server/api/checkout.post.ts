/**
 * POST /api/checkout — monta o pedido, segura o estoque e cria a cobrança.
 *
 * Regra que governa o arquivo: **preço nunca vem do navegador**. O cliente diz
 * QUAIS lotes e QUANTOS; todo valor é relido do banco e recalculado aqui. Um
 * checkout que aceita `price` do front é um checkout onde o cliente escolhe
 * quanto pagar — e isso não aparece em teste nenhum, só no fechamento do mês.
 *
 * Ordem das operações, de propósito:
 *   1. transação: valida → reserva estoque → grava pedido → COMMIT
 *   2. fora da transação: chama o Asaas
 *   3. grava o retorno do gateway
 * Chamada externa dentro de transação segura lock de linha pelo tempo da rede
 * do terceiro. Numa virada de lote isso trava a fila inteira.
 */
import { z } from 'zod'
import { q, q1, tx } from '../utils/db'
import { EstoqueInsuficiente, liberar, LoteIndisponivel, reservar } from '../utils/estoque'
import { faceComDesconto, somarPedido, type ModoTaxa } from '../utils/dinheiro'
import {
  acharOuCriarCliente, cancelarCobranca, centavosParaReais, criarCobranca,
  qrCodePix, vencimentoEmDias, type ConfigAsaas,
} from '../utils/asaas'
import { gerarCodigo } from '../utils/ingresso'
import { cpfValido } from '../utils/documento'
import * as simulado from '../utils/gateway-simulado'

const Entrada = z.object({
  eventSlug: z.string().min(1),
  itens: z.array(z.object({
    lotId: z.string().uuid(),
    ticketTypeId: z.string().uuid().nullish(),
    quantidade: z.number().int().positive().max(50),
  })).min(1).max(20),
  comprador: z.object({
    nome: z.string().min(3).max(120),
    email: z.string().email(),
    documento: z.string().min(11).max(18),
    telefone: z.string().min(10).max(20).optional(),
  }),
  cupom: z.string().max(40).optional(),
  promoter: z.string().max(40).optional(),
  forma: z.enum(['pix', 'credito']).default('pix'),
  parcelas: z.number().int().min(1).max(12).default(1),
})

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const p = Entrada.safeParse(body)
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const dados = p.data
  const documento = dados.comprador.documento.replace(/\D/g, '')
  if (!cpfValido(documento)) {
    throw createError({ statusCode: 400, statusMessage: 'CPF inválido' })
  }

  // ------------------------------------------------------------- 1. evento
  const ev = await q1<any>(
    `SELECT e.*, o.asaas_api_key, o.asaas_env, o.asaas_wallet
       FROM events e JOIN organizations o ON o.id = e.org_id
      WHERE e.slug = $1`, [dados.eventSlug])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  if (ev.status !== 'ativo') {
    throw createError({ statusCode: 409, statusMessage: 'As vendas deste evento não estão abertas' })
  }
  if (ev.sales_end_at && new Date(ev.sales_end_at) <= new Date()) {
    throw createError({ statusCode: 409, statusMessage: 'As vendas deste evento já encerraram' })
  }

  // --------------------------------------------- 2. preços, lidos do banco
  const lotIds = [...new Set(dados.itens.map((i) => i.lotId))]
  const lotes = await q<any>(
    `SELECT l.id, l.name, l.price_cents, l.sector_id, s.event_id, s.kind
       FROM lots l JOIN sectors s ON s.id = l.sector_id
      WHERE l.id = ANY($1::uuid[])`, [lotIds])
  const porLote = new Map(lotes.map((l) => [l.id, l]))
  for (const it of dados.itens) {
    const l = porLote.get(it.lotId)
    if (!l) throw createError({ statusCode: 404, statusMessage: 'Lote não encontrado' })
    if (l.event_id !== ev.id) {
      // lote de outro evento no mesmo pedido: ou é bug de front ou é tentativa
      throw createError({ statusCode: 400, statusMessage: 'Lote não pertence a este evento' })
    }
  }

  const tipoIds = dados.itens.map((i) => i.ticketTypeId).filter(Boolean) as string[]
  const tipos = tipoIds.length
    ? await q<any>(`SELECT id, lot_id, name, discount_bps, requires_document
                      FROM ticket_types WHERE id = ANY($1::uuid[])`, [tipoIds])
    : []
  const porTipo = new Map(tipos.map((t) => [t.id, t]))

  const modo: ModoTaxa = ev.fee_mode_online
  const linhas = dados.itens.map((it) => {
    const lote = porLote.get(it.lotId)!
    let face = Number(lote.price_cents)
    if (it.ticketTypeId) {
      const t = porTipo.get(it.ticketTypeId)
      if (!t) throw createError({ statusCode: 404, statusMessage: 'Tipo de ingresso não encontrado' })
      if (t.lot_id !== it.lotId) {
        throw createError({ statusCode: 400, statusMessage: 'Tipo de ingresso não é deste lote' })
      }
      face = faceComDesconto(face, Number(t.discount_bps))
    }
    return { quantidade: it.quantidade, faceUnitCents: face }
  })

  // ------------------------------------------------------------- 3. cupom
  let cupom: any = null
  if (dados.cupom) {
    cupom = await q1<any>(
      `SELECT * FROM promo_codes
        WHERE event_id = $1 AND upper(code) = upper($2) AND active = true
          AND (starts_at IS NULL OR starts_at <= now())
          AND (ends_at   IS NULL OR ends_at   >= now())
          AND (max_uses  IS NULL OR uses < max_uses)`, [ev.id, dados.cupom])
    if (!cupom) throw createError({ statusCode: 422, statusMessage: 'Cupom inválido ou expirado' })
    if (cupom.lot_ids?.length) {
      const vale = dados.itens.every((i) => cupom.lot_ids.includes(i.lotId))
      if (!vale) throw createError({ statusCode: 422, statusMessage: 'Cupom não vale para estes ingressos' })
    }
  }

  let promoter: any = null
  if (dados.promoter) {
    promoter = await q1<any>(
      `SELECT * FROM promoters WHERE event_id = $1 AND upper(code) = upper($2) AND active = true`,
      [ev.id, dados.promoter])
    // promoter inválido não derruba a venda: só não credita ninguém
  }

  const total = somarPedido(linhas, Number(ev.fee_bps), modo,
    cupom ? { kind: cupom.kind, value: Number(cupom.value) } : undefined)

  // -------------------------- 4. teto por CPF (evento → setor → tipo) -----
  await conferirTetoPorDocumento(ev, dados.itens, documento, porLote, porTipo)

  // --------------------- 5. transação: reserva + grava pedido -------------
  const codigo = gerarCodigo('PED')
  const expiraEm = new Date(Date.now() + Number(ev.hold_minutes) * 60_000)

  const pedido = await tx(async (c) => {
    await reservar(c, dados.itens.map((i) => ({
      lotId: i.lotId, ticketTypeId: i.ticketTypeId ?? null, quantidade: i.quantidade,
    })), { canal: 'online' })

    const cliente = await c.query(
      `INSERT INTO customers (org_id, name, email, document, phone)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id, email) DO UPDATE
         SET name = EXCLUDED.name,
             document = COALESCE(EXCLUDED.document, customers.document),
             phone = COALESCE(EXCLUDED.phone, customers.phone)
       RETURNING id, asaas_customer_id`,
      [ev.org_id, dados.comprador.nome, dados.comprador.email.toLowerCase(),
       documento, dados.comprador.telefone ?? null])

    const ord = await c.query(
      `INSERT INTO orders (org_id, event_id, customer_id, code, status, channel,
                           face_cents, fee_cents, platform_cents, discount_cents, total_cents,
                           payment_method, installments, promo_code_id, promoter_id, expires_at)
       VALUES ($1,$2,$3,$4,'aguardando_pagamento','online',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, code`,
      [ev.org_id, ev.id, cliente.rows[0].id, codigo,
       total.faceCents, total.feeCents, total.platformCents, total.discountCents, total.totalCents,
       dados.forma === 'pix' ? 'pix' : 'credito', dados.parcelas,
       cupom?.id ?? null, promoter?.id ?? null, expiraEm])

    for (let i = 0; i < dados.itens.length; i++) {
      const it = dados.itens[i]
      const l = total.linhas[i]
      await c.query(
        `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity,
                                  unit_face_cents, unit_fee_cents, unit_total_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [ord.rows[0].id, it.lotId, it.ticketTypeId ?? null, it.quantidade,
         l.faceCents, l.feeCents, l.totalCents])
    }

    if (cupom) await c.query(`UPDATE promo_codes SET uses = uses + 1 WHERE id = $1`, [cupom.id])

    return { id: ord.rows[0].id, code: ord.rows[0].code, customerId: cliente.rows[0].id,
             asaasCustomerId: cliente.rows[0].asaas_customer_id }
  }).catch((e) => {
    if (e instanceof EstoqueInsuficiente) {
      throw createError({ statusCode: 409, statusMessage: e.message,
        data: { tipo: 'estoque', disponivel: e.disponivel } })
    }
    if (e instanceof LoteIndisponivel) {
      throw createError({ statusCode: 409, statusMessage: e.message, data: { tipo: 'lote' } })
    }
    throw e
  })

  // Pedido gratuito (cortesia/100% off) não passa por gateway.
  if (total.totalCents === 0) {
    await confirmarGratuito(pedido.id)
    return { ok: true, pedido: pedido.code, pedidoId: pedido.id, status: 'pago', totalCents: 0 }
  }

  // ----------------------------------- 6. gateway, FORA da transação ------
  const cfg: ConfigAsaas = {
    apiKey: ev.asaas_api_key, environment: ev.asaas_env, walletId: ev.asaas_wallet,
  }

  // Sem chave: em produção isso é indisponibilidade, e o pedido tem que morrer
  // liberando o estoque. Só na máquina, com PAGAMENTO_SIMULADO=1, o fluxo segue
  // por um gateway de mentira pra a tela poder ser exercitada ponta a ponta.
  if (!cfg.apiKey) {
    if (!simulado.ligado()) {
      await desfazer(pedido.id, 'Organização sem Asaas configurado')
      throw createError({ statusCode: 503, statusMessage: 'Pagamento indisponível no momento' })
    }
    return await cobrarSimulado(pedido, ev, total, dados, expiraEm)
  }

  let cobranca: any
  try {
    const asaasCustomer = pedido.asaasCustomerId || await acharOuCriarCliente(cfg, {
      name: dados.comprador.nome, email: dados.comprador.email,
      cpfCnpj: documento, mobilePhone: dados.comprador.telefone,
    })
    if (!pedido.asaasCustomerId) {
      await q(`UPDATE customers SET asaas_customer_id = $2 WHERE id = $1`,
        [pedido.customerId, asaasCustomer])
    }

    cobranca = await criarCobranca(cfg, {
      customer: asaasCustomer,
      billingType: dados.forma === 'pix' ? 'PIX' : 'CREDIT_CARD',
      value: centavosParaReais(total.totalCents),
      dueDate: vencimentoEmDias(1),
      description: `${ev.name} — pedido ${pedido.code}`,
      externalReference: pedido.id,       // é isto que liga o webhook ao pedido
      installmentCount: dados.parcelas > 1 ? dados.parcelas : undefined,
    })
  } catch (e: any) {
    // Gateway caiu: devolve o estoque na hora. Sem isso, cada erro do Asaas
    // queima ingresso que ninguém comprou até a varredura de expirados passar.
    await desfazer(pedido.id, `Asaas: ${e.message}`)
    throw createError({ statusCode: 502, statusMessage: 'Não foi possível gerar a cobrança. Tente de novo.' })
  }

  let pix: { encodedImage?: string; payload?: string } | null = null
  if (dados.forma === 'pix') {
    try { pix = await qrCodePix(cfg, cobranca.id) } catch { pix = null }
  }

  await q(
    `UPDATE orders SET asaas_payment_id = $2, pix_payload = $3, pix_qr_base64 = $4
      WHERE id = $1`,
    [pedido.id, cobranca.id, pix?.payload ?? null, pix?.encodedImage ?? null])

  return {
    ok: true,
    pedido: pedido.code,
    pedidoId: pedido.id,
    status: 'aguardando_pagamento',
    expiraEm: expiraEm.toISOString(),
    totalCents: total.totalCents,
    faceCents: total.faceCents,
    feeCents: total.feeCents,
    descontoCents: total.discountCents,
    pagamento: {
      forma: dados.forma,
      pixPayload: pix?.payload ?? null,
      pixQrBase64: pix?.encodedImage ?? null,
      linkFatura: cobranca.invoiceUrl ?? null,
    },
  }
})

/**
 * Mesmo retorno do caminho real, com cobrança de mentira. Fica numa função
 * separada pra o caminho de produção acima continuar legível sem `if` de
 * ambiente no meio.
 */
async function cobrarSimulado(
  pedido: any, ev: any, total: any, dados: any, expiraEm: Date,
) {
  const cobranca = await simulado.criarCobrancaSimulada({
    value: centavosParaReais(total.totalCents),
    description: `${ev.name} — pedido ${pedido.code}`,
    externalReference: pedido.id,
  })
  const pix = dados.forma === 'pix'
    ? await simulado.pixSimulado(centavosParaReais(total.totalCents), pedido.code)
    : null

  await q(
    `UPDATE orders SET asaas_payment_id = $2, pix_payload = $3, pix_qr_base64 = $4
      WHERE id = $1`,
    [pedido.id, cobranca.id, pix?.payload ?? null, pix?.encodedImage ?? null])

  return {
    ok: true,
    pedido: pedido.code,
    pedidoId: pedido.id,
    status: 'aguardando_pagamento',
    expiraEm: expiraEm.toISOString(),
    totalCents: total.totalCents,
    faceCents: total.faceCents,
    feeCents: total.feeCents,
    descontoCents: total.discountCents,
    simulado: true,
    pagamento: {
      forma: dados.forma,
      pixPayload: pix?.payload ?? null,
      pixQrBase64: pix?.encodedImage ?? null,
      linkFatura: null,
    },
  }
}

/** Desfaz pedido que não virou cobrança: libera estoque e marca como falhou. */
async function desfazer(orderId: string, motivo: string) {
  await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT lot_id AS "lotId", ticket_type_id AS "ticketTypeId", quantity AS quantidade
         FROM order_items WHERE order_id = $1`, [orderId])
    await liberar(c, rows)
    await c.query(
      `UPDATE orders SET status = 'falhou', canceled_at = now() WHERE id = $1`, [orderId])
    await c.query(
      `INSERT INTO audit_log (entity, entity_id, action, after)
       VALUES ('order', $1, 'falhou', $2::jsonb)`,
      [orderId, JSON.stringify({ motivo })])
  })
}

async function confirmarGratuito(orderId: string) {
  const { emitirIngressos } = await import('../utils/emissao')
  await emitirIngressos(orderId)
}

/**
 * Teto de compra por CPF, na cascata evento → setor → tipo.
 * A regra mais específica ganha, que é como a Zig faz e é o que o produtor
 * espera: "no evento pode 10, mas deste camarote só 2".
 */
async function conferirTetoPorDocumento(
  ev: any, itens: any[], documento: string,
  porLote: Map<string, any>, porTipo: Map<string, any>,
) {
  const jaTem = await q1<any>(
    `SELECT COALESCE(SUM(oi.quantity), 0)::int AS n
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
       JOIN customers c ON c.id = o.customer_id
      WHERE o.event_id = $1 AND c.document = $2
        AND o.status IN ('pago','aguardando_pagamento','em_analise')`,
    [ev.id, documento])
  const compradoAntes = Number(jaTem?.n ?? 0)
  const agora = itens.reduce((s, i) => s + i.quantidade, 0)

  if (ev.max_per_customer && compradoAntes + agora > ev.max_per_customer) {
    throw createError({ statusCode: 422,
      statusMessage: `Limite de ${ev.max_per_customer} ingressos por CPF neste evento` })
  }

  // setor
  const porSetor = new Map<string, number>()
  for (const i of itens) {
    const l = porLote.get(i.lotId)
    porSetor.set(l.sector_id, (porSetor.get(l.sector_id) ?? 0) + i.quantidade)
  }
  if (porSetor.size) {
    const setores = await q<any>(
      `SELECT id, name, max_per_customer FROM sectors WHERE id = ANY($1::uuid[])`,
      [[...porSetor.keys()]])
    for (const s of setores) {
      const n = porSetor.get(s.id)!
      if (s.max_per_customer && n > s.max_per_customer) {
        throw createError({ statusCode: 422,
          statusMessage: `Máximo de ${s.max_per_customer} por CPF no setor ${s.name}` })
      }
    }
  }

  // tipo (sobrepõe os de cima)
  for (const i of itens) {
    if (!i.ticketTypeId) continue
    const t = porTipo.get(i.ticketTypeId)
    if (t?.max_per_customer && i.quantidade > t.max_per_customer) {
      throw createError({ statusCode: 422,
        statusMessage: `Máximo de ${t.max_per_customer} por CPF em ${t.name}` })
    }
  }
}

// Re-exportado porque o balcão e os testes já importavam daqui. A regra em si
// mora em utils/documento.ts, uma cópia só pros dois caixas.
export { cpfValido }
