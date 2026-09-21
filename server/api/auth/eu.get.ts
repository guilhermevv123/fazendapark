/**
 * GET /api/auth/eu — quem está logado.
 *
 * Devolve 200 com `{ usuario: null }` quando não há sessão, em vez de 401.
 * O layout chama esta rota em toda navegação: se ela respondesse 401, o
 * console do navegador ficaria vermelho o tempo todo numa situação que é
 * normal (visitante na página pública), e o vermelho de verdade sumiria no
 * meio do ruído.
 */
import { lerSessao } from '../../utils/sessao'

export default defineEventHandler(async (event) => {
  const s = await lerSessao(event)
  return { usuario: s ? { nome: s.nome, email: s.email, papel: s.papel, orgId: s.orgId } : null }
})
