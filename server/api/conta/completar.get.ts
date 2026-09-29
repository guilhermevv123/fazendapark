/** GET /api/conta/completar — o que o Google/Apple já disse (pra tela preencher o que falta). */
import { abrirPacoteSocial, COOKIE_DO_CADASTRO_SOCIAL } from '../../utils/entrar-social'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const p = abrirPacoteSocial<any>(getCookie(event, COOKIE_DO_CADASTRO_SOCIAL))
  if (!p) throw createError({ statusCode: 404, statusMessage: 'O tempo para concluir acabou. Entre de novo.' })
  return { provedor: p.provedor, nome: p.nome ?? null, email: p.email ?? null, emailVerificado: !!p.emailVerificado }
})
