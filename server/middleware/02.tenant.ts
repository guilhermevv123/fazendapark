/**
 * Cerca de organização. Deny-by-default, igual ao porteiro de autenticação.
 *
 * O porteiro anterior responde "você está logado e o seu papel cobre esta
 * área?". Faltava a segunda pergunta, que é a que separa um cliente do outro:
 * **este `:id` é SEU?**
 *
 * Sem ela, todo recurso identificado por UUID na URL era público entre
 * clientes: quem tinha qualquer login válido lia o painel, o borderô e a
 * lista de participantes — com nome, documento e e-mail de cada comprador —
 * de um evento de outro produtor, bastando ter o id. E não era só leitura:
 * os PATCH e DELETE de lote, cupom e promoter passavam igual.
 *
 * A correção mora aqui, e não em cada handler, pelo mesmo motivo do arquivo
 * anterior: handler que precisa lembrar de conferir é handler que um dia
 * nasce sem a linha. Aqui, rota nova sob `/api/admin/evento/:id/` já nasce
 * cercada — quem precisar de exceção põe na lista, e isso aparece no diff.
 *
 * O `org_id` do dono do recurso vem do BANCO; o da sessão vem do cookie
 * assinado. Nenhum dos dois vem do payload, que é o que o cliente controla.
 */
import { caminhoDaRota } from '../utils/caminho'
import { q1 } from '../utils/db'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * prefixo da rota → como descobrir de quem é o recurso.
 * `coluna` existe porque pedido aceita id OU código na URL.
 */
const CERCAS: { prefixo: string; sql: (porCodigo: boolean) => string; rotulo: string }[] = [
  {
    prefixo: '/api/admin/evento/',
    rotulo: 'evento',
    sql: () => `SELECT org_id FROM events WHERE id = $1`,
  },
  {
    prefixo: '/api/admin/pedido/',
    rotulo: 'pedido',
    sql: (porCodigo) =>
      `SELECT org_id FROM orders WHERE ${porCodigo ? 'upper(code) = upper($1)' : 'id = $1'}`,
  },
]

export default defineEventHandler(async (event) => {
  const caminho = caminhoDaRota(event)
  const cerca = CERCAS.find((c) => caminho.startsWith(c.prefixo))
  if (!cerca) return

  // `/api/admin/evento/novo` e afins não têm id — nada a cercar aqui, a
  // criação tem a regra dela (usa o org da sessão, nunca o do payload).
  const resto = caminho.slice(cerca.prefixo.length)
  const chave = resto.split('/')[0]
  if (!chave) return

  const sessao = (event.context as any).sessao
  // Sem sessão o porteiro anterior já derrubou; se chegou aqui sem ela, algo
  // muito errado aconteceu e o certo é fechar, não deixar passar.
  if (!sessao?.orgId) {
    throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })
  }

  const porCodigo = !UUID.test(chave)
  // id que nem parece id não vai virar consulta; e no caso do evento, onde só
  // uuid é aceito, cai direto em 404 em vez de vazar erro de sintaxe do Postgres.
  if (porCodigo && cerca.rotulo === 'evento') {
    throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  }

  const dono = await q1<any>(cerca.sql(porCodigo), [chave])

  // 404, não 403: dizer "existe, mas não é seu" já entrega que aquele id é
  // real. Pra quem não é dono, o recurso simplesmente não existe.
  if (!dono || dono.org_id !== sessao.orgId) {
    throw createError({
      statusCode: 404,
      statusMessage: cerca.rotulo === 'evento' ? 'Evento não encontrado' : 'Pedido não encontrado',
    })
  }

  // Guardado pra quem quiser usar sem repetir a consulta.
  ;(event.context as any).orgDoRecurso = dono.org_id
})
