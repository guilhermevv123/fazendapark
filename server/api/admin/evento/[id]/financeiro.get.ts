/**
 * GET /api/admin/evento/:id/financeiro — transferências do evento.
 *
 * As quatro caixas de cima respondem, nesta ordem, as quatro perguntas que o
 * produtor faz:
 *
 *   Total líquido          o que é meu (face das vendas pagas, menos estorno)
 *   Valor retido           o que ainda não posso sacar, e até quando
 *   Transferido            o que já saiu
 *   Disponível             o que dá pra sacar AGORA
 *
 * A regra da retenção é a parte que gera ligação: o dinheiro do ingresso só
 * libera depois que o evento acontece (aqui, fim do evento + 2 dias). Não é
 * capricho — antes disso, um cancelamento de evento significa devolver tudo, e
 * o dinheiro precisa estar em pé pra isso. Uma plataforma que libera antes
 * devolve do próprio bolso quando o show não acontece.
 *
 * Por isso a data de liberação vem na resposta: "retido" sem "até quando" é o
 * que faz o produtor ligar.
 */
import { q, q1 } from '../../../../utils/db'
import { DIAS_DE_RETENCAO, SQL_LIBERA_EM } from '../../../../utils/retencao'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const ev = await q1<any>(
    `SELECT id, name, org_id, status, starts_at, ends_at,
            ${SQL_LIBERA_EM()} AS libera_em,
            (now() >= ${SQL_LIBERA_EM()}) AS liberado
       FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  // A taxa de serviço não é do produtor — mas descontá-la da face só acerta
  // quando ela foi repassada ao comprador. Quando é absorvida (padrão do
  // balcão), a face já inclui a taxa que vai sair dele. A conta que vale nos
  // dois casos mora em `utils/liquido.ts`; aqui ela é só somada.
  const v = await q1<any>(
    `SELECT ${SQL_LIQUIDO()}                                                        AS liquido,
            COALESCE(SUM(face_cents) FILTER (WHERE status = 'pago'), 0)::bigint     AS bruto,
            COALESCE(SUM(discount_cents) FILTER (WHERE status = 'pago'), 0)::bigint AS descontos,
            COALESCE(SUM(refunded_cents), 0)::bigint                                AS estornado,
            COALESCE(SUM(fee_cents) FILTER (WHERE status = 'pago'), 0)::bigint      AS taxas,
            count(*) FILTER (WHERE status = 'pago')::int                            AS pedidos_pagos
       FROM orders WHERE event_id = $1`, [id])

  const liquido = Number(v.liquido)

  const t = await q1<any>(
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status = 'concluida'), 0)::bigint AS concluido,
            COALESCE(SUM(amount_cents) FILTER (WHERE status IN ('solicitada','processando')), 0)::bigint AS em_curso,
            count(*)::int AS total
       FROM payouts WHERE event_id = $1`, [id])

  const transferido = Number(t.concluido)
  const emCurso = Number(t.em_curso)
  // Retido é tudo enquanto o prazo não vence. Depois, zero — o que sobra do
  // líquido já transferido é o disponível.
  const retido = ev.liberado ? 0 : Math.max(liquido - transferido - emCurso, 0)
  const disponivel = Math.max(liquido - transferido - emCurso - retido, 0)

  const lista = await q<any>(
    `SELECT p.id, p.code, p.beneficiary_name, p.beneficiary_doc, p.destination_kind,
            p.destination, p.amount_cents, p.fee_cents, p.status, p.requested_at,
            p.processed_at, p.error, p.notes, p.asaas_transfer_id,
            u.name AS pedido_por, u.email AS pedido_por_email
       FROM payouts p
       LEFT JOIN users u ON u.id = p.requested_by
      WHERE p.event_id = $1
      ORDER BY p.requested_at DESC
      LIMIT 200`, [id])

  return {
    evento: {
      id: ev.id, nome: ev.name, status: ev.status,
      fim: ev.ends_at, liberaEm: ev.libera_em, liberado: ev.liberado,
      diasDeRetencao: DIAS_DE_RETENCAO,
    },
    resumo: {
      brutoCents: Number(v.bruto),
      descontosCents: Number(v.descontos),
      estornadoCents: Number(v.estornado),
      taxasCents: Number(v.taxas),
      liquidoCents: liquido,
      retidoCents: retido,
      transferidoCents: transferido,
      emCursoCents: emCurso,
      disponivelCents: disponivel,
      pedidosPagos: v.pedidos_pagos,
      transferencias: t.total,
    },
    transferencias: lista.map((p) => ({
      id: p.id, codigo: p.code,
      beneficiario: p.beneficiary_name, documento: p.beneficiary_doc,
      destinoTipo: p.destination_kind,
      // A chave sai MASCARADA na listagem. Chave pix inteira numa tela que
      // qualquer operador abre é vazamento de dado de quem recebe — quem
      // precisa do valor cheio abre o detalhe, que exige papel financeiro.
      destino: mascarar(p.destination, p.destination_kind),
      valorCents: Number(p.amount_cents), taxaCents: Number(p.fee_cents),
      status: p.status,
      pedidoPor: p.pedido_por, pedidoPorEmail: p.pedido_por_email,
      pedidoEm: p.requested_at, processadoEm: p.processed_at,
      erro: p.error, observacao: p.notes,
      idNoGateway: p.asaas_transfer_id,
    })),
  }
})

/** Mostra as pontas e come o meio: `joao@email.com` → `jo…@email.com`. */
function mascarar(v: string, tipo: string): string {
  const s = String(v || '')
  if (tipo === 'conta') return s.replace(/\d(?=\d{2})/g, '•')
  if (s.includes('@')) {
    const [u, d] = s.split('@')
    return `${u.slice(0, 2)}${'•'.repeat(Math.max(u.length - 2, 1))}@${d}`
  }
  if (s.length <= 6) return s
  return `${s.slice(0, 3)}${'•'.repeat(s.length - 6)}${s.slice(-3)}`
}
