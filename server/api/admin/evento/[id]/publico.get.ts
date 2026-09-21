/**
 * GET /api/admin/evento/:id/publico — quem comprou.
 *
 * O dashboard tinha a aba "Público" como botão morto: trocava a variável e
 * nada aparecia. Esta rota é o conteúdo dela.
 *
 * **Só sai daqui o que a casa realmente coletou.** O cadastro do comprador
 * tem nome, e-mail, documento e telefone — não tem data de nascimento nem
 * gênero. Faixa etária e divisão por sexo seriam número inventado, e número
 * inventado num painel é pior que campo vazio: alguém compra mídia em cima.
 * O dia em que o checkout perguntar, a conta entra aqui.
 *
 * O que dá pra saber com honestidade e é o que a produção usa:
 *
 * - **de onde vem** — pelo DDD do telefone. Não é endereço, é o DDD de quem
 *   comprou, e a tela diz isso com essas palavras;
 * - **é a primeira vez?** — quem já comprou em OUTRO evento desta produtora
 *   antes desta compra é recorrente. É a única pergunta de fidelidade que os
 *   dados respondem sem chute;
 * - **quantos ingressos por pessoa** — quem leva 1 e quem leva 6 se comporta
 *   diferente na porta e na fila;
 * - **a que horas compram** — define quando a campanha vai ao ar.
 */
import { q, q1 } from '../../../../utils/db'
import { DDD_UF, REGIAO_DDD } from '../../../../utils/ddd'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const ev = await q1<any>(`SELECT id, org_id, name FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const [pessoas, porPessoa, origem, hora, topo, titulares] = await Promise.all([
    // novos × recorrentes, numa passada só
    q1<any>(
      `WITH meus AS (
         SELECT o.customer_id, min(o.paid_at) AS primeira
           FROM orders o
          WHERE o.event_id = $1 AND o.status = 'pago' AND o.customer_id IS NOT NULL
          GROUP BY o.customer_id)
       SELECT count(*)::int AS compradores,
              count(*) FILTER (WHERE NOT ja)::int  AS novos,
              count(*) FILTER (WHERE ja)::int      AS recorrentes,
              count(*) FILTER (WHERE c.phone IS NULL)::int AS sem_telefone
         FROM (SELECT m.customer_id, m.primeira,
                      EXISTS (SELECT 1 FROM orders x
                               WHERE x.customer_id = m.customer_id
                                 AND x.status = 'pago' AND x.event_id <> $1
                                 AND x.paid_at < m.primeira) AS ja
                 FROM meus m) t
         JOIN customers c ON c.id = t.customer_id`, [id]),

    // ingressos por pessoa — conta INGRESSO na tabela de ingresso, nunca a
    // quantidade do item do pedido: cortesia cancelada deixa o item lá.
    q<any>(
      `SELECT o.customer_id, count(*)::int AS ingressos,
              sum(oi.unit_total_cents)::bigint AS gasto
         FROM tickets t
         JOIN orders o ON o.id = t.order_id
         LEFT JOIN order_items oi ON oi.id = t.order_item_id
        WHERE t.event_id = $1 AND t.status <> 'cancelado' AND o.status = 'pago'
          AND o.customer_id IS NOT NULL
        GROUP BY o.customer_id`, [id]),

    q<any>(
      `SELECT left(regexp_replace(c.phone, '\\D', '', 'g'), 2) AS ddd,
              count(DISTINCT c.id)::int AS pessoas
         FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.event_id = $1 AND o.status = 'pago' AND c.phone IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC`, [id]),

    q<any>(
      `SELECT extract(hour FROM o.paid_at AT TIME ZONE 'America/Bahia')::int AS hora,
              count(*)::int AS pedidos
         FROM orders o
        WHERE o.event_id = $1 AND o.status = 'pago' AND o.paid_at IS NOT NULL
        GROUP BY 1 ORDER BY 1`, [id]),

    q<any>(
      `SELECT c.name, c.email,
              count(t.id)::int AS ingressos,
              sum(o.total_cents)::bigint AS gasto,
              count(DISTINCT o.id)::int AS pedidos
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         LEFT JOIN tickets t ON t.order_id = o.id AND t.status <> 'cancelado'
        WHERE o.event_id = $1 AND o.status = 'pago'
        GROUP BY c.id ORDER BY 3 DESC, 4 DESC LIMIT 12`, [id]),

    // quem ainda não disse quem vai usar o ingresso — trabalho de portaria,
    // não estatística: sem titular a entrada vira conferência na mão.
    q1<any>(
      `SELECT count(*) FILTER (WHERE holder_name IS NOT NULL AND holder_name <> '')::int AS com_nome,
              count(*) FILTER (WHERE holder_name IS NULL OR holder_name = '')::int AS sem_nome
         FROM tickets WHERE event_id = $1 AND status <> 'cancelado'`, [id]),
  ])

  // faixas de quantidade: 1, 2, 3-4, 5-9, 10+
  const FAIXAS = [
    { rotulo: '1 ingresso', de: 1, ate: 1 },
    { rotulo: '2 ingressos', de: 2, ate: 2 },
    { rotulo: '3 a 4', de: 3, ate: 4 },
    { rotulo: '5 a 9', de: 5, ate: 9 },
    { rotulo: '10 ou mais', de: 10, ate: Infinity },
  ]
  const distribuicao = FAIXAS.map((f) => {
    const dentro = porPessoa.filter((p) => p.ingressos >= f.de && p.ingressos <= f.ate)
    return {
      rotulo: f.rotulo,
      pessoas: dentro.length,
      ingressos: dentro.reduce((s, p) => s + p.ingressos, 0),
    }
  }).filter((f) => f.pessoas > 0)

  const porUf = new Map<string, number>()
  const porDdd = origem.map((o: any) => {
    const uf = DDD_UF[o.ddd] ?? '—'
    porUf.set(uf, (porUf.get(uf) ?? 0) + o.pessoas)
    return { ddd: o.ddd, uf, regiao: REGIAO_DDD[o.ddd] ?? null, pessoas: o.pessoas }
  })

  const totalIngressos = porPessoa.reduce((s, p) => s + p.ingressos, 0)
  const compradores = pessoas?.compradores ?? 0

  return {
    evento: { id: ev.id, nome: ev.name },
    pessoas: {
      compradores,
      novos: pessoas?.novos ?? 0,
      recorrentes: pessoas?.recorrentes ?? 0,
      semTelefone: pessoas?.sem_telefone ?? 0,
      // média com 1 casa: "2 ingressos por pessoa" esconde a diferença entre
      // 1,6 e 2,4, que é a diferença entre vender pra casal e vender pra grupo
      ingressosPorPessoa: compradores ? Math.round((totalIngressos / compradores) * 10) / 10 : 0,
    },
    distribuicao,
    porDdd: porDdd.slice(0, 12),
    porUf: [...porUf.entries()].map(([uf, pessoas]) => ({ uf, pessoas }))
      .sort((a, b) => b.pessoas - a.pessoas),
    horaDaCompra: hora.map((h: any) => ({ hora: h.hora, pedidos: h.pedidos })),
    topCompradores: topo.map((t: any) => ({
      nome: t.name, email: t.email,
      ingressos: t.ingressos, gastoCents: Number(t.gasto ?? 0), pedidos: t.pedidos,
    })),
    titulares: {
      comNome: titulares?.com_nome ?? 0,
      semNome: titulares?.sem_nome ?? 0,
    },
    // a tela mostra isto como aviso, não como número: é o que a casa NÃO
    // coletou, e some sozinho no dia em que o checkout perguntar
    naoColetado: ['data de nascimento', 'gênero', 'endereço'],
  }
})
