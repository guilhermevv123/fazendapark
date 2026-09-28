/**
 * GET /api/admin/evento/:id/publico — quem comprou.
 *
 * O dashboard tinha a aba "Público" como botão morto: trocava a variável e
 * nada aparecia. Esta rota é o conteúdo dela.
 *
 * **Só sai daqui o que a casa realmente coletou.** O cadastro do comprador tem nome, e-mail,
 * documento e telefone — e, desde o 027, data de nascimento e endereço, OPCIONAIS no checkout.
 * Faixa etária e cidade saem só de quem respondeu, com a contagem de quantos responderam
 * (ADM-32: a tela dizia "o checkout não pergunta" nascimento e endereço, e pergunta). Gênero não
 * é perguntado em lugar nenhum: divisão por sexo seria número inventado, e número inventado num
 * painel é pior que campo vazio — alguém compra mídia em cima.
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
 *
 * ## Duas coisas que esta rota contava errado
 *
 * 1. **`WHERE o.status = 'pago'` apagava o comprador com estorno parcial.**
 *    Quem devolveu R$ 20 de uma compra de R$ 850 sumia da base inteira: das
 *    pessoas, do DDD, da hora, do top. Agora o recorte é `PEDIDO_VIVO()`, de
 *    `utils/liquido.ts` — o mesmo que o borderô e os financeiros usam.
 *
 * 2. **O top de compradores multiplicava o gasto pelo número de ingressos.**
 *    Com `LEFT JOIN tickets` na mesma consulta, o pedido aparecia uma vez por
 *    ingresso e `sum(o.total_cents)` somava o mesmo pedido quatro vezes. Medido
 *    no evento semeado: um comprador de R$ 220,97 aparecia com R$ 883,88 na
 *    tela. A contagem de ingressos agora sai de subconsulta lateral e o pedido
 *    é somado uma vez só.
 *
 * ## Público é quem ENTROU
 *
 * "Quantas pessoas vieram" não se responde por ingresso emitido — ingresso
 * vendido que não apareceu não é público, e uma mesa de 4 é um ingresso com
 * quatro pessoas dentro. A resposta mora em `entries` (`SQL_PUBLICO`,
 * `sum(people)`), a mesma expressão que a portaria usa.
 */
import { q, q1 } from '../../../../utils/db'
import { DDD_UF, REGIAO_DDD } from '../../../../utils/ddd'
import { PEDIDO_VIVO } from '../../../../utils/liquido'
import { SQL_PUBLICO } from '../../../../utils/catraca'
import { fusoDoEvento } from './dashboard.get'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const ev = await q1<any>(`SELECT id, org_id, name, timezone FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  // a hora da compra é a do relógio DO EVENTO, a mesma de Relatórios (ADM-10)
  const fuso = fusoDoEvento(ev.timezone)

  const [pessoas, porPessoa, origem, hora, topo, titulares, presenca, idades, cidades] = await Promise.all([
    // novos × recorrentes, numa passada só
    q1<any>(
      `WITH meus AS (
         SELECT o.customer_id, min(o.paid_at) AS primeira
           FROM orders o
          WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')} AND o.customer_id IS NOT NULL
          GROUP BY o.customer_id)
       SELECT count(*)::int AS compradores,
              count(*) FILTER (WHERE NOT ja)::int  AS novos,
              count(*) FILTER (WHERE ja)::int      AS recorrentes,
              count(*) FILTER (WHERE c.phone IS NULL)::int AS sem_telefone
         FROM (SELECT m.customer_id, m.primeira,
                      EXISTS (SELECT 1 FROM orders x
                               WHERE x.customer_id = m.customer_id
                                 AND ${PEDIDO_VIVO('x.')} AND x.event_id <> $1
                                 AND x.paid_at < m.primeira) AS ja
                 FROM meus m) t
         JOIN customers c ON c.id = t.customer_id`, [id]),

    // ingressos por pessoa — conta INGRESSO na tabela de ingresso, nunca a
    // quantidade do item do pedido: cortesia cancelada deixa o item lá.
    //
    // Sem soma de dinheiro aqui de propósito: a única que existia era um
    // `sum(oi.unit_total_cents)` que ninguém lia e que somava o preço unitário
    // uma vez por INGRESSO, com o pedido repetido no meio. Soma de dinheiro
    // sem leitor é a que ninguém confere e que um dia alguém coloca na tela.
    q<any>(
      `SELECT o.customer_id, count(*)::int AS ingressos
         FROM tickets t
         JOIN orders o ON o.id = t.order_id
        WHERE t.event_id = $1 AND t.status <> 'cancelado' AND ${PEDIDO_VIVO('o.')}
          AND o.customer_id IS NOT NULL
        GROUP BY o.customer_id`, [id]),

    q<any>(
      `SELECT left(regexp_replace(c.phone, '\\D', '', 'g'), 2) AS ddd,
              count(DISTINCT c.id)::int AS pessoas
         FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')} AND c.phone IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC`, [id]),

    q<any>(
      `SELECT extract(hour FROM o.paid_at AT TIME ZONE $2)::int AS hora,
              count(*)::int AS pedidos
         FROM orders o
        WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')} AND o.paid_at IS NOT NULL
        GROUP BY 1 ORDER BY 1`, [id, fuso]),

    // O ingresso vem de subconsulta lateral, e não de um JOIN na mesma
    // consulta: com o JOIN, o pedido aparecia uma vez POR INGRESSO e
    // `sum(o.total_cents)` contava o mesmo pedido quatro vezes. `gasto` é o
    // que o comprador deixou — cobrado menos o que voltou pra ele.
    q<any>(
      `SELECT c.name, c.email,
              COALESCE(SUM(tk.n),0)::int AS ingressos,
              COALESCE(SUM(o.total_cents - o.refunded_cents),0)::bigint AS gasto,
              COALESCE(SUM(o.refunded_cents),0)::bigint AS devolvido,
              count(*)::int AS pedidos
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM tickets t
                             WHERE t.order_id = o.id AND t.status <> 'cancelado') tk ON true
        WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')}
        GROUP BY c.id, c.name, c.email
        -- A MESMA régua de relatórios (ADM-63): quem mais DEIXOU no evento, e o desempate por
        -- ingressos. Aqui era por ingressos primeiro — o mesmo título "Quem mais comprou" com duas
        -- ordens diferentes, e o cliente de maior gasto sumia do top da aba Público.
        ORDER BY gasto DESC, ingressos DESC, c.name, c.id LIMIT 12`, [id]),

    // quem ainda não disse quem vai usar o ingresso — trabalho de portaria,
    // não estatística: sem titular a entrada vira conferência na mão.
    q1<any>(
      `SELECT count(*) FILTER (WHERE holder_name IS NOT NULL AND holder_name <> '')::int AS com_nome,
              count(*) FILTER (WHERE holder_name IS NULL OR holder_name = '')::int AS sem_nome
         FROM tickets WHERE event_id = $1 AND status <> 'cancelado'`, [id]),

    // quem de fato ENTROU — livro da porta, `sum(people)`
    q1<any>(SQL_PUBLICO, [id]),

    // A IDADE NO DIA DO EVENTO de quem comprou e informou o nascimento (027). Os mesmos
    // compradores das outras contas (pedido vivo); quem não informou fica em `faixa` nula e vira
    // a diferença entre "informaram" e "compradores" — nunca uma faixa inventada.
    q<any>(
      `WITH compradores AS (
         SELECT DISTINCT o.customer_id FROM orders o
          WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')} AND o.customer_id IS NOT NULL),
       dia AS (SELECT (starts_at AT TIME ZONE $2)::date AS d FROM events WHERE id = $1)
       -- A idade é o campo ANOS do age(), e não "age() < interval '18 years'": interval compara
       -- mês como 30 dias, e "17 anos, 11 meses e 30 dias" (a véspera do aniversário) empata com
       -- 18 anos — o adolescente entrava na faixa de adulto (medido no teste desta rota).
       SELECT CASE
                WHEN c.birth_date IS NULL THEN NULL
                WHEN date_part('year', age(dia.d, c.birth_date)) < 18 THEN 'Até 17 anos'
                WHEN date_part('year', age(dia.d, c.birth_date)) < 25 THEN '18 a 24'
                WHEN date_part('year', age(dia.d, c.birth_date)) < 35 THEN '25 a 34'
                WHEN date_part('year', age(dia.d, c.birth_date)) < 45 THEN '35 a 44'
                WHEN date_part('year', age(dia.d, c.birth_date)) < 60 THEN '45 a 59'
                ELSE '60 ou mais'
              END AS faixa,
              count(*)::int AS pessoas
         FROM compradores m JOIN customers c ON c.id = m.customer_id CROSS JOIN dia
        GROUP BY 1`, [id, fuso]),

    // A CIDADE do endereço do cadastro (027), de quem informou. `initcap(lower(trim()))` junta
    // "SALVADOR", "salvador " e "Salvador" numa linha só.
    q<any>(
      `WITH compradores AS (
         SELECT DISTINCT o.customer_id FROM orders o
          WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')} AND o.customer_id IS NOT NULL)
       SELECT initcap(lower(trim(c.city))) AS cidade, c.state AS uf, count(*)::int AS pessoas
         FROM compradores m JOIN customers c ON c.id = m.customer_id
        WHERE c.city IS NOT NULL AND trim(c.city) <> ''
        GROUP BY 1, 2 ORDER BY 3 DESC, 1`, [id]),
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

  const FAIXAS_ETARIAS = ['Até 17 anos', '18 a 24', '25 a 34', '35 a 44', '45 a 59', '60 ou mais']
  const informaramIdade = idades.filter((f: any) => f.faixa).reduce((n: number, f: any) => n + f.pessoas, 0)

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
      ingressos: t.ingressos,
      gastoCents: Number(t.gasto ?? 0), devolvidoCents: Number(t.devolvido ?? 0),
      pedidos: t.pedidos,
    })),
    titulares: {
      comNome: titulares?.com_nome ?? 0,
      semNome: titulares?.sem_nome ?? 0,
    },
    // Quem ENTROU, contado no livro da porta. Fica ao lado de "compradores"
    // de propósito: comprador é quem pagou, público é quem apareceu, e a
    // distância entre os dois é o que a produção quer saber.
    presenca: {
      pessoas: Number(presenca?.pessoas ?? 0),
      passagens: Number(presenca?.entradas ?? 0),
      ingressosComEntrada: Number(presenca?.ingressos ?? 0),
      passagensOffline: Number(presenca?.offline ?? 0),
      ultimaEm: presenca?.ultima ?? null,
    },
    // faixa etária e cidade: só de quem respondeu, com quantos responderam (ADM-32)
    idades: {
      informaram: informaramIdade,
      faixas: FAIXAS_ETARIAS.map((faixa) => ({
        faixa, pessoas: Number(idades.find((f: any) => f.faixa === faixa)?.pessoas ?? 0),
      })),
    },
    cidades: {
      informaram: cidades.reduce((n: number, c: any) => n + c.pessoas, 0),
      top: cidades.slice(0, 10).map((c: any) => ({ cidade: c.cidade, uf: c.uf, pessoas: c.pessoas })),
    },
    // a tela mostra isto como aviso, não como número: é o que a casa NÃO pergunta em lugar nenhum
    // (nascimento e endereço ela pergunta — opcionais — e aparecem acima)
    naoColetado: ['gênero'],
  }
})
