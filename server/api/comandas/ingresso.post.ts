/**
 * POST /api/comandas/ingresso — consulta o ingresso ANTES de abrir a conta por ele.
 *
 * `{ qr }` (o texto do QR lido pela câmera) ou `{ codigo }` (o código impresso). Devolve
 * quem comprou (o responsável, com o contato que pagou pelo Asaas), o nome sugerido pra
 * quem vai usar a pulseira, se esse ingresso já tem conta aberta e se o comprador deve
 * alguma conta antiga. Só lê a bilheteria; nada lá é alterado.
 */
import { ctx } from '../../utils/comandas'
import { acharIngresso } from '../../utils/comandas-ingresso'

export default defineEventHandler(async (event) => {
  const c = ctx(event)
  const corpo = await readBody<{ qr?: string; codigo?: string }>(event)
  return acharIngresso(c.orgId, corpo)
})
