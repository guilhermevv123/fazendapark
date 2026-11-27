/**
 * POST /api/comandas/pedidos — um ou vários pedidos do tablet.
 *
 * `{ pedidos: PedidoDoTablet[] }`. Com internet vem um por vez; quando a internet volta,
 * o tablet manda a fila inteira, na ordem em que foi feita. Cada um responde por si
 * (`ok` ou o motivo), e reenviar o mesmo `idLocal` nunca lança duas vezes.
 */
import { ctx, gravarPedido, type PedidoDoTablet } from '../../utils/comandas'

export default defineEventHandler(async (event) => {
  const c = ctx(event)
  const corpo = await readBody<{ pedidos?: PedidoDoTablet[] }>(event)
  const pedidos = Array.isArray(corpo?.pedidos) ? corpo!.pedidos.slice(0, 200) : []
  if (!pedidos.length) throw createError({ statusCode: 400, statusMessage: 'Nenhum pedido enviado.' })
  const resultados = []
  // em ordem, um por vez: a fila do tablet é a ordem em que os pedidos aconteceram
  // um pedido com defeito não pode travar a fila inteira do tablet: responde só por ele
  for (const p of pedidos) {
    try { resultados.push(await gravarPedido(c, p)) } catch (e: any) {
      console.error('[comandas] pedido com erro', p?.idLocal, e?.message)
      resultados.push({ idLocal: String(p?.idLocal ?? ''), ok: false, codigo: 'erro', mensagem: 'Este pedido deu erro no servidor. Avise o gerente.' })
    }
  }
  return { resultados }
})
