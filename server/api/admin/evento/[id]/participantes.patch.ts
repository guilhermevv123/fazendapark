/**
 * PATCH /api/admin/evento/:id/participantes — nomeia um ingresso.
 *
 * Quem compra 6 ingressos recebe 5 em branco (ver emissao.ts). Nomear é o que
 * transforma a compra numa lista de portaria — e é o que permite exigir
 * documento na entrada.
 *
 * Ingresso JÁ USADO não muda de nome. A pessoa que entrou entrou; trocar o
 * portador depois reescreve quem esteve lá dentro, que é justamente o registro
 * que alguém vai querer consultar se algo acontecer no evento.
 *
 * Trocar o portador é trocar QUEM entra — por isso vira linha de auditoria,
 * com o antes e o depois. E o documento é conferido: "123" no lugar do CPF é o
 * que a portaria vai ter que discutir no portão.
 */
import { z } from 'zod'
import { q1, tx } from '../../../../utils/db'
import { cpfValido } from '../../../../utils/documento'
import { autorDaRequisicao, registrarAuditoria } from '../../../../utils/auditoria'

/**
 * CPF ou RG. Onze dígitos só de número é CPF e passa pela conta do dígito
 * verificador; o resto é tratado como RG (formato varia por estado), com um
 * mínimo que separa documento de rabisco.
 */
export function documentoDoPortador(bruto: string): { ok: true; valor: string } | { ok: false; recado: string } {
  const limpo = bruto.trim()
  const alfa = limpo.replace(/[^0-9a-zA-Z]/g, '')
  const soDigitos = /^\d+$/.test(alfa)
  if (soDigitos && alfa.length === 11) {
    return cpfValido(alfa)
      ? { ok: true, valor: alfa }
      : { ok: false, recado: 'CPF inválido — confira os números com o documento na mão.' }
  }
  if (alfa.length < 5) {
    return { ok: false, recado: 'Documento curto demais. Digite o CPF (11 números) ou o RG completo.' }
  }
  return { ok: true, valor: limpo }
}

const Entrada = z.object({
  id: z.string().uuid(),
  nome: z.string().max(120).nullish(),
  email: z.string().email().max(160).nullish().or(z.literal('')),
  documento: z.string().max(20).nullish(),
})

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    const campos = p.error.flatten().fieldErrors
    throw createError({
      statusCode: 400,
      statusMessage: campos.email ? 'E-mail inválido — confira o endereço.'
        : campos.nome ? 'O nome pode ter no máximo 120 letras.'
          : campos.documento ? 'Documento longo demais.'
            : 'Não entendi os dados do portador. Confira e salve de novo.',
      data: p.error.flatten(),
    })
  }
  const d = p.data

  let documento: string | null = null
  if (d.documento?.trim()) {
    const doc = documentoDoPortador(d.documento)
    if (!doc.ok) throw createError({ statusCode: 400, statusMessage: doc.recado })
    documento = doc.valor
  }

  const ing = await q1<any>(
    `SELECT id, code, status, holder_name, holder_email, holder_document
       FROM tickets WHERE id = $1 AND event_id = $2`,
    [d.id, eventoId])
  if (!ing) throw createError({ statusCode: 404, statusMessage: 'Ingresso não encontrado' })
  if (ing.status === 'usado') {
    throw createError({
      statusCode: 409,
      statusMessage: `"${ing.code}" já entrou no evento. O portador não pode mais ser trocado.`,
    })
  }
  if (ing.status === 'cancelado') {
    throw createError({ statusCode: 409, statusMessage: 'Ingresso cancelado.' })
  }

  const depois = {
    codigo: ing.code, nome: d.nome?.trim() || null, email: d.email || null, documento,
  }
  await tx(async (c) => {
    // `AND status = 'valido'` repete a guarda de cima COM a escrita: a portaria
    // pode ter marcado a entrada entre a leitura e aqui.
    const r = await c.query(
      `UPDATE tickets SET holder_name = $2, holder_email = $3, holder_document = $4
        WHERE id = $1 AND status NOT IN ('usado','cancelado') RETURNING id`,
      [d.id, depois.nome, depois.email, depois.documento])
    if (!r.rowCount) {
      throw createError({
        statusCode: 409,
        statusMessage: `"${ing.code}" acabou de entrar no evento ou foi cancelado. O portador não muda mais.`,
      })
    }
    await registrarAuditoria({
      autor: autorDaRequisicao(event), entidade: 'ingresso', entidadeId: d.id,
      acao: 'portador_alterado',
      antes: { codigo: ing.code, nome: ing.holder_name, email: ing.holder_email,
               documento: ing.holder_document },
      depois,
    }, c)
  })

  return { ok: true }
})
