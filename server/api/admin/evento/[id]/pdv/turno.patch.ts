/**
 * PATCH /api/admin/evento/:id/pdv/turno — fecha o caixa.
 *
 * O operador conta o dinheiro da gaveta e digita o que contou. O sistema NÃO
 * mostra o esperado antes: quem vê o número que devia dar digita o número que
 * devia dar, e a conferência vira teatro. O confronto acontece depois, na
 * resposta.
 *
 * O `UPDATE` condicional em `status = 'aberto'` é a trava — e ela mora em
 * `utils/caixa.ts` junto com a do ponto de venda, pra que o teste rode a
 * MESMA instrução. Aqui não existe checagem prévia de propósito: uma
 * checagem antes resolveria o caso em fila e esconderia a trava, que foi o
 * erro cometido duas vezes neste sistema (catraca e aceite de transferência).
 */
import { z } from 'zod'
import { q1, tx } from '../../../../../utils/db'
import {
  contarTurno, quebra, SQL_FECHA_TURNO, SQL_TRAVA_TURNO_ABERTO,
} from '../../../../../utils/caixa'

const Entrada = z.object({
  turnoId: z.string().uuid(),
  contadoCents: z.number().int().min(0).max(100_000_00),
  observacao: z.string().max(400).nullish(),
})

export default defineEventHandler(async (event) => {
  const eventId = getRouterParam(event, 'id')!
  const sessao = (event.context as any).sessao
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data

  // id do turno vem no corpo → cerca própria, antes de qualquer escrita.
  const dono = await q1<any>(
    `SELECT t.id, t.org_id, p.name AS ponto
       FROM pos_shifts t JOIN pos_terminals p ON p.id = t.terminal_id
      WHERE t.id = $1 AND t.event_id = $2`, [d.turnoId, eventId])
  if (!dono) throw createError({ statusCode: 404, statusMessage: 'Caixa não encontrado' })

  return await tx(async (c) => {
    // Trava a linha do turno ANTES de contar, e é a mesma instrução que a
    // venda usa. É isso que impede a falta fantasma: sem o lock aqui, uma
    // venda cabe entre a contagem e o fechamento, o `esperado` congela sem
    // ela, e de manhã o relatório acusa uma falta do tamanho exato da última
    // venda — com o dinheiro na gaveta, certinho.
    const trava = await c.query(SQL_TRAVA_TURNO_ABERTO, [d.turnoId])
    if (trava.rowCount !== 1) {
      throw createError({ statusCode: 409, statusMessage: 'Este caixa já foi fechado.' })
    }

    const contagem = await contarTurno(c, d.turnoId)

    const r = await c.query(SQL_FECHA_TURNO, [
      d.turnoId, sessao?.usuarioId ?? null, d.contadoCents,
      contagem.esperadoCents, d.observacao?.trim() || null,
    ])
    if (r.rowCount !== 1) {
      throw createError({ statusCode: 409, statusMessage: 'Este caixa já foi fechado.' })
    }

    const q = quebra(d.contadoCents, contagem.esperadoCents)

    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'turno',$2,'fechado',$3::jsonb)`,
      [dono.org_id, d.turnoId, JSON.stringify({
        ponto: dono.ponto, contadoCents: d.contadoCents,
        esperadoCents: contagem.esperadoCents, diferencaCents: q.diferencaCents,
        por: sessao?.nome ?? null,
      })])

    return { ok: true, contagem, ...q, contadoCents: d.contadoCents }
  })
})
