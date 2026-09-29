/** POST /api/conta/sair — derruba a sessão do cliente (no banco, não só o cookie). */
import { mutacaoDeOutroSite } from '../../utils/caminho'
import { sairDaContaDoCliente } from '../../utils/conta-do-cliente'

export default defineEventHandler(async (event) => {
  if (mutacaoDeOutroSite(event)) throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
  await sairDaContaDoCliente(event)
  return { ok: true }
})
