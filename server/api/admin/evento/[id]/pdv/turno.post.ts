/**
 * POST /api/admin/evento/:id/pdv/turno — abre o caixa.
 *
 * Abrir caixa é declarar com quanto de troco a gaveta começou. Esse número é
 * o que separa "sobrou R$ 200" de "o turno abriu com R$ 200" na conferência
 * do fim da noite — sem ele toda apuração acusa sobra e ninguém confia mais
 * no relatório.
 *
 * Quem abre é quem vende: o operador do turno é o usuário da sessão. Abrir
 * caixa no nome de outra pessoa faria a diferença de caixa cair no colo de
 * quem não estava lá.
 */
import { z } from 'zod'
import { q1 } from '../../../../../utils/db'

const Entrada = z.object({
  pontoId: z.string().uuid(),
  fundoCents: z.number().int().min(0).max(100_000_00).default(0),
})

export default defineEventHandler(async (event) => {
  const eventId = getRouterParam(event, 'id')!
  const sessao = (event.context as any).sessao
  if (!sessao?.usuarioId) {
    throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })
  }
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }

  // id do ponto vem no corpo: a cerca é aqui.
  const ponto = await q1<any>(
    `SELECT p.id, p.name, p.active, p.org_id
       FROM pos_terminals p WHERE p.id = $1 AND p.event_id = $2`, [p.data.pontoId, eventId])
  if (!ponto) throw createError({ statusCode: 404, statusMessage: 'Ponto de venda não encontrado' })
  if (!ponto.active) {
    throw createError({ statusCode: 409, statusMessage: 'Este ponto de venda está desativado.' })
  }

  try {
    const turno = await q1<any>(
      `INSERT INTO pos_shifts (org_id, event_id, terminal_id, operator_id, opening_float_cents)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, opened_at`,
      [ponto.org_id, eventId, ponto.id, sessao.usuarioId, p.data.fundoCents])

    await q1(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'turno',$2,'aberto',$3::jsonb) RETURNING id`,
      [ponto.org_id, turno.id,
       JSON.stringify({ ponto: ponto.name, fundoCents: p.data.fundoCents, por: sessao.nome })])

    return { ok: true, turnoId: turno.id, abriuEm: turno.opened_at, ponto: ponto.name }
  } catch (e: any) {
    // `turno_aberto_unico` — o índice parcial é que garante um caixa aberto
    // por ponto. A mensagem aqui é só pra dizer o porquê a quem está na tela.
    if (e?.code === '23505') {
      throw createError({
        statusCode: 409,
        statusMessage: `O caixa de ${ponto.name} já está aberto. Feche antes de abrir outro.`,
      })
    }
    throw e
  }
})
