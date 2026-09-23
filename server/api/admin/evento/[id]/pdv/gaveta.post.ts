/**
 * POST /api/admin/evento/:id/pdv/gaveta — sangria, suprimento e a anulação
 * de um lançamento errado.
 *
 * Sangria é o gerente recolhendo dinheiro do guichê no meio da noite; sem
 * registrar, o caixa fecha com uma falta do tamanho do que foi recolhido e a
 * conversa vira acusação. Suprimento é o contrário: mais troco entrou.
 *
 *   { turnoId, tipo, valorCents, motivo? }   → lança um movimento
 *   { turnoId, anular: <id>, motivo }        → anula um movimento lançado errado
 *
 * Só entra em caixa ABERTO — mexer na gaveta de um turno já conferido muda um
 * fechamento que já foi assinado. Por isso usa a mesma trava da venda.
 *
 * ## Sangria maior que a gaveta
 *
 * Tirar da gaveta mais dinheiro do que o sistema diz que tem nela é quase
 * sempre dedo: R$ 5.000 digitado no lugar de R$ 500. Aceitar deixava o
 * esperado negativo e o fechamento acusando uma sobra do tamanho do erro —
 * sobra que ninguém tem como achar. A conta é feita COM a trava do turno na
 * mão, então uma venda em dinheiro que chega no meio não fura o teto.
 *
 * ## Anular não é apagar
 *
 * O lançamento errado fica onde está; a correção é outro, de sinal contrário
 * e mesmo valor, com a marca de qual ele anula (ver `utils/caixa.ts`). É o
 * rastro que a conferência de caixa existe pra guardar.
 */
import { z } from 'zod'
import { q1, tx } from '../../../../../utils/db'
import {
  SQL_TRAVA_TURNO_ABERTO, anulaQual, contarTurno, motivoDeAnulacao,
} from '../../../../../utils/caixa'

const Lancar = z.object({
  turnoId: z.string().uuid(),
  tipo: z.enum(['sangria', 'suprimento']),
  valorCents: z.number().int().positive().max(100_000_00),
  motivo: z.string().max(200).nullish(),
})

const Anular = z.object({
  turnoId: z.string().uuid(),
  anular: z.string().uuid(),
  /** obrigatório: anulação sem motivo é o lançamento sumindo sem explicação */
  motivo: z.string().trim().min(3).max(160),
})

const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default defineEventHandler(async (event) => {
  const eventId = getRouterParam(event, 'id')!
  const sessao = (event.context as any).sessao
  const corpo = await readBody(event)

  const anulacao = corpo && typeof corpo === 'object' && 'anular' in corpo
  const p = anulacao ? Anular.safeParse(corpo) : Lancar.safeParse(corpo)
  if (!p.success) {
    throw createError({
      statusCode: 400,
      statusMessage: anulacao
        ? 'Diga por que está anulando este lançamento (pelo menos 3 letras).'
        : 'Diga se é sangria ou suprimento e quanto (maior que zero).',
      data: p.error.flatten(),
    })
  }
  const d = p.data as any

  // turno vem no corpo → cerca própria
  const dono = await q1<any>(
    `SELECT id, org_id FROM pos_shifts WHERE id = $1 AND event_id = $2`, [d.turnoId, eventId])
  if (!dono) throw createError({ statusCode: 404, statusMessage: 'Caixa não encontrado' })

  return await tx(async (c) => {
    const trava = await c.query(SQL_TRAVA_TURNO_ABERTO, [d.turnoId])
    if (trava.rowCount !== 1) {
      throw createError({ statusCode: 409, statusMessage: 'Este caixa está fechado.' })
    }

    let tipo: 'sangria' | 'suprimento'
    let valorCents: number
    let motivo: string | null
    let anulaId: string | null = null

    if (anulacao) {
      // O original, com a MESMA cerca de turno: id de movimento de outro
      // caixa não anula nada aqui.
      const { rows } = await c.query(
        `SELECT id, kind, amount_cents, reason FROM pos_cash_movements
          WHERE id = $1 AND shift_id = $2`, [d.anular, d.turnoId])
      const orig = rows[0]
      if (!orig) {
        throw createError({ statusCode: 404, statusMessage: 'Lançamento não encontrado neste caixa.' })
      }
      if (anulaQual(orig.reason)) {
        throw createError({
          statusCode: 409,
          statusMessage: 'Este lançamento já é uma anulação. Se ele também saiu errado, '
            + 'lance o valor certo como um movimento novo.',
        })
      }
      // Anulado duas vezes = o valor voltando em dobro. A trava do turno
      // acima serializa: a segunda anulação chega aqui e enxerga a primeira.
      const { rows: jaAnulado } = await c.query(
        `SELECT 1 FROM pos_cash_movements
          WHERE shift_id = $1 AND reason LIKE $2 LIMIT 1`,
        [d.turnoId, `${motivoDeAnulacao(orig.id, '')}%`])
      if (jaAnulado.length) {
        throw createError({ statusCode: 409, statusMessage: 'Este lançamento já foi anulado.' })
      }
      tipo = orig.kind === 'sangria' ? 'suprimento' : 'sangria'
      valorCents = Number(orig.amount_cents)
      motivo = motivoDeAnulacao(orig.id, d.motivo)
      anulaId = orig.id
    } else {
      tipo = d.tipo
      valorCents = d.valorCents
      motivo = d.motivo?.trim() || null
    }

    // Dinheiro que sai não pode ser mais do que o que está na gaveta.
    if (tipo === 'sangria') {
      const conta = await contarTurno(c, d.turnoId)
      if (valorCents > conta.esperadoCents) {
        throw createError({
          statusCode: 409,
          statusMessage: `A gaveta deste caixa deve ter ${brl(Math.max(conta.esperadoCents, 0))} `
            + `e a saída é de ${brl(valorCents)}. Confira o valor digitado — `
            + (anulaId
              ? 'anular este suprimento deixaria a gaveta negativa.'
              : 'não dá para tirar mais do que tem.'),
          data: { tipo: 'sangria_acima_do_saldo', saldoCents: conta.esperadoCents },
        })
      }
    }

    const { rows: novo } = await c.query(
      `INSERT INTO pos_cash_movements (org_id, shift_id, kind, amount_cents, reason, by_user)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [dono.org_id, d.turnoId, tipo, valorCents, motivo, sessao?.usuarioId ?? null])

    await c.query(
      `INSERT INTO audit_log (org_id, user_id, entity, entity_id, action, after)
       VALUES ($1,$2,'turno',$3,$4,$5::jsonb)`,
      [dono.org_id, sessao?.usuarioId ?? null, d.turnoId,
       anulaId ? 'movimento_anulado' : tipo,
       JSON.stringify({
         movimento: novo[0].id, tipo, valorCents, motivo: anulaId ? d.motivo : motivo,
         anula: anulaId, por: sessao?.nome ?? null,
       })])

    return { ok: true, id: novo[0].id as string, tipo, valorCents, anula: anulaId }
  })
})
