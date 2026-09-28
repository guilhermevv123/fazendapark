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
import { documentoDaEmpresaValido, somenteDigitos } from '../../../app/composables/dadosDaEmpresa'
import { explicarErro } from './evento/index.post'

/** texto opcional do cadastro: espaço some, vazio vira `null` (apaga), ausente não mexe */
const opcional = (max: number) => z.string().trim().max(max).nullish()
  .transform((v) => (v === undefined ? undefined : (v ? v : null)))

const Entrada = z.object({
  // trim ANTES do min: "   " passava no min(2) e apagava o nome da organização
  nome: z.string().trim().min(2).max(160).optional(),
  documento: opcional(20),
  ambienteAsaas: z.enum(['sandbox', 'production']).optional(),
  // a chave colada com menos de 20 caracteres não é chave do Asaas (a tela avisa antes — CFG-01)
  chaveAsaas: z.string().trim().min(20).max(400).nullish(),
  carteiraAsaas: opcional(80),

  // Os dados que o site de vendas mostra (Decreto 7.962/2013 — auditoria PROD-08). Nada é
  // inventado: o que ficar vazio o site omite.
  razaoSocial: opcional(200),
  enderecoLinha: opcional(200),
  enderecoBairro: opcional(120),
  enderecoCidade: opcional(120),
  enderecoUf: opcional(2),
  // com pontuação colada ("45.550-000") passa do tamanho do número: o formato é conferido depois
  enderecoCep: opcional(12),
  emailAtendimento: z.string().trim().max(160).email().nullish().or(z.literal('').transform(() => null)),
  telefoneAtendimento: opcional(25),
  encarregadoDados: opcional(200),
})

/** Os nomes da tela, pro erro dizer QUAL campo — "Dados inválidos" seco não se conserta (CFG-04). */
const ROTULOS: Record<string, string> = {
  nome: 'Nome', documento: 'CNPJ ou CPF', chaveAsaas: 'Chave de API do Asaas',
  carteiraAsaas: 'Carteira (walletId)', ambienteAsaas: 'Ambiente',
  razaoSocial: 'Razão social', enderecoLinha: 'Endereço', enderecoBairro: 'Bairro',
  enderecoCidade: 'Cidade', enderecoUf: 'UF', enderecoCep: 'CEP',
  emailAtendimento: 'E-mail de atendimento', telefoneAtendimento: 'Telefone de atendimento',
  encarregadoDados: 'Encarregado de dados (LGPD)',
}

/** Recusa com frase — o campo e o que fazer. */
const recusar = (frase: string) => { throw createError({ statusCode: 422, statusMessage: frase }) }

export default defineEventHandler(async (event) => {
  const sessao = (event.context as any).sessao
  const orgId = sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })
  // O papel FINO, o mesmo que o `middleware/03.papel.ts` leu do banco — a checagem antiga lia o
  // `role` legado ("master" ou "admin"), e o financeiro tem `role = 'admin'` (auditoria CFG-03).
  if ((event.context as any).papel !== 'master') {
    throw createError({
      statusCode: 403,
      statusMessage: 'Só o master muda o cadastro e as credenciais de cobrança.',
    })
  }

  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: explicarErro(p.error, ROTULOS), data: p.error.flatten() })
  }
  const d = p.data

  // Formato conferido aqui, com frase de gente (a máscara da tela é conforto; quem decide é a rota).
  if (d.documento && !documentoDaEmpresaValido(d.documento)) {
    recusar('CNPJ ou CPF: o número não confere (dígito verificador errado). Copie do cartão do CNPJ, com ou sem pontuação.')
  }
  if (d.documento) d.documento = d.documento.toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (d.enderecoUf) {
    if (!/^[A-Za-z]{2}$/.test(d.enderecoUf)) recusar('UF: use a sigla do estado com duas letras (ex.: BA).')
    d.enderecoUf = d.enderecoUf.toUpperCase()
  }
  if (d.enderecoCep) {
    d.enderecoCep = somenteDigitos(d.enderecoCep)
    if (d.enderecoCep.length !== 8) recusar('CEP: são 8 números (ex.: 45000-000).')
  }
  if (d.telefoneAtendimento) {
    d.telefoneAtendimento = somenteDigitos(d.telefoneAtendimento)
    if (!/^\d{10,11}$/.test(d.telefoneAtendimento)) {
      recusar('Telefone de atendimento: informe com DDD, só números (ex.: (73) 99999-9999).')
    }
  }

  const atual = await q1<any>(
    `SELECT name, document, asaas_env, asaas_wallet, asaas_api_key,
            asaas_api_key IS NOT NULL AS tem_chave,
            legal_name, address_line, address_district, address_city, address_state, address_zip,
            support_email, support_phone, privacy_contact
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
  // os dados públicos da empresa (rodapé do site, termos, privacidade) — PROD-08
  const LEGAIS: [keyof typeof d, string, string][] = [
    ['razaoSocial', 'legal_name', 'razaoSocial'],
    ['enderecoLinha', 'address_line', 'enderecoLinha'],
    ['enderecoBairro', 'address_district', 'enderecoBairro'],
    ['enderecoCidade', 'address_city', 'enderecoCidade'],
    ['enderecoUf', 'address_state', 'enderecoUf'],
    ['enderecoCep', 'address_zip', 'enderecoCep'],
    ['emailAtendimento', 'support_email', 'emailAtendimento'],
    ['telefoneAtendimento', 'support_phone', 'telefoneAtendimento'],
    ['encarregadoDados', 'privacy_contact', 'encarregadoDados'],
  ]
  for (const [campo, coluna, rotulo] of LEGAIS) {
    if (d[campo] !== undefined && d[campo] !== atual[coluna]) por(coluna, d[campo], rotulo, atual[coluna])
  }
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
