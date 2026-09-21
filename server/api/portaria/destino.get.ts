/**
 * GET /api/portaria/destino — quais eventos têm leitor de entrada pra este login.
 *
 * A portaria não alcança a lista de eventos (`GET /api/admin/eventos` é 403
 * pra ela, de propósito — ali tem venda, estoque e faturamento), e o leitor
 * mora DENTRO de um evento: `/admin/evento/<id>/validacao`. Sem esta rota o
 * porteiro entrava com o login certo e dava de cara com "esta lista não é do
 * seu acesso" — um beco sem saída, com fila na frente, e a única saída era
 * pedir a um master o endereço do leitor por mensagem.
 *
 * Devolve só o que abre a porta: `id` e `nome` dos eventos PUBLICADOS da
 * organização de quem pergunta e que ainda não acabaram (um dia de folga
 * depois do fim, pra leitura de madrugada). Sem valor, sem pedido, sem
 * estoque — a portaria continua sem ver a lista de verdade.
 *
 * ## Por que a autenticação é feita à mão aqui
 *
 * Mesma razão de `sincronizar.post.ts`: `/api/portaria/*` não cai no
 * middleware 01 (que tranca `/api/admin/*` e `/api/checkin`) nem na tabela do
 * 03. Rota nova aqui nasceria ABERTA, então ela repete as cercas da casa —
 * sessão e área — com as mesmas funções. É GET e não escreve nada, então a
 * cerca de origem (que existe pra POST) não se aplica.
 */
import { q } from '../../utils/db'
import { exigir } from '../../utils/sessao'
import { papelPode, ROTULO } from '../../utils/papeis'

export default defineEventHandler(async (event) => {
  const sessao = await exigir(event, 'portaria')

  // A grade FINA, a que o resto da casa usa. `exigir` acima confere só a grossa
  // (`users.role`); a decisão de quem entra é esta.
  if (!papelPode(sessao.papelFino, 'portaria')) {
    throw createError({
      statusCode: 403,
      statusMessage: `Seu acesso é de ${ROTULO[sessao.papelFino] ?? sessao.papelFino} e não inclui o leitor de entrada. `
        + `Peça a um master da sua organização.`,
    })
  }

  const eventos = await q<{ id: string; nome: string }>(
    `SELECT id, name AS nome
       FROM events
      WHERE org_id = $1
        AND status = 'ativo'
        AND canceled_at IS NULL
        AND COALESCE(ends_at, starts_at + interval '1 day') > now() - interval '1 day'
      ORDER BY starts_at, id
      LIMIT 20`,
    [sessao.orgId])

  return { eventos }
})
