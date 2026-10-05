/**
 * O ingresso pelo WhatsApp (dono, 05/10/2026) — a fila da 038, pela UAZAPI.
 *
 * Quando o pedido vira pago, o banco enfileira uma linha em `whatsapp_sends` (gatilho da 038);
 * este trabalhador manda a mensagem base com o link da página do ingresso, onde está o QR.
 *
 * Regras que não se negociam:
 *   · **Carimbo da Sofia.** O número é o mesmo da atendente automática; envio pela API SEM
 *     `track_source: 'sofia'` parece humano e trava a Sofia 6 h naquela conversa (fp:block).
 *   · **Nada sai sem a chave.** Sem UAZAPI_URL + UAZAPI_TOKEN no ambiente o trabalhador não
 *     roda; com `WHATSAPP_INGRESSO=off` também não.
 *   · **Lista branca pra testar.** Com `WHATSAPP_SO_PARA` (números separados por vírgula), só
 *     esses recebem; os outros são marcados 'desligado' com o motivo. Número inventado já
 *     recebeu mensagem de verdade uma vez (30/08) — teste é com número nosso.
 *   · **Não manda mensagem velha.** Linha que esperou mais de 48 h (o WhatsApp estava
 *     desligado quando o pedido pagou) é dada como vencida, não dispara atrasada.
 */
import { q, q1 } from './db'
import { quando } from './email'
import { baseDoSite } from './envio'

export const INTERVALO_DO_WHATSAPP_MS = 15_000
const VALIDADE_HORAS = 48
const ESPERAS_S = [60, 300, 900]

export function configDoWhatsapp(env: Record<string, string | undefined> = process.env) {
  const url = String(env.UAZAPI_URL ?? '').trim().replace(/\/+$/, '')
  const token = String(env.UAZAPI_TOKEN ?? '').trim()
  const soPara = String(env.WHATSAPP_SO_PARA ?? '').split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean)
  const ligado = !!url && !!token && env.WHATSAPP_INGRESSO !== 'off'
  return { url, token, soPara, ligado }
}

export interface DadosDoWhatsapp {
  nome?: string | null
  evento: string
  inicio?: Date | string | null
  fuso?: string | null
  pedido: string
  quantidade: number
  link: string
}

/** A mensagem base. Negrito do WhatsApp é *assim*; o link sozinho na linha vira prévia. */
export function montarMensagemDoWhatsapp(d: DadosDoWhatsapp): string {
  const primeiro = String(d.nome ?? '').trim().split(/\s+/)[0]
  const varios = d.quantidade !== 1
  return [
    `Olá${primeiro ? `, ${primeiro}` : ''}! 🎉`,
    '',
    `${varios ? `Seus ${d.quantidade} ingressos` : 'Seu ingresso'} do *${d.evento}* ${varios ? 'estão confirmados' : 'está confirmado'}.`,
    d.inicio ? `📅 ${quando(d.inicio, d.fuso)}` : '',
    `🎟️ Pedido ${d.pedido}`,
    '',
    `Toque no link pra ver ${varios ? 'os QR Codes' : 'o QR Code'} de entrada:`,
    d.link,
    '',
    'Na portaria é só mostrar o QR no celular. O ingresso também foi pro seu e-mail.',
    '',
    'Até lá! 💦',
    '— Conquista Park',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')
}

interface LinhaDoWhatsapp {
  id: string; order_id: string; to_phone: string; to_name: string | null; attempts: number; max_attempts: number
}

/** Reserva a próxima linha pronta (e devolve à fila a que ficou presa em 'enviando'). */
async function reservarWhatsapp(): Promise<LinhaDoWhatsapp | null> {
  await q(`UPDATE whatsapp_sends SET status = 'na_fila', claimed_at = NULL
            WHERE status = 'enviando' AND claimed_at < now() - interval '5 minutes'`)
  return q1<LinhaDoWhatsapp>(
    `UPDATE whatsapp_sends SET status = 'enviando', claimed_at = now(), attempts = attempts + 1
      WHERE id = (SELECT id FROM whatsapp_sends
                   WHERE status = 'na_fila' AND available_at <= now()
                   ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, order_id, to_phone, to_name, attempts, max_attempts`)
}

async function dadosDoPedidoParaWhatsapp(orderId: string) {
  return q1<any>(
    `SELECT o.code, e.name AS evento, e.starts_at, e.timezone,
            (SELECT count(*)::int FROM tickets t WHERE t.order_id = o.id AND t.status = 'valido') AS quantidade
       FROM orders o JOIN events e ON e.id = o.event_id
      WHERE o.id = $1`, [orderId])
}

export interface ResultadoDoWhatsapp { id: string; ok: boolean; status: string; erro?: string }

/** Manda UMA linha. `enviar` é injetável pro teste (o padrão é a UAZAPI de verdade). */
export async function processarUmWhatsapp(
  enviar: (corpo: Record<string, unknown>) => Promise<{ id?: string | null }> = enviarPelaUazapi,
): Promise<ResultadoDoWhatsapp | null> {
  const cfg = configDoWhatsapp()
  const linha = await reservarWhatsapp()
  if (!linha) return null
  const fim = async (status: string, erro: string | null, extra: { texto?: string; msg?: string | null } = {}) => {
    await q(`UPDATE whatsapp_sends SET status = $2, last_error = $3, body_text = COALESCE($4, body_text),
                    message_id = COALESCE($5, message_id), claimed_at = NULL,
                    sent_at = CASE WHEN $2 = 'enviado' THEN now() ELSE sent_at END
              WHERE id = $1`, [linha.id, status, erro, extra.texto ?? null, extra.msg ?? null])
    return { id: linha.id, ok: status === 'enviado', status, ...(erro ? { erro } : {}) }
  }

  const idade = await q1<{ velha: boolean }>(
    `SELECT created_at < now() - make_interval(hours => $2) AS velha FROM whatsapp_sends WHERE id = $1`,
    [linha.id, VALIDADE_HORAS])
  if (idade?.velha) return fim('falhou', `venceu: esperou mais de ${VALIDADE_HORAS} h na fila`)
  if (cfg.soPara.length && !cfg.soPara.includes(linha.to_phone)) {
    return fim('desligado', 'fora da lista WHATSAPP_SO_PARA (modo de teste)')
  }

  const p = await dadosDoPedidoParaWhatsapp(linha.order_id)
  const base = baseDoSite()
  if (!p || !base) return fim('falhou', !p ? 'pedido não encontrado' : 'site sem PUBLIC_BASE_URL: o link não tem pra onde apontar')
  if (!p.quantidade) return fim('falhou', 'pedido sem ingresso válido')

  const texto = montarMensagemDoWhatsapp({
    nome: linha.to_name, evento: p.evento, inicio: p.starts_at, fuso: p.timezone, pedido: p.code,
    quantidade: p.quantidade, link: `${base}/ingressos/${encodeURIComponent(p.code)}`,
  })
  try {
    const r = await enviar({
      number: linha.to_phone, text: texto, linkPreview: true,
      track_source: 'sofia', track_id: `ingresso:${p.code}`,
    })
    return fim('enviado', null, { texto, msg: r?.id ?? null })
  } catch (e: any) {
    const erro = String(e?.message ?? e).slice(0, 300)
    // 463 = o WhatsApp não deixa abrir conversa com esse número agora (sem WhatsApp, ou a conta
    // restringida pra conversa nova). Tentar de novo não muda nada e só piora a conta.
    const semVolta = /\b463\b/.test(erro)
    if (semVolta || linha.attempts >= linha.max_attempts) return fim('falhou', erro, { texto })
    const espera = ESPERAS_S[Math.min(linha.attempts - 1, ESPERAS_S.length - 1)]
    await q(`UPDATE whatsapp_sends SET status = 'na_fila', last_error = $2, body_text = $3, claimed_at = NULL,
                    available_at = now() + make_interval(secs => $4)
              WHERE id = $1`, [linha.id, erro, texto, espera])
    return { id: linha.id, ok: false, status: 'na_fila', erro }
  }
}

/** POST /send/text da UAZAPI. Erro HTTP vira exceção com a resposta (a fila tenta de novo). */
export async function enviarPelaUazapi(corpo: Record<string, unknown>): Promise<{ id?: string | null }> {
  const { url, token } = configDoWhatsapp()
  const r = await fetch(`${url}/send/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', token },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(20_000),
  })
  const bruto = await r.text()
  if (!r.ok) throw new Error(`UAZAPI ${r.status}: ${bruto.slice(0, 200)}`)
  let j: any = null
  try { j = JSON.parse(bruto) } catch { /* resposta sem JSON: vale o 200 */ }
  return { id: j?.messageid ?? j?.id ?? j?.key?.id ?? null }
}

/** Esvazia o que está pronto (no máximo 10 por volta: o WhatsApp não gosta de rajada). */
export async function processarFilaDoWhatsapp(): Promise<ResultadoDoWhatsapp[]> {
  const feitos: ResultadoDoWhatsapp[] = []
  for (let i = 0; i < 10; i++) {
    const r = await processarUmWhatsapp()
    if (!r) break
    feitos.push(r)
  }
  return feitos
}

let relogioDoWhatsapp: ReturnType<typeof setInterval> | null = null
let rodandoWhatsapp = false

export function garantirWorkerDoWhatsapp(): boolean {
  if (relogioDoWhatsapp || !configDoWhatsapp().ligado) return false
  relogioDoWhatsapp = setInterval(() => {
    if (rodandoWhatsapp) return
    rodandoWhatsapp = true
    processarFilaDoWhatsapp()
      .then((f) => {
        const ruins = f.filter((r) => !r.ok)
        if (f.length) console.log(`[whatsapp] ${f.length - ruins.length} enviado(s)`
          + (ruins.length ? `, ${ruins.length} sem sair: ${ruins[0].erro}` : ''))
      })
      .catch((e) => console.error('[whatsapp] varredura falhou:', String(e?.message ?? e)))
      .finally(() => { rodandoWhatsapp = false })
  }, INTERVALO_DO_WHATSAPP_MS)
  relogioDoWhatsapp.unref?.()
  return true
}

export function pararWorkerDoWhatsapp() {
  if (relogioDoWhatsapp) clearInterval(relogioDoWhatsapp)
  relogioDoWhatsapp = null
}
