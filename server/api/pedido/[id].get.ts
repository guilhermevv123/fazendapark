/**
 * GET /api/pedido/:id — estado do pedido e, se pago, os ingressos.
 *
 * Aceita o UUID (que a tela de pagamento tem na mão) ou o código PED-XXXX (que
 * o comprador tem no e-mail). São a mesma coisa pra quem consulta; separar em
 * duas rotas só obrigaria a tela a saber qual dos dois ela guardou.
 *
 * Não exige login de propósito: o código é a credencial. Por isso ele é
 * aleatório e longo, e por isso esta rota devolve o e-mail mascarado — quem
 * chuta um código não descobre de quem ele é.
 *
 * ## "Cortesia" aqui é a origem do pedido, não o valor
 *
 * O campo saía de `tickets.is_courtesy`, que quer dizer "o pedido fechou em
 * zero". Quem comprou com cupom de 100% e quem levou a criança de 4 anos
 * recebiam, na própria tela do pedido, um ingresso escrito CORTESIA — e o
 * comprador que usou o cupom que ele ganhou merecidamente lê ali que alguém
 * lhe deu esmola. Pior no sentido inverso: em evento com meia/gratuidade por
 * idade, "cortesia" no ingresso é o que a fiscalização de meia-entrada cobra
 * explicação.
 *
 * Agora vêm dois campos separados, e eles nunca são verdade juntos:
 * `cortesia` (saiu pela porta da cortesia) e `gratuito` (é venda, e ela deu
 * zero). A régua é a mesma de `utils/emissao.ts`, a mesma do borderô e a
 * mesma de Participantes — a tela do comprador não pode divergir do
 * relatório do produtor sobre o mesmo ingresso.
 *
 * ## Por que `customers` entra por LEFT JOIN
 *
 * `orders.customer_id` é opcional (a FK é `ON DELETE SET NULL`), e a CORTESIA
 * nunca tem comprador: quem recebe o convite não preencheu formulário nenhum
 * — o nome dele está no INGRESSO. Com o `JOIN` comum, o pedido sumia da
 * consulta e esta rota respondia **"Pedido não encontrado"** pro link que o
 * próprio sistema mandou, sem exceção, sem log e sem teste vermelho.
 *
 * Medido no banco antes do conserto: 8 pedidos vivos sem comprador (1
 * cortesia, 3 de balcão, 4 online) — todos com 404 na cara de quem tinha o
 * código na mão, enquanto um pedido igualzinho COM comprador abria em 200. O
 * convidado do patrocinador caía nisso sempre, por construção.
 */
import { q, q1 } from '../../utils/db'
import { montarQr } from '../../utils/ingresso'
import { CANAL_CORTESIA, eCortesia } from '../../utils/emissao'
import { PEDIDO_VIVO } from '../../utils/liquido'
import { conferirFreio, marcarNoFreio } from '../../utils/sessao'
import { qrCodePix } from '../../utils/asaas'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let avisouSemChave = false

/**
 * O QR do ingresso, ou `null` quando não há chave pra assinar. Sem chave a
 * rota inteira dava 500 — e o comprador perdia até o CÓDIGO, que a portaria
 * aceita digitado. A falta da chave grita no boot e em `/api/saude`.
 */
function qrOuNada(code: string, eventId: string): string | null {
  try {
    return montarQr(code, eventId)
  } catch (e: any) {
    if (!avisouSemChave) {
      avisouSemChave = true
      console.error(`[pedido] QR sem assinatura: ${e?.message ?? e}`)
    }
    return null
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'pedido ausente' })

  // B15: o código PED-XXXX-XXXX é a credencial, e 404 × 200 sem freio deixava
  // chutar à vontade. Só a consulta por CÓDIGO entra no balde — o UUID (que a
  // tela de pagamento consulta a cada 4 s) não é adivinhável, e frear a
  // consulta dele seria derrubar o relógio da cobrança de quem está pagando.
  const porCodigo = !UUID.test(id)
  if (porCodigo) conferirFreio(event, 'pedido_404')

  const o = await q1<any>(
    `SELECT o.id, o.code, o.status, o.face_cents, o.fee_cents, o.discount_cents,
            o.total_cents, o.refunded_cents, o.payment_method, o.installments,
            o.expires_at, o.channel, o.created_at, o.paid_at, o.pix_payload, o.pix_qr_base64,
            o.invoice_url, o.asaas_payment_id, o.org_id,
            (${PEDIDO_VIVO('o.')}) AS vivo,
            c.name AS comprador, c.email,
            e.id AS event_id, e.name AS evento, e.slug, e.starts_at, e.ticket_noun,
            e.venue_name, e.city, e.state, e.banner_url, e.timezone,
            -- Volte Mais (037): o retorno com desconto leva o selo da consumação no ingresso
            (SELECT json_build_object('nome', lp.nome, 'consumacao_bps', lp.consumacao_bps)
               FROM loyalty_programs lp WHERE lp.id = o.loyalty_program_id) AS fidelidade
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       JOIN events e ON e.id = o.event_id
      WHERE ${porCodigo ? 'upper(o.code) = upper($1)' : 'o.id = $1'}`, [id])
  if (!o) {
    if (porCodigo) marcarNoFreio(event, 'pedido_404')
    throw createError({ statusCode: 404, statusMessage: 'Pedido não encontrado' })
  }

  // PIX do plano B (Asaas) que nasceu sem QR: o Asaas às vezes ainda não gerou o QR no segundo da
  // cobrança, e o checkout aceita isso (`pix` nulo). A tela ficava em "O QR está sendo gerado"
  // PARA SEMPRE — ninguém perguntava de novo. A consulta que a tela faz a cada 4 s pergunta, com
  // freio: no máximo uma vez a cada 15 s por pedido (o Asaas tem cota, e a tela de quem esqueceu a
  // aba aberta não pode gastá-la).
  if (o.status === 'aguardando_pagamento' && o.payment_method === 'pix' && !o.pix_payload
      && o.asaas_payment_id && !String(o.asaas_payment_id).startsWith('sim_')) {
    Object.assign(o, await buscarQrDeNovo(o))
  }

  const itens = await q<any>(
    `SELECT oi.quantity, oi.unit_face_cents, oi.unit_fee_cents, oi.unit_total_cents,
            l.name AS lote, s.name AS setor, tt.name AS tipo
       FROM order_items oi
       JOIN lots l ON l.id = oi.lot_id
       JOIN sectors s ON s.id = l.sector_id
       LEFT JOIN ticket_types tt ON tt.id = oi.ticket_type_id
      WHERE oi.order_id = $1`, [o.id])

  // QR só existe pra pedido com a venda de pé. Emitir a imagem antes disso
  // seria entregar ingresso válido a quem ainda não pagou.
  //
  // A régua é `PEDIDO_VIVO` (utils/liquido.ts), não `status = 'pago'` (B01): o
  // estorno PARCIAL grava `estornado_parcial`, devolve parte do dinheiro e NÃO
  // cancela ingresso nenhum (o valor devolvido não diz qual). Recortar por
  // 'pago' sumia com os ingressos que continuavam valendo — a tela dizia "ainda
  // não foi pago" e o PNG do QR dava 404, com a portaria aceitando o código.
  const ingressos = o.vivo
    ? (await q<any>(
        // `transferido`: o ingresso segue ligado a ESTE pedido (é o pedido de
        // quem comprou), mas passou pra outra pessoa por transferência aceita.
        // `tickets.status` continua 'valido' de propósito — é o destinatário
        // que entra com ele —, então quem responde "ainda é deste comprador?"
        // é a transferência concluída. Cancelar a transferência a tira de
        // 'concluido', e o ingresso volta a aparecer aqui.
        `SELECT t.id, t.code, t.status, t.holder_name, t.checked_in_at, t.is_courtesy,
                EXISTS (SELECT 1 FROM ticket_transfers tr
                         WHERE tr.ticket_id = t.id AND tr.status = 'concluido') AS transferido,
                l.name AS lote, s.name AS setor, tt.name AS tipo,
                ses.title AS sessao, ses.starts_at AS sessao_inicio,
                -- reagendado pelo cliente (036): o pedido novo que substituiu este ingresso
                (SELECT o2.code FROM orders o2 WHERE o2.rescheduled_from_ticket_id = t.id) AS reagendado_para
           FROM tickets t
           JOIN lots l ON l.id = t.lot_id
           JOIN sectors s ON s.id = l.sector_id
           LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
           LEFT JOIN event_sessions ses ON ses.id = s.session_id
          WHERE t.order_id = $1
          ORDER BY s.sort_order, t.issued_at`, [o.id]))
        .map((t) => {
          const status = t.transferido && t.status === 'valido' ? 'transferido' : t.status
          // QR (e o código legível, que a portaria aceita digitado) só pro
          // ingresso que ENTRA por este pedido. Ingresso cancelado não tem o
          // que mostrar; o transferido é de outra pessoa agora — mostrar o QR
          // dele aqui era deixar o remetente e o destinatário entrarem os dois.
          const entra = status === 'valido'
          return {
            id: t.id, codigo: status === 'transferido' ? null : t.code, status,
            titular: t.holder_name,
            // `is_courtesy` sozinho é "fechou em zero"; a origem é quem decide.
            // Aqui o pedido está na mão, então não há consulta a fazer — é a
            // mesma conta de `SQL_E_CORTESIA`, feita em TypeScript.
            cortesia: eCortesia(t.is_courtesy, o.channel),
            /** saiu de graça, mas é VENDA: promoção de 100%, criança, lote R$ 0 */
            gratuito: Boolean(t.is_courtesy) && !eCortesia(t.is_courtesy, o.channel),
            usadoEm: t.checked_in_at, setor: t.setor, lote: t.lote, tipo: t.tipo,
            sessao: t.sessao, sessaoInicio: t.sessao_inicio,
            /** código do pedido novo quando o cliente trocou este ingresso de dia */
            reagendadoPara: t.reagendado_para ?? null,
            qr: entra ? qrOuNada(t.code, o.event_id) : null,
          }
        })
    : []

  // PIX pago depois do prazo e sem lugar pra refazer a reserva (ver
  // `emissao.ts`). O pedido segue 'expirado', mas ENTROU dinheiro: a tela não
  // pode mandar essa pessoa "escolher de novo" e pagar duas vezes.
  const pagoSemIngresso = o.status === 'expirado' && !!(await q1<any>(
    `SELECT 1 FROM audit_log
      WHERE entity = 'order' AND entity_id = $1::text AND action = 'pago_sem_lugar'
      LIMIT 1`, [o.id]))

  return {
    pedido: o.code,
    pedidoId: o.id,
    status: o.status,
    criadoEm: o.created_at,
    pagoEm: o.paid_at,
    expiraEm: o.expires_at,
    faceCents: Number(o.face_cents),
    feeCents: Number(o.fee_cents),
    descontoCents: Number(o.discount_cents),
    totalCents: Number(o.total_cents),
    /** o que já voltou pro comprador — o estorno parcial mostra isto ao lado dos ingressos */
    estornadoCents: Number(o.refunded_cents ?? 0),
    formaDePagamento: o.payment_method,
    /** fuso do evento: a tela escreve a data na hora do PARQUE, não na do navegador */
    fuso: o.timezone ?? 'America/Bahia',
    /**
     * Do PEDIDO, não do ingresso — e as duas nunca são verdade juntas.
     * `gratuito` é o que a tela precisa pra escrever "você não paga nada" sem
     * chamar de cortesia a compra que a pessoa fez com o cupom dela.
     */
    cortesia: o.channel === CANAL_CORTESIA,
    /** Volte Mais (037): pedido de retorno com desconto — o ingresso mostra o selo da consumação */
    fidelidade: o.fidelidade ? { nome: o.fidelidade.nome, consumacaoPct: Number(o.fidelidade.consumacao_bps) / 100 } : null,
    gratuito: Number(o.total_cents) === 0 && o.channel !== CANAL_CORTESIA,
    // Sem comprador é ausência, não string vazia: `null` deixa a tela escolher
    // o que escrever (no convite, o nome de quem recebe está no INGRESSO).
    // E `mascarar(null)` estourava — o TypeError vinha só quando o pedido sem
    // comprador finalmente chegasse aqui, que é o dia em que o JOIN parasse
    // de esconder o caso.
    comprador: { nome: o.comprador ?? null, email: o.email ? mascarar(o.email) : null },
    evento: {
      nome: o.evento, slug: o.slug, inicio: o.starts_at, substantivo: o.ticket_noun,
      local: o.venue_name, cidade: o.city, estado: o.state, banner: o.banner_url,
    },
    itens: itens.map((i) => ({
      quantidade: i.quantity, setor: i.setor, lote: i.lote, tipo: i.tipo,
      unitFaceCents: Number(i.unit_face_cents),
      unitTotalCents: Number(i.unit_total_cents),
    })),
    // `linkFatura` (B08): a fatura do cartão ficava só na memória da aba que
    // pagou. Quem fechava a aba — ou abria o link do pedido no celular — não
    // achava como pagar, e a reserva ficava presa até vencer.
    pagamento: o.status === 'aguardando_pagamento'
      ? {
          forma: o.payment_method, pixPayload: o.pix_payload, pixQrBase64: o.pix_qr_base64,
          linkFatura: o.invoice_url ?? null,
        }
      : null,
    ingressos,
    pagoSemIngresso,
  }
})

/** Quando cada pedido perguntou o QR pela última vez (por processo — o freio é de cota, não de segurança). */
const perguntouQr = new Map<string, number>()
export const INTERVALO_QR_MS = 15_000

async function buscarQrDeNovo(o: any): Promise<{ pix_payload?: string; pix_qr_base64?: string }> {
  const agora = Date.now()
  if ((perguntouQr.get(o.id) ?? 0) > agora - INTERVALO_QR_MS) return {}
  perguntouQr.set(o.id, agora)
  if (perguntouQr.size > 5000) {
    for (const [id, quando] of perguntouQr) if (quando < agora - INTERVALO_QR_MS) perguntouQr.delete(id)
  }
  try {
    const org = await q1<any>(
      `SELECT asaas_api_key, asaas_env, asaas_wallet FROM organizations WHERE id = $1`, [o.org_id])
    if (!org?.asaas_api_key) return {}
    const pix = await qrCodePix(
      { apiKey: org.asaas_api_key, environment: org.asaas_env, walletId: org.asaas_wallet },
      String(o.asaas_payment_id))
    if (!pix?.payload) return {}
    // `pix_payload IS NULL`: duas consultas ao mesmo tempo não brigam, e um QR já gravado não é trocado
    await q(`UPDATE orders SET pix_payload = $2, pix_qr_base64 = $3 WHERE id = $1 AND pix_payload IS NULL`,
      [o.id, pix.payload, pix.encodedImage ?? null])
    return { pix_payload: pix.payload, pix_qr_base64: pix.encodedImage ?? o.pix_qr_base64 }
  } catch (e: any) {
    // gateway fora: a tela segue com o link da fatura, e a próxima consulta (daqui a 15 s) tenta de novo
    console.warn(`[pedido] QR do PIX do pedido ${o.code} ainda não veio do Asaas: ${e?.message ?? e}`)
    return {}
  }
}

/** joao.silva@gmail.com → jo•••••@gmail.com */
function mascarar(email: string) {
  const [u, d] = email.split('@')
  if (!d) return '•••'
  return `${u.slice(0, 2)}${'•'.repeat(Math.max(3, u.length - 2))}@${d}`
}
