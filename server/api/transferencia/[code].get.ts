/**
 * GET /api/transferencia/:code — o que a pessoa que recebeu o link vê.
 *
 * Rota PÚBLICA: quem abre o link não tem conta. Por isso ela devolve o
 * mínimo pra decidir ("qual evento, qual lugar, quem mandou") e nada que só
 * interesse à produção: sem id de ingresso, sem valor pago, sem documento de
 * ninguém. Quem tem o link tem o ingresso — o link já é a credencial.
 *
 * O e-mail de quem mandou aparece parcialmente coberto: a pessoa precisa
 * reconhecer o remetente, não precisa do endereço dele.
 */
import { q1 } from '../../utils/db'
import { STATUS_LEGIVEL } from '../../utils/transferencia'

/** fulano@casa.com → fu•••@casa.com */
function meioEscondido(email?: string | null): string | null {
  if (!email) return null
  const [nome, dominio] = email.split('@')
  if (!dominio) return null
  return `${nome.slice(0, 2)}•••@${dominio}`
}

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')

  const tr = await q1<any>(
    `SELECT tr.status, tr.created_at, tr.expires_at, tr.accepted_at,
            tr.de_nome, tr.de_email, tr.para_nome, tr.para_email,
            t.code AS ingresso, t.status AS ingresso_status,
            e.name AS evento, e.starts_at, e.venue_name, e.city, e.state, e.slug,
            s.name AS setor, l.name AS lote, tt.name AS tipo,
            se.label AS assento,
            es.title AS sessao, es.starts_at AS sessao_inicio
       FROM ticket_transfers tr
       JOIN tickets t ON t.id = tr.ticket_id
       JOIN events  e ON e.id = tr.event_id
       JOIN sectors s ON s.id = t.sector_id
       JOIN lots    l ON l.id = t.lot_id
       LEFT JOIN ticket_types tt   ON tt.id = t.ticket_type_id
       LEFT JOIN seats se          ON se.ticket_id = t.id
       LEFT JOIN event_sessions es ON es.id = t.session_id
      WHERE tr.code = $1`, [code])

  if (!tr) throw createError({ statusCode: 404, statusMessage: 'Transferência não encontrada' })

  // Vencida mas ainda marcada como aguardando: a varredura roda de minuto em
  // minuto e alguém pode abrir o link exatamente no vão. A tela não pode
  // dizer "aguardando" pra quem já não consegue aceitar.
  const vencida = tr.status === 'aguardando'
    && tr.expires_at && new Date(tr.expires_at).getTime() < Date.now()
  const status = vencida ? 'expirado' : tr.status

  return {
    status,
    statusTexto: STATUS_LEGIVEL[status] ?? status,
    podeAceitar: status === 'aguardando',
    venceEm: tr.expires_at,
    de: { nome: tr.de_nome, email: meioEscondido(tr.de_email) },
    para: { nome: tr.para_nome, email: meioEscondido(tr.para_email) },
    evento: {
      nome: tr.evento, comecaEm: tr.starts_at, slug: tr.slug,
      local: tr.venue_name, cidade: tr.city, estado: tr.state,
    },
    ingresso: {
      setor: tr.setor, lote: tr.lote, tipo: tr.tipo,
      assento: tr.assento, sessao: tr.sessao, sessaoInicio: tr.sessao_inicio,
      // o código só aparece depois de aceito: antes disso ele é do outro
      codigo: status === 'concluido' ? tr.ingresso : null,
    },
  }
})
