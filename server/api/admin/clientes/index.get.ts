/**
 * GET /api/admin/clientes — a base de clientes da organização.
 *
 * É o cadastro que o formulário do site preenche (migração 027) somado ao que
 * o cliente já comprou. Serve pra uma pergunta só: "quem é essa gente e como
 * falo com ela" — follow-up, remarketing, lista pro WhatsApp. Por isso a lista
 * carrega, ao lado de cada pessoa, o que ela comprou.
 *
 * ## O que a lista NÃO mostra
 *
 * O CPF sai mascarado (`***.982.247-**`); o número inteiro só na ficha
 * (`clientes/[id]`), que é uma consulta por pessoa. Uma lista de cinquenta
 * linhas com CPF inteiro é o vazamento pronto pra virar print de tela.
 *
 * ## Quem é "cliente"
 *
 * Todo mundo que existe em `customers` — inclusive quem só gerou um PIX que
 * expirou. `pedidos` conta só o que virou dinheiro (`PEDIDO_VIVO`), e o filtro
 * `situacao` separa "compraram" de "só tentaram": para remarketing, quem
 * tentou e não pagou é justamente o contato mais quente.
 *
 * `gastoCents` é o que a PESSOA pagou (cobrado menos o que voltou pra ela), não
 * o líquido do produtor — o mesmo critério do "quem mais comprou" do relatório.
 */
import { q, q1 } from '../../../utils/db'
import { PEDIDO_VIVO } from '../../../utils/liquido'
import { cpfMascarado, SQL_FAIXA, SQL_IDADE } from '../../../utils/cadastro'
import { filtroDeClientes, FiltroInvalido } from '../../../utils/clientes-filtro'

/** ordem por NOME de opção — o que vai pro `ORDER BY` nunca vem da URL */
const ORDEM: Record<string, string> = {
  recentes: 'cu.created_at DESC, cu.id',
  nome: 'cu.name ASC, cu.id',
  gasto: 'gasto DESC, cu.name, cu.id',
  compras: 'pedidos DESC, gasto DESC, cu.name, cu.id',
}

export default defineEventHandler(async (event) => {
  const orgId = (event.context as any).sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })

  const query = getQuery(event) as Record<string, string | undefined>
  let filtro
  try { filtro = filtroDeClientes(orgId, query) }
  catch (e) {
    if (e instanceof FiltroInvalido) throw createError({ statusCode: 400, statusMessage: e.message })
    throw e
  }

  const porPagina = Math.min(100, Math.max(1, Math.trunc(Number(query.porPagina)) || 50))
  const pagina = Math.max(1, Math.trunc(Number(query.pagina)) || 1)
  const ordem = ORDEM[query.ordem ?? ''] ?? ORDEM.recentes

  const params = [...filtro.params, porPagina, (pagina - 1) * porPagina]
  const [itens, resumo, cidades] = await Promise.all([
    q<any>(
      `SELECT cu.id, cu.name, cu.email, cu.document, cu.phone, cu.instagram,
              cu.city, cu.state,
              ${SQL_IDADE('cu.birth_date')} AS idade, ${SQL_FAIXA('cu.birth_date')} AS faixa,
              cu.marketing_opt_in, cu.registered_at, cu.created_at,
              COALESCE(v.pedidos, 0)::int AS pedidos,
              COALESCE(v.gasto, 0)::bigint AS gasto,
              v.ultima,
              (count(*) OVER())::int AS total_filtrado
         FROM customers cu
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS pedidos,
                  COALESCE(SUM(o.total_cents - o.refunded_cents), 0)::bigint AS gasto,
                  MAX(o.paid_at) AS ultima
             FROM orders o
            WHERE o.customer_id = cu.id AND ${PEDIDO_VIVO('o.')}
         ) v ON true
        WHERE ${filtro.onde}
        ORDER BY ${ordem}
        LIMIT $${filtro.params.length + 1} OFFSET $${filtro.params.length + 2}`, params),

    // a base inteira, sem filtro: são os números do topo da tela
    q1<any>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.customer_id = cu.id AND ${PEDIDO_VIVO('o.')}))::int AS compraram,
              count(*) FILTER (WHERE cu.registered_at IS NOT NULL)::int AS com_cadastro,
              count(*) FILTER (WHERE cu.marketing_opt_in)::int AS aceitam_novidades,
              count(*) FILTER (WHERE cu.instagram IS NOT NULL)::int AS com_instagram
         FROM customers cu WHERE cu.org_id = $1`, [orgId]),

    q<any>(
      `SELECT city, state, count(*)::int AS clientes
         FROM customers WHERE org_id = $1 AND city IS NOT NULL
        GROUP BY 1, 2 ORDER BY 3 DESC, 1 LIMIT 40`, [orgId]),
  ])

  // O total vem colado na PRIMEIRA linha da janela. Página além do fim volta
  // vazia e sem ele: sem esta pergunta, um `?pagina=99` velho na URL dizia "0 de
  // 0" e "nenhum cliente" sobre um recorte que tem gente.
  let totalFiltrado = Number(itens[0]?.total_filtrado ?? 0)
  if (!itens.length && pagina > 1) {
    totalFiltrado = Number((await q1<any>(
      `SELECT count(*)::int AS n FROM customers cu WHERE ${filtro.onde}`, filtro.params))!.n)
  }

  return {
    resumo: {
      total: Number(resumo.total),
      compraram: Number(resumo.compraram),
      comCadastro: Number(resumo.com_cadastro),
      aceitamNovidades: Number(resumo.aceitam_novidades),
      comInstagram: Number(resumo.com_instagram),
    },
    paginacao: { pagina, porPagina, total: totalFiltrado },
    cidades: cidades.map((c) => ({ cidade: c.city, estado: c.state, clientes: c.clientes })),
    itens: itens.map((c) => ({
      id: c.id, nome: c.name, email: c.email,
      cpf: cpfMascarado(c.document),
      telefone: c.phone, instagram: c.instagram,
      cidade: c.city, estado: c.state,
      idade: c.idade, faixa: c.faixa,
      aceitaNovidades: c.marketing_opt_in,
      cadastrado: c.registered_at !== null,
      criadoEm: c.created_at,
      pedidos: c.pedidos, gastoCents: Number(c.gasto), ultimaCompraEm: c.ultima,
    })),
  }
})
