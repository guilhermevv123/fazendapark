/**
 * GET /api/admin/pedido/:id — a ficha do pedido, do lado de quem atende.
 *
 * Diferente da rota pública do comprador em duas coisas que importam:
 * o e-mail e o documento vêm INTEIROS (quem atende precisa conferir com a
 * pessoa ao telefone), e vem o histórico bruto do gateway — cada evento que
 * o Asaas mandou, na ordem. É esse histórico que responde "o cliente jura
 * que pagou": ou tem o evento de pagamento, ou não tem.
 *
 * ## O TERCEIRO leitor de `is_courtesy` — este aqui
 *
 * Participantes e a tela do comprador já param de confundir "fechou em zero"
 * com "é cortesia"; esta ficha ainda devolvia `cortesia: t.is_courtesy` cru, e
 * é ela que o atendente abre com o cliente ao telefone. Medido antes do
 * conserto, num pedido ONLINE com cupom de 100% (face 4000, desconto 4000,
 * total 0): `ingressos[0].cortesia = true`. O atendente lia CORTESIA no
 * ingresso de quem comprou com o cupom que ganhou — e é essa tela que ele usa
 * pra responder "eu paguei ou me deram?".
 *
 * A régua é a mesma da casa (`utils/emissao.ts`), aplicada com o pedido que já
 * está na mão — o canal dele decide, não o valor. E como aqui os dois recortes
 * particionam o que saiu de graça, a ficha devolve os DOIS campos, nunca
 * verdade juntos: `cortesia` (saiu pela porta da cortesia) e `gratuito`
 * (é VENDA, e ela deu zero: promoção de 100%, criança, lote de R$ 0).
 *
 * `origemNaoRegistrada` não existe nesta rota de propósito: os ingressos vêm
 * todos por `t.order_id = <este pedido>`, então origem aqui sempre existe.
 */
import { q, q1 } from '../../../utils/db'
import { eCortesia } from '../../../utils/emissao'
import { avaliarArrependimento } from '../../../utils/cancelamento'
import { ehPapel, papelPode } from '../../../utils/papeis'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!

  const uuid = /^[0-9a-f-]{36}$/i.test(id)
  const pedido = await q1<any>(
    `SELECT o.*, c.name AS cliente, c.email, c.document, c.phone,
            e.name AS evento_nome, e.id AS evento_id, e.starts_at AS evento_comeca,
            e.status AS evento_status,
            t.status AS turno_status, pt.name AS ponto
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       JOIN events e ON e.id = o.event_id
       LEFT JOIN pos_shifts t ON t.id = o.pos_shift_id
       LEFT JOIN pos_terminals pt ON pt.id = t.terminal_id
      WHERE ${uuid ? 'o.id = $1' : 'upper(o.code) = upper($1)'}`, [id])
  if (!pedido) throw createError({ statusCode: 404, statusMessage: 'Pedido não encontrado' })

  const itens = await q<any>(
    `SELECT oi.quantity, oi.unit_face_cents, oi.unit_fee_cents, oi.unit_total_cents,
            l.name AS lote, s.name AS setor, tt.name AS tipo
       FROM order_items oi
       JOIN lots l ON l.id = oi.lot_id
       JOIN sectors s ON s.id = l.sector_id
       LEFT JOIN ticket_types tt ON tt.id = oi.ticket_type_id
      WHERE oi.order_id = $1
      ORDER BY s.sort_order, l.sort_order`, [pedido.id])

  const ingressos = await q<any>(
    `SELECT t.id, t.code, t.status, t.holder_name, t.holder_document,
            t.checked_in_at, t.is_courtesy,
            s.name AS setor, l.name AS lote, tt.name AS tipo,
            u.name AS validado_por
       FROM tickets t
       JOIN sectors s ON s.id = t.sector_id
       JOIN lots l ON l.id = t.lot_id
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN users u ON u.id = t.checked_in_by
      WHERE t.order_id = $1
      ORDER BY s.sort_order, t.issued_at`, [pedido.id])

  // As colunas são event_name/created_at. Chutar nome de coluna já custou um
  // 500 em toda consulta de pedido pago neste mesmo projeto — confira no \d.
  const eventos = await q<any>(
    `SELECT id, event_name, created_at, processed_at, error, payload
       FROM payment_events WHERE order_id = $1 ORDER BY created_at`, [pedido.id])

  // ------------------------------------------ o que dá pra fazer com ele
  //
  // A ficha diz ANTES do clique se o pedido pode ser cancelado e por qual
  // caminho — a rota recusa com a mesma frase, mas descobrir depois do clique
  // é o operador tentando três vezes com o cliente no telefone.
  const papel = (event.context as any).papel
  const podeDinheiro = ehPapel(papel) && papelPode(papel, 'dinheiro')
  const vivo = pedido.status === 'pago' || pedido.status === 'estornado_parcial'
  const entraram = ingressos.filter((t) => t.checked_in_at || t.status === 'usado').length
  const validos = ingressos.filter((t) => t.status === 'valido').length
  const caixaAberto = !!pedido.pos_shift_id && pedido.turno_status === 'aberto'
  const aDevolverCents = Number(pedido.total_cents) - Number(pedido.refunded_cents)

  // Tentativa anterior cujo estorno não saiu: ingressos já mortos, pedido
  // ainda 'pago'. O botão vira "tentar a devolução de novo".
  const tentativa = vivo && validos === 0 && ingressos.length > 0
    ? await q1<any>(
        `SELECT 1 FROM audit_log WHERE entity = 'order' AND entity_id = $1
            AND action = 'pedido_cancelado_admin' LIMIT 1`, [pedido.id])
    : null

  let impedimento: string | null = null
  if (!vivo) {
    impedimento = pedido.status === 'cancelado' || pedido.status === 'estornado'
      ? 'Este pedido já foi cancelado.'
      : 'Só pedido pago pode ser cancelado.'
  } else if (pedido.evento_status === 'cancelado') {
    impedimento = 'O evento foi cancelado: a devolução deste pedido sai pela fila do evento.'
  } else if (entraram > 0) {
    impedimento = `${entraram} ingresso(s) já entraram no parque — o acerto é com o gerente.`
  } else if (caixaAberto) {
    impedimento = `O caixa desta venda (${pedido.ponto ?? 'guichê'}) ainda está aberto: `
      + 'cancele pela Conferência de caixa desse ponto.'
  } else if (!podeDinheiro) {
    impedimento = 'Cancelar pedido é do financeiro ou do dono da conta.'
  }

  const arrependimento = avaliarArrependimento({
    canal: pedido.channel, status: pedido.status,
    compradoEm: pedido.paid_at ?? pedido.created_at,
    eventoComecaEm: pedido.evento_comeca, aDevolverCents,
  })

  return {
    acoes: {
      /** quem pode tocar no botão de cancelar agora; senão, `impedimento` diz por quê */
      cancelar: !impedimento,
      impedimento,
      /** a desistência do comprador (CDC art. 49) vale para este pedido? */
      arrependimento: arrependimento.disponivel,
      arrependimentoMotivo: arrependimento.motivo,
      /** houve cancelamento cuja devolução pelo banco não saiu */
      devolucaoPendente: !!tentativa,
      aDevolverCents: Math.max(aDevolverCents, 0),
      passouPelaPlataforma: !!pedido.asaas_payment_id,
      /** fichas do balcão e reenvio por e-mail só fazem sentido com ingresso valendo */
      reimprimir: vivo && validos > 0,
      reenviar: vivo && validos > 0,
    },
    pedido: {
      id: pedido.id, codigo: pedido.code, situacao: pedido.status, canal: pedido.channel,
      forma: pedido.payment_method, parcelas: pedido.installments,
      faceCents: Number(pedido.face_cents), taxaCents: Number(pedido.fee_cents),
      descontoCents: Number(pedido.discount_cents), totalCents: Number(pedido.total_cents),
      estornadoCents: Number(pedido.refunded_cents),
      criadoEm: pedido.created_at, pagoEm: pedido.paid_at,
      canceladoEm: pedido.canceled_at, estornadoEm: pedido.refunded_at,
      expiraEm: pedido.expires_at,
      idNoGateway: pedido.asaas_payment_id,
      eventoId: pedido.evento_id, eventoNome: pedido.evento_nome,
      ponto: pedido.ponto ?? null,
      caixaAberto,
    },
    cliente: {
      nome: pedido.cliente, email: pedido.email,
      documento: pedido.document, telefone: pedido.phone,
    },
    itens: itens.map((i) => ({
      setor: i.setor, lote: i.lote, tipo: i.tipo, quantidade: i.quantity,
      faceCents: Number(i.unit_face_cents), taxaCents: Number(i.unit_fee_cents),
      totalCents: Number(i.unit_total_cents),
      somaCents: Number(i.unit_total_cents) * i.quantity,
    })),
    ingressos: ingressos.map((t) => {
      // `is_courtesy` é só "o pedido fechou em zero". Quem decide é a ORIGEM,
      // e o pedido já está lido aqui — então é a régua em TypeScript, a mesma
      // que a tela do comprador usa sobre o MESMO ingresso.
      const cortesia = eCortesia(t.is_courtesy, pedido.channel)
      return {
        id: t.id, codigo: t.code, situacao: t.status, titular: t.holder_name,
        documento: t.holder_document, entrouEm: t.checked_in_at, validadoPor: t.validado_por,
        cortesia,
        /** saiu de graça, mas é VENDA: promoção de 100%, criança, lote R$ 0 */
        gratuito: Boolean(t.is_courtesy) && !cortesia,
        setor: t.setor, lote: t.lote, tipo: t.tipo,
      }
    }),
    gateway: eventos.map((e) => ({
      id: e.id, tipo: e.event_name, em: e.created_at,
      processadoEm: e.processed_at, erro: e.error,
      // só o miolo: o payload cru tem centenas de campos que ninguém lê
      resumo: {
        valor: e.payload?.payment?.value ?? e.payload?.value ?? null,
        situacao: e.payload?.payment?.status ?? e.payload?.status ?? null,
      },
    })),
  }
})
