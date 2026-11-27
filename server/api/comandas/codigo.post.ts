/**
 * POST /api/comandas/codigo — manda o código de 4 números pro WhatsApp de quem vai abrir a
 * conta à mão. `{ telefone }`. No computador de teste o código volta na resposta.
 */
import { ctx, recusa, telefoneLimpo } from '../../utils/comandas'
import { mandarCodigo } from '../../utils/comandas-whatsapp'

export default defineEventHandler(async (event) => {
  const c = ctx(event)
  const { telefone } = (await readBody<{ telefone?: string }>(event)) ?? {}
  const fone = telefoneLimpo(telefone)
  if (!fone) recusa('Telefone inválido. Digite com DDD, ex.: (77) 99999-0000.', 'telefone')
  try {
    return await mandarCodigo(c.orgId, c.usuarioId, fone)
  } catch (e: any) {
    if (e?.statusCode) throw e
    recusa('Não consegui mandar o código pelo WhatsApp agora. Tente de novo ou chame o gerente.', 'whatsapp_falhou')
  }
})
