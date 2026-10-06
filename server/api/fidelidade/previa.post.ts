/**
 * POST /api/fidelidade/previa { eventSlug, itens } — quanto o "Volte Mais" desconta NESTE carrinho,
 * ANTES de pagar (CDC art. 30–31: o cliente vê o desconto e o limite antes do clique final).
 *
 * É a MESMA decisão do checkout (`beneficioDeFidelidade`, utils/fidelidade.ts), sem trava e sem
 * gravar nada — o checkout decide de novo com a trava do CPF na mão; esta resposta é só a vitrine.
 * Sem conta na sessão: 200 com `disponivel: false` (o carrinho de quem não entrou não é erro).
 */
import { z } from 'zod'
import { db, q, q1 } from '../../utils/db'
import { contaDaSessaoDoCliente } from '../../utils/conta-do-cliente'
import { faceDoTipo, type ModoTaxa } from '../../utils/dinheiro'
import { beneficioDeFidelidade } from '../../utils/fidelidade'
import { regulamentoDaFidelidade } from '../../utils/fidelidade-texto'

const Entrada = z.object({
  eventSlug: z.string().min(1).max(200),
  itens: z.array(z.object({
    lotId: z.string().uuid(),
    ticketTypeId: z.string().uuid().nullable().optional(),
    quantidade: z.number().int().min(1).max(100),
  })).min(1).max(30),
})

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  frearPortaPublica(event, 'cupom')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) throw createError({ statusCode: 400, statusMessage: 'Carrinho inválido.' })

  const ev = await q1<any>(
    `SELECT e.id, e.org_id, e.starts_at, e.timezone, e.fee_bps, e.fee_mode_online, e.status
       FROM events e WHERE e.slug = $1`, [p.data.eventSlug])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const conta = await contaDaSessaoDoCliente(event)
  if (!conta || conta.orgId !== ev.org_id) return { disponivel: false, motivo: 'entre na sua conta' }

  const lotIds = [...new Set(p.data.itens.map((i) => i.lotId))]
  const lotes = await q<any>(
    `SELECT l.id, l.price_cents FROM lots l JOIN sectors s ON s.id = l.sector_id
      WHERE l.id = ANY($1::uuid[]) AND s.event_id = $2`, [lotIds, ev.id])
  const porLote = new Map(lotes.map((l) => [l.id, l]))
  const tipoIds = p.data.itens.map((i) => i.ticketTypeId).filter(Boolean) as string[]
  const tipos = tipoIds.length
    ? await q<any>(`SELECT id, lot_id, discount_bps, price_cents, requires_document FROM ticket_types WHERE id = ANY($1::uuid[])`, [tipoIds])
    : []
  const porTipo = new Map(tipos.map((t) => [t.id, t]))
  const modo: ModoTaxa = ev.fee_mode_online
  const linhas = []
  for (const it of p.data.itens) {
    const l = porLote.get(it.lotId)
    if (!l) return { disponivel: false, motivo: 'lote fora deste evento' }
    const t = it.ticketTypeId ? porTipo.get(it.ticketTypeId) : null
    if (it.ticketTypeId && (!t || t.lot_id !== it.lotId)) return { disponivel: false, motivo: 'tipo de ingresso inválido' }
    const face = t ? faceDoTipo(Number(l.price_cents), Number(t.discount_bps), Number(ev.fee_bps), modo, (t.price_cents == null ? null : Number(t.price_cents))) : Number(l.price_cents)
    linhas.push({ faceUnitCents: face, quantidade: it.quantidade,
                  tipoComDesconto: !!t && (Number(t.discount_bps) > 0 || !!t.requires_document
                    || (t.price_cents != null && Number(t.price_cents) < Number(l.price_cents))) })
  }

  const b = await beneficioDeFidelidade(db(), {
    orgId: ev.org_id, evento: { id: ev.id, inicio: ev.starts_at, fuso: ev.timezone },
    documento: conta.cpf, linhas, temCupom: false,
  })
  if (!b.programa || !b.programa.ativo) return { disponivel: false, motivo: 'sem promoção ativa' }
  const regulamento = b.programa.regulamento || regulamentoDaFidelidade(b.programa)
  if (!b.aplica) return { disponivel: false, nome: b.programa.nome, motivo: b.motivo, regulamento }
  return {
    disponivel: true,
    nome: b.programa.nome,
    descontoCents: b.cents,
    ingressos: b.ingressos,
    descontoPct: b.programa.desconto_bps / 100,
    restantesDepois: b.restantesDepois,
    validoAte: b.validoAte,
    consumacaoPct: b.programa.consumacao_bps / 100,
    regulamento,
  }
})
