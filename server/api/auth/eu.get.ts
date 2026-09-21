/**
 * GET /api/auth/eu — quem está logado.
 *
 * Devolve 200 com `{ usuario: null }` quando não há sessão, em vez de 401.
 * O layout chama esta rota em toda navegação: se ela respondesse 401, o
 * console do navegador ficaria vermelho o tempo todo numa situação que é
 * normal (visitante na página pública), e o vermelho de verdade sumiria no
 * meio do ruído.
 *
 * **O `papel` daqui é o MESMO que tranca a rota** (`users.papel`, a grade fina
 * de `utils/papeis.ts`), e não o `users.role` legado. Enquanto foi o legado,
 * esta rota e o porteiro falavam de papéis diferentes sobre a mesma pessoa:
 * quem era `financeiro` aparecia como "admin" no canto do painel (porque
 * `roleLegado('financeiro') = 'admin'`) e quem era `operacao` aparecia como
 * "operacional". Não é erro de rótulo: é o menu desta tela decidindo o que
 * mostrar por uma régua que o servidor não usa.
 */
import { lerSessao } from '../../utils/sessao'
import { ROTULO } from '../../utils/papeis'

export default defineEventHandler(async (event) => {
  const s = await lerSessao(event)
  if (!s) return { usuario: null }
  return {
    usuario: {
      nome: s.nome,
      email: s.email,
      papel: s.papelFino,
      // como se escreve esse papel pra gente ler — a tela não monta a frase
      papelRotulo: ROTULO[s.papelFino] ?? s.papelFino,
      orgId: s.orgId,
    },
  }
})
