/**
 * GET /api/conta/fidelidade — onde a conta está no "Volte Mais" (037): já ganhou? quantos retornos
 * sobram? até quando? É o aviso de "Meus ingressos" ("Você tem 2 retornos com 50%"). Nada aqui
 * decide preço: quem decide é o checkout (utils/fidelidade.ts).
 */
import { db } from '../../utils/db'
import { contaDaSessaoDoCliente } from '../../utils/conta-do-cliente'
import { diaNoFusoDaFidelidade, programaDeFidelidadeDaOrg, situacaoNaFidelidade } from '../../utils/fidelidade'
import { regulamentoDaFidelidade } from '../../utils/fidelidade-texto'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const conta = await contaDaSessaoDoCliente(event)
  if (!conta) throw createError({ statusCode: 401, statusMessage: 'Entre na sua conta.', data: { tipo: 'conta' } })
  const p = await programaDeFidelidadeDaOrg(db(), conta.orgId)
  const hoje = diaNoFusoDaFidelidade(new Date())
  if (!p || !p.ativo || !p.vigencia_inicio || !p.vigencia_fim || hoje < p.vigencia_inicio || hoje > p.vigencia_fim) {
    return { ativo: false }
  }
  const s = await situacaoNaFidelidade(db(), p, conta.cpf)
  return {
    ativo: true,
    nome: p.nome,
    descontoPct: p.desconto_bps / 100,
    consumacaoPct: p.consumacao_bps / 100,
    retornos: p.retornos,
    ...(s.qualificado
      ? { qualificado: true, restantes: s.restantes, validoAte: s.validoAte, primeiraVisita: s.primeiraVisita }
      : { qualificado: false, motivo: s.motivo }),
    regulamento: p.regulamento || regulamentoDaFidelidade(p),
  }
})
