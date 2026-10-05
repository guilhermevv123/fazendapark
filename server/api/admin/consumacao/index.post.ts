/**
 * POST /api/admin/consumacao { token | codigo, semEntrada? } — dar baixa no cupom de consumação
 * do Volte Mais (042). A decisão é do servidor, com a linha travada (utils/cupom-consumacao.ts):
 * 409 com `data.tipo` quando não pode (já usado, outro dia, cancelado, sem entrada registrada).
 */
import { z } from 'zod'
import { CupomRecusadoNoCaixa, darBaixaNoCupom, situacaoParaOCaixa } from '../../../utils/cupom-consumacao'
import { autorDaSessao } from '../../../utils/base-conhecimento'

const Entrada = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/).optional(),
  codigo: z.string().max(20).optional(),
  semEntrada: z.boolean().optional(),
}).refine((b) => !!b.token || !!b.codigo, { message: 'token ou código' })

export default defineEventHandler(async (event) => {
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) throw createError({ statusCode: 400, statusMessage: 'Mande o QR ou o código do cupom.' })
  const sessao = event.context.sessao
  try {
    const s = await darBaixaNoCupom({ orgId: sessao.orgId, token: p.data.token, codigo: p.data.codigo },
      autorDaSessao(sessao) || 'caixa', { semEntrada: p.data.semEntrada })
    return { ok: true, cupom: situacaoParaOCaixa(s) }
  } catch (e) {
    if (e instanceof CupomRecusadoNoCaixa) {
      throw createError({ statusCode: e.tipo === 'inexistente' ? 404 : 409, statusMessage: e.message,
        data: { tipo: e.tipo, cupom: e.situacao ? situacaoParaOCaixa(e.situacao) : null } })
    }
    throw e
  }
})
