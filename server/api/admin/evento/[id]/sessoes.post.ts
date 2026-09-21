/**
 * POST /api/admin/evento/:id/sessoes — cria e mantém os dias vendáveis.
 *
 * Quatro ações numa rota só, pelo mesmo motivo de `ingressos.post.ts`: todas
 * precisam conferir que a sessão (ou o lote) é DESTE evento, e regra que mora
 * em quatro arquivos é regra que um dia nasce sem a linha.
 *
 *   criar   várias datas de uma vez — o parque abre todo fim de semana, e
 *           cadastrar 52 sábados na mão é como se cadastram 51
 *   editar  título e capacidade do dia
 *   lotes   quais ingressos valem em quais dias (nos dois sentidos)
 *   apagar  tira o dia do catálogo, se ninguém comprou
 *
 * ## As datas são montadas no Postgres, não em JavaScript
 *
 * `new Date('2026-10-17') ` nasce em UTC, e `toISOString()` converte antes de
 * cortar: às 21h de Brasília "hoje" já virou amanhã. O parque abre às 09:00
 * **em America/Bahia**, e é isso que precisa ficar gravado. Montando a data no
 * banco (`(dia + hora) AT TIME ZONE fuso`) o fuso do evento entra na conta uma
 * vez só, do lado que conhece fuso de verdade — e o servidor pode estar em
 * qualquer lugar do mundo.
 *
 * ## A capacidade é conferida com a linha travada
 *
 * Baixar o teto enquanto alguém compra é a mesma corrida de dois compradores
 * na última vaga, com um dos lados na tela do produtor. A leitura da ocupação
 * aqui vem DEPOIS do `FOR UPDATE` na sessão — a mesma linha que o gatilho do
 * 016 segura na venda. Assim as duas pontas entram na fila uma da outra.
 */
import { z } from 'zod'
import { q, q1, tx } from '../../../../utils/db'

const DATA = /^\d{4}-\d{2}-\d{2}$/
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/

const Criar = z.object({
  o: z.literal('criar'),
  de: z.string().regex(DATA),
  ate: z.string().regex(DATA),
  /** ISO: 1 = segunda … 7 = domingo */
  dias: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  horarios: z.array(z.object({
    inicio: z.string().regex(HORA),
    fim: z.string().regex(HORA),
  })).min(1).max(6),
  capacidade: z.number().int().min(1).max(1_000_000).nullish(),
  titulo: z.string().min(1).max(80).nullish(),
  /** já deixa estes lotes à venda nos dias gerados */
  loteIds: z.array(z.string().uuid()).max(50).default([]),
})

const Editar = z.object({
  o: z.literal('editar'),
  sessaoId: z.string().uuid(),
  titulo: z.string().min(1).max(80).nullish(),
  /** null tira o teto */
  capacidade: z.number().int().min(1).max(1_000_000).nullable().optional(),
})

const Lotes = z.object({
  o: z.literal('lotes'),
  sessaoId: z.string().uuid().optional(),
  loteIds: z.array(z.string().uuid()).max(200).optional(),
  loteId: z.string().uuid().optional(),
  sessaoIds: z.array(z.string().uuid()).max(400).optional(),
})

const Apagar = z.object({
  o: z.literal('apagar'),
  sessaoId: z.string().uuid(),
})

const Entrada = z.discriminatedUnion('o', [Criar, Editar, Lotes, Apagar])

/** teto do que uma chamada de criação pode gerar de uma vez */
const MAXIMO_POR_VEZ = 400

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data

  const ev = await q1<any>(
    `SELECT id, org_id, name, timezone FROM events WHERE id = $1`, [eventoId])
  if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  const fuso = ev.timezone || 'America/Bahia'

  if (d.o === 'criar') return await criar(d, ev, fuso)
  if (d.o === 'editar') return await editar(d, ev)
  if (d.o === 'lotes') return await ligarLotes(d, ev)
  return await apagar(d, ev)
})

// ------------------------------------------------------------------ criar ---
async function criar(d: z.infer<typeof Criar>, ev: any, fuso: string) {
  if (d.ate < d.de) {
    throw createError({ statusCode: 422, statusMessage: 'A data final é anterior à inicial.' })
  }
  const dias = (Date.parse(`${d.ate}T00:00:00Z`) - Date.parse(`${d.de}T00:00:00Z`)) / 86_400_000
  if (!Number.isFinite(dias)) {
    throw createError({ statusCode: 422, statusMessage: 'Data inválida.' })
  }
  if (dias > 366) {
    throw createError({
      statusCode: 422,
      statusMessage: 'O período passa de um ano. Faça em blocos de até 12 meses.',
    })
  }

  // O CHECK do schema exige 15 minutos de sessão; recusar aqui é o que
  // transforma "violates check constraint" numa frase que o operador entende.
  for (const h of d.horarios) {
    const [hi, mi] = h.inicio.split(':').map(Number)
    const [hf, mf] = h.fim.split(':').map(Number)
    let duracao = (hf * 60 + mf) - (hi * 60 + mi)
    if (duracao <= 0) duracao += 24 * 60      // atravessa a meia-noite
    if (duracao < 15) {
      throw createError({
        statusCode: 422,
        statusMessage: `O horário ${h.inicio}–${h.fim} dura menos de 15 minutos.`,
      })
    }
  }

  const inicios = d.horarios.map((h) => h.inicio)
  const fins = d.horarios.map((h) => h.fim)

  // O gerador, escrito uma vez e usado duas: contar antes e inserir depois.
  // `g.d` vem de generate_series como timestamp; o ::date é o que permite
  // somar a hora e virar o dia quando a sessão atravessa a meia-noite.
  //
  // Os sete parâmetros dele vêm PRIMEIRO de propósito: a consulta de contagem
  // recebe só estes sete, e o Postgres recusa um $n que a instrução não usa
  // ("could not determine data type of parameter").
  const GERADOR = `
    SELECT (g.d::date + h.inicio::time) AT TIME ZONE $1 AS inicio,
           ((g.d::date + CASE WHEN h.fim::time <= h.inicio::time THEN 1 ELSE 0 END)
             + h.fim::time) AT TIME ZONE $1 AS fim,
           COALESCE($2::text,
             (ARRAY['Segunda','Terça','Quarta','Quinta','Sexta','Sábado','Domingo'])
               [EXTRACT(ISODOW FROM g.d)::int] || ' ' || to_char(g.d, 'DD/MM')) AS titulo
      FROM generate_series($3::date, $4::date, interval '1 day') AS g(d)
      CROSS JOIN unnest($5::text[], $6::text[]) AS h(inicio, fim)
     WHERE EXTRACT(ISODOW FROM g.d)::int = ANY($7::int[])`

  const parGerador = [fuso, d.titulo ?? null, d.de, d.ate, inicios, fins, d.dias]
  const par = [...parGerador, ev.id, d.capacidade ?? null]

  const previa = await q1<any>(`SELECT count(*)::int AS n FROM (${GERADOR}) x`, parGerador)
  if (Number(previa.n) === 0) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Nenhuma data cai nos dias da semana escolhidos dentro desse período.',
    })
  }
  if (Number(previa.n) > MAXIMO_POR_VEZ) {
    throw createError({
      statusCode: 422,
      statusMessage: `Isso criaria ${previa.n} sessões de uma vez. Faça em blocos de até ${MAXIMO_POR_VEZ}.`,
    })
  }

  // O UNION não é enfeite: o SELECT de fora de um CTE que grava NÃO enxerga o
  // que o CTE acabou de inserir (todos os ramos leem o mesmo snapshot). Ler a
  // tabela aqui devolveria só as sessões que já existiam, e a resposta diria
  // "criadas: 0" logo depois de criar 20.
  const linhas = await q<any>(
    `WITH gerado AS (${GERADOR}),
     novas AS (
       INSERT INTO event_sessions (event_id, starts_at, ends_at, title, capacity)
       SELECT $8, g.inicio, g.fim, g.titulo, $9::int FROM gerado g
       ON CONFLICT (event_id, starts_at) DO NOTHING
       RETURNING id, starts_at, title, capacity
     )
     SELECT id, starts_at, title, capacity, true AS nova FROM novas
     UNION ALL
     SELECT es.id, es.starts_at, es.title, es.capacity, false
       FROM event_sessions es
       JOIN gerado g ON g.inicio = es.starts_at
      WHERE es.event_id = $8
      ORDER BY starts_at`, par)

  const novas = linhas.filter((l) => l.nova)

  // A ordem do menu, da tela pública e do relatório sai de sort_order. Com
  // datas criadas fora de ordem (o produtor cadastra o feriado depois), a
  // numeração cronológica precisa ser refeita — é barato e evita a lista que
  // mostra 20/12 antes de 13/12.
  await q(
    `UPDATE event_sessions es SET sort_order = x.n
       FROM (SELECT id, row_number() OVER (ORDER BY starts_at) AS n
               FROM event_sessions WHERE event_id = $1) x
      WHERE es.id = x.id AND es.sort_order <> x.n`, [ev.id])

  let vinculos = 0
  if (d.loteIds.length) {
    const meus = await q<any>(
      `SELECT l.id FROM lots l JOIN sectors s ON s.id = l.sector_id
        WHERE l.id = ANY($1::uuid[]) AND s.event_id = $2`, [d.loteIds, ev.id])
    if (meus.length !== d.loteIds.length) {
      throw createError({ statusCode: 422, statusMessage: 'Algum lote não é deste evento.' })
    }
    const r = await q<any>(
      `INSERT INTO lot_sessions (lot_id, session_id)
       SELECT l, s FROM unnest($1::uuid[]) AS l CROSS JOIN unnest($2::uuid[]) AS s
       ON CONFLICT DO NOTHING
       RETURNING lot_id`,
      [d.loteIds, linhas.map((l) => l.id)])
    vinculos = r.length
  }

  await q(
    `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
     VALUES ($1,'evento',$2,'sessoes_criadas',$3::jsonb)`,
    [ev.org_id, ev.id, JSON.stringify({
      de: d.de, ate: d.ate, dias: d.dias, horarios: d.horarios,
      capacidade: d.capacidade ?? null, criadas: novas.length,
      repetidas: linhas.length - novas.length, vinculos,
    })])

  return {
    ok: true,
    criadas: novas.length,
    // "já existia" não é erro: reexecutar o mesmo intervalo é o jeito normal
    // de esticar o calendário sem apagar nada.
    repetidas: linhas.length - novas.length,
    vinculos,
    sessoes: linhas.map((l) => ({
      id: l.id, titulo: l.title, inicio: l.starts_at,
      capacidade: l.capacity === null ? null : Number(l.capacity), nova: l.nova,
    })),
  }
}

// ----------------------------------------------------------------- editar ---
async function editar(d: z.infer<typeof Editar>, ev: any) {
  return await tx(async (c) => {
    // A trava vem ANTES da conta, e é a mesma linha que a venda segura.
    const { rows } = await c.query(
      `SELECT id, title, capacity FROM event_sessions
        WHERE id = $1 AND event_id = $2
        FOR UPDATE`, [d.sessaoId, ev.id])
    const sessao = rows[0]
    if (!sessao) throw createError({ statusCode: 404, statusMessage: 'Sessão não é deste evento' })

    if (d.capacidade !== undefined && d.capacidade !== null) {
      const { rows: o } = await c.query(`SELECT sessao_ocupacao($1) AS n`, [d.sessaoId])
      const ocupadas = Number(o[0].n)
      if (d.capacidade < ocupadas) {
        throw createError({
          statusCode: 409,
          statusMessage: `Este dia já tem ${ocupadas} lugar(es) vendido(s) — o teto não pode ser menor que isso. `
            + 'Cancele pedidos antes de reduzir.',
        })
      }
    }

    // `COALESCE(título, título)` aqui seria falha muda: quem apagasse o nome
    // na tela e salvasse veria o nome antigo voltar sem nenhum aviso — o
    // formulário diz que salvou, e o campo desobedece. Chave ausente é "não
    // mexi"; chave com null é "apaga e volta pro nome automático". O mesmo
    // que a capacidade já fazia.
    const { rows: upd } = await c.query(
      `UPDATE event_sessions
          SET title    = CASE WHEN $2::boolean THEN $3::text ELSE title END,
              capacity = CASE WHEN $4::boolean THEN $5::int ELSE capacity END
        WHERE id = $1
        RETURNING id, title, capacity, starts_at, ends_at`,
      [d.sessaoId, d.titulo !== undefined, d.titulo ?? null,
       d.capacidade !== undefined, d.capacidade ?? null])

    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, before, after)
       VALUES ($1,'sessao',$2,'editada',$3::jsonb,$4::jsonb)`,
      [ev.org_id, d.sessaoId,
       JSON.stringify({ titulo: sessao.title, capacidade: sessao.capacity }),
       JSON.stringify({ titulo: upd[0].title, capacidade: upd[0].capacity })])

    return {
      ok: true,
      sessao: {
        id: upd[0].id, titulo: upd[0].title,
        capacidade: upd[0].capacity === null ? null : Number(upd[0].capacity),
        inicio: upd[0].starts_at, fim: upd[0].ends_at,
      },
    }
  })
}

// ------------------------------------------------------------------ lotes ---
/**
 * Troca o conjunto de ligações lote × sessão.
 *
 * Aceita os dois sentidos porque as duas perguntas são feitas de verdade:
 * "quais ingressos valem neste sábado?" (tela do dia) e "em quais dias este
 * ingresso vale?" (tela do lote). É a mesma tabela.
 *
 * Desligar é o lado perigoso: se alguém já comprou este lote PARA este dia, a
 * ligação é o único papel que diz que aquele ingresso vale naquele sábado.
 * Tirar deixaria o comprador com um ingresso de dia nenhum.
 */
async function ligarLotes(d: z.infer<typeof Lotes>, ev: any) {
  const porSessao = !!d.sessaoId
  if (porSessao === !!d.loteId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Mande sessaoId + loteIds, ou loteId + sessaoIds — um dos dois.',
    })
  }

  const sessaoIds = porSessao ? [d.sessaoId!] : (d.sessaoIds ?? [])
  const loteIds = porSessao ? (d.loteIds ?? []) : [d.loteId!]

  if (sessaoIds.length) {
    const s = await q<any>(
      `SELECT id FROM event_sessions WHERE id = ANY($1::uuid[]) AND event_id = $2`,
      [sessaoIds, ev.id])
    if (s.length !== sessaoIds.length) {
      throw createError({ statusCode: 422, statusMessage: 'Alguma sessão não é deste evento.' })
    }
  }
  if (loteIds.length) {
    const l = await q<any>(
      `SELECT l.id FROM lots l JOIN sectors s ON s.id = l.sector_id
        WHERE l.id = ANY($1::uuid[]) AND s.event_id = $2`, [loteIds, ev.id])
    if (l.length !== loteIds.length) {
      throw createError({ statusCode: 422, statusMessage: 'Algum lote não é deste evento.' })
    }
  }

  return await tx(async (c) => {
    const atuais = porSessao
      ? (await c.query(`SELECT lot_id AS outro FROM lot_sessions WHERE session_id = $1`,
          [d.sessaoId])).rows.map((r) => r.outro)
      : (await c.query(`SELECT session_id AS outro FROM lot_sessions WHERE lot_id = $1`,
          [d.loteId])).rows.map((r) => r.outro)

    const pedidos = porSessao ? loteIds : sessaoIds
    const removidos = atuais.filter((x: string) => !pedidos.includes(x))

    for (const alvo of removidos) {
      const loteId = porSessao ? alvo : d.loteId
      const sessaoId = porSessao ? d.sessaoId : alvo
      const { rows } = await c.query(
        `SELECT COALESCE(SUM(oi.quantity),0)::int AS n,
                (SELECT name FROM lots WHERE id = $1) AS lote,
                (SELECT to_char(es.starts_at AT TIME ZONE e.timezone, 'DD/MM HH24:MI')
                   FROM event_sessions es JOIN events e ON e.id = es.event_id
                  WHERE es.id = $2) AS dia
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE oi.lot_id = $1 AND oi.session_id = $2
            AND o.status IN ('aguardando_pagamento','em_analise','pago','estornado_parcial')`,
        [loteId, sessaoId])
      if (Number(rows[0].n) > 0) {
        throw createError({
          statusCode: 409,
          statusMessage: `"${rows[0].lote}" já tem ${rows[0].n} ingresso(s) vendido(s) para ${rows[0].dia}. `
            + 'Tirar esse dia deixaria esses compradores sem data.',
        })
      }
    }

    if (removidos.length) {
      if (porSessao) {
        await c.query(`DELETE FROM lot_sessions WHERE session_id = $1 AND lot_id = ANY($2::uuid[])`,
          [d.sessaoId, removidos])
      } else {
        await c.query(`DELETE FROM lot_sessions WHERE lot_id = $1 AND session_id = ANY($2::uuid[])`,
          [d.loteId, removidos])
      }
    }

    let ligados = 0
    if (pedidos.length) {
      const r = await c.query(
        `INSERT INTO lot_sessions (lot_id, session_id)
         SELECT l, s FROM unnest($1::uuid[]) AS l CROSS JOIN unnest($2::uuid[]) AS s
         ON CONFLICT DO NOTHING RETURNING lot_id`,
        [loteIds, sessaoIds])
      ligados = r.rowCount ?? 0
    }

    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'sessao',$2,'lotes_do_dia',$3::jsonb)`,
      [ev.org_id, porSessao ? d.sessaoId : d.loteId,
       JSON.stringify({ porSessao, lotes: loteIds, sessoes: sessaoIds,
                        ligados, desligados: removidos.length })])

    return { ok: true, ligados, desligados: removidos.length }
  })
}

// ----------------------------------------------------------------- apagar ---
async function apagar(d: z.infer<typeof Apagar>, ev: any) {
  const s = await q1<any>(
    `SELECT es.id, es.title,
            sessao_ocupacao(es.id) AS ocupadas,
            -- tickets.session_id sozinho é NULL em todo ingresso do modelo
            -- novo (quem carimba é emissao.ts, e ele copia o dia do SETOR):
            -- esta guarda ficava morta justamente no caso que ela existe pra
            -- proteger. Ver sessao_ingressos no 016.
            sessao_ingressos(es.id) AS ingressos,
            (SELECT count(*)::int FROM sectors se WHERE se.session_id = es.id) AS setores
       FROM event_sessions es
      WHERE es.id = $1 AND es.event_id = $2`, [d.sessaoId, ev.id])
  if (!s) throw createError({ statusCode: 404, statusMessage: 'Sessão não é deste evento' })

  if (Number(s.ocupadas) > 0 || Number(s.ingressos) > 0) {
    throw createError({
      statusCode: 409,
      statusMessage: `"${s.title ?? 'Esta sessão'}" já tem ${s.ocupadas || s.ingressos} pessoa(s) com ingresso. `
        + 'Cancele os pedidos antes de apagar o dia.',
    })
  }
  // `sectors.session_id` é ON DELETE CASCADE desde o 001: apagar a sessão
  // levaria o setor inteiro junto — e com ele os lotes e o preço. Isso não
  // pode acontecer por um clique numa tela de calendário.
  if (Number(s.setores) > 0) {
    throw createError({
      statusCode: 409,
      statusMessage: `Existe(m) ${s.setores} setor(es) amarrado(s) a este dia. `
        + 'Apagar o dia apagaria o setor e os lotes dele junto — mude o setor de dia primeiro.',
    })
  }

  await q(`DELETE FROM event_sessions WHERE id = $1`, [d.sessaoId])
  await q(
    `INSERT INTO audit_log (org_id, entity, entity_id, action, before)
     VALUES ($1,'sessao',$2,'apagada',$3::jsonb)`,
    [ev.org_id, d.sessaoId, JSON.stringify({ titulo: s.title })])

  return { ok: true }
}
