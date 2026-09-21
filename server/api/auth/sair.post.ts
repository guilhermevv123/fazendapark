/**
 * POST /api/auth/sair — sair do painel.
 *
 * ## O defeito que isto fecha
 *
 * Esta rota respondia `{ ok: true }` sem nunca olhar se tinha conseguido
 * encerrar alguma coisa. Medido no servidor no ar, com um `dt_sessao` de
 * resíduo na frente do bom (é o que o navegador faz quando há dois cookies de
 * mesmo nome e caminhos diferentes — ver `segredosDoCookie`):
 *
 * | passo                                   | antes            | agora |
 * |-----------------------------------------|------------------|-------|
 * | POST /api/auth/sair                     | 200 `{ok:true}`  | 200 `{ok:true, saiu:true, sessoesEncerradas:1}` |
 * | GET /api/auth/eu (com o cookie bom)     | **"Dono" master**| `{usuario:null}` |
 * | GET /admin (com o cookie bom)           | **renderizou**   | manda pro login |
 * | `sessions.revoked_at` do token bom      | **NULL**         | carimbado |
 *
 * "Saiu" era uma frase da tela, não um fato do servidor: quem fechasse o
 * painel no computador do guichê deixava a sessão de pé, viva pelos 30 dias
 * da renovação deslizante, pra quem sentasse depois.
 *
 * ## Por que a rota CONFERE antes de responder
 *
 * Revogar e responder "ok" é a mesma promessa vazia de antes, um passo
 * adiante: `UPDATE` que casa zero linha não levanta erro nenhum. Aqui a rota
 * relê a sessão pelo MESMO caminho que todo mundo lê — `lerSessao`, a função
 * que `/api/auth/eu` chama e que o `middleware/01.autenticacao.ts` chama antes
 * de servir qualquer página de `/admin`. Se ela ainda achar sessão, a resposta
 * NÃO diz que saiu: diz que não conseguiu, e o que fazer.
 */
import { encerrarSessao, lerSessao } from '../../utils/sessao'

export default defineEventHandler(async (event) => {
  const saida = await encerrarSessao(event)

  // A conferência. `lerSessao` lê o cookie do PEDIDO (o apagado vai na
  // resposta), então ela ainda tenta abrir a porta com a mesma chave que o
  // navegador acabou de usar — que é exatamente o que precisa ter morrido.
  const aindaEntra = await lerSessao(event)
  if (aindaEntra) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Não consegui encerrar a sua sessão neste aparelho. '
        + 'Feche o navegador e avise um master da sua organização — o acesso continua aberto.',
    })
  }

  return {
    ok: true,
    saiu: true,
    /** quantas linhas de sessão este pedido revogou (0 = o cookie já não valia) */
    sessoesEncerradas: saida.revogadas,
  }
})
