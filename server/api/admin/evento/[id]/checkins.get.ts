/**
 * GET /api/admin/evento/:id/checkins — o que aconteceu na porta.
 *
 * Toda leitura vira linha em `checkins`, inclusive a recusada. Esta rota é o
 * que transforma esse log em resposta pras três perguntas que aparecem no dia
 * do evento:
 *
 *   "quantos já entraram?"      → resumo
 *   "a fila está andando?"      → porHora
 *   "por que aquele foi barrado?" → a lista, com o motivo de cada recusa
 *
 * A recusa importa mais que o sucesso: um código inválido lido três vezes no
 * mesmo minuto é alguém tentando entrar com print de ingresso de outro, e o
 * único lugar onde isso aparece é aqui.
 */
import { q, q1 } from '../../../../utils/db'

const PAGINA = 60

/** rótulo humano por resultado — a tela não deve inventar o seu */
export const MOTIVO: Record<string, string> = {
  ok: 'Entrou',
  ja_usado: 'Já tinha entrado',
  invalido: 'Código inválido',
  cancelado: 'Ingresso cancelado',
  fora_da_sessao: 'Fora do horário da sessão',
  evento_errado: 'Ingresso de outro evento',
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const { resultado, gate, busca, pagina } = getQuery(event) as Record<string, string>

  const ev = await q1<any>(
    `SELECT id, name, starts_at, ends_at FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const onde = ['ck.event_id = $1']
  const par: any[] = [id]
  if (resultado) { par.push(resultado); onde.push(`ck.resultado = $${par.length}`) }
  if (gate) { par.push(gate); onde.push(`ck.gate = $${par.length}`) }
  if (busca?.trim()) {
    par.push(`%${busca.trim()}%`)
    onde.push(`(ck.code_lido ILIKE $${par.length} OR t.holder_name ILIKE $${par.length})`)
  }
  const filtro = onde.join(' AND ')
  const p = Math.max(1, Number(pagina) || 1)

  const [linhas, contagem, porHora, portoes, emitidos] = await Promise.all([
    q<any>(
      `SELECT ck.id, ck.code_lido, ck.resultado, ck.gate, ck.created_at,
              t.holder_name, s.name AS setor, l.name AS lote,
              u.name AS operador
         FROM checkins ck
         LEFT JOIN tickets t ON t.id = ck.ticket_id
         LEFT JOIN sectors s ON s.id = t.sector_id
         LEFT JOIN lots    l ON l.id = t.lot_id
         LEFT JOIN users   u ON u.id = ck.operator_id
        WHERE ${filtro}
        ORDER BY ck.created_at DESC
        LIMIT ${PAGINA} OFFSET ${(p - 1) * PAGINA}`, par),

    q1<any>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE ck.resultado = 'ok')::int AS ok,
              count(*) FILTER (WHERE ck.resultado <> 'ok')::int AS recusadas
         FROM checkins ck
         LEFT JOIN tickets t ON t.id = ck.ticket_id
        WHERE ${filtro}`, par),

    // Fila por hora: o pico é o que dimensiona quantos portões abrir no ano
    // que vem. Só a leitura aceita entra — recusa não é pessoa entrando.
    q<any>(
      `SELECT date_trunc('hour', created_at) AS hora, count(*)::int AS n
         FROM checkins WHERE event_id = $1 AND resultado = 'ok'
        GROUP BY 1 ORDER BY 1`, [id]),

    q<any>(
      `SELECT COALESCE(gate, '—') AS gate, count(*)::int AS n,
              count(*) FILTER (WHERE resultado = 'ok')::int AS ok
         FROM checkins WHERE event_id = $1
        GROUP BY 1 ORDER BY 2 DESC`, [id]),

    // O denominador do comparecimento é o ingresso VÁLIDO ou já usado — o
    // cancelado nunca ia entrar, e deixá-lo no total faria o percentual
    // parecer pior do que foi.
    q1<any>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'usado')::int AS usados
         FROM tickets WHERE event_id = $1 AND status <> 'cancelado'`, [id]),
  ])

  const total = Number(emitidos.total)
  return {
    evento: { id: ev.id, nome: ev.name, comeca: ev.starts_at, termina: ev.ends_at },
    resumo: {
      leituras: contagem.total,
      aceitas: contagem.ok,
      recusadas: contagem.recusadas,
      entraram: emitidos.usados,
      aptos: total,
      faltam: Math.max(total - emitidos.usados, 0),
      comparecimentoPct: total > 0 ? Math.round((emitidos.usados / total) * 100) : 0,
    },
    porHora: porHora.map((h) => ({ hora: h.hora, n: h.n })),
    portoes: portoes.map((g) => ({ gate: g.gate, leituras: g.n, aceitas: g.ok })),
    pagina: p,
    paginas: Math.max(1, Math.ceil(contagem.total / PAGINA)),
    leituras: linhas.map((r) => ({
      id: r.id, codigo: r.code_lido, resultado: r.resultado,
      motivo: MOTIVO[r.resultado] ?? r.resultado,
      gate: r.gate, quando: r.created_at, operador: r.operador,
      titular: r.holder_name, setor: r.setor, lote: r.lote,
    })),
  }
})
