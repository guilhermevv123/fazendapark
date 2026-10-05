/**
 * GET /api/admin/consumacao?token=…|codigo=… — Caixa do bar (042): a atendente confere o cupom de
 * consumação do Volte Mais. Versão completa (nome, CPF pra conferir com o documento, hora da
 * entrada de hoje, quem deu as baixas). Área `portaria` (utils/papeis.ts).
 * Sem token nem código: devolve as últimas baixas (a lista da tela do caixa).
 */
import { cupomDeConsumacaoPeloCodigo, cupomDeConsumacaoPeloToken, situacaoParaOCaixa, ultimasBaixasDeCupom } from '../../../utils/cupom-consumacao'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const orgId = event.context.sessao.orgId as string
  const { token, codigo } = getQuery(event) as { token?: string; codigo?: string }
  if (!token && !codigo) return { baixas: await ultimasBaixasDeCupom(orgId, 20) }
  const s = token ? await cupomDeConsumacaoPeloToken(String(token)) : await cupomDeConsumacaoPeloCodigo(orgId, String(codigo))
  // cupom de OUTRO parque responde igual a "não existe" — não confirma que o token é real
  if (!s || s.cupom.org_id !== orgId) {
    throw createError({ statusCode: 404, statusMessage: 'Cupom não encontrado neste parque. Confira o código.' })
  }
  return { cupom: situacaoParaOCaixa(s) }
})

