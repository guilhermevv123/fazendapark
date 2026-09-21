/**
 * GET /api/admin/financeiro — o caixa da organização inteira.
 *
 * O financeiro do evento responde "quanto sobra DESTE evento". Este responde
 * "quanto a produtora tem a receber, somando tudo" — que é a pergunta de quem
 * paga fornecedor no fim do mês, não a de quem está produzindo um show.
 *
 * A regra de liberação é a MESMA do financeiro por evento, importada de
 * `utils/retencao`. Duas definições de "quando o dinheiro libera" é a receita
 * pra esta tela dizer que tem saldo e a outra dizer que não tem.
 */
import { q, q1 } from '../../utils/db'
import { DIAS_DE_RETENCAO, SQL_LIBERA_EM } from '../../utils/retencao'
import { SQL_LIQUIDO } from '../../utils/liquido'

export default defineEventHandler(async (event) => {
  const orgId = (event.context as any).sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })

  const [porEvento, transferencias, porMes, resumoPagamentos] = await Promise.all([
    q<any>(
      `SELECT e.id, e.name, e.status, e.starts_at, e.ends_at,
              now() > ${SQL_LIBERA_EM('e.ends_at')} AS liberado,
              ${SQL_LIBERA_EM('e.ends_at')} AS libera_em,
              COALESCE(v.face, 0)::bigint      AS face,
              COALESCE(v.taxa, 0)::bigint      AS taxa,
              COALESCE(v.estornado, 0)::bigint AS estornado,
              COALESCE(v.liquido, 0)::bigint   AS liquido,
              COALESCE(v.pedidos, 0)::int      AS pedidos,
              COALESCE(t.transferido, 0)::bigint AS transferido,
              COALESCE(t.em_curso, 0)::bigint    AS em_curso
         FROM events e
         LEFT JOIN LATERAL (
           -- O recorte é por FILTER em cada soma, nunca por um WHERE que vale
           -- pra todas. Enquanto era WHERE status = 'pago', o pedido com
           -- estorno PARCIAL — que o webhook marca 'estornado_parcial' — caía
           -- fora antes de a conta do líquido filtrar: uma devolução de
           -- R$ 20 apagava um pedido de R$ 850 do caixa da organização, e o
           -- estorno em si também sumia da coluna que devia mostrá-lo.
           SELECT SUM(face_cents) FILTER (WHERE status = 'pago')  AS face,
                  SUM(fee_cents)  FILTER (WHERE status = 'pago')  AS taxa,
                  SUM(refunded_cents)                             AS estornado,
                  COUNT(*)        FILTER (WHERE status = 'pago')  AS pedidos,
                  ${SQL_LIQUIDO()} AS liquido
             FROM orders WHERE event_id = e.id
         ) v ON true
         LEFT JOIN LATERAL (
           SELECT SUM(amount_cents) FILTER (WHERE status = 'concluida') AS transferido,
                  SUM(amount_cents) FILTER (WHERE status IN ('solicitada','processando')) AS em_curso
             FROM payouts WHERE event_id = e.id
         ) t ON true
        WHERE e.org_id = $1
        ORDER BY e.starts_at DESC NULLS LAST`, [orgId]),

    q<any>(
      `SELECT p.id, p.code, p.beneficiary_name, p.amount_cents, p.status,
              p.destination_kind, p.requested_at, p.processed_at,
              e.name AS evento, u.name AS pedido_por
         FROM payouts p
         LEFT JOIN events e ON e.id = p.event_id
         LEFT JOIN users u ON u.id = p.requested_by
        WHERE p.org_id = $1
        ORDER BY p.requested_at DESC LIMIT 40`, [orgId]),

    // Competência pelo PAGAMENTO, não pela criação do pedido: o mês em que o
    // dinheiro entrou é o mês que o contador quer ver.
    q<any>(
      `SELECT date_trunc('month', o.paid_at) AS mes,
              COALESCE(SUM(o.face_cents),0)::bigint AS face,
              COALESCE(SUM(o.fee_cents),0)::bigint  AS taxa,
              COUNT(*)::int AS pedidos
         FROM orders o
        WHERE o.org_id = $1 AND o.status = 'pago' AND o.paid_at IS NOT NULL
        GROUP BY 1 ORDER BY 1 DESC LIMIT 18`, [orgId]),

    q<any>(
      `SELECT payment_method AS forma, COUNT(*)::int AS pedidos,
              COALESCE(SUM(total_cents),0)::bigint AS cobrado
         FROM orders WHERE org_id = $1 AND status = 'pago'
        GROUP BY 1 ORDER BY 3 DESC`, [orgId]),
  ])

  let face = 0, taxa = 0, estornado = 0, transferido = 0, emCurso = 0, retido = 0, disponivel = 0
  let somaLiquido = 0
  const eventos = porEvento.map((e) => {
    // conta única em `utils/liquido.ts` — a face cheia mentia sempre que a
    // taxa foi absorvida ou um cupom entrou
    const liquido = Number(e.liquido)
    const t = Number(e.transferido)
    const c = Number(e.em_curso)
    const preso = e.liberado ? 0 : Math.max(liquido - t - c, 0)
    const livre = Math.max(liquido - t - c - preso, 0)

    face += Number(e.face); taxa += Number(e.taxa); estornado += Number(e.estornado)
    somaLiquido += liquido
    transferido += t; emCurso += c; retido += preso; disponivel += livre

    return {
      id: e.id, nome: e.name, status: e.status,
      comeca: e.starts_at, termina: e.ends_at,
      liberado: e.liberado, liberaEm: e.libera_em,
      pedidos: e.pedidos,
      faceCents: Number(e.face), taxaCents: Number(e.taxa),
      estornadoCents: Number(e.estornado), liquidoCents: liquido,
      transferidoCents: t, emCursoCents: c,
      retidoCents: preso, disponivelCents: livre,
    }
  })

  return {
    diasDeRetencao: DIAS_DE_RETENCAO,
    totais: {
      faceCents: face, taxaCents: taxa, estornadoCents: estornado,
      // soma dos líquidos por evento, não uma segunda conta sobre os totais:
      // total que não é a soma das linhas é o jeito clássico de a tela do
      // dinheiro discordar de si mesma
      liquidoCents: somaLiquido,
      transferidoCents: transferido, emCursoCents: emCurso,
      retidoCents: retido, disponivelCents: disponivel,
    },
    eventos,
    porMes: porMes.map((m) => ({
      mes: m.mes, pedidos: m.pedidos,
      faceCents: Number(m.face), taxaCents: Number(m.taxa),
    })),
    porForma: resumoPagamentos.map((f) => ({
      forma: f.forma, pedidos: f.pedidos, cobradoCents: Number(f.cobrado),
    })),
    transferencias: transferencias.map((t) => ({
      id: t.id, codigo: t.code, beneficiario: t.beneficiary_name,
      valorCents: Number(t.amount_cents), status: t.status,
      destinoTipo: t.destination_kind, evento: t.evento, pedidoPor: t.pedido_por,
      solicitadaEm: t.requested_at, processadaEm: t.processed_at,
    })),
  }
})
