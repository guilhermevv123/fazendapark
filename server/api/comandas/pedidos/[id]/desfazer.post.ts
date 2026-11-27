/**
 * POST /api/comandas/pedidos/<lançamento>/desfazer — o botão "Desfazer" do tablet.
 *
 * Cancela todos os itens do pedido. O atendente desfaz o PRÓPRIO pedido sozinho dentro do
 * prazo (`minutos_para_desfazer`); fora dele, ou pedido de outro, precisa do gerente.
 * Aceita o `id_local` do tablet no lugar do id (o tablet que lançou sem internet só conhece ele).
 */
import { configDaComanda, ctx, exigirGerente, nivelCobre, reaisTexto, recusa, registrar, resumoDaComanda, texto } from '../../../../utils/comandas'
import { tx } from '../../../../utils/db'

export default defineEventHandler(async (event) => {
  const c = ctx(event)
  const chave = String(getRouterParam(event, 'id') ?? '')
  const b = (await readBody<{ pin?: string; motivo?: string }>(event)) ?? {}
  const config = await configDaComanda(c.orgId)

  const comandaId = await tx(async (cl) => {
    const l = (await cl.query(
      `SELECT l.*, c.situacao, c.numero FROM comanda_lancamentos l JOIN comandas c ON c.id = l.comanda_id
        WHERE l.org_id = $1 AND (l.id::text = $2 OR l.id_local = $2) FOR UPDATE OF l`, [c.orgId, chave])).rows[0]
    if (!l) recusa('Pedido não encontrado. Se foi feito sem internet, espere ele ser enviado.', 'pedido')
    const dele = c.linkId ? l.link_id === c.linkId : l.atendente_id === c.usuarioId && !l.link_id
    const noPrazo = Date.now() - new Date(l.feito_em).getTime() <= config.minutosParaDesfazer * 60_000
    let liberou = ''
    // conta já fechada (paga, não paga…) só o gerente mexe — mesma regra de `corrigir.post.ts`
    const aberta = l.situacao === 'aberta'
    const sozinho = aberta && (nivelCobre(c.nivel, 'caixa') || (dele && noPrazo))
    if (!sozinho) {
      const g = await exigirGerente(c, b.pin)
      if (g && g.id !== c.usuarioId) liberou = ` — liberado por ${g.nome}`
    }
    const itens = (await cl.query(
      `UPDATE comanda_lancamento_itens SET cancelado = true, cancelado_em = now(), cancelado_por = $2, cancelado_motivo = $3
        WHERE lancamento_id = $1 AND NOT cancelado RETURNING nome, quantidade, preco_cents`,
      [l.id, c.usuarioId, texto(b.motivo, 200) ?? 'pedido desfeito no tablet'])).rows
    if (!itens.length) recusa('Este pedido já estava desfeito.', 'ja_desfeito')
    const valor = itens.reduce((s: number, i: any) => s + Number(i.preco_cents) * i.quantidade, 0)
    await registrar(cl, c, { comandaId: l.comanda_id, acao: 'desfazer_pedido',
      descricao: `Pedido desfeito (${reaisTexto(valor)}): ${itens.map((i: any) => `${i.quantidade}× ${i.nome}`).join(', ')}${liberou}` })
    return l.comanda_id as string
  })
  return { conta: await resumoDaComanda(c.orgId, comandaId) }
})
