/**
 * Link público pra reconectar o WhatsApp do parque (a instância da UAZAPI que manda o ingresso e que
 * o robô de atendimento usa). Quando o WhatsApp desloga ("logged out from another device"), quem tem
 * o celular do número abre `/conectar-whatsapp/<token>` onde estiver, lê o QR e pronto — sem login
 * no painel e sem o dono precisar estar na frente do aparelho.
 *
 * O token do link NÃO é guardado em lugar nenhum: sai de um HMAC do UAZAPI_TOKEN que já está no env.
 * Quem não tem o env não adivinha; trocar o UAZAPI_TOKEN invalida o link antigo sozinho.
 * A página só vê estado, QR e o final do número — nunca o token da instância.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { configDoWhatsapp } from './whatsapp-ingresso'

export function tokenDoLinkDeConexao(uazapiToken: string): string {
  return createHmac('sha256', uazapiToken).update('conectar-whatsapp:v1').digest('hex').slice(0, 40)
}

/** `null` = recurso desligado ou link errado (a rota responde 404 igual nos dois casos). */
export function configDaConexao(tokenDoLink: string, env: Record<string, string | undefined> = process.env) {
  const c = configDoWhatsapp(env)
  if (!c.url || !c.token || env.CONECTAR_WHATSAPP === 'off') return null
  const esperado = Buffer.from(tokenDoLinkDeConexao(c.token))
  const recebido = Buffer.from(String(tokenDoLink))
  if (esperado.length !== recebido.length || !timingSafeEqual(esperado, recebido)) return null
  return { url: c.url, token: c.token }
}

export interface EstadoDaConexao {
  estado: 'conectado' | 'conectando' | 'desconectado'
  qrcode: string | null
  numero: string | null
}

/** O número pela metade: quem abre o link confere que é o aparelho certo, sem expor o número inteiro. */
export function numeroMascarado(n: unknown): string | null {
  const d = String(n ?? '').replace(/\D/g, '')
  return d.length >= 8 ? `${d.slice(0, 4)}•••••${d.slice(-2)}` : null
}

export function lerEstadoDaUazapi(j: any): EstadoDaConexao {
  const i = j?.instance ?? j ?? {}
  const bruto = String(i.status ?? '').toLowerCase()
  const conectado = bruto === 'connected' || j?.status?.connected === true
  const estado = conectado ? 'conectado' : bruto === 'connecting' ? 'conectando' : 'desconectado'
  const qr = typeof i.qrcode === 'string' && i.qrcode.length > 40 ? i.qrcode : null
  return {
    estado,
    qrcode: conectado ? null : qr ? (qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`) : null,
    numero: numeroMascarado(i.owner),
  }
}

async function chamar(c: { url: string; token: string }, metodo: 'GET' | 'POST', caminho: string, corpo?: object) {
  const r = await fetch(`${c.url}${caminho}`, {
    method: metodo,
    headers: { token: c.token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) throw new Error(`UAZAPI ${caminho} → ${r.status}`)
  return r.json()
}

export async function estadoDaInstancia(c: { url: string; token: string }) {
  return lerEstadoDaUazapi(await chamar(c, 'GET', '/instance/status'))
}

/** Pede QR novo. Se já está conectada não mexe em nada (connect numa sessão viva a derruba). */
export async function pedirQrNovo(c: { url: string; token: string }) {
  const atual = await estadoDaInstancia(c)
  if (atual.estado === 'conectado') return atual
  return lerEstadoDaUazapi(await chamar(c, 'POST', '/instance/connect', {}))
}
