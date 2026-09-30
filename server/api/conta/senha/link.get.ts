/**
 * GET /api/conta/senha/link?t=… — o link de nova senha ainda vale? Só sim/não, sem gastar nada.
 * A tela de nova senha pergunta ao abrir: link vencido avisa ANTES de a pessoa digitar duas senhas.
 */
import { frearPortaPublica } from '../../../utils/sessao'
import { conferirLinkDaConta } from '../../../utils/conta-email'

export default defineEventHandler(async (event) => {
  frearPortaPublica(event, 'conta_link')
  const t = getQuery(event).t
  return { valido: !!(await conferirLinkDaConta(typeof t === 'string' ? t : null, 'redefinir_senha')) }
})
