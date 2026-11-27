/**
 * POST /api/comandas/conta/<id>/pagar — registra COMO o cliente pagou (o dinheiro passa na
 * maquininha do parque) e, se `fechar`, fecha a conta e solta a pulseira.
 *
 * `{ pagamentos: [{ forma, valorCents, recebidoCents? }], fechar: boolean }`
 *
 * Fechar exige a conta zerada (o que foi pago agora + antes = o total). Pagamento dividido
 * (parte no dinheiro, parte no cartão) vem como várias linhas. Conta que estava "não paga"
 * ou "cobrada" vira "paga depois" — a história de que ela saiu sem pagar continua.
 */
import {
  configDaComanda, ctx, nivelCobre, reaisTexto, recusa, registrar, resumoDaComanda, soltarPulseiras,
  SQL_PAGO, SQL_TOTAL,
} from '../../../../utils/comandas'
import { tx } from '../../../../utils/db'

const FORMAS = ['dinheiro', 'pix', 'debito', 'credito'] as const
const NOME_DA_FORMA: Record<string, string> = { dinheiro: 'Dinheiro', pix: 'Pix', debito: 'Débito', credito: 'Crédito' }

export default defineEventHandler(async (event) => {
  const c = ctx(event)
  const config = await configDaComanda(c.orgId)
  if (!nivelCobre(c.nivel, 'caixa') && !config.atendenteFechaConta) {
    recusa('Fechar conta é no caixa. Peça ao cliente para passar no caixa.', 'so_caixa')
  }
  const id = String(getRouterParam(event, 'id') ?? '')
  const b = (await readBody<{ pagamentos?: any[]; fechar?: boolean }>(event)) ?? {}
  const pagamentos = (Array.isArray(b.pagamentos) ? b.pagamentos : []).map((p) => ({
    forma: String(p?.forma ?? ''),
    valorCents: Math.trunc(Number(p?.valorCents)),
    recebidoCents: p?.recebidoCents == null || p?.recebidoCents === '' ? null : Math.trunc(Number(p.recebidoCents)),
  }))
  for (const p of pagamentos) {
    if (!FORMAS.includes(p.forma as any)) recusa('Escolha a forma de pagamento: dinheiro, Pix, débito ou crédito.', 'forma')
    if (!Number.isInteger(p.valorCents) || p.valorCents <= 0) recusa('Valor do pagamento inválido.', 'valor')
    if (p.recebidoCents != null && (p.forma !== 'dinheiro' || p.recebidoCents < p.valorCents)) {
      recusa('O valor recebido em dinheiro não pode ser menor que o valor pago.', 'recebido')
    }
  }
  if (!pagamentos.length && !b.fechar) recusa('Nenhum pagamento informado.', 'sem_pagamento')

  await tx(async (cl) => {
    const conta = (await cl.query(`SELECT * FROM comandas WHERE org_id = $1 AND id = $2 FOR UPDATE`, [c.orgId, id])).rows[0]
    if (!conta) throw createError({ statusCode: 404, statusMessage: 'Conta não encontrada.' })
    if (!['aberta', 'nao_paga', 'cobrada'].includes(conta.situacao)) {
      recusa(conta.situacao === 'juntada' ? 'Esta conta foi juntada com outra. Feche a conta que recebeu os itens.' : 'Esta conta já está fechada.', 'ja_fechada')
    }
    const { t, pg } = (await cl.query(`SELECT ${SQL_TOTAL} AS t, ${SQL_PAGO} AS pg FROM comandas c WHERE c.id = $1`, [id])).rows[0]
    // falta negativa: item cancelado/movido depois de pagar. Não trava: fecha sem cobrar (a sobra fica no histórico).
    const falta = Math.max(Number(t) - Number(pg), 0)
    const agora = pagamentos.reduce((s, p) => s + p.valorCents, 0)
    if (agora > falta) recusa(`O pagamento (${reaisTexto(agora)}) passa do que falta (${reaisTexto(falta)}).`, 'passou', { faltaCents: falta })
    if (b.fechar && agora !== falta) {
      recusa(`Ainda faltam ${reaisTexto(falta - agora)} para fechar a conta.`, 'falta', { faltaCents: falta - agora })
    }

    for (const p of pagamentos) {
      await cl.query(
        `INSERT INTO comanda_pagamentos (org_id, comanda_id, forma, valor_cents, recebido_cents, feito_por, aparelho, link_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [c.orgId, id, p.forma, p.valorCents, p.recebidoCents, c.usuarioId, c.aparelho, c.linkId ?? null])
    }
    if (pagamentos.length) {
      await registrar(cl, c, {
        comandaId: id, acao: 'pagamento',
        descricao: 'Pagamento: ' + pagamentos.map((p) => `${NOME_DA_FORMA[p.forma]} ${reaisTexto(p.valorCents)}`
          + (p.recebidoCents != null && p.recebidoCents > p.valorCents ? ` (recebeu ${reaisTexto(p.recebidoCents)}, troco ${reaisTexto(p.recebidoCents - p.valorCents)})` : '')).join(' + '),
        detalhes: { pagamentos },
      })
    }

    if (b.fechar) {
      const depois = conta.situacao === 'nao_paga' || conta.situacao === 'cobrada'
      await cl.query(
        `UPDATE comandas SET situacao = $2, fechada_em = now(), fechada_por = $3,
                encerrada_em = CASE WHEN $4 THEN now() ELSE encerrada_em END,
                encerrada_por = CASE WHEN $4 THEN $3 ELSE encerrada_por END
          WHERE id = $1`, [id, depois ? 'paga_depois' : 'paga', c.usuarioId, depois])
      await soltarPulseiras(cl, c, id, 'paga')
      await registrar(cl, c, {
        comandaId: id, acao: 'fechar',
        descricao: `Conta ${conta.numero} fechada — total ${reaisTexto(Number(t))}${depois ? ' (paga depois da cobrança)' : ''}. Pulseira liberada.`,
      })
    }
  })

  return { conta: await resumoDaComanda(c.orgId, id) }
})
