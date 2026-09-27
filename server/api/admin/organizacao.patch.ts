/**
 * PATCH /api/admin/organizacao — cadastro e credenciais do Asaas.
 *
 * Duas regras que vieram de como o dinheiro entra:
 *
 * 1. **Chave e ambiente têm que concordar DEPOIS de salvar.** Quem escolhe a
 *    URL do gateway é o PREFIXO da chave (`ambienteDaChave`, em `utils/asaas.ts`);
 *    a configuração só desempata chave sem prefixo. Até 27/09 esta rota aceitava
 *    trocar só o `<select>`: com a chave de sandbox gravada, "Produção" passava,
 *    o selo dizia PRODUÇÃO e o checkout seguia gerando PIX de sandbox — e o
 *    avesso, chave de produção com o selo "Testes — ninguém é cobrado", cobrava
 *    de verdade (auditoria ORG-01, P0). A regra mora em `utils/asaas-ambiente.ts`
 *    e confere a chave que VAI ficar (a colada agora ou a já gravada) contra o
 *    ambiente que vai ficar. Produção sem chave continua recusada.
 *
 * 2. **Chave só entra, nunca sai.** Mandar `null` apaga; mandar texto grava;
 *    não mandar o campo deixa como está. Não existe como ler de volta — nem
 *    por esta rota, nem pela de leitura. A chave gravada é lida aqui SÓ pra
 *    conferir o prefixo; não volta na resposta nem entra na auditoria.
 *
 * Só o master mexe (a grade de `utils/papeis.ts` já tranca a área
 * `organizacao`; a linha do handler é o cinto além do suspensório).
 */
import { z } from 'zod'
import { q1, tx } from '../../utils/db'
import { autorDaRequisicao, registrarAuditoria } from '../../utils/auditoria'
import { recusaDeAmbiente, type AmbienteAsaas } from '../../utils/asaas-ambiente'

const Entrada = z.object({
  // trim ANTES do min: "   " passava no min(2) e apagava o nome da organização
  nome: z.string().trim().min(2).max(160).optional(),
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
    `SELECT name, document, asaas_env, asaas_wallet, asaas_api_key,
            asaas_api_key IS NOT NULL AS tem_chave
       FROM organizations WHERE id = $1`, [orgId])
  if (!atual) throw createError({ statusCode: 404, statusMessage: 'Organização não encontrada' })

  // Mexeu em chave OU em ambiente: confere o par que vai ficar gravado. Salvar só
  // o nome não passa por aqui — uma organização já divergente continua podendo
  // corrigir o cadastro, e a tela grita a divergência (ver `organizacao.get.ts`).
  if (d.ambienteAsaas !== undefined || d.chaveAsaas !== undefined) {
    const recusa = recusaDeAmbiente({
      chaveFinal: d.chaveAsaas === undefined ? atual.asaas_api_key : d.chaveAsaas,
      ambienteFinal: (d.ambienteAsaas ?? atual.asaas_env) as AmbienteAsaas,
      chaveNova: typeof d.chaveAsaas === 'string',
    })
    if (recusa) throw createError({ statusCode: 422, statusMessage: recusa })
  }

  const set: string[] = []
  const par: any[] = [orgId]
  const antes: Record<string, unknown> = {}
  const log: Record<string, unknown> = {}
  const por = (coluna: string, valor: any, rotulo?: string, anterior?: unknown) => {
    par.push(valor)
    set.push(`${coluna} = $${par.length}`)
    if (rotulo) { log[rotulo] = valor; antes[rotulo] = anterior ?? null }
  }

  if (d.nome !== undefined) por('name', d.nome, 'nome', atual.name)
  if (d.documento !== undefined) por('document', d.documento, 'documento', atual.document)
  if (d.ambienteAsaas !== undefined) por('asaas_env', d.ambienteAsaas, 'ambienteAsaas', atual.asaas_env)
  if (d.carteiraAsaas !== undefined) por('asaas_wallet', d.carteiraAsaas, 'carteiraAsaas', atual.asaas_wallet)
  // o VALOR da chave não entra no log de auditoria — só o fato da troca
  if (d.chaveAsaas !== undefined) {
    por('asaas_api_key', d.chaveAsaas)
    antes.chaveAsaas = atual.tem_chave ? 'configurada' : 'ausente'
    log.chaveAsaas = d.chaveAsaas === null ? 'removida' : 'trocada'
  }

  if (!set.length) return { ok: true, semMudanca: true }

  return await tx(async (c) => {
    try {
      await c.query(`UPDATE organizations SET ${set.join(', ')} WHERE id = $1`, par)
      // Autor nas colunas, na mesma transação. `registrarAuditoria` não grava
      // quando antes == depois (salvar sem mexer em nada não é ato).
      await registrarAuditoria({
        autor: autorDaRequisicao(event),
        entidade: 'organizacao',
        entidadeId: orgId,
        acao: 'editada',
        antes,
        depois: log,
      }, c)
      return { ok: true }
    } catch (e: any) {
      if (e?.code === '23505') {
        throw createError({ statusCode: 409, statusMessage: 'Já existe organização com esse endereço.' })
      }
      throw e
    }
  })
})
