/**
 * POST /api/comandas/gestao/encerrar-dia — o gerente confirma, conta por conta, quem saiu
 * sem pagar.
 *
 * `{ contas: [{ id, decisao: 'nao_paga' | 'continua' }], ignorarTablets?: boolean }`
 *
 * Antes de marcar alguém como devedor: nenhum tablet pode estar com pedido na fila (a não
 * ser que o gerente diga que conferiu), a conta não pode ter sido juntada nem paga, e conta
 * sem consumo nenhum só fecha (não vira dívida de R$ 0).
 */
import {
  aparelhosComRisco, exigirNivel, reaisTexto, recusa, registrar, soltarPulseiras, SQL_PAGO, SQL_TOTAL,
} from '../../../utils/comandas'
import { tx } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const c = exigirNivel(event, 'gerente')
  const b = (await readBody<{ contas?: { id: string; decisao: string }[]; ignorarTablets?: boolean }>(event)) ?? {}
  const risco = aparelhosComRisco(c.orgId).filter((a) => a.pendentes > 0)
  if (risco.length && !b.ignorarTablets) {
    recusa(`${risco.map((a) => a.nome).join(', ')} ainda tem pedido sem enviar. Espere a internet voltar nesses tablets.`, 'tablets', { aparelhos: risco })
  }
  const decisoes = (Array.isArray(b.contas) ? b.contas : []).filter((d) => d?.decisao === 'nao_paga')
  const feitas: { numero: number; nome: string; resultado: string }[] = []

  await tx(async (cl) => {
    for (const d of decisoes) {
      const conta = (await cl.query(`SELECT * FROM comandas WHERE org_id = $1 AND id::text = $2 FOR UPDATE`, [c.orgId, String(d.id)])).rows[0]
      if (!conta || conta.situacao !== 'aberta') continue
      const { t, pg } = (await cl.query(`SELECT ${SQL_TOTAL} AS t, ${SQL_PAGO} AS pg FROM comandas c WHERE c.id = $1`, [conta.id])).rows[0]
      const falta = Number(t) - Number(pg)
      if (falta <= 0) {
        // nada a pagar: só fecha e solta a pulseira
        await cl.query(`UPDATE comandas SET situacao = 'paga', fechada_em = now(), fechada_por = $2 WHERE id = $1`, [conta.id, c.usuarioId])
        await soltarPulseiras(cl, c, conta.id, 'encerrada')
        await registrar(cl, c, { comandaId: conta.id, acao: 'encerrar_dia', descricao: 'Dia encerrado: conta sem valor a pagar, fechada.' })
        feitas.push({ numero: Number(conta.numero), nome: conta.nome, resultado: 'fechada (nada a pagar)' })
        continue
      }
      await cl.query(`UPDATE comandas SET situacao = 'nao_paga', encerrada_em = now(), encerrada_por = $2, fechada_em = now()
                       WHERE id = $1`, [conta.id, c.usuarioId])
      await soltarPulseiras(cl, c, conta.id, 'encerrada')
      await registrar(cl, c, { comandaId: conta.id, acao: 'nao_paga',
        descricao: `Dia encerrado: confirmado pelo gerente que saiu SEM PAGAR ${reaisTexto(falta)}. Pulseira liberada.` })
      feitas.push({ numero: Number(conta.numero), nome: conta.nome, resultado: `não paga (${reaisTexto(falta)})` })
    }
  })
  return { feitas }
})
