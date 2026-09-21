/**
 * POST /api/checkin — a catraca.
 *
 * Roda com gente na fila esperando, então otimiza pra: decidir rápido, decidir
 * certo, e NUNCA deixar o mesmo ingresso entrar duas vezes mesmo se dois
 * leitores lerem no mesmo instante (acontece toda hora: dois portões, ou o
 * operador que lê de novo achando que falhou).
 *
 * A trava é o UPDATE condicional: quem grava `usado` primeiro ganha, o segundo
 * vê rowCount 0 e recebe "já entrou". Ler e depois gravar deixaria os dois
 * passarem.
 *
 * TODA leitura vira linha em checkins, inclusive a recusada — é o que permite
 * auditar fila, portão e tentativa de fraude depois.
 */
import { z } from 'zod'
import { q, q1, tx } from '../utils/db'
import { SQL_MARCA_ENTRADA } from '../utils/catraca'
import { lerQr, MENSAGEM_CHECKIN, type ResultadoCheckin } from '../utils/ingresso'

const Entrada = z.object({
  qr: z.string().min(4).max(200),
  eventId: z.string().uuid(),
  gate: z.string().max(40).optional(),
  /** só confere, não marca — pro operador checar antes de deixar entrar */
  apenasConsultar: z.boolean().default(false),
})

export default defineEventHandler(async (event) => {
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) throw createError({ statusCode: 400, statusMessage: 'Dados inválidos' })
  const { qr, eventId, gate, apenasConsultar } = p.data

  // Quem leu. O middleware já exigiu sessão nesta rota, então o operador
  // SEMPRE existe aqui. Sem este carimbo, `checkins.operator_id` e
  // `tickets.checked_in_by` ficam nulos pra sempre e a coluna "validado por"
  // da tela de participantes nasce morta — a leitura fica sem dono, que é
  // justamente o que alguém vai querer saber quando um ingresso entrar duas
  // vezes ou entrar sem direito.
  const operador = (event.context as any).sessao?.usuarioId ?? null

  // ---- a cerca desta rota, que a do middleware não alcança ----------------
  // `02.tenant.ts` confere dono pelo id que está na URL. Aqui o evento vem no
  // CORPO, então a cerca tem que ser feita à mão — e sem ela a porta de uma
  // produtora queimava ingresso de outra: bastava o código na mão e um login
  // em qualquer casa da instalação pra derrubar a entrada de uma empresa
  // inteira. O código é público (vai impresso no ingresso).
  const orgDaSessao = (event.context as any).sessao?.orgId ?? null
  if (!orgDaSessao) throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })

  const eventoDaCasa = await q1<any>(
    `SELECT id FROM events WHERE id = $1 AND org_id = $2`, [eventId, orgDaSessao])
  // 404, não 403: dizer "existe, mas não é seu" já confirma que aquele id é
  // de um evento real de outra empresa.
  if (!eventoDaCasa) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const registrar = async (resultado: ResultadoCheckin, ticketId: string | null, codigo: string) => {
    await q(
      `INSERT INTO checkins (event_id, ticket_id, code_lido, resultado, gate, operator_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [eventId, ticketId, codigo.slice(0, 120), resultado, gate ?? null, operador])
    return {
      ok: resultado === 'ok',
      resultado,
      mensagem: MENSAGEM_CHECKIN[resultado],
    }
  }

  // O QR pode vir assinado (DT1:...) ou o operador digitou o código legível.
  const lido = lerQr(qr)
  const codigo = lido.ok ? lido.code! : qr.trim().toUpperCase()

  if (!lido.ok && lido.motivo === 'assinatura') {
    // Formato certo, assinatura errada = alguém fabricou. Isso é o achado mais
    // importante que esta rota produz; fica marcado como inválido e auditável.
    return registrar('invalido', null, qr)
  }
  if (lido.ok && lido.eventId !== eventId) {
    return registrar('evento_errado', null, qr)
  }

  const ingresso = await q1<any>(
    `SELECT t.id, t.status, t.event_id, t.holder_name, t.checked_in_at,
            s.name AS setor, l.name AS lote, tt.name AS tipo,
            es.starts_at AS sessao_inicio, es.ends_at AS sessao_fim
       FROM tickets t
       JOIN sectors s ON s.id = t.sector_id
       JOIN lots l    ON l.id = t.lot_id
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN event_sessions es ON es.id = t.session_id
      WHERE t.code = $1 AND t.org_id = $2`, [codigo, orgDaSessao])
  // O `org_id` no WHERE é o que separa "ingresso de outro evento MEU"
  // (evento_errado, mensagem útil pro público) de "ingresso de outra
  // empresa" — que aqui simplesmente não existe.

  if (!ingresso) return registrar('invalido', null, codigo)
  if (ingresso.event_id !== eventId) return registrar('evento_errado', ingresso.id, codigo)
  if (ingresso.status === 'cancelado') return registrar('cancelado', ingresso.id, codigo)
  if (ingresso.status === 'usado') {
    const r = await registrar('ja_usado', ingresso.id, codigo)
    return { ...r, entrouEm: ingresso.checked_in_at, titular: ingresso.holder_name }
  }

  // janela da sessão, com 2h de folga antes e depois — chegar cedo é normal
  if (ingresso.sessao_inicio) {
    const agora = Date.now()
    const abre = new Date(ingresso.sessao_inicio).getTime() - 2 * 3600_000
    const fecha = new Date(ingresso.sessao_fim ?? ingresso.sessao_inicio).getTime() + 2 * 3600_000
    if (agora < abre || agora > fecha) return registrar('fora_da_sessao', ingresso.id, codigo)
  }

  if (apenasConsultar) {
    return {
      ok: true, resultado: 'ok' as const, mensagem: 'Válido (não marcado)',
      consulta: true,
      ingresso: dadosDoIngresso(ingresso),
    }
  }

  // ---- a trava: só um UPDATE consegue virar 'usado' -----------------------
  // A instrução mora em utils/catraca.ts pra que o teste rode exatamente
  // esta, e não uma cópia que envelhece sozinha.
  const venceu = await tx(async (c) => {
    const r = await c.query(SQL_MARCA_ENTRADA, [ingresso.id, operador])
    return r.rowCount === 1
  })

  if (!venceu) {
    const r = await registrar('ja_usado', ingresso.id, codigo)
    return { ...r, titular: ingresso.holder_name }
  }

  const r = await registrar('ok', ingresso.id, codigo)
  return { ...r, ingresso: dadosDoIngresso(ingresso) }
})

function dadosDoIngresso(i: any) {
  return {
    titular: i.holder_name,
    setor: i.setor,
    lote: i.lote,
    tipo: i.tipo,
  }
}
