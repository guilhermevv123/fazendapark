/**
 * POST /api/transferencia/:code — a pessoa aceita e o ingresso vira dela.
 *
 * Aqui é onde a titularidade muda de verdade, e é a operação que não pode
 * acontecer duas vezes: dois cliques no botão, dois toques do celular com a
 * rede ruim, e a segunda passada não pode reabrir nada. Por isso o UPDATE é
 * condicional em `status = 'aguardando'` — mesma trava da catraca, mesmo
 * motivo. A segunda chamada encontra rowCount 0 e responde "já aceita" em
 * vez de gravar por cima.
 *
 * Rota PÚBLICA por desenho: quem recebe não tem conta no painel. O token do
 * link é a credencial, e ele é opaco e único.
 */
import { z } from 'zod'
import { q1, tx } from '../../utils/db'
import { SQL_ACEITA_TRANSFERENCIA } from '../../utils/transferencia'
import { novoCodigoDoIngresso } from '../../utils/ingresso'

const Entrada = z.object({
  /** a pessoa confirma o próprio nome; pode corrigir grafia, não trocar de dono */
  nome: z.string().min(2).max(120).optional(),
  documento: z.string().max(20).nullish(),
})

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')
  const p = Entrada.safeParse(await readBody(event).catch(() => ({})))
  if (!p.success) throw createError({ statusCode: 400, statusMessage: 'Dados inválidos' })
  const d = p.data

  const tr = await q1<any>(
    `SELECT tr.id, tr.org_id, tr.ticket_id, tr.status, tr.expires_at,
            tr.para_nome, tr.para_email, tr.para_documento,
            t.status AS ingresso_status
       FROM ticket_transfers tr JOIN tickets t ON t.id = tr.ticket_id
      WHERE tr.code = $1`, [code])

  if (!tr) throw createError({ statusCode: 404, statusMessage: 'Transferência não encontrada' })
  if (tr.status === 'concluido') {
    throw createError({ statusCode: 409, statusMessage: 'Esta transferência já foi aceita.' })
  }
  if (tr.status === 'cancelado') {
    throw createError({ statusCode: 409, statusMessage: 'Quem enviou cancelou esta transferência.' })
  }
  if (tr.status === 'expirado'
      || (tr.expires_at && new Date(tr.expires_at).getTime() < Date.now())) {
    throw createError({
      statusCode: 409,
      statusMessage: 'O prazo para aceitar venceu. Peça pra quem enviou mandar de novo.',
    })
  }
  if (tr.ingresso_status !== 'valido') {
    throw createError({
      statusCode: 409,
      statusMessage: tr.ingresso_status === 'usado'
        ? 'Este ingresso já foi usado na entrada.'
        : 'Este ingresso foi cancelado e não pode mais ser transferido.',
    })
  }

  return await tx(async (c) => {
    // a instrução mora em utils/transferencia.ts pra o teste rodar esta, e
    // não uma cópia que envelhece sozinha
    const r = await c.query(SQL_ACEITA_TRANSFERENCIA, [tr.id])
    if (r.rowCount !== 1) {
      throw createError({ statusCode: 409, statusMessage: 'Esta transferência já foi aceita.' })
    }

    const nome = (d.nome ?? tr.para_nome).trim()
    // CÓDIGO NOVO no aceite. Trocar só o titular deixava o QR do remetente
    // valendo — a assinatura é HMAC(evento:código), e o código não mudava.
    // Medido antes do conserto: depois do aceite, o QR antigo seguia dando
    // "Liberado" na /api/checkin, e os dois entravam. Com o código novo o QR
    // antigo (print, e-mail, tela do pedido) morre na hora: a catraca procura
    // o código e não acha. `status = 'valido'` no WHERE: ingresso que entrou
    // ou foi cancelado entre a checagem e aqui não troca de dono.
    const antigo = await c.query(
      `SELECT code FROM tickets WHERE id = $1 FOR UPDATE`, [tr.ticket_id])
    const codigoNovo = novoCodigoDoIngresso(antigo.rows[0]?.code)
    const mudou = await c.query(
      `UPDATE tickets SET holder_name = $2, holder_email = $3, holder_document = $4, code = $5
        WHERE id = $1 AND status = 'valido'`,
      [tr.ticket_id, nome, tr.para_email, d.documento ?? tr.para_documento ?? null, codigoNovo])
    if (mudou.rowCount !== 1) {
      throw createError({ statusCode: 409,
        statusMessage: 'Este ingresso já foi usado ou cancelado e não pode mais ser transferido.' })
    }

    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'ingresso',$2,'transferencia_aceita',$3::jsonb)`,
      [tr.org_id, tr.ticket_id, JSON.stringify({
        transferencia: tr.id, titular: tr.para_email,
        // o código antigo fica na trilha: é por ele que a portaria vai
        // perguntar quando alguém aparecer com o print velho
        codigoAnterior: antigo.rows[0]?.code, codigoNovo,
      })])

    return { ok: true, titular: nome, ingresso: codigoNovo }
  })
})
