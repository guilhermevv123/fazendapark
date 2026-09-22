/**
 * GET /api/admin/clientes/:id — a ficha de UM cliente.
 *
 * É aqui, e só aqui, que o CPF sai inteiro (a lista mascara). Consulta por
 * pessoa, dentro da organização da sessão: um id de outra organização responde
 * 404 igual a um id que não existe — não confirma que ele existe em outro lugar.
 *
 * O hash da senha NUNCA sai daqui. A ficha só diz se a pessoa criou uma senha
 * (`temSenha`), porque é o que a equipe precisa saber; o valor não tem serventia
 * pra tela nenhuma.
 */
import { q, q1 } from '../../../utils/db'
import { SQL_FAIXA, SQL_IDADE } from '../../../utils/cadastro'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default defineEventHandler(async (event) => {
  const orgId = (event.context as any).sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })

  const id = getRouterParam(event, 'id') ?? ''
  const naoAchou = () => createError({ statusCode: 404, statusMessage: 'Cliente não encontrado.' })
  // id que nem é uuid não vai ao banco: o cast quebraria com 500
  if (!UUID.test(id)) throw naoAchou()

  const c = await q1<any>(
    `SELECT cu.id, cu.name, cu.email, cu.document, cu.phone, cu.instagram,
            cu.birth_date::text AS nascimento,
            ${SQL_IDADE('cu.birth_date')} AS idade, ${SQL_FAIXA('cu.birth_date')} AS faixa,
            cu.zip_code, cu.street, cu.address_number, cu.neighborhood, cu.city, cu.state,
            cu.address_complement, cu.marketing_opt_in, cu.marketing_opt_in_at,
            cu.registered_at, cu.created_at,
            (cu.password_hash IS NOT NULL) AS tem_senha
       FROM customers cu
      WHERE cu.id = $1 AND cu.org_id = $2`, [id, orgId])
  if (!c) throw naoAchou()

  // Todo pedido, inclusive o que não virou dinheiro: a ficha responde "o que
  // essa pessoa fez aqui", e quem tentou e não pagou é parte da resposta. O
  // `LEFT JOIN` em eventos é só rótulo — pedido não some por falta dele.
  const pedidos = await q<any>(
    `SELECT o.id, o.code, o.status, o.channel, o.payment_method, o.total_cents,
            o.refunded_cents, o.created_at, o.paid_at, o.event_id, e.name AS evento
       FROM orders o LEFT JOIN events e ON e.id = o.event_id
      WHERE o.customer_id = $1
      ORDER BY o.created_at DESC LIMIT 100`, [id])

  return {
    id: c.id, nome: c.name, email: c.email, cpf: c.document, telefone: c.phone,
    instagram: c.instagram,
    nascimento: c.nascimento, idade: c.idade, faixa: c.faixa,
    endereco: {
      cep: c.zip_code, rua: c.street, numero: c.address_number, bairro: c.neighborhood,
      cidade: c.city, estado: c.state, complemento: c.address_complement,
    },
    aceitaNovidades: c.marketing_opt_in,
    aceitaNovidadesEm: c.marketing_opt_in_at,
    cadastradoEm: c.registered_at,
    temSenha: c.tem_senha,
    criadoEm: c.created_at,
    pedidos: pedidos.map((o) => ({
      id: o.id, codigo: o.code, situacao: o.status, canal: o.channel, forma: o.payment_method,
      totalCents: Number(o.total_cents), devolvidoCents: Number(o.refunded_cents),
      criadoEm: o.created_at, pagoEm: o.paid_at, eventoId: o.event_id, evento: o.evento,
    })),
  }
})
