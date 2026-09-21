/**
 * GET /api/admin/evento/:id/sessoes — os dias vendáveis do evento.
 *
 * A tela precisa responder três perguntas que hoje não têm resposta em lugar
 * nenhum do sistema:
 *
 *   1. **quantas pessoas já vêm neste dia?** — somada na hora dos pedidos
 *      vivos (`sessao_ocupacao`, do 016), não de um contador que desencaixa.
 *      É a mesma função que o gatilho usa pra recusar a venda; se a tela
 *      tivesse a conta dela, uma das duas envelheceria.
 *
 *   2. **quais ingressos valem neste dia?** — pelos dois caminhos: o lote
 *      ligado explicitamente (`lot_sessions`) e o lote que herda o dia do
 *      setor (modelo antigo, que é o que está no banco hoje). Mostrar só o
 *      primeiro faria o sábado do evento semeado aparecer vazio, com 5.000
 *      ingressos vendidos nele.
 *
 *   3. **o catálogo promete mais gente do que cabe?** — a soma do estoque dos
 *      lotes do dia contra a capacidade. Isso é AVISO, não recusa: o produtor
 *      tem direito de deixar 3 lotes de 500 num dia de 800 e parar de vender
 *      em 800 (a trava do 016 garante). O que ele não pode é descobrir isso no
 *      portão.
 *
 * O `LEFT JOIN` em `lots` é de propósito: sessão sem lote nenhum precisa
 * aparecer na lista — é justamente a que ninguém consegue comprar.
 */
import { q, q1 } from '../../../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  const ev = await q1<any>(
    `SELECT id, name, status, timezone, starts_at, ends_at FROM events WHERE id = $1`, [id])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  const sessoes = await q<any>(
    `SELECT es.id, es.title, es.starts_at, es.ends_at, es.capacity, es.sort_order,
            sessao_ocupacao(es.id) AS ocupadas,
            -- pelo carimbo do ingresso OU pelo dia do item — ver o comentário
            -- de sessao_ingressos no 016. tickets.session_id sozinho é sempre
            -- 0 no modelo novo, e o cartão mostrava "2 pessoas confirmadas /
            -- 0 ingressos emitidos" para a mesma venda.
            sessao_ingressos(es.id) AS ingressos,
            (SELECT count(*)::int FROM sectors s WHERE s.session_id = es.id) AS setores
       FROM event_sessions es
      WHERE es.event_id = $1
      ORDER BY es.starts_at`, [id])

  const lotes = await q<any>(
    `SELECT l.id, l.name, l.quantity, l.sold, l.reserved, l.visible, l.channels,
            l.price_cents, l.sort_order,
            s.id AS sector_id, s.name AS setor, s.kind, s.session_id AS sessao_do_setor,
            ARRAY(SELECT ls.session_id FROM lot_sessions ls WHERE ls.lot_id = l.id
                   ORDER BY ls.session_id) AS sessoes
       FROM lots l
       JOIN sectors s ON s.id = l.sector_id
      WHERE s.event_id = $1
      ORDER BY s.sort_order, l.sort_order`, [id])

  /** os lotes que vendem este dia, pelos dois caminhos */
  const lotesDoDia = (sessaoId: string) =>
    lotes.filter((l) =>
      l.sessoes.includes(sessaoId) ||
      (l.sessoes.length === 0 && l.sessao_do_setor === sessaoId))

  return {
    evento: {
      id: ev.id, nome: ev.name, status: ev.status, fuso: ev.timezone,
      inicio: ev.starts_at, fim: ev.ends_at,
    },

    sessoes: sessoes.map((s) => {
      const meus = lotesDoDia(s.id)
      // Pior caso: se todo mundo que pode escolher este dia escolher este dia.
      // É a régua certa pro aviso — a capacidade precisa aguentar o pior caso,
      // não a média.
      const prometido = meus.reduce((n, l) => n + Number(l.quantity), 0)
      const ocupadas = Number(s.ocupadas)
      const capacidade = s.capacity === null ? null : Number(s.capacity)
      return {
        id: s.id,
        titulo: s.title,
        inicio: s.starts_at,
        fim: s.ends_at,
        capacidade,
        ocupadas,
        vagas: capacidade === null ? null : Math.max(capacidade - ocupadas, 0),
        lotado: capacidade !== null && ocupadas >= capacidade,
        estoquePrometido: prometido,
        excedeCapacidade: capacidade !== null && prometido > capacidade,
        ingressosEmitidos: Number(s.ingressos),
        setoresPresos: Number(s.setores),
        // Apagar leva junto o setor preso a ela (ON DELETE CASCADE no schema
        // 001) — e com o setor iriam os lotes. Quem já vendeu, ou quem tem
        // setor amarrado, não some por um clique.
        podeApagar: ocupadas === 0 && Number(s.ingressos) === 0 && Number(s.setores) === 0,
        lotes: meus.map((l) => ({
          id: l.id, nome: l.name, setor: l.setor,
          quantidade: Number(l.quantity),
          vendidos: Number(l.sold), reservados: Number(l.reserved),
          faceCents: Number(l.price_cents),
          // 'lote' = escolhido nesta tela; 'setor' = herdado do modelo antigo,
          // em que o setor inteiro era de um dia só.
          vinculo: l.sessoes.includes(s.id) ? 'lote' : 'setor',
        })),
      }
    }),

    lotes: lotes.map((l) => ({
      id: l.id, nome: l.name, setor: l.setor, tipoSetor: l.kind,
      quantidade: Number(l.quantity), vendidos: Number(l.sold),
      visivel: l.visible, canais: l.channels,
      sessoes: l.sessoes as string[],
      sessaoDoSetor: l.sessao_do_setor,
      // Quantos dias este lote vende, contando os dois caminhos.
      dias: l.sessoes.length || (l.sessao_do_setor ? 1 : 0),
      // Quem ainda vai ter que ESCOLHER um dia na hora da compra — e, até o
      // checkout perguntar, sai sem data e não desconta vaga de ninguém.
      //
      // Passaporte NÃO entra aqui, e a diferença não é de rótulo: ele não
      // escolhe dia nenhum, ele COBRE todos os dias ligados e ocupa vaga em
      // CADA UM (o gatilho do 016 trava e confere a capacidade dia a dia).
      // Medido: um passe de 4 pessoas ligado a dois dias levou o sábado de 2
      // para 6 e o domingo de 0 para 4 numa venda só. Enfiar o passaporte no
      // mesmo aviso fazia a tela dizer ao operador exatamente o contrário do
      // que o banco tinha acabado de fazer.
      escolheDia: l.kind !== 'passaporte' && l.sessoes.length > 1,
      cobreTodosOsDias: l.kind === 'passaporte' && l.sessoes.length > 1,
    })),
  }
})
