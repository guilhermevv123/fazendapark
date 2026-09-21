/**
 * POST /api/admin/evento/:id/cortesias — emite cortesia, e define a cota dela.
 *
 * Cortesia É venda, com preço zero. Ela precisa **baixar estoque igual**, ou o
 * lote vende 100 e a portaria recebe 130. Foi por isso que ela não passa pelo
 * `reservar()` comum e sim por uma reserva escrita aqui: a porta de venda de
 * lá exige evento 'ativo' e canal liberado, e cortesia se emite com o evento
 * ainda em rascunho e por fora de qualquer canal.
 *
 * O que NÃO se afrouxa é o estoque: o UPDATE condicional é o mesmo, com a
 * mesma condição `sold + reserved + n <= quantity` e o mesmo CHECK do schema
 * por trás. Cortesia que fura o teto do lote é entrada a mais no parque.
 *
 * ## O que a 017 acrescentou, e por quê
 *
 * O estoque nunca foi o teto da cortesia — ele é o teto da CASA. Enquanto
 * houvesse lugar, esta rota emitia de graça sem limite nenhum, sem motivo
 * obrigatório e sem dizer a pedido de quem. Um evento de 5.000 lugares podia
 * sair inteiro de graça sem estourar nenhuma conferência, e o rastro do que
 * aconteceu era um `emitidoPor` dentro do JSON de uma linha de auditoria.
 *
 * Agora são três coisas, e nenhuma delas é opcional:
 *
 *   - **cota** por evento e por lote (`courtesy_quota`; NULL = sem cota);
 *   - **motivo** e **quem pediu**, obrigatórios em cada emissão;
 *   - **quem autorizou**, carimbado da sessão — nunca do corpo do pedido.
 *
 * ## A ordem das travas (é ela que faz a cota valer)
 *
 * A cota do LOTE seria serializada pela trava do lote, que já existia. A do
 * EVENTO não: duas emissões em lotes diferentes do mesmo evento não disputam
 * linha nenhuma, contam a mesma cota livre e as duas passam. Por isso a
 * trava do evento vem PRIMEIRO, e é a linha de `events` que serializa a
 * cortesia do evento inteiro — o mesmo desenho de `utils/saque.ts`, pelo
 * mesmo motivo.
 *
 *     1. FOR UPDATE na linha do EVENTO   (serializa a cota do evento)
 *     2. FOR UPDATE na linha do LOTE     (a trava que tira o estoque)
 *     3. conta o que já foi emitido      ← só aqui, nunca antes
 *     4. confere cota, confere estoque
 *     5. UPDATE condicional em lots.sold
 *
 * **A contagem vem DEPOIS das duas travas, sempre.** Contar antes passa em
 * teste sequencial e não serializa nada: o segundo pedido decide em cima de
 * uma cota que o primeiro já gastou, e a única coisa que restaria seria o
 * gatilho da 017 — que também não enxerga transação não confirmada. Duas
 * cortesias a mais no portão, sem erro em lugar nenhum.
 *
 * Evento → lote é a MESMA ordem de `utils/cancelamento.ts`. Ninguém neste
 * sistema trava lote antes de evento (`SQL_TRAVA_LOTE` trava só o lote), então
 * não há ciclo pra virar deadlock.
 *
 * ## Por que definir a cota mora nesta rota
 *
 * Seria um PATCH em qualquer outro dia. Ele está aqui porque a conferência
 * "a cota nova não pode nascer abaixo do que já foi dado" precisa contar sob
 * a MESMA trava de evento que a emissão usa — separado, o produtor baixa a
 * cota pra 10 no instante em que a 11ª está sendo emitida e as duas operações
 * concordam entre si estando erradas juntas.
 */
import { z } from 'zod'
import { tx } from '../../../../utils/db'
import { gerarCodigo } from '../../../../utils/ingresso'
import { autorDaRequisicao, registrarAuditoria } from '../../../../utils/auditoria'
import { ROTULO, type Papel } from '../../../../utils/papeis'
import {
  CANAL_CORTESIA, SQL_E_CORTESIA, SQL_ORIGEM_NAO_E_VENDA,
} from '../../../../utils/emissao'

/**
 * A trava do evento, como statement solto.
 *
 * O teste de concorrência não importa esta constante (arquivo de rota não
 * carrega fora do Nitro): ele segura a MESMA linha de `events` por uma
 * conexão do pool e prova, pela HTTP, que a rota fica pendurada e que ela lê
 * a cota só depois de o outro confirmar. Prova mais forte que comparar texto
 * de SQL — se a trava sair daqui, a rota responde na hora e o caso fica
 * vermelho pelos dois lados.
 */
const SQL_TRAVA_EVENTO_CORTESIA = `
  SELECT id, org_id, name, courtesy_quota
    FROM events
   WHERE id = $1
   FOR UPDATE`

/**
 * O que conta contra a cota — e o que NÃO conta.
 *
 * `tickets.is_courtesy` **não** quer dizer cortesia. `utils/emissao.ts` marca
 * a coluna em todo ingresso de pedido que fechou em zero: lote de R$ 0,
 * evento gratuito, cupom de 100%. Isso é venda, com comprador e CPF, e no
 * canal `online`.
 *
 * Contar pela marca fazia a venda gratuita comer, em silêncio, a vaga que o
 * produtor guardou pra imprensa — e, com a cota cheia, o gatilho da 017
 * derrubava o checkout público inteiro (HTTP 500 na cara do comprador, pedido
 * pendurado em `aguardando_pagamento` e estoque preso em `reserved`).
 *
 * A régua é o PEDIDO: cortesia é o que esta rota emitiu, e ela grava
 * `orders.channel = 'cortesia'`. Ingresso SEM pedido (INSERT na mão,
 * importação) continua contando, que é o caminho que a cota mais precisa
 * pegar.
 *
 * **A definição não mora mais aqui** — ela mora em `utils/emissao.ts`,
 * encostada na linha que carimba a coluna, porque quem lê precisa achar a
 * régua no mesmo lugar em que a marca nasce. Este nome continua exportado
 * porque o borderô e `cortesias.get.ts` importam por ele; apagá-lo trocaria
 * um arquivo de trilha alheia por um erro de import.
 *
 * O mesmo recorte está no gatilho da 017. Todos precisam recortar igual: se a
 * tela contar de um jeito e a recusa de outro, o operador vê "ainda cabem 3"
 * e leva um 409.
 */
export const eCortesiaMesmo = SQL_ORIGEM_NAO_E_VENDA

/** e-mail em branco é ausência de e-mail, não e-mail inválido */
const vazioVirouNulo = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? null : v

const Pessoa = z.object({
  nome: z.string().trim().min(2).max(120),
  email: z.preprocess(vazioVirouNulo, z.string().trim().email().max(160).nullish()),
  documento: z.preprocess(vazioVirouNulo, z.string().trim().max(20).nullish()),
})

const Emissao = z.object({
  loteId: z.string().uuid(),
  tipoId: z.string().uuid().nullish(),
  /**
   * Por que saiu de graça. Deixou de ser opcional: cortesia sem motivo é a
   * linha que ninguém consegue explicar seis meses depois, quando o sócio
   * pergunta por que 400 pessoas entraram sem pagar.
   */
  motivo: z.string().trim().min(3).max(200),
  /**
   * A pedido de QUEM. Não é quem clica — esse vem da sessão. É o diretor, o
   * patrocinador, o vereador: a pessoa por quem alguém vai ter que responder.
   */
  responsavel: z.string().trim().min(2).max(120),
  /** Uma linha por cortesia: quem recebe. Nome em branco não passa. */
  pessoas: z.array(Pessoa).min(1).max(200),
})

const Cota = z.object({
  acao: z.literal('cota'),
  /** null tira a cota do evento (volta a "sem teto") */
  cotaEvento: z.number().int().min(0).max(1_000_000).nullable(),
  lotes: z.array(z.object({
    id: z.string().uuid(),
    cota: z.number().int().min(0).max(1_000_000).nullable(),
  })).max(200).default([]),
})

/**
 * Mensagem de erro que serve pra quem está no guichê às 21h.
 *
 * O `flatten()` do zod devolve `{"motivo":["String must contain at least 3
 * character(s)"]}`, que é texto de programador em inglês numa tela em
 * português. Quem lê isso não sabe o que fazer; quem lê a frase abaixo sabe.
 */
const EXPLICACAO: Record<string, string> = {
  motivo: 'Diga o motivo da cortesia (imprensa, patrocinador, equipe). Ela sai do estoque e não entra no faturamento — o motivo é o que explica isso depois.',
  responsavel: 'Diga quem pediu a cortesia. Sem isso ninguém consegue responder por ela quando o sócio perguntar.',
  loteId: 'Escolha de qual lote sai a cortesia.',
  pessoas: 'Preencha o nome de quem recebe. Cortesia sem nome não serve na portaria.',
}

function recusaDeFormulario(erro: z.ZodError): never {
  const campo = erro.issues[0]?.path?.[0]
  throw createError({
    statusCode: 400,
    statusMessage: EXPLICACAO[String(campo)] ?? 'Confira os dados da cortesia.',
    data: erro.flatten(),
  })
}

/**
 * Quem autorizou. `autorDaRequisicao` carrega id/e-mail/IP; o NOME vem da
 * mesma sessão e vai carimbado junto no rastro, porque é ele que aparece na
 * tela — um e-mail não responde "quem é essa pessoa" pra quem lê o relatório
 * seis meses depois.
 */
type Autoria = ReturnType<typeof autorDaRequisicao> & { nome: string | null }

/**
 * Quem MEXE no teto não pode ser quem o teto segura.
 *
 * Emitir cortesia e definir a cota entram pela mesma rota, e por isso caíam
 * na mesma área `evento` da grade de `utils/papeis.ts` — que `operacao` tem.
 * Medido no sistema no ar, com um usuário de papel `operacao`:
 *
 *     POST .../cortesias {"acao":"cota","cotaEvento":9999}  → 200, cota = 9999
 *     POST .../cortesias {...3 pessoas}                     → 200, 3 emitidas
 *
 * Duas chamadas: a primeira levanta o teto, a segunda passa por baixo dele.
 * Teto que o próprio interessado levanta não é teto — é um número na tela que
 * o produtor acredita. A emissão continua sendo de `operacao` (é trabalho de
 * quem atende); o TETO é do master, que é quem responde pela entrada de graça
 * no parque.
 *
 * A grade de `papeis.ts` não resolve isto sozinha: ela decide por rota, e as
 * duas operações são a mesma rota. Separá-las lá exigiria uma rota nova — e a
 * conferência "a cota não pode nascer abaixo do que já foi dado" tem que
 * rodar sob a MESMA trava de evento da emissão. Por isso a trava mora aqui,
 * no ato, e não no caminho.
 *
 * O papel vem do `middleware/03.papel.ts`, que já leu o BANCO nesta
 * requisição — nunca do corpo. Sem papel no contexto, nega: a ordem dos
 * middlewares ter mudado é motivo pra fechar, não pra deixar passar.
 */
function exigirMaster(event: any) {
  const papel = event.context?.papel as Papel | undefined
  if (papel === 'master') return
  const rotulo = papel ? ROTULO[papel] ?? papel : 'sem papel definido'
  throw createError({
    statusCode: 403,
    statusMessage: `Só um acesso Master define a cota de cortesia — o seu é de ${rotulo}. `
      + `Emitir cortesia dentro da cota você continua podendo; mudar o teto, não. `
      + `Peça a um master da sua organização.`,
  })
}

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const corpo = await readBody(event)
  const autor: Autoria = {
    ...autorDaRequisicao(event),
    nome: (event.context as any).sessao?.nome ?? null,
  }

  if (corpo?.acao === 'cota') {
    exigirMaster(event)
    const p = Cota.safeParse(corpo)
    if (!p.success) recusaDeFormulario(p.error)
    return await definirCota(eventoId!, p.data, autor)
  }

  const p = Emissao.safeParse(corpo)
  if (!p.success) recusaDeFormulario(p.error)
  return await emitir(eventoId!, p.data, autor)
})

/* ------------------------------------------------------------------ cota */

async function definirCota(eventoId: string, d: z.infer<typeof Cota>, autor: Autoria) {
  return await tx(async (c) => {
    const { rows: eventos } = await c.query(SQL_TRAVA_EVENTO_CORTESIA, [eventoId])
    const ev = eventos[0]
    if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

    // Contagem DEPOIS da trava, como na emissão: sem isso o produtor baixa a
    // cota pra 10 no mesmo instante em que a 11ª está sendo emitida, e as duas
    // operações se acham certas.
    const { rows: usados } = await c.query(
      `SELECT count(*)::int AS no_evento
         FROM tickets t
        WHERE t.event_id = $1 AND t.status <> 'cancelado'
          AND ${SQL_E_CORTESIA('t')}`, [eventoId])
    const jaNoEvento = usados[0].no_evento

    // Teto abaixo do que já foi dado é promessa que o passado já quebrou: as
    // cortesias emitidas não somem da portaria por causa de um número novo na
    // tela. Recusar aqui é a mesma regra da capacidade de sessão.
    if (d.cotaEvento !== null && d.cotaEvento < jaNoEvento) {
      throw createError({
        statusCode: 409,
        statusMessage: `Este evento já tem ${jaNoEvento} cortesia(s) emitida(s) — a cota não pode ficar abaixo disso. Cancele cortesias antes de baixar o teto.`,
      })
    }

    const antesEvento = ev.courtesy_quota
    await c.query(`UPDATE events SET courtesy_quota = $2 WHERE id = $1`,
      [eventoId, d.cotaEvento])

    const lotesMudados: { id: string; nome: string; antes: number | null; agora: number | null }[] = []
    for (const lote of d.lotes) {
      // Cerca por evento no próprio UPDATE: sem ela, o id de um lote de OUTRO
      // produtor entraria pelo corpo da requisição e a cota dele mudaria.
      const { rows } = await c.query(
        `SELECT l.id, l.name, l.courtesy_quota,
                (SELECT count(*)::int FROM tickets t
                  WHERE t.lot_id = l.id AND t.status <> 'cancelado'
                    AND ${SQL_E_CORTESIA('t')}) AS ja
           FROM lots l
           JOIN sectors s ON s.id = l.sector_id
          WHERE l.id = $1 AND s.event_id = $2
          FOR UPDATE OF l`, [lote.id, eventoId])
      const l = rows[0]
      if (!l) throw createError({ statusCode: 404, statusMessage: 'Um dos lotes não é deste evento' })

      if (lote.cota !== null && lote.cota < l.ja) {
        throw createError({
          statusCode: 409,
          statusMessage: `"${l.name}" já tem ${l.ja} cortesia(s) emitida(s) — a cota dele não pode ficar abaixo disso.`,
        })
      }
      if (l.courtesy_quota === lote.cota) continue

      await c.query(`UPDATE lots SET courtesy_quota = $2 WHERE id = $1`, [lote.id, lote.cota])
      lotesMudados.push({ id: l.id, nome: l.name, antes: l.courtesy_quota, agora: lote.cota })
    }

    await registrarAuditoria({
      autor,
      entidade: 'evento',
      entidadeId: eventoId,
      acao: 'cota_cortesia',
      antes: { cotaEvento: antesEvento, lotes: lotesMudados.map((l) => ({ lote: l.nome, cota: l.antes })) },
      depois: { cotaEvento: d.cotaEvento, lotes: lotesMudados.map((l) => ({ lote: l.nome, cota: l.agora })) },
    }, c)

    return {
      ok: true,
      cotaEvento: d.cotaEvento,
      emitidasNoEvento: jaNoEvento,
      lotesAtualizados: lotesMudados.length,
    }
  })
}

/* --------------------------------------------------------------- emissão */

async function emitir(eventoId: string, d: z.infer<typeof Emissao>, autor: Autoria) {
  const n = d.pessoas.length

  return await tx(async (c) => {
    // ---- 1. trava do evento -------------------------------------------------
    const { rows: eventos } = await c.query(SQL_TRAVA_EVENTO_CORTESIA, [eventoId])
    const ev = eventos[0]
    if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

    // ---- 2. trava do lote (a mesma que tira o estoque) ----------------------
    const { rows: lotes } = await c.query(
      `SELECT l.id, l.name, l.quantity, l.sold, l.reserved, l.price_cents, l.courtesy_quota,
              s.id AS sector_id, s.session_id, e.id AS event_id, e.org_id, e.slug
         FROM lots l
         JOIN sectors s ON s.id = l.sector_id
         JOIN events  e ON e.id = s.event_id
        WHERE l.id = $1 AND e.id = $2
        FOR UPDATE OF l`, [d.loteId, eventoId])
    const lote = lotes[0]
    if (!lote) throw createError({ statusCode: 404, statusMessage: 'Lote não é deste evento' })

    // ---- 3. contagem, já com as duas travas na mão --------------------------
    //
    // Uma varredura só devolve as duas contas. Cancelada não entra: a rota de
    // cancelamento devolve o estoque, então ela devolve a cota junto.
    const { rows: contagem } = await c.query(
      `SELECT count(*)::int AS no_evento,
              count(*) FILTER (WHERE t.lot_id = $2)::int AS no_lote
         FROM tickets t
        WHERE t.event_id = $1 AND t.status <> 'cancelado'
          AND ${SQL_E_CORTESIA('t')}`,
      [eventoId, d.loteId])
    const jaNoEvento = contagem[0].no_evento
    const jaNoLote = contagem[0].no_lote

    // ---- 4. cota, e só então estoque ---------------------------------------
    if (ev.courtesy_quota !== null) {
      const sobra = ev.courtesy_quota - jaNoEvento
      if (n > sobra) throw createError({ statusCode: 409, statusMessage: recusaDeCota('deste evento', sobra, ev.courtesy_quota, n) })
    }
    if (lote.courtesy_quota !== null) {
      const sobra = lote.courtesy_quota - jaNoLote
      if (n > sobra) throw createError({ statusCode: 409, statusMessage: recusaDeCota(`de "${lote.name}"`, sobra, lote.courtesy_quota, n) })
    }

    const disponivel = lote.quantity - lote.sold - lote.reserved
    if (n > disponivel) {
      throw createError({
        statusCode: 409,
        statusMessage: `"${lote.name}" tem ${disponivel} disponível(is) e você pediu ${n} cortesia(s).`,
      })
    }

    if (d.tipoId) {
      const { rows } = await c.query(
        `SELECT id FROM ticket_types WHERE id = $1 AND lot_id = $2`, [d.tipoId, d.loteId])
      if (!rows[0]) throw createError({ statusCode: 422, statusMessage: 'Tipo não é deste lote' })
    }

    // ---- 5. baixa de estoque ------------------------------------------------
    //
    // Direto em `sold`: cortesia não tem pagamento pendente pra esperar, então
    // não existe estado de reserva — ela já nasce vendida.
    const upd = await c.query(
      `UPDATE lots SET sold = sold + $2
        WHERE id = $1 AND sold + reserved + $2 <= quantity RETURNING id`,
      [d.loteId, n])
    if (upd.rowCount !== 1) {
      throw createError({ statusCode: 409, statusMessage: 'O estoque acabou de mudar. Tente de novo.' })
    }
    if (d.tipoId) {
      const t = await c.query(
        `UPDATE ticket_types SET sold = sold + $2
          WHERE id = $1 AND sold + $2 <= quantity RETURNING id`, [d.tipoId, n])
      if (t.rowCount !== 1) {
        throw createError({ statusCode: 409, statusMessage: 'O tipo escolhido não tem essa quantidade' })
      }
    }

    // O pedido existe pra cortesia ter dono, data e rastro no mesmo lugar que
    // a venda. Sem ele, a cortesia seria um ingresso solto sem quem emitiu.
    // Tudo zerado e `channel = 'cortesia'`: é isso que mantém a cortesia FORA
    // da receita no borderô e DENTRO da coluna de ocupação.
    //
    // Este `channel` é a ÚNICA coisa no sistema que diz "isto é cortesia" —
    // é ele que `SQL_E_CORTESIA` lê, aqui, no borderô, em Participantes e no
    // pedido do comprador. Por isso vem da constante, e não de um literal
    // solto que um dia alguém troca em um arquivo só.
    const { rows: pedidos } = await c.query(
      `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method,
                           face_cents, fee_cents, platform_cents, discount_cents,
                           total_cents, paid_at)
       VALUES ($1,$2,$3,'pago','${CANAL_CORTESIA}','cortesia',0,0,0,0,0,now())
       RETURNING id, code`,
      [lote.org_id, eventoId, `CRT-${gerarCodigo('X').slice(2)}`])
    const pedido = pedidos[0]

    const { rows: itens } = await c.query(
      `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity,
                                unit_face_cents, unit_fee_cents, unit_total_cents)
       VALUES ($1,$2,$3,$4,0,0,0) RETURNING id`,
      [pedido.id, d.loteId, d.tipoId ?? null, n])

    // ---- 6. o rastro --------------------------------------------------------
    //
    // Antes do INSERT dos ingressos de propósito: se o gatilho da cota recusar
    // algum ingresso, a transação inteira cai e não sobra grant órfão.
    const { rows: grants } = await c.query(
      `INSERT INTO courtesy_grants (org_id, event_id, order_id, lot_id, ticket_type_id,
                                    quantity, reason, requested_by,
                                    authorized_by, authorized_email, authorized_name,
                                    unit_face_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [lote.org_id, eventoId, pedido.id, d.loteId, d.tipoId ?? null,
       n, d.motivo, d.responsavel,
       autor.usuarioId, autor.email, autor.nome,
       Number(lote.price_cents)])

    const prefixo = String(lote.slug || 'ING').replace(/[^a-zA-Z]/g, '').slice(0, 3) || 'ING'
    const codigos: string[] = []
    for (const pessoa of d.pessoas) {
      const code = gerarCodigo(prefixo)
      await c.query(
        `INSERT INTO tickets (org_id, event_id, session_id, order_id, order_item_id,
                              sector_id, lot_id, ticket_type_id, code, qr_secret,
                              status, is_courtesy, holder_name, holder_email, holder_document)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,encode(gen_random_bytes(16),'hex'),
                 'valido',true,$10,$11,$12)`,
        [lote.org_id, eventoId, lote.session_id, pedido.id, itens[0].id,
         lote.sector_id, d.loteId, d.tipoId ?? null, code,
         pessoa.nome.trim(), pessoa.email || null, pessoa.documento || null])
      codigos.push(code)
    }

    // A auditoria entra na MESMA transação do ato: gravar por fora produz o
    // registro que sobrevive a um rollback. E vai pelo helper, não por um
    // INSERT solto — era assim que o autor acabava dentro do JSON, num campo
    // que a tela de auditoria não filtra.
    await registrarAuditoria({
      autor,
      entidade: 'order',
      entidadeId: pedido.id,
      acao: 'cortesia',
      depois: {
        quantidade: n,
        lote: lote.name,
        motivo: d.motivo,
        pedidaPor: d.responsavel,
        grant: grants[0].id,
        pedido: pedido.code,
      },
    }, c)

    return {
      ok: true,
      pedido: pedido.code,
      quantidade: n,
      codigos,
      cotaEvento: ev.courtesy_quota,
      restamNoEvento: ev.courtesy_quota === null ? null : ev.courtesy_quota - jaNoEvento - n,
    }
  })
}

/**
 * A recusa por cota, escrita pra quem está no guichê.
 *
 * Diz três coisas que a pessoa precisa: quanto sobra, qual é o teto e o que
 * fazer. "Cota excedida" manda ela procurar alguém; a frase abaixo resolve.
 */
function recusaDeCota(onde: string, sobra: number, teto: number, pedido: number): string {
  if (sobra <= 0) {
    return `A cota de cortesia ${onde} acabou: o teto é ${teto} e já foram emitidas ${teto}. Cancele uma cortesia ou peça a um master para aumentar a cota em Cortesias › Definir cota.`
  }
  return `Sobra${sobra === 1 ? '' : 'm'} ${sobra} cortesia(s) na cota ${onde} (teto de ${teto}) e você pediu ${pedido}.`
}
