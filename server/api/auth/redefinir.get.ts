/**
 * GET /api/auth/redefinir?t=… — o link de senha nova da equipe (051) ainda vale? Só sim/não e o
 * primeiro nome, sem gastar o link: a tela avisa do link vencido antes de a pessoa digitar.
 */
import { frearPortaPublica } from '../../utils/sessao'
import { conferirLinkDaEquipe } from '../../utils/senha-da-equipe'

export default defineEventHandler(async (event) => {
  frearPortaPublica(event, 'conta_link')
  const t = getQuery(event).t
  const l = await conferirLinkDaEquipe(typeof t === 'string' ? t : null)
  return { valido: !!l, nome: l ? (l.nome.split(' ')[0] ?? '') : null }
})
