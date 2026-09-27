/**
 * GET /api/admin/agentes — a visão do atendimento automático: números do dia, conversas dos
 * últimos 7 dias, casos (reclamação, elogio, o que a Sofia não soube) e a SAÚDE dos fluxos.
 *
 * As duas perguntas vão juntas ao n8n (visão e saúde). Se só a saúde falhar, a tela ainda mostra
 * as conversas com um aviso — saúde fora do ar não é motivo pra esconder quem está falando.
 * Área `agentes` (só master): ver `server/utils/papeis.ts`.
 */
import { erroDoPainel, perguntarAoPainel } from '../../../utils/agentes'

export default defineEventHandler(async () => {
  const [visao, saude] = await Promise.allSettled([
    perguntarAoPainel('visao'),
    perguntarAoPainel('saude'),
  ])
  if (visao.status === 'rejected') throw erroDoPainel(visao.reason)
  return {
    visao: visao.value,
    saude: saude.status === 'fulfilled' ? saude.value : null,
    avisoSaude: saude.status === 'rejected'
      ? 'Não consegui ler a saúde dos fluxos agora; as conversas abaixo estão atualizadas.'
      : null,
  }
})
