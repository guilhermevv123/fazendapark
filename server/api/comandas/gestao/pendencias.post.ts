/**
 * POST /api/comandas/gestao/pendencias — `{ id, decisao: 'cobrar' | 'cancelar', motivo }`.
 *
 * - cobrar: o pedido fica na conta, e a conta (que estava paga) passa a "não paga" pelo
 *   valor que falta — entra na lista de cobrança como qualquer outra.
 * - cancelar: os itens do pedido são cancelados com o motivo (o parque assume).
 */
import { exigirNivel, reaisTexto, recusa, registrar, SQL_PAGO, SQL_TOTAL, texto } from '../../../utils/comandas'
import { tx } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const c = exigirNivel(event, 'gerente')
  const b = (await readBody<{ id?: string; decisao?: string; motivo?: string }>(event)) ?? {}
  const motivo = texto(b.motivo, 200)
  if (!motivo) recusa('Escreva o motivo da decisão.', 'motivo')
  await tx(async (cl) => {
    const l = (await cl.query(
      `SELECT l.*, c.situacao, c.numero FROM comanda_lancamentos l JOIN comandas c ON c.id = l.comanda_id
        WHERE l.org_id = $1 AND l.id::text = $2 AND l.chegou_depois_de_fechada AND l.pendencia_resolvida_em IS NULL
        FOR UPDATE OF l`, [c.orgId, String(b.id ?? '')])).rows[0]
    if (!l) recusa('Pendência não encontrada (talvez já resolvida).', 'pendencia')
    if (b.decisao === 'cancelar') {
      await cl.query(`UPDATE comanda_lancamento_itens SET cancelado = true, cancelado_em = now(), cancelado_por = $2, cancelado_motivo = $3
                       WHERE lancamento_id = $1 AND NOT cancelado`, [l.id, c.usuarioId, `pendência cancelada: ${motivo}`])
      await registrar(cl, c, { comandaId: l.comanda_id, acao: 'pendencia_cancelada', descricao: `Pedido que chegou depois do fechamento foi CANCELADO — motivo: ${motivo}` })
    } else if (b.decisao === 'cobrar') {
      const { t, pg } = (await cl.query(`SELECT ${SQL_TOTAL} AS t, ${SQL_PAGO} AS pg FROM comandas c WHERE c.id = $1`, [l.comanda_id])).rows[0]
      const falta = Number(t) - Number(pg)
      if (falta > 0 && ['paga', 'paga_depois', 'perdoada'].includes(l.situacao)) {
        await cl.query(`UPDATE comandas SET situacao = 'nao_paga', encerrada_em = now(), encerrada_por = $2 WHERE id = $1`, [l.comanda_id, c.usuarioId])
      }
      await registrar(cl, c, { comandaId: l.comanda_id, acao: 'pendencia_cobrar',
        descricao: `Pedido que chegou depois do fechamento MANTIDO na conta — falta ${reaisTexto(Math.max(falta, 0))}. Motivo: ${motivo}` })
    } else {
      recusa('Escolha cobrar ou cancelar.', 'decisao')
    }
    await cl.query(`UPDATE comanda_lancamentos SET pendencia_resolvida_em = now(), pendencia_resolvida_por = $2 WHERE id = $1`, [l.id, c.usuarioId])
  })
  return { ok: true }
})
