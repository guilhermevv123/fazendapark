/**
 * POST /api/portaria/troca-de-dia — o ingresso de OUTRO dia entra pagando a diferença (049).
 *
 * Dono, 08/10: "e se aparecer alguém com ingresso de sábado pra entrar domingo? ... bloquear, mas se a
 * pessoa quiser entrar, ela faz o pagamento lá na hora, o valor da diferença, e aí ela entra".
 *
 * O leitor (`/api/checkin`) barra e devolve as opções de hoje com a diferença. O porteiro escolhe o
 * tipo, recebe o dinheiro (dinheiro, Pix ou maquininha — o sistema não cobra, REGISTRA o que entrou
 * na mão dele) e confirma. Aqui, numa transação só: o ingresso vira `usado`, a passagem entra no
 * livro (`entries`, com as pessoas do ingresso — combo de 10 = 10), a leitura vai pro log e a troca
 * vira linha em `day_changes`, com o valor, a forma e quem cobrou.
 *
 * Idempotente pelo `id` que nasce no tablet (o mesmo da passagem): o segundo toque, ou a resposta que
 * se perdeu e o porteiro confirmou de novo, NÃO cobra duas vezes — devolve a troca já feita.
 *
 * Sem rede o tablet faz a mesma conta com a lista baixada, libera e guarda a troca na fila; ela chega
 * por `/api/portaria/sincronizar`, que grava a MESMA linha com o MESMO id.
 */
import { z } from 'zod'
import { mutacaoDeOutroSite } from '../../utils/caminho'
import { q1, tx } from '../../utils/db'
import { exigir } from '../../utils/sessao'
import { ehPapel, papelDoRoleLegado, papelPode, ROTULO } from '../../utils/papeis'
import { lerQr } from '../../utils/ingresso'
import { diaDeUsoDe, limparDiasDeUso, valeNoDiaDeUso } from '../../utils/dias-de-uso'
import { ehPassaporte, retratoDoPublico, SQL_GRAVA_ENTRADA, SQL_MARCA_ENTRADA, SQL_PUBLICO } from '../../utils/catraca'
import { conferirTroca, opcoesDeTroca, ROTULO_DA_FORMA, type FormaDeTroca } from '../../utils/troca-de-dia'
import { pagoDoIngressoNaTroca, SQL_PAGO_DO_INGRESSO, tiposDaTrocaDeDia } from '../../utils/troca-de-dia-banco'
import { SQL_PESSOAS_DO_INGRESSO } from '../../utils/combo'

const Corpo = z.object({
  /** uuid do tablet: é o id da passagem E da troca */
  id: z.string().uuid(),
  qr: z.string().min(4).max(200),
  eventId: z.string().uuid(),
  tipoId: z.string().uuid(),
  forma: z.enum(['dinheiro', 'pix', 'credito', 'debito', 'sem_diferenca']),
  cobradoCents: z.number().int().min(0).max(100_000_00),
  gate: z.string().max(40).nullish(),
  deviceId: z.string().max(60).nullish(),
  /** combo (050): troca a pessoa k do combo do QR lido (ver `/api/checkin`) */
  parteDoCombo: z.number().int().min(1).max(100).nullish(),
})

export default defineEventHandler(async (event) => {
  // ---- as cercas de /api/portaria/sincronizar: sessão, papel, origem ------
  const sessao = await exigir(event, 'portaria')
  const linha = await q1<{ papel: string | null; role: string | null }>(
    `SELECT papel, role FROM users WHERE id = $1`, [sessao.usuarioId])
  const papel = ehPapel(linha?.papel) ? linha!.papel as any : papelDoRoleLegado(linha?.role)
  if (!papelPode(papel, 'portaria')) {
    throw createError({ statusCode: 403,
      statusMessage: `Seu acesso é de ${ROTULO[papel] ?? papel} e não inclui o leitor de entrada.` })
  }
  if (mutacaoDeOutroSite(event)) throw createError({ statusCode: 403, statusMessage: 'Origem não autorizada' })

  const p = Corpo.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400,
      statusMessage: 'A troca enviada não está no formato esperado. Leia o ingresso de novo.' })
  }
  const { id, qr, eventId, tipoId, forma, cobradoCents, gate, deviceId, parteDoCombo } = p.data
  const operador = sessao.usuarioId
  const orgId = sessao.orgId

  const evento = await q1<any>(`SELECT id, timezone FROM events WHERE id = $1 AND org_id = $2`, [eventId, orgId])
  if (!evento) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  // ---- toque repetido / resposta perdida: a troca já existe, devolve ela -----
  const feita = await q1<any>(
    `SELECT dc.to_type_name, dc.cobrado_cents, dc.forma, dc.people FROM day_changes dc
      WHERE dc.id = $1 AND dc.org_id = $2`, [id, orgId])
  if (feita) return respostaDaTroca(feita, await q1<any>(SQL_PUBLICO, [eventId]))

  // ---- o ingresso -----------------------------------------------------------
  const lido = lerQr(qr)
  const qrAntigo = !lido.ok && lido.chaveAposentada === true && !!lido.code
  if (!lido.ok && lido.motivo === 'assinatura' && !qrAntigo) recusar(400, 'QR inválido.')
  if ((lido.ok || qrAntigo) && lido.eventId !== eventId) recusar(400, 'Ingresso é de outro evento.')
  const codigo = lido.ok || qrAntigo ? lido.code! : qr.trim().toUpperCase()

  const ingresso = await q1<any>(
    `SELECT t.id, t.status, t.ticket_type_id, tt.name AS tipo, s.sessions_covered,
            tt.valid_dates::text[] AS dias_de_uso, ${SQL_PESSOAS_DO_INGRESSO}::int AS pessoas,
            COALESCE(tt.admits, s.admits, 1)::int AS pessoas_do_tipo, t.code,
            ${SQL_PAGO_DO_INGRESSO} AS pago_cents
       FROM tickets t JOIN sectors s ON s.id = t.sector_id
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
      WHERE t.org_id = $2 AND t.event_id = $3 AND ${parteDoCombo
        ? `t.combo_seq = $4 AND t.combo_group =
             (SELECT b.combo_group FROM tickets b WHERE b.code = $1 AND b.org_id = $2)`
        : 't.code = $1'}`, parteDoCombo ? [codigo, orgId, eventId, parteDoCombo] : [codigo, orgId, eventId])
  if (!ingresso) recusar(404, 'Ingresso não encontrado neste evento.')
  if (ingresso.status === 'cancelado') recusar(409, 'Ingresso cancelado — não dá pra trocar o dia.')
  if (ingresso.status !== 'valido') recusar(409, 'Este ingresso já foi usado — leia de novo pra ver quando entrou.')
  if (ehPassaporte(ingresso.sessions_covered)) recusar(409, 'Passaporte não troca de dia na portaria.')

  const hoje = diaDeUsoDe(new Date(), evento.timezone)
  if (valeNoDiaDeUso(limparDiasDeUso(ingresso.dias_de_uso), hoje)) {
    recusar(409, 'Este ingresso vale hoje: leia de novo e libere normalmente, sem cobrar.')
  }

  // ---- a conta, com o preço de AGORA ---------------------------------------
  const tipos = await tiposDaTrocaDeDia(eventId)
  const pagoCents = pagoDoIngressoNaTroca(ingresso.pago_cents, ingresso.ticket_type_id, tipos,
    ingresso.pessoas, ingresso.pessoas_do_tipo)
  const opcoes = opcoesDeTroca({ tipo: ingresso.tipo, pessoas: ingresso.pessoas,
    pessoasDoTipo: ingresso.pessoas_do_tipo, pagoCents }, tipos, hoje)
  const conferido = conferirTroca(opcoes, tipoId, cobradoCents, forma)
  if (!conferido.ok) {
    // 409 com a conta nova: a tela troca o valor e o porteiro confirma de novo
    throw createError({ statusCode: 409, statusMessage: conferido.erro,
      data: { troca: { hoje, pagoCents, pessoas: ingresso.pessoas, opcoes } } })
  }
  const opcao = conferido.opcao

  // ---- tudo ou nada: usado + livro + log + troca ----------------------------
  const pessoas = await tx(async (c) => {
    const marcou = await c.query(SQL_MARCA_ENTRADA, [ingresso.id, operador])
    if (marcou.rowCount !== 1) return null
    const livro = await c.query(SQL_GRAVA_ENTRADA,
      [id, ingresso.id, orgId, gate ?? null, deviceId ?? null, operador, false, null])
    await c.query(
      `INSERT INTO checkins (event_id, ticket_id, code_lido, resultado, gate, operator_id)
       VALUES ($1,$2,$3,'ok',$4,$5)`, [eventId, ingresso.id, String(ingresso.code ?? codigo).slice(0, 120), gate ?? null, operador])
    const people = Number(livro.rows[0]?.people ?? ingresso.pessoas ?? 1)
    await c.query(
      `INSERT INTO day_changes (id, org_id, event_id, ticket_id, from_type_id, to_type_id, from_type_name,
                                to_type_name, day, pago_cents, preco_cents, cobrado_cents, esperado_cents,
                                forma, people, gate, device_id, operator_id, offline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$12,$13,$14,$15,$16,$17,false)
       ON CONFLICT (id) DO NOTHING`,
      [id, orgId, eventId, ingresso.id, ingresso.ticket_type_id, opcao.tipoId, ingresso.tipo, opcao.nome,
       hoje, pagoCents, opcao.precoCents, opcao.diferencaCents, forma, people, gate ?? null,
       deviceId ?? null, operador])
    return people
  })
  if (pessoas == null) recusar(409, 'Este ingresso acabou de ser usado em outro portão — leia de novo.')

  const publico = await q1<any>(SQL_PUBLICO, [eventId])
  return respostaDaTroca({ to_type_name: opcao.nome, cobrado_cents: opcao.diferencaCents, forma, people: pessoas },
    publico)
})

function recusar(statusCode: number, statusMessage: string): never {
  throw createError({ statusCode, statusMessage })
}

function respostaDaTroca(t: { to_type_name: string; cobrado_cents: number | string; forma: string; people: number },
  publico: any) {
  const cobrado = Number(t.cobrado_cents)
  const forma = t.forma as FormaDeTroca
  return {
    ok: true,
    resultado: 'ok' as const,
    mensagem: cobrado > 0
      ? `Liberado com troca de dia — diferença paga (${ROTULO_DA_FORMA[forma] ?? forma})`
      : 'Liberado com troca de dia — sem diferença',
    pessoas: Number(t.people ?? 1),
    trocaFeita: { tipo: t.to_type_name, cobradoCents: cobrado, forma },
    publico: retratoDoPublico(publico),
  }
}
