/**
 * Porteiro de `/api/comandas/*` (055). Deny-by-default, como o de `/api/admin`.
 *
 * A comanda mora FORA de `/api/admin` de propósito: a grade de papéis do painel
 * (`utils/papeis.ts`) não muda e nenhuma rota que já existe é tocada. Aqui a régua é o
 * NÍVEL na comanda (`comanda_acessos`): atendente < caixa < gerente. O master da
 * organização é gerente sem precisar de linha.
 *
 * Com a chave `comanda_config.ativo` desligada, só o master passa — é ele quem monta o
 * cardápio, cadastra pulseira e liga quando estiver pronto.
 */
import { caminhoDaRota, mutacaoDeOutroSite } from '../utils/caminho'
import { conferirPinDoLink, configDaComanda, hashDoLink, type ContextoDaComanda, type Nivel } from '../utils/comandas'
import { q1 } from '../utils/db'
import { lerSessao } from '../utils/sessao'

/**
 * O que o LINK do funcionário pode chamar — e nada mais. Atender (estado, pulseira, abrir,
 * pedido, desfazer), ver e fechar a conta, e a lista das contas de hoje. Relatório, caixa,
 * cardápio, configuração e equipe ficam de fora mesmo que a rota aceite atendente.
 */
const ROTAS_DO_LINK: [string, RegExp][] = [
  ['GET', /^\/api\/comandas\/estado$/],
  ['GET', /^\/api\/comandas\/hoje$/],
  ['GET', /^\/api\/comandas\/pulseira\/[^/]+$/],
  ['POST', /^\/api\/comandas\/abrir$/],
  ['POST', /^\/api\/comandas\/pedidos$/],
  ['POST', /^\/api\/comandas\/pedidos\/[^/]+\/desfazer$/],
  ['GET', /^\/api\/comandas\/conta\/[^/]+$/],
  ['POST', /^\/api\/comandas\/conta\/[^/]+\/(pagar|corrigir)$/],
]

export default defineEventHandler(async (event) => {
  const caminho = caminhoDaRota(event)
  if (!caminho.startsWith('/api/comandas')) return

  // Entrada pelo link do funcionário: não usa a sessão do sistema (o funcionário não tem login).
  const segredo = String(getRequestHeader(event, 'x-comanda-link') ?? '').trim()
  if (segredo) {
    if (event.method !== 'GET' && event.method !== 'HEAD' && mutacaoDeOutroSite(event)) {
      throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
    }
    if (!ROTAS_DO_LINK.some(([m, r]) => m === event.method && r.test(caminho))) {
      throw createError({ statusCode: 403, statusMessage: 'O link do atendente não abre esta parte.' })
    }
    const link = await q1<any>(
      `SELECT id, org_id, nome, criado_por, pin_hash
         FROM comanda_links WHERE token_hash = $1 AND desativado_em IS NULL`, [hashDoLink(segredo)])
    if (!link) {
      throw createError({ statusCode: 401, statusMessage: 'Este link foi desligado ou não existe. Peça um link novo ao gerente.', data: { codigo: 'link' } })
    }
    await conferirPinDoLink(link, getRequestHeader(event, 'x-comanda-pin'))
    const config = await configDaComanda(link.org_id)
    if (!config.ativo) throw createError({ statusCode: 403, statusMessage: 'As comandas ainda não foram ligadas pelo gerente.' })
    q1(`UPDATE comanda_links SET ultimo_uso_em = now() WHERE id = $1 AND (ultimo_uso_em IS NULL OR ultimo_uso_em < now() - interval '1 minute') RETURNING id`, [link.id]).catch(() => {})
    const aparelhoDoLink = String(getRequestHeader(event, 'x-aparelho') ?? '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40) || null
    ;(event.context as any).comanda = {
      orgId: link.org_id,
      // as tabelas pedem um usuário: fica quem criou o link; QUEM FEZ de fato é o link (link_id e nome)
      usuarioId: link.criado_por,
      nome: link.nome,
      email: '',
      nivel: 'atendente',
      master: false,
      aparelho: aparelhoDoLink,
      linkId: link.id,
    } satisfies ContextoDaComanda
    return
  }

  const sessao = await lerSessao(event)
  if (!sessao) throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })

  if (event.method !== 'GET' && event.method !== 'HEAD' && mutacaoDeOutroSite(event)) {
    throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
  }

  const master = sessao.papelFino === 'master'
  let nivel: Nivel | null = master ? 'gerente' : null
  if (!nivel) {
    const a = await q1<{ nivel: Nivel }>(
      `SELECT nivel FROM comanda_acessos WHERE user_id = $1 AND org_id = $2`, [sessao.usuarioId, sessao.orgId])
    nivel = a?.nivel ?? null
  }
  if (!nivel) {
    throw createError({ statusCode: 403, statusMessage: 'Seu acesso não inclui as comandas. Peça ao gerente para liberar.' })
  }

  const config = await configDaComanda(sessao.orgId)
  if (!config.ativo && !master) {
    throw createError({ statusCode: 403, statusMessage: 'As comandas ainda não foram ligadas pelo gerente.' })
  }

  const aparelho = String(getRequestHeader(event, 'x-aparelho') ?? '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40) || null

  ;(event.context as any).sessao = sessao
  ;(event.context as any).comanda = {
    orgId: sessao.orgId,
    usuarioId: sessao.usuarioId,
    nome: sessao.nome,
    email: sessao.email,
    nivel,
    master,
    aparelho,
  } satisfies ContextoDaComanda
})
