/**
 * POST /api/portaria/sincronizar — a portaria conversando com o servidor
 * depois que a rede voltou.
 *
 * ## Por que esta rota existe
 *
 * O parque fica na Bahia e o 4G cai. Quando cai, o portão não pode parar: o
 * tablet valida contra a lista que baixou antes e guarda cada passagem numa
 * fila local. Esta rota é o outro lado disso, e faz as duas metades num
 * fôlego só:
 *
 *   sobe  → a fila de entradas que aconteceram sem rede
 *   desce → a lista de ingressos do evento, pro tablet validar na próxima vez
 *
 * Uma chamada só porque são a mesma conversa: o tablet que acabou de recuperar
 * a rede precisa entregar o que acumulou E atualizar o que tem na mão, e duas
 * chamadas separadas garantem que um dia uma delas vai ser esquecida num
 * caminho de erro.
 *
 * ## As três coisas que esta rota não pode errar
 *
 * 1. **Reenviar a fila não pode contar a pessoa duas vezes.** A idempotência
 *    não é feita aqui: ela é o `ON CONFLICT (id) DO NOTHING` do
 *    `SQL_GRAVA_ENTRADA`, com o id que nasceu no dispositivo. Aqui só se
 *    interpreta o resultado — `RETURNING` vazio significa "já estava no
 *    livro", e isso é `repetida`, não `aplicada`.
 *
 * 2. **Conflito aparece, não some.** Duas catracas offline deixam o mesmo QR
 *    entrar duas vezes; as duas passagens entram no livro (ids diferentes) e
 *    a resposta marca `conflito` no item e lista o par em `conflitos`. A
 *    tentação — recusar a segunda — apagaria uma pessoa que está fisicamente
 *    dentro do parque.
 *
 * 3. **O servidor não acredita na contagem do tablet.** Quantas pessoas cada
 *    entrada vale sai de `sectors.admits`, lido dentro do INSERT. Um aparelho
 *    que passou a noite fora de rede não decide o público do evento.
 *
 * ## Por que a autenticação é feita à mão aqui
 *
 * `middleware/01.autenticacao.ts` tranca `/api/admin/*` e `/api/checkin`, e
 * `middleware/03.papel.ts` só opina sobre rotas que `utils/papeis.ts`
 * classifica. `/api/portaria/*` não cai em nenhum dos dois: esta rota nasceria
 * ABERTA. Então ela mesma repete as três cercas da casa — sessão, área e
 * origem — usando as mesmas funções, sem inventar régua própria.
 */
import { z } from 'zod'
// Sem `randomUUID` aqui, e não por engano: nesta rota o id da passagem vem do
// DISPOSITIVO e de mais lugar nenhum. Um gerador de uuid à mão neste arquivo é
// o primeiro passo pra alguém "resolver" um id faltando inventando outro — e
// aí o `ON CONFLICT (id)` nunca mais dispara e a contagem infla em silêncio.
import { q, q1, tx } from '../../utils/db'
import { exigir } from '../../utils/sessao'
import { ehPapel, papelDoRoleLegado, papelPode, ROTULO } from '../../utils/papeis'
import { lerQr } from '../../utils/ingresso'
import {
  LIMITE_FILA, MENSAGEM_DA_FILA, normalizarFila,
  SQL_CONFLITOS, SQL_GRAVA_ENTRADA, SQL_MARCA_ENTRADA_EM, SQL_PUBLICO,
  type ResultadoDaFila,
} from '../../utils/catraca'

/** Teto da lista que desce. Acima disso o tablet não aguentaria mesmo. */
const LIMITE_LISTA = 20_000

const ItemDaFila = z.object({
  /** uuid criado no dispositivo, ANTES de existir rede. É a chave de tudo. */
  id: z.string().uuid(),
  qr: z.string().min(4).max(200),
  gate: z.string().max(40).nullish(),
  /** hora da passagem medida no tablet; ausente = agora */
  em: z.string().datetime({ offset: true }).nullish(),
  offline: z.boolean().default(true),
})

const Corpo = z.object({
  eventId: z.string().uuid(),
  deviceId: z.string().min(1).max(60).optional(),
  fila: z.array(ItemDaFila).max(LIMITE_FILA).default([]),
  /** `false` num flush de fila: baixar 20 mil ingressos a cada envio é o que
   *  transforma uma rede ruim em rede parada. */
  comLista: z.boolean().default(true),
})

export default defineEventHandler(async (event) => {
  // ---- cerca 1 e 2: sessão + área, as mesmas do resto da casa -------------
  const sessao = await exigir(event, 'portaria')

  // A grade FINA (utils/papeis.ts) vem do banco a cada requisição, como no
  // middleware 03 — rebaixar alguém na tela de equipe tem que valer na hora,
  // e o papel não viaja no cookie (a sessão dura 30 dias).
  const linha = await q1<{ papel: string | null; role: string | null }>(
    `SELECT papel, role FROM users WHERE id = $1`, [sessao.usuarioId])
  const papel = ehPapel(linha?.papel) ? linha!.papel as any : papelDoRoleLegado(linha?.role)
  if (!papelPode(papel, 'portaria')) {
    throw createError({
      statusCode: 403,
      statusMessage: `Seu acesso é de ${ROTULO[papel] ?? papel} e não inclui o leitor de entrada. `
        + `Peça a um master da sua organização.`,
    })
  }

  // ---- cerca 3: origem ----------------------------------------------------
  // O cookie é SameSite=Lax, o que já barra POST de outro site; isto é o cinto
  // além do suspensório, copiado do middleware 01 porque ele não roda aqui.
  const origem = getRequestHeader(event, 'origin')
  if (origem && origem !== getRequestURL(event).origin) {
    throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })
  }

  const p = Corpo.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'A fila enviada não está no formato esperado. '
        + 'Atualize a página da portaria e tente de novo.',
    })
  }
  const { eventId, deviceId, comLista } = p.data
  const operador = sessao.usuarioId
  const orgId = sessao.orgId

  // ---- o evento é desta casa? --------------------------------------------
  // Mesma cerca do /api/checkin: o evento vem no CORPO, então nenhum
  // middleware de tenant alcança. 404 e não 403 — "existe, mas não é seu" já
  // confirma que o id é de um evento real de outra empresa.
  const evento = await q1<any>(
    `SELECT id, name, starts_at, ends_at FROM events WHERE id = $1 AND org_id = $2`,
    [eventId, orgId])
  if (!evento) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  /* ------------------------------------------------------------ a fila sobe */

  const { fila, repetidasNoEnvio } = normalizarFila(p.data.fila)
  const itens: Array<{ id: string; codigo: string; resultado: ResultadoDaFila; mensagem: string }> = []

  for (const item of fila) {
    // O QR pode vir assinado (DT1:…) ou o operador digitou o código legível —
    // o mesmo par de casos do leitor online.
    const lido = lerQr(item.qr)
    const codigo = lido.ok ? lido.code! : item.qr.trim().toUpperCase()

    const registra = (resultado: ResultadoDaFila) => {
      itens.push({ id: item.id, codigo, resultado, mensagem: MENSAGEM_DA_FILA[resultado] })
    }

    // Assinatura errada = QR fabricado. Não entra no livro: contar gente que
    // não existe é pior do que perder o registro de uma que existe.
    if (!lido.ok && lido.motivo === 'assinatura') { registra('invalido'); continue }
    if (lido.ok && lido.eventId !== eventId) { registra('invalido'); continue }

    const ingresso = await q1<any>(
      `SELECT id, status FROM tickets WHERE code = $1 AND org_id = $2 AND event_id = $3`,
      [codigo, orgId, eventId])
    if (!ingresso) { registra('invalido'); continue }

    const quando = item.em ?? null

    const desfecho = await tx(async (c) => {
      const gravou = await c.query(SQL_GRAVA_ENTRADA, [
        item.id, ingresso.id, orgId, item.gate ?? null,
        deviceId ?? null, operador, item.offline, quando,
      ])
      // Nada de volta = este id já está no livro. É reenvio da mesma fila, e
      // a pessoa já foi contada. Este é o ponto inteiro do id nascer no
      // dispositivo.
      if (gravou.rowCount !== 1) return 'repetida' as const

      // Carimba o ingresso com a hora da PASSAGEM. `rowCount 0` = ele já
      // estava usado quando esta passagem chegou — o carimbo do primeiro fica
      // (ver o teste "o segundo não recarimba"), e isto aqui é conflito.
      const marcou = await c.query(SQL_MARCA_ENTRADA_EM, [ingresso.id, operador, quando])

      // A contagem é feita DEPOIS do insert, dentro da mesma transação: é ela
      // que enxerga a passagem retroativa (migração 013) e a do outro tablet
      // que chegou minutos antes. Olhar só o status do ingresso deixaria
      // passar o caso do ingresso cancelado, que nunca vira 'usado'.
      //
      // O status é relido AQUI, e não aproveitado da consulta lá de cima: a
      // fila pode ter ficado horas parada, e o ingresso pode ter sido
      // cancelado nesse meio-tempo. Decidir com o valor velho trocaria o
      // aviso "cancelado, vá atrás da pessoa" por um "tudo certo".
      const estado = await c.query(
        `SELECT (SELECT status FROM tickets WHERE id = $1) AS status,
                (SELECT count(*)::int FROM entries WHERE ticket_id = $1) AS n`,
        [ingresso.id])
      const passagens = Number(estado.rows[0]?.n ?? 1)
      const statusAgora = estado.rows[0]?.status as string | undefined

      // O log do LEITOR também ganha a linha, com a hora da passagem: é dele
      // que sai o gráfico de fila por hora, e uma entrada offline que não
      // aparecesse ali faria o pico das 14h sumir do relatório. `ok` porque é
      // o que o leitor decidiu na hora — a repetição aparece em `conflitos`,
      // que é o lugar dela.
      await c.query(
        `INSERT INTO checkins (event_id, ticket_id, code_lido, resultado, gate, operator_id, created_at)
         VALUES ($1,$2,$3,'ok',$4,$5, COALESCE($6::timestamptz, now()))`,
        [eventId, ingresso.id, codigo.slice(0, 120), item.gate ?? null, operador, quando])

      // Cancelado nunca vira 'usado' — e a pessoa entrou assim mesmo, porque
      // a lista do tablet era mais velha que o cancelamento. Fica registrada
      // (ela está dentro) e a portaria recebe o aviso pra ir atrás.
      if (marcou.rowCount !== 1 && statusAgora === 'cancelado') return 'cancelado' as const
      // Não conseguiu carimbar por outro motivo (já `usado`, `transferido`)
      // ou já havia passagem no livro: o ingresso entrou duas vezes.
      if (marcou.rowCount !== 1 || passagens > 1) return 'conflito' as const
      return 'aplicada' as const
    })

    registra(desfecho)
  }

  /* ------------------------------------------------ o retrato + a lista desce */

  const [publico, conflitos] = await Promise.all([
    q1<any>(SQL_PUBLICO, [eventId]),
    q<any>(SQL_CONFLITOS, [eventId]),
  ])

  const conta = (r: ResultadoDaFila) => itens.filter((i) => i.resultado === r).length

  return {
    ok: true,
    evento: { id: evento.id, nome: evento.name },
    geradaEm: new Date().toISOString(),
    resumo: {
      enviadas: p.data.fila.length,
      aplicadas: conta('aplicada'),
      // `repetidasNoEnvio` são as que vieram duas vezes dentro da MESMA
      // remessa; somar as duas dá o total de reenvio, que é o número que o
      // operador entende ("nada disso virou gente nova").
      repetidas: conta('repetida') + repetidasNoEnvio,
      conflitos: conta('conflito'),
      cancelados: conta('cancelado'),
      recusadas: conta('invalido'),
    },
    itens,
    publico: {
      pessoas: publico?.pessoas ?? 0,
      entradas: publico?.entradas ?? 0,
      ingressos: publico?.ingressos ?? 0,
      offline: publico?.offline ?? 0,
      ultima: publico?.ultima ?? null,
    },
    conflitos: conflitos.map((c) => ({
      ticketId: c.ticket_id,
      codigo: c.code,
      titular: c.holder_name,
      passagens: c.passagens,
      pessoas: c.pessoas,
      offline: c.offline,
      dispositivos: c.dispositivos,
      primeira: c.primeira,
      ultima: c.ultima,
      detalhe: c.detalhe ?? [],
    })),
    lista: comLista ? await listaDoEvento(eventId, orgId) : null,
  }
})

/**
 * O que o tablet precisa pra decidir sozinho, sem rede.
 *
 * Validar offline é comparar o código lido com esta lista — e isso é MAIS
 * forte que conferir a assinatura do QR, porque a assinatura só prova que o
 * ingresso foi emitido; a lista prova que ele existe, é deste evento e diz o
 * estado dele. A chave de assinatura não sai do servidor por nada.
 *
 * `sectors` e `lots` entram com JOIN comum de propósito: as duas colunas são
 * `NOT NULL` com `ON DELETE RESTRICT`, não existe ingresso órfão. `tipo` e
 * `sessão` são opcionais e entram com LEFT JOIN — com JOIN comum, todo
 * ingresso sem tipo sumiria da lista em silêncio e o portão recusaria gente
 * com ingresso bom.
 */
async function listaDoEvento(eventId: string, orgId: string) {
  const linhas = await q<any>(
    `SELECT t.code, t.status, t.holder_name, s.name AS setor, s.admits,
            l.name AS lote, tt.name AS tipo,
            es.id AS sessao_id, es.starts_at, es.ends_at
       FROM tickets t
       JOIN sectors s ON s.id = t.sector_id
       JOIN lots    l ON l.id = t.lot_id
       LEFT JOIN ticket_types  tt ON tt.id = t.ticket_type_id
       LEFT JOIN event_sessions es ON es.id = t.session_id
      WHERE t.event_id = $1 AND t.org_id = $2
      ORDER BY t.code
      LIMIT ${LIMITE_LISTA}`, [eventId, orgId])

  return {
    geradaEm: new Date().toISOString(),
    truncada: linhas.length >= LIMITE_LISTA,
    ingressos: linhas.map((t) => ({
      codigo: t.code,
      status: t.status,
      titular: t.holder_name,
      setor: t.setor,
      lote: t.lote,
      tipo: t.tipo,
      pessoas: t.admits,
      sessaoInicio: t.starts_at,
      sessaoFim: t.ends_at,
    })),
  }
}
