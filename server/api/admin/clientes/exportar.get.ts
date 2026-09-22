/**
 * GET /api/admin/clientes/exportar — as linhas da planilha, com o MESMO filtro
 * da lista.
 *
 * O arquivo em si é montado na tela (`baixarCsv`, com `;`, BOM e `\r\n`); esta
 * rota devolve as linhas e — o motivo de ela existir separada da lista —
 * REGISTRA na auditoria quem exportou e com que filtro. Levar a base de
 * clientes pra fora do sistema é o ato mais sensível deste módulo, e sem rastro
 * a pergunta "quem tem essa lista?" não tem resposta.
 *
 * ## O que vai na planilha, e o que fica de fora
 *
 * Nome, e-mail, celular, Instagram, cidade, estado, idade, se aceita novidades
 * e o resumo de compras: o que serve pra falar com a pessoa. **CPF e endereço
 * de rua ficam fora** — nenhuma ferramenta de mensagem precisa deles, e uma
 * planilha solta por aí não deve carregar o documento de ninguém.
 *
 * Teto de 20 mil linhas: passar disso é sinal de filtro esquecido, e o
 * navegador não deve montar um arquivo desses sem a pessoa saber.
 */
import { q } from '../../../utils/db'
import { PEDIDO_VIVO } from '../../../utils/liquido'
import { SQL_IDADE } from '../../../utils/cadastro'
import { filtroDeClientes, FiltroInvalido } from '../../../utils/clientes-filtro'
import { autorDaRequisicao, registrarAuditoria } from '../../../utils/auditoria'

const TETO = 20_000

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

  const linhas = await q<any>(
    `SELECT cu.name, cu.email, cu.phone, cu.instagram, cu.city, cu.state,
            ${SQL_IDADE('cu.birth_date')} AS idade, cu.marketing_opt_in,
            cu.created_at,
            COALESCE(v.pedidos, 0)::int AS pedidos,
            COALESCE(v.gasto, 0)::bigint AS gasto,
            v.ultima
       FROM customers cu
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS pedidos,
                COALESCE(SUM(o.total_cents - o.refunded_cents), 0)::bigint AS gasto,
                MAX(o.paid_at) AS ultima
           FROM orders o
          WHERE o.customer_id = cu.id AND ${PEDIDO_VIVO('o.')}
       ) v ON true
      WHERE ${filtro.onde}
      ORDER BY cu.name, cu.id
      LIMIT ${TETO + 1}`, filtro.params)

  if (linhas.length > TETO) {
    throw createError({ statusCode: 413,
      statusMessage: `São mais de ${TETO.toLocaleString('pt-BR')} clientes. `
        + 'Aplique um filtro (cidade, faixa de idade, quem aceita novidades) e exporte de novo.' })
  }

  await registrarAuditoria({
    autor: autorDaRequisicao(event),
    entidade: 'clientes',
    entidadeId: null,
    acao: 'exportado',
    depois: {
      linhas: linhas.length,
      // o recorte, pra a auditoria dizer QUE lista saiu e não só que saiu uma
      filtro: Object.fromEntries(
        ['q', 'uf', 'cidade', 'faixa', 'novidades', 'cadastro', 'situacao']
          .filter((k) => query[k]).map((k) => [k, query[k]])),
    },
  })

  return {
    total: linhas.length,
    linhas: linhas.map((c) => ({
      nome: c.name, email: c.email, telefone: c.phone, instagram: c.instagram,
      cidade: c.city, estado: c.state, idade: c.idade,
      aceitaNovidades: c.marketing_opt_in, clienteDesde: c.created_at,
      pedidos: c.pedidos, gastoCents: Number(c.gasto), ultimaCompraEm: c.ultima,
    })),
  }
})
