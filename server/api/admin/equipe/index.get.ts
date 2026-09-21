/**
 * GET /api/admin/equipe — quem tem acesso ao painel.
 *
 * Traz junto a última entrada e quantas sessões estão abertas. Esses dois
 * números são o que responde "esse login ainda é de alguém?" — conta de
 * pessoa que saiu da empresa fica ativa em silêncio, e a tela de equipe é o
 * único lugar onde isso aparece.
 *
 * O `papel` que sai daqui é a coluna `papel`, não o `role` legado: é a coluna
 * que o `middleware/03.papel.ts` usa pra decidir cada rota. Mostrar o `role`
 * faria a tela dizer "Administrador" pra quem, na prática, só pode mexer em
 * dinheiro — e a tela de permissão mentindo sobre permissão é pior que não
 * ter tela.
 *
 * O CATÁLOGO de papéis também vem daqui, do servidor, em vez de estar
 * escrito na página. A lista de "o que cada papel pode" já foi uma cópia no
 * `.vue`, e cópia de regra de permissão envelhece do jeito mais silencioso
 * que existe: a grade muda de um lado e a tela continua prometendo o antigo.
 *
 * Nunca devolve `password_hash`. Hash em JSON vira hash em log, em cache de
 * navegador e em print de tela.
 *
 * **Só `master` lê.** O `middleware/03.papel.ts` já barra a área `equipe` pros
 * outros três papéis; a linha aqui embaixo é o mesmo cinto além do suspensório
 * que o POST e o PATCH já tinham — e que só faltava aqui. Sem ela, o dia em
 * que alguém puser `equipe` na lista de outro papel em `papeis.ts` abre a
 * LISTA (nome, e-mail, última entrada, quantas sessões abertas cada um tem) de
 * um lado só: gravar continuaria recusado e ler passaria a valer, sem nada
 * denunciar a diferença.
 */
import { q, q1 } from '../../../utils/db'
import { CATALOGO, ehPapel, papelDoRoleLegado } from '../../../utils/papeis'

export default defineEventHandler(async (event) => {
  const sessao = (event.context as any).sessao
  const orgId = sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })
  if ((event.context as any).papel !== 'master') {
    throw createError({ statusCode: 403, statusMessage: 'Só um master vê a equipe.' })
  }

  const [pessoas, org] = await Promise.all([
    q<any>(
      `SELECT u.id, u.name, u.email, u.papel, u.role, u.active, u.last_login_at, u.created_at,
              (SELECT count(*) FROM sessions s
                WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now())::int AS sessoes,
              (SELECT count(*) FROM checkins c WHERE c.operator_id = u.id)::int AS leituras
         FROM users u
        WHERE u.org_id = $1
        ORDER BY u.active DESC, u.name`, [orgId]),

    q1<any>(`SELECT id, name FROM organizations WHERE id = $1`, [orgId]),
  ])

  return {
    organizacao: org ? { id: org.id, nome: org.name } : null,
    eu: sessao?.usuarioId ?? null,
    papeis: CATALOGO,
    pessoas: pessoas.map((p) => ({
      id: p.id, nome: p.name, email: p.email,
      papel: ehPapel(p.papel) ? p.papel : papelDoRoleLegado(p.role),
      ativo: p.active,
      ultimaEntrada: p.last_login_at, criadoEm: p.created_at,
      sessoesAbertas: p.sessoes, leituras: p.leituras,
    })),
  }
})
