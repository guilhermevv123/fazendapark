/** GET /api/conta/google/volta — a volta do Google (código na URL). Ver `utils/conta-social.ts`. */
import { voltaDoProvedorSocial } from '../../../utils/conta-social'

export default defineEventHandler(async (event) => {
  const { code, state, error } = getQuery(event) as Record<string, string | undefined>
  return sendRedirect(event, await voltaDoProvedorSocial(event, 'google', { code, state, erro: error }), 302)
})
