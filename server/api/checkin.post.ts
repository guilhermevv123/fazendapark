/**
 * POST /api/checkin — a catraca.
 *
 * Roda com gente na fila esperando, então otimiza pra: decidir rápido, decidir
 * certo, e NUNCA deixar o mesmo ingresso entrar duas vezes mesmo se dois
 * leitores lerem no mesmo instante (acontece toda hora: dois portões, ou o
 * operador que lê de novo achando que falhou).
 *
 * A trava é o UPDATE condicional: quem grava `usado` primeiro ganha, o segundo
 * vê rowCount 0 e recebe "já entrou". Ler e depois gravar deixaria os dois
 * passarem.
 *
 * TODA leitura vira linha em checkins, inclusive a recusada — é o que permite
 * auditar fila, portão e tentativa de fraude depois. E toda leitura ACEITA
 * vira também uma linha em `entries`, o livro de quem entrou: é de lá que sai
 * a contagem de PESSOAS (uma mesa de 4 é uma leitura e quatro pessoas) e é lá
 * que a entrada feita offline, sem servidor, vai parar quando a rede voltar.
 * Os dois caminhos gravam no mesmo livro, com o mesmo formato de id.
 */
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { q, q1, tx } from '../utils/db'
import {
  meiaDoIngresso, retratoDoPublico, SQL_GRAVA_ENTRADA, SQL_MARCA_ENTRADA,
  SQL_PRIMEIRA_ENTRADA, SQL_PUBLICO,
} from '../utils/catraca'
import { lerQr, MENSAGEM_CHECKIN, type ResultadoCheckin } from '../utils/ingresso'

const Entrada = z.object({
  qr: z.string().min(4).max(200),
  eventId: z.string().uuid(),
  gate: z.string().max(40).optional(),
  /** só confere, não marca — pro operador checar antes de deixar entrar */
  apenasConsultar: z.boolean().default(false),
  /**
   * id da passagem, criado no DISPOSITIVO antes de mandar. Opcional: quem não
   * manda ganha um do servidor. Mandar é melhor — se a resposta se perder no
   * caminho e o operador ler de novo, a segunda tentativa carrega o mesmo id e
   * o livro não ganha duas linhas pra uma pessoa só.
   */
  entradaId: z.string().uuid().optional(),
  /** qual tablet. Vira a coluna que explica duas entradas do mesmo ingresso. */
  deviceId: z.string().max(60).optional(),
})

export default defineEventHandler(async (event) => {
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) throw createError({ statusCode: 400, statusMessage: 'Dados inválidos' })
  const { qr, eventId, gate, apenasConsultar, entradaId, deviceId } = p.data

  // Quem leu. O middleware já exigiu sessão nesta rota, então o operador
  // SEMPRE existe aqui. Sem este carimbo, `checkins.operator_id` e
  // `tickets.checked_in_by` ficam nulos pra sempre e a coluna "validado por"
  // da tela de participantes nasce morta — a leitura fica sem dono, que é
  // justamente o que alguém vai querer saber quando um ingresso entrar duas
  // vezes ou entrar sem direito.
  const operador = (event.context as any).sessao?.usuarioId ?? null

  // ---- a cerca desta rota, que a do middleware não alcança ----------------
  // `02.tenant.ts` confere dono pelo id que está na URL. Aqui o evento vem no
  // CORPO, então a cerca tem que ser feita à mão — e sem ela a porta de uma
  // produtora queimava ingresso de outra: bastava o código na mão e um login
  // em qualquer casa da instalação pra derrubar a entrada de uma empresa
  // inteira. O código é público (vai impresso no ingresso).
  const orgDaSessao = (event.context as any).sessao?.orgId ?? null
  if (!orgDaSessao) throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })

  const eventoDaCasa = await q1<any>(
    `SELECT id FROM events WHERE id = $1 AND org_id = $2`, [eventId, orgDaSessao])
  // 404, não 403: dizer "existe, mas não é seu" já confirma que aquele id é
  // de um evento real de outra empresa.
  if (!eventoDaCasa) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  /**
   * Grava a leitura no log E devolve o retrato do público junto.
   *
   * O retrato vem daqui, e não de uma segunda chamada da tela, por causa de um
   * furo medido em 21/09 com o leitor aberto: os três KPIs do topo ("Pessoas
   * dentro", "Já entraram", "Comparecimento") só eram preenchidos pela rota de
   * sincronização, que com rede boa roda UMA vez, na montagem da página. O
   * operador lia um ingresso, a tela respondia "PODE ENTRAR", e os três
   * números continuavam nos valores da abertura — medido: servidor com
   * `pessoas = 1`, tela mostrando `0`. Um painel que não anda é pior que
   * painel nenhum: ele parece atualizado.
   *
   * Vem em TODA leitura registrada (inclusive a recusada) de propósito: o
   * portão vizinho também está contando gente, e uma recusa aqui é um momento
   * em que o operador olha a tela. Só a consulta ("só conferir") não paga esse
   * preço — ela devolve antes, sem registrar nada.
   *
   * `Promise.all` com o INSERT porque a fila anda: a consulta do retrato não
   * pode somar latência à decisão da porta. E é o MESMO `SQL_PUBLICO` da
   * sincronização — dois retratos calculados em lugares diferentes é como os
   * números voltam a discordar.
   */
  const registrar = async (resultado: ResultadoCheckin, ticketId: string | null, codigo: string) => {
    const [, publico] = await Promise.all([
      q(`INSERT INTO checkins (event_id, ticket_id, code_lido, resultado, gate, operator_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [eventId, ticketId, codigo.slice(0, 120), resultado, gate ?? null, operador]),
      q1<any>(SQL_PUBLICO, [eventId]),
    ])
    return {
      ok: resultado === 'ok',
      resultado,
      mensagem: MENSAGEM_CHECKIN[resultado],
      publico: retratoDoPublico(publico),
    }
  }

  // O QR pode vir assinado (DT1:...) ou o operador digitou o código legível.
  const lido = lerQr(qr)
  const codigo = lido.ok ? lido.code! : qr.trim().toUpperCase()

  if (!lido.ok && lido.motivo === 'assinatura') {
    // Formato certo, assinatura errada = alguém fabricou. Isso é o achado mais
    // importante que esta rota produz; fica marcado como inválido e auditável.
    return registrar('invalido', null, qr)
  }
  if (lido.ok && lido.eventId !== eventId) {
    return registrar('evento_errado', null, qr)
  }

  const ingresso = await q1<any>(
    // `half_*` entra aqui porque a portaria é quem PEDE o documento. Sem estes
    // três campos o operador lia só o nome do tipo ("Meia-entrada") e ficava
    // sem saber qual papel pedir — com a fila na frente, que é o problema que
    // a migração 015 existe pra resolver e que morria na borda da consulta.
    // `tt.kind` vem junto porque a meia do BALCÃO nasce sem `half_reason` e
    // sem texto congelado (o gatilho da 015 só derruba a venda online sem
    // motivo). Sem a espécie, esse ingresso volta a chegar na porta sem dizer
    // que é meia — o mesmo furo, por outra porta.
    `SELECT t.id, t.status, t.event_id, t.holder_name, t.checked_in_at,
            t.half_reason, t.half_document, t.half_document_required,
            s.name AS setor, l.name AS lote, tt.name AS tipo, tt.kind AS especie,
            es.starts_at AS sessao_inicio, es.ends_at AS sessao_fim
       FROM tickets t
       JOIN sectors s ON s.id = t.sector_id
       JOIN lots l    ON l.id = t.lot_id
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN event_sessions es ON es.id = t.session_id
      WHERE t.code = $1 AND t.org_id = $2`, [codigo, orgDaSessao])
  // O `org_id` no WHERE é o que separa "ingresso de outro evento MEU"
  // (evento_errado, mensagem útil pro público) de "ingresso de outra
  // empresa" — que aqui simplesmente não existe.

  if (!ingresso) return registrar('invalido', null, codigo)
  if (ingresso.event_id !== eventId) return registrar('evento_errado', ingresso.id, codigo)
  if (ingresso.status === 'cancelado') return registrar('cancelado', ingresso.id, codigo)
  if (ingresso.status === 'usado') {
    const r = await registrar('ja_usado', ingresso.id, codigo)
    return { ...r, ...(await ondeEntrou(ingresso)), titular: ingresso.holder_name }
  }

  // janela da sessão, com 2h de folga antes e depois — chegar cedo é normal
  if (ingresso.sessao_inicio) {
    const agora = Date.now()
    const abre = new Date(ingresso.sessao_inicio).getTime() - 2 * 3600_000
    const fecha = new Date(ingresso.sessao_fim ?? ingresso.sessao_inicio).getTime() + 2 * 3600_000
    if (agora < abre || agora > fecha) return registrar('fora_da_sessao', ingresso.id, codigo)
  }

  if (apenasConsultar) {
    return {
      ok: true, resultado: 'ok' as const, mensagem: 'Válido (não marcado)',
      consulta: true,
      ingresso: dadosDoIngresso(ingresso),
    }
  }

  // ---- a trava: só um UPDATE consegue virar 'usado' -----------------------
  // A instrução mora em utils/catraca.ts pra que o teste rode exatamente
  // esta, e não uma cópia que envelhece sozinha.
  //
  // O livro de entradas é escrito na MESMA transação: um carimbo sem linha no
  // livro é uma pessoa dentro do parque que o relatório de público não conta,
  // e é o tipo de furo que só aparece no fim da noite, quando a conferência
  // não fecha e ninguém sabe qual das duas telas está errada.
  const passagem = await tx(async (c) => {
    const r = await c.query(SQL_MARCA_ENTRADA, [ingresso.id, operador])
    if (r.rowCount !== 1) return null

    const gravar = (id: string) => c.query(SQL_GRAVA_ENTRADA,
      [id, ingresso.id, orgDaSessao, gate ?? null, deviceId ?? null, operador, false, null])

    let livro = await gravar(entradaId ?? randomUUID())
    // `RETURNING` vazio só acontece se o id mandado pelo dispositivo já estiver
    // no livro (dois eventos diferentes reusando o mesmo uuid — bug de quem
    // chama). O carimbo já foi dado e a pessoa está passando: a saída certa é
    // registrar com um id novo, não devolver erro pra uma fila que anda.
    if (livro.rowCount !== 1) livro = await gravar(randomUUID())
    return { pessoas: Number(livro.rows[0]?.people ?? 1) }
  })

  if (!passagem) {
    const r = await registrar('ja_usado', ingresso.id, codigo)
    return { ...r, ...(await ondeEntrou(ingresso)), titular: ingresso.holder_name }
  }

  const r = await registrar('ok', ingresso.id, codigo)
  return { ...r, ingresso: dadosDoIngresso(ingresso), pessoas: passagem.pessoas }
})

function dadosDoIngresso(i: any) {
  return {
    titular: i.holder_name,
    setor: i.setor,
    lote: i.lote,
    tipo: i.tipo,
    // null quando o ingresso é inteira — a tela só mostra o bloco quando há
    // algo a pedir. Ver `meiaDoIngresso` em utils/catraca.ts.
    meia: meiaDoIngresso(i),
  }
}

/**
 * Onde e quando este ingresso já passou.
 *
 * "Este ingresso já entrou" com a fila andando e o cliente jurando que não
 * entrou não resolve nada — e era só isso que a porta dizia. Com o portão e a
 * hora, o operador responde em dois segundos e a fila volta a andar. Cai pro
 * `checked_in_at` do ingresso quando a passagem é anterior ao livro.
 */
async function ondeEntrou(i: any) {
  const e = await q1<any>(SQL_PRIMEIRA_ENTRADA, [i.id])
  return {
    entrouEm: e?.entered_at ?? i.checked_in_at,
    portao: e?.gate ?? null,
    operadorEntrada: e?.operador ?? null,
    entrouOffline: e?.offline ?? false,
  }
}
