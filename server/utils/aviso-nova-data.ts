/**
 * A data do evento mudou com ingresso vendido: quem comprou fica sabendo (dono, 27/10/2026).
 *
 * "Deixe editável mesmo depois de publicado" — a 9ª edição saiu com 29/10 no lugar de 30/10 e a
 * tela travava a data na primeira venda. A data agora muda pelo painel, e esta é a parte que
 * impede o comprador de chegar no portão no dia velho: uma linha por compra nas filas de
 * WhatsApp e e-mail que já entregam o ingresso (sobrevive a reinício, tenta de novo, fica
 * registrada no pedido).
 *
 * O texto é montado AQUI, na transação que muda a data, e gravado na linha: ele fala "de X para
 * Y", e isso é deste instante. Se a data mudar de novo, sai outro aviso com a data certa.
 */
import type { PoolClient } from 'pg'
import { quando } from './email'
import { botaoDoEmail, escaparNoEmail, moldeDoEmail } from './email-visual'
import { PEDIDO_VIVO } from './liquido'

export interface DadosDoAviso {
  nome?: string | null
  evento: string
  pedido: string
  deInicio: Date | string
  paraInicio: Date | string
  paraFim: Date | string
  fuso?: string | null
  link: string
}

/** Dia e hora sem o ano, no fuso do evento: "30 de outubro, 09:00". */
const dia = (d: Date | string, fuso?: string | null) => quando(d, fuso).replace(/ de \d{4},? (às )?/, ', ')

/** Mesmo dia de início, só o fim mudou: a frase não diz "mudou de 30/10 para 30/10". */
const mesmoInicio = (d: DadosDoAviso) =>
  new Date(d.deInicio).getTime() === new Date(d.paraInicio).getTime()

export function montarAvisoDeNovaData(d: DadosDoAviso) {
  const primeiro = String(d.nome ?? '').trim().split(/\s+/)[0]
  const nome = primeiro ? primeiro[0]!.toUpperCase() + primeiro.slice(1).toLowerCase() : ''
  const periodo = `de *${dia(d.paraInicio, d.fuso)}* até *${dia(d.paraFim, d.fuso)}*`
  const mudou = mesmoInicio(d)
    ? `O horário do *${d.evento}* foi atualizado: agora é ${periodo}.`
    : `A data do *${d.evento}* mudou: agora é ${periodo}.`

  const whatsapp = [
    `Olá${nome ? `, ${nome}` : ''}! Aqui é o Conquista Park. 💦`,
    '',
    mudou,
    '',
    // sem endereço do site (PUBLIC_BASE_URL), sem a linha do link: nada de "o mesmo:" pendurado
    ...(d.link
      ? [`Seu ingresso do pedido ${d.pedido} continua valendo, não precisa fazer nada. O QR Code é o mesmo:`, d.link]
      : [`Seu ingresso do pedido ${d.pedido} continua valendo, não precisa fazer nada. O QR Code é o mesmo.`]),
    '',
    'Qualquer dúvida, é só responder esta mensagem.',
    '— Conquista Park',
  ].join('\n')

  const assunto = mesmoInicio(d)
    ? `Horário atualizado: ${d.evento} — pedido ${d.pedido}`
    : `Nova data: ${d.evento} — pedido ${d.pedido}`
  const negrito = (t: string) => escaparNoEmail(t).replace(/\*([^*]+)\*/g, '<b>$1</b>')
  const corpo = `
    <p style="margin:0 0 14px">Olá${nome ? `, ${escaparNoEmail(nome)}` : ''}!</p>
    <p style="margin:0 0 14px">${negrito(mudou)}</p>
    <p style="margin:0 0 20px">Seu ingresso do pedido <b>${escaparNoEmail(d.pedido)}</b> continua valendo, não precisa fazer nada. O QR Code é o mesmo.</p>
    ${d.link ? botaoDoEmail('Ver meu ingresso', d.link) : ''}
    <p style="margin:20px 0 0">Qualquer dúvida, é só responder este e-mail.</p>`
  const molde = moldeDoEmail({ assunto, previa: mudou.replace(/\*/g, ''), corpo })

  return { whatsapp, assunto, texto: whatsapp.replace(/\*/g, ''), html: molde.html }
}

/**
 * Enfileira o aviso pra toda compra com ingresso válido. Roda na transação que mudou a data:
 * se a gravação da data falhar, nenhum aviso sai. Devolve quantos avisos de cada canal.
 *
 * Cortesia entra: é gente vindo no dia velho do mesmo jeito.
 */
export async function enfileirarAvisoDeNovaData(c: PoolClient, p: {
  eventId: string
  deInicio: Date | string
  paraInicio: Date | string
  paraFim: Date | string
  base: string | null
  pedidoPor?: string | null
}): Promise<{ compras: number; whatsapp: number; email: number }> {
  const { rows } = await c.query(
    `SELECT o.id, o.org_id, o.code, e.name AS evento, e.timezone,
            COALESCE(NULLIF(a.name, ''), cu.name) AS nome,
            NULLIF(trim(COALESCE(NULLIF(a.email, ''), cu.email, '')), '') AS email,
            regexp_replace(COALESCE(NULLIF(a.phone, ''), cu.phone, ''), '\\D', '', 'g') AS fone
       FROM orders o
       JOIN events e ON e.id = o.event_id
       LEFT JOIN customer_accounts a ON a.id = o.customer_account_id
       LEFT JOIN customers cu ON cu.id = o.customer_id
      WHERE o.event_id = $1 AND ${PEDIDO_VIVO('o.')}
        AND EXISTS (SELECT 1 FROM tickets t WHERE t.order_id = o.id AND t.status = 'valido')`,
    [p.eventId])

  let whatsapp = 0
  let email = 0
  for (const o of rows) {
    const link = p.base ? `${p.base}/ingressos/${encodeURIComponent(o.code)}` : ''
    const m = montarAvisoDeNovaData({
      nome: o.nome, evento: o.evento, pedido: o.code, fuso: o.timezone, link,
      deInicio: p.deInicio, paraInicio: p.paraInicio, paraFim: p.paraFim,
    })
    // mesma regra do gatilho da 038: DDD + número ganha o 55 na frente
    let fone = String(o.fone ?? '')
    if (fone.length === 10 || fone.length === 11) fone = '55' + fone
    if (fone.length >= 12) {
      await c.query(
        `INSERT INTO whatsapp_sends (org_id, event_id, order_id, origin, kind, to_phone, to_name, body_text)
         VALUES ($1,$2,$3,'reenvio','aviso_nova_data',$4,$5,$6)`,
        [o.org_id, p.eventId, o.id, fone, o.nome, m.whatsapp])
      whatsapp++
    }
    if (o.email) {
      await c.query(
        `INSERT INTO email_sends (org_id, event_id, order_id, kind, origin, to_email, to_name,
                                  subject, body_text, body_html, requested_by)
         VALUES ($1,$2,$3,'aviso_nova_data','reenvio',$4,$5,$6,$7,$8,$9)`,
        [o.org_id, p.eventId, o.id, o.email, o.nome, m.assunto, m.texto, m.html, p.pedidoPor ?? null])
      email++
    }
  }
  return { compras: rows.length, whatsapp, email }
}
