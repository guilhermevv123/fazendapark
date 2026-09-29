/**
 * POST /api/conta/apple/volta — a volta da Apple, por `form_post` VINDO DE OUTRO SITE (é assim
 * que a Apple devolve). Por isso sem a checagem de origem: quem protege é o `state` do cookie
 * assinado, conferido em `concluirEntradaSocial`. O nome só vem aqui, e só na primeira vez.
 */
import { nomeQueAAppleMandou } from '../../../utils/entrar-social'
import { voltaDoProvedorSocial } from '../../../utils/conta-social'

export default defineEventHandler(async (event) => {
  const b = ((await readBody(event).catch(() => null)) ?? {}) as Record<string, any>
  const destino = await voltaDoProvedorSocial(event, 'apple', {
    code: b.code, state: b.state, erro: b.error, nomeDaApple: nomeQueAAppleMandou(b.user),
  })
  return sendRedirect(event, destino, 303)
})
