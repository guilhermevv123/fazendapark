/**
 * Porteiro de TODA rota administrativa. Deny-by-default.
 *
 * A regra é de cima pra baixo: qualquer coisa sob `/api/admin/` exige sessão,
 * sem exceção e sem o handler precisar lembrar de pedir. O jeito oposto —
 * cada rota chamando `exigir()` por conta própria — já falhou em sistema de
 * produção mais de uma vez: a rota nova nasce sem a linha, ninguém percebe
 * porque a tela continua bonita, e o dado sai pela API aberta.
 *
 * Aqui, esquecer é o contrário: rota nova nasce TRANCADA. Quem quiser abrir
 * precisa entrar na lista `PUBLICAS` de propósito, e isso aparece no diff.
 */
import { lerSessao, podeFazer, type Sessao } from '../utils/sessao'

/** Rotas administrativas que rodam sem login. Adicionar aqui é decisão. */
const PUBLICAS: string[] = []

/**
 * Prefixo da rota → área de permissão. O primeiro que casar manda.
 * Sem correspondência, exige só sessão válida (qualquer papel).
 */
const AREAS: [string, string][] = [
  ['/api/admin/evento/', 'evento'],
  ['/api/admin/eventos', 'evento'],
  ['/api/admin/venda', 'venda'],
  ['/api/admin/cortesia', 'cortesia'],
  ['/api/admin/cupom', 'cupom'],
  ['/api/admin/promoter', 'promoter'],
  ['/api/admin/relatorio', 'relatorio'],
  ['/api/admin/financeiro', 'financeiro'],
  ['/api/admin/equipe', 'equipe'],
  ['/api/admin/organizacoes', 'evento'],
]

/** Rotas de ingresso que a portaria usa — sessão obrigatória, área portaria. */
const PORTARIA = ['/api/checkin']

export default defineEventHandler(async (event) => {
  const caminho = getRequestURL(event).pathname
  const metodo = event.method

  const admin = caminho.startsWith('/api/admin/')
  const portaria = PORTARIA.some((p) => caminho.startsWith(p))
  if (!admin && !portaria) return
  if (PUBLICAS.some((p) => caminho.startsWith(p))) return

  const sessao = await lerSessao(event)
  if (!sessao) throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })

  // Origem, para requisição que muda estado. O cookie é SameSite=Lax, o que
  // já barra POST vindo de outro site; esta checagem é o cinto além do
  // suspensório, e de propósito NÃO é um token com prazo próprio — token de
  // CSRF que vence antes da sessão devolve 403 em todo salvamento com o
  // usuário logado, e o motivo real fica invisível.
  if (metodo !== 'GET' && metodo !== 'HEAD') {
    const origem = getRequestHeader(event, 'origin')
    if (origem) {
      const meu = getRequestURL(event).origin
      if (origem !== meu) {
        throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
      }
    }
  }

  const area = portaria ? 'portaria' : AREAS.find(([p]) => caminho.startsWith(p))?.[1]
  if (area && !podeFazer(sessao.papel, area)) {
    throw createError({
      statusCode: 403,
      statusMessage: `Seu acesso (${sessao.papel}) não inclui ${area}.`,
    })
  }

  // Disponível para os handlers sem repetir a consulta.
  event.context.sessao = sessao as Sessao
})
