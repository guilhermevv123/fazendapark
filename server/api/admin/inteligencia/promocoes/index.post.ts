/**
 * POST /api/admin/inteligencia/promocoes { programa } — salva o "Volte Mais" da organização.
 * Ligar exige o INÍCIO da vigência (042: o fim pode ficar em branco = programa permanente, por tempo
 * indeterminado — o regulamento diz que o parque encerra avisando com 30 dias). O banco confere a
 * mesma regra (CHECK em 042), aqui sai a frase pra tela.
 */
import { z } from 'zod'
import { db } from '../../../../utils/db'
import { programaDeFidelidadeDaOrg } from '../../../../utils/fidelidade'
import { autorDaSessao } from '../../../../utils/base-conhecimento'

const DATA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().or(z.literal('').transform(() => null))
const Programa = z.object({
  nome: z.string().trim().min(2).max(60),
  ativo: z.boolean(),
  desconto_bps: z.number().int().min(100).max(10_000),
  retornos: z.number().int().min(1).max(50).nullable(),       // null = todas as próximas visitas
  prazo_dias: z.number().int().min(1).max(730).nullable(),
  ingressos_por_compra: z.number().int().min(1).max(20),
  conta_visita: z.enum(['entrada', 'compra']),
  dias_semana: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  vale_feriado: z.boolean(),
  eventos_fora: z.array(z.string().uuid()).max(200),
  vale_visita_anterior: z.boolean(),
  consumacao_bps: z.number().int().min(0).max(10_000),
  consumacao_usos: z.number().int().min(1).max(20).default(1),
  consumacao_dia_todo: z.boolean().default(false),
  vigencia_inicio: DATA,
  vigencia_fim: DATA,
  regulamento: z.string().max(6000).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const corpo = await readBody<{ programa?: unknown }>(event)
  const r = Programa.safeParse(corpo?.programa)
  if (!r.success) {
    const campo = r.error.issues[0]?.path.join('.') || 'programa'
    throw createError({ statusCode: 400, statusMessage: `Confira o campo "${campo}".` })
  }
  const p = r.data
  if (p.ativo && !p.vigencia_inicio) {
    throw createError({ statusCode: 400, statusMessage: 'Pra ligar, preencha a data de início (o fim pode ficar em branco: aí vale por tempo indeterminado).' })
  }
  if (p.vigencia_inicio && p.vigencia_fim && p.vigencia_fim < p.vigencia_inicio) {
    throw createError({ statusCode: 400, statusMessage: 'O fim da vigência está antes do início.' })
  }
  const orgId = event.context.sessao.orgId as string
  const regulamento = p.regulamento?.trim() ? p.regulamento.trim() : null
  await db().query(
    `INSERT INTO loyalty_programs (org_id, nome, ativo, desconto_bps, retornos, prazo_dias, ingressos_por_compra, conta_visita,
                                  dias_semana, vale_feriado, eventos_fora, vale_visita_anterior, consumacao_bps,
                                  vigencia_inicio, vigencia_fim, regulamento, updated_by, consumacao_usos, consumacao_dia_todo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::int[],$10,$11::uuid[],$12,$13,$14::date,$15::date,$16,$17,$18,$19)
     ON CONFLICT (org_id) DO UPDATE SET nome = EXCLUDED.nome, ativo = EXCLUDED.ativo, desconto_bps = EXCLUDED.desconto_bps,
       retornos = EXCLUDED.retornos, prazo_dias = EXCLUDED.prazo_dias, ingressos_por_compra = EXCLUDED.ingressos_por_compra,
       conta_visita = EXCLUDED.conta_visita, dias_semana = EXCLUDED.dias_semana, vale_feriado = EXCLUDED.vale_feriado,
       eventos_fora = EXCLUDED.eventos_fora, vale_visita_anterior = EXCLUDED.vale_visita_anterior,
       consumacao_bps = EXCLUDED.consumacao_bps, vigencia_inicio = EXCLUDED.vigencia_inicio, vigencia_fim = EXCLUDED.vigencia_fim,
       regulamento = EXCLUDED.regulamento, updated_by = EXCLUDED.updated_by, updated_at = now(),
       consumacao_usos = EXCLUDED.consumacao_usos, consumacao_dia_todo = EXCLUDED.consumacao_dia_todo`,
    [orgId, p.nome, p.ativo, p.desconto_bps, p.retornos, p.prazo_dias, p.ingressos_por_compra, p.conta_visita,
     [...new Set(p.dias_semana)].sort(), p.vale_feriado, [...new Set(p.eventos_fora)], p.vale_visita_anterior,
     p.consumacao_bps, p.vigencia_inicio, p.vigencia_fim, regulamento, autorDaSessao(event.context.sessao),
     p.consumacao_usos, p.consumacao_dia_todo])
  return { programa: await programaDeFidelidadeDaOrg(db(), orgId) }
})
