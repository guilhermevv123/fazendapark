/**
 * POST /api/admin/evento/:id/financeiro — pede uma transferência.
 *
 * Esta rota NÃO move dinheiro. Ela registra o pedido com status 'solicitada' e
 * para. Quem move é o processo que fala com o gateway, lendo esta fila.
 *
 * A separação é de propósito. Um pedido que chama o banco no meio do handler
 * fica sem resposta se o gateway demorar, o operador clica de novo, e o
 * produtor recebe duas vezes. Gravar primeiro, sacar depois é o que deixa o
 * saque ser retentado sem risco de duplicar: o registro já existe, e o segundo
 * clique cai na trava de valor disponível abaixo.
 *
 * O teto é recalculado AQUI DENTRO da transação, não confiando no número que a
 * tela mostrou. A tela pode ter sido aberta antes de outro saque entrar.
 */
import { z } from 'zod'
import { tx } from '../../../../utils/db'
import { gerarCodigo } from '../../../../utils/ingresso'
import { DIAS_DE_RETENCAO, SQL_LIBERA_EM } from '../../../../utils/retencao'
import { SQL_TRAVA_EVENTO, recusaDeSaque, saldoParaSaque } from '../../../../utils/saque'

const Entrada = z.object({
  beneficiario: z.string().min(2).max(140),
  documento: z.string().max(20).nullish(),
  destinoTipo: z.enum(['pix', 'conta']),
  destino: z.string().min(4).max(200),
  valorCents: z.number().int().positive().max(5_000_000_00),
  observacao: z.string().max(500).nullish(),
})

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data
  const sessao = (event.context as any).sessao

  return await tx(async (c) => {
    // A trava vem PRIMEIRO, e sem nenhuma checagem de saldo antes dela. Ver
    // `utils/saque.ts`: uma pré-checagem aqui resolveria o caso enfileirado
    // e esconderia a ausência da trava do próprio teste.
    const { rows: evs } = await c.query(SQL_TRAVA_EVENTO, [eventoId])
    const ev = evs[0]
    if (!ev) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

    const { rows: libs } = await c.query(
      `SELECT (now() >= ${SQL_LIBERA_EM()}) AS liberado, ${SQL_LIBERA_EM()} AS libera_em
         FROM events WHERE id = $1`, [eventoId])
    ev.liberado = libs[0].liberado
    ev.libera_em = libs[0].libera_em

    if (!ev.liberado) {
      const quando = new Date(ev.libera_em).toLocaleDateString('pt-BR')
      throw createError({
        statusCode: 409,
        statusMessage: `O dinheiro deste evento libera em ${quando} (${DIAS_DE_RETENCAO} dias após o fim).`,
      })
    }

    // O teto sai do MESMO cálculo que o borderô mostra, já com a trava na
    // mão. Enquanto eram duas contas, esta aqui usava a face cheia e
    // liberava pra saque a taxa que o produtor tinha absorvido no balcão —
    // dinheiro que nunca chegou a ser dele. Ver `utils/liquido.ts`.
    const { disponivelCents } = await saldoParaSaque(c, eventoId!)

    if (d.valorCents > disponivelCents) {
      throw createError({ statusCode: 409, statusMessage: recusaDeSaque(disponivelCents) })
    }

    const { rows } = await c.query(
      `INSERT INTO payouts (org_id, event_id, code, beneficiary_name, beneficiary_doc,
                            destination_kind, destination, amount_cents,
                            status, requested_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'solicitada',$9,$10)
       RETURNING id, code, status, requested_at`,
      [ev.org_id, eventoId, `TRF-${gerarCodigo('X').slice(2)}`,
       d.beneficiario.trim(), d.documento?.replace(/\D/g, '') || null,
       d.destinoTipo, d.destino.trim(), d.valorCents,
       sessao?.usuarioId ?? null, d.observacao ?? null])

    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'payout',$2,'solicitada',$3::jsonb)`,
      [ev.org_id, rows[0].id, JSON.stringify({
        valorCents: d.valorCents, beneficiario: d.beneficiario,
        por: sessao?.email ?? null,
      })])

    return { ok: true, ...rows[0] }
  })
})
