/**
 * PATCH /api/admin/organizacao — cadastro e credenciais do Asaas.
 *
 * Duas regras que vieram de como o dinheiro entra:
 *
 * 1. **Trocar de sandbox pra produção sem chave é o erro caro.** O sistema
 *    passaria a gerar cobrança de verdade apontando pra uma credencial que
 *    não existe: o comprador paga e o webhook nunca confirma. Aqui a troca
 *    de ambiente exige a chave daquele ambiente na mesma requisição, ou
 *    recusa.
 *
 * 2. **Chave só entra, nunca sai.** Mandar `null` apaga; mandar texto grava;
 *    não mandar o campo deixa como está. Não existe como ler de volta — nem
 *    por esta rota, nem pela de leitura.
 *
 * Só master e admin mexem: credencial de cobrança é a chave do caixa.
 */
import { z } from 'zod'
import { q1, tx } from '../../utils/db'

const Entrada = z.object({
  nome: z.string().min(2).max(160).optional(),
  documento: z.string().max(20).nullish(),
  ambienteAsaas: z.enum(['sandbox', 'production']).optional(),
  chaveAsaas: z.string().min(20).max(400).nullish(),
  carteiraAsaas: z.string().max(80).nullish(),
})

export default defineEventHandler(async (event) => {
  const sessao = (event.context as any).sessao
  const orgId = sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })
  if (sessao.papel !== 'master' && sessao.papel !== 'admin') {
    throw createError({
      statusCode: 403,
      statusMessage: 'Só master e admin mudam o cadastro e as credenciais de cobrança.',
    })
  }

  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data

  const atual = await q1<any>(
    `SELECT asaas_env, asaas_api_key IS NOT NULL AS tem_chave
       FROM organizations WHERE id = $1`, [orgId])
  if (!atual) throw createError({ statusCode: 404, statusMessage: 'Organização não encontrada' })

  const ambienteNovo = d.ambienteAsaas ?? atual.asaas_env
  const mudouAmbiente = d.ambienteAsaas != null && d.ambienteAsaas !== atual.asaas_env
  const vaiFicarSemChave = d.chaveAsaas === null || (!atual.tem_chave && d.chaveAsaas == null)

  if (ambienteNovo === 'production' && (mudouAmbiente || d.chaveAsaas !== undefined)
      && vaiFicarSemChave) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Produção sem chave do Asaas geraria cobrança de verdade que nunca confirma. '
        + 'Informe a chave de produção junto com a troca de ambiente.',
    })
  }

  // A chave de produção do Asaas começa com $aact_prod_ e a de sandbox com
  // $aact_hmlg_ / $aact_. Trocar as duas de lugar é o engano que só aparece
  // quando o primeiro comprador não recebe o ingresso.
  if (d.chaveAsaas) {
    const ehProd = d.chaveAsaas.startsWith('$aact_prod_')
    if (ambienteNovo === 'production' && !ehProd) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Esta não parece uma chave de produção do Asaas '
          + '(as de produção começam com $aact_prod_).',
      })
    }
    if (ambienteNovo === 'sandbox' && ehProd) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Você colou a chave de PRODUÇÃO num ambiente de testes. '
          + 'Isso cobraria de verdade quem estivesse só testando.',
      })
    }
  }

  const set: string[] = []
  const par: any[] = [orgId]
  const log: any = {}
  const por = (coluna: string, valor: any, rotulo?: string) => {
    par.push(valor)
    set.push(`${coluna} = $${par.length}`)
    if (rotulo) log[rotulo] = valor
  }

  if (d.nome !== undefined) por('name', d.nome.trim(), 'nome')
  if (d.documento !== undefined) por('document', d.documento, 'documento')
  if (d.ambienteAsaas !== undefined) por('asaas_env', d.ambienteAsaas, 'ambienteAsaas')
  if (d.carteiraAsaas !== undefined) por('asaas_wallet', d.carteiraAsaas, 'carteiraAsaas')
  // o VALOR da chave não entra no log de auditoria — só o fato da troca
  if (d.chaveAsaas !== undefined) {
    por('asaas_api_key', d.chaveAsaas)
    log.chaveAsaas = d.chaveAsaas === null ? 'removida' : 'trocada'
  }

  if (!set.length) return { ok: true, semMudanca: true }

  return await tx(async (c) => {
    try {
      await c.query(`UPDATE organizations SET ${set.join(', ')} WHERE id = $1`, par)
      await c.query(
        `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
         VALUES ($1,'organizacao',$1,'editada',$2::jsonb)`,
        [orgId, JSON.stringify({ ...log, porQuem: sessao.email })])
      return { ok: true }
    } catch (e: any) {
      if (e?.code === '23505') {
        throw createError({ statusCode: 409, statusMessage: 'Já existe organização com esse endereço.' })
      }
      throw e
    }
  })
})
