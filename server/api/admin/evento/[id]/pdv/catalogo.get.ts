/**
 * GET /api/admin/evento/:id/pdv/catalogo — o que dá pra vender no balcão.
 *
 * O preço aqui é o do BALCÃO, não o do site: a bilheteria usa `fee_mode_pos`,
 * que na prática do parque é "absorver" — quem chega no portão paga o valor
 * de face, redondo, e a taxa sai do produtor. Mostrar o preço online numa
 * tela de guichê faz o operador cobrar errado e o cliente discutir na fila.
 *
 * A tela também recebe os lotes que NÃO são vendidos no balcão, com o motivo.
 * Sem isso o operador procura um ingresso que existe, não acha, e conclui que
 * o sistema está quebrado — quando na verdade ninguém marcou o canal.
 */
import { q, q1 } from '../../../../../utils/db'
import { precificar, type ModoTaxa } from '../../../../../utils/dinheiro'

export default defineEventHandler(async (event) => {
  const eventId = getRouterParam(event, 'id')!

  const ev = await q1<any>(
    `SELECT id, name, fee_bps, fee_mode_pos, status, sales_end_at FROM events WHERE id = $1`,
    [eventId])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const linhas = await q<any>(
    `SELECT l.id, l.name, l.price_cents, l.quantity, l.sold, l.reserved,
            l.visible, l.channels, l.starts_at, l.expires_at,
            l.min_per_order, l.max_per_order,
            s.id AS setor_id, s.name AS setor, s.sort_order,
            ses.id AS sessao_id, ses.starts_at AS sessao_comeca
       FROM lots l
       JOIN sectors s ON s.id = l.sector_id
       LEFT JOIN event_sessions ses ON ses.id = s.session_id
      WHERE s.event_id = $1
      ORDER BY s.sort_order, l.sort_order, l.name`, [eventId])

  const tipos = await q<any>(
    `SELECT t.id, t.lot_id, t.name, t.discount_bps, t.quantity, t.sold, t.requires_document
       FROM ticket_types t
       JOIN lots l ON l.id = t.lot_id
       JOIN sectors s ON s.id = l.sector_id
      WHERE s.event_id = $1
      ORDER BY t.name`, [eventId])

  const modo: ModoTaxa = ev.fee_mode_pos
  const agora = new Date()

  const monta = (l: any) => {
    const disponivel = Number(l.quantity) - Number(l.sold) - Number(l.reserved)
    const p = precificar(Number(l.price_cents), Number(ev.fee_bps), modo)
    return {
      id: l.id,
      nome: l.name,
      setor: l.setor,
      setorId: l.setor_id,
      sessaoComeca: l.sessao_comeca,
      faceCents: Number(l.price_cents),
      /** o que a pessoa paga no guichê */
      balcaoCents: p.totalCents,
      taxaCents: p.feeCents,
      disponivel,
      minimo: Number(l.min_per_order),
      maximo: Number(l.max_per_order),
      tipos: tipos.filter((t) => t.lot_id === l.id).map((t) => {
        const face = Math.round(Number(l.price_cents) * (10_000 - Number(t.discount_bps)) / 10_000)
        const pt = precificar(face, Number(ev.fee_bps), modo)
        return {
          id: t.id, nome: t.name, faceCents: face, balcaoCents: pt.totalCents,
          exigeDocumento: t.requires_document,
          disponivel: Number(t.quantity) - Number(t.sold),
        }
      }),
    }
  }

  const vendaveis: any[] = []
  const bloqueados: { nome: string; setor: string; motivo: string; id: string }[] = []

  for (const l of linhas) {
    const motivo = porQueNao(l, agora)
    if (motivo) bloqueados.push({ id: l.id, nome: l.name, setor: l.setor, motivo })
    else vendaveis.push(monta(l))
  }

  return {
    evento: { id: ev.id, nome: ev.name, status: ev.status, modoTaxa: modo, feeBps: Number(ev.fee_bps) },
    lotes: vendaveis,
    bloqueados,
  }
})

/**
 * O motivo, em português, de um lote não aparecer no balcão.
 *
 * A ordem importa: o primeiro motivo verdadeiro é o que o operador precisa
 * ouvir. "Sem estoque" quando na verdade o canal não está marcado manda a
 * pessoa procurar ingresso que existe.
 */
function porQueNao(l: any, agora: Date): string | null {
  if (!l.channels?.includes('bilheteria')) {
    return 'Não está liberado para venda na bilheteria'
  }
  if (!l.visible) return 'Lote desativado'
  if (l.starts_at && new Date(l.starts_at) > agora) return 'Ainda não abriu'
  if (l.expires_at && new Date(l.expires_at) <= agora) return 'Já encerrou'
  if (Number(l.quantity) - Number(l.sold) - Number(l.reserved) <= 0) return 'Esgotado'
  return null
}
