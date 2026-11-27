/**
 * WhatsApp da comanda (055): o código de 4 números da abertura e a cobrança de quem saiu
 * sem pagar. Usa a MESMA Uazapi do ingresso (`whatsapp-ingresso.ts`), sem passar pela fila
 * dele: aqui a resposta tem que ser na hora (o cliente está na frente do atendente).
 *
 * Sem Uazapi configurada fora de produção (o computador de teste), o envio é SIMULADO: o
 * código volta na resposta e a tela mostra "modo de teste". Em produção, sem Uazapi, a
 * abertura manual só passa com o PIN do gerente.
 */
import { createHash, randomInt } from 'node:crypto'
import { q, q1 } from './db'
import { configDoWhatsapp, enviarPelaUazapi } from './whatsapp-ingresso'

export const VALIDADE_DO_CODIGO_MIN = 10
const TENTATIVAS = 5

const hashDoCodigo = (orgId: string, telefone: string, codigo: string) =>
  createHash('sha256').update(`${orgId}:${telefone}:${codigo}`).digest('hex')

export function whatsappSimulado(): boolean {
  return !configDoWhatsapp().ligado && process.env.NODE_ENV !== 'production'
}

export async function enviarWhatsapp(telefone: string, texto: string, trilha: string): Promise<{ simulado: boolean }> {
  if (whatsappSimulado()) {
    console.log(`[comandas] WhatsApp SIMULADO para ${telefone}:\n${texto}`)
    return { simulado: true }
  }
  if (!configDoWhatsapp().ligado) throw new Error('WhatsApp do parque desligado')
  await enviarPelaUazapi({ number: '55' + telefone, text: texto, track_source: 'sofia', track_id: trilha })
  return { simulado: false }
}

/** Manda um código novo. Devolve o código só no modo simulado (computador de teste). */
export async function mandarCodigo(orgId: string, usuarioId: string, telefone: string) {
  const recentes = await q1<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM comanda_codigos WHERE org_id = $1 AND telefone = $2 AND criado_em > now() - interval '10 minutes'`,
    [orgId, telefone])
  if ((recentes?.n ?? 0) >= 3) throw createError({ statusCode: 429, statusMessage: 'Muitos códigos para este telefone. Espere alguns minutos.' })
  const codigo = String(randomInt(0, 10000)).padStart(4, '0')
  const r = await enviarWhatsapp(telefone,
    `*Conquista Park*\nSeu código para abrir a comanda é *${codigo}*.\nDiga este número ao atendente. Vale por ${VALIDADE_DO_CODIGO_MIN} minutos.`,
    `comanda-codigo:${telefone}`)
  await q(`INSERT INTO comanda_codigos (org_id, telefone, codigo_hash, expira_em, criado_por)
           VALUES ($1,$2,$3, now() + make_interval(mins => $4), $5)`,
  [orgId, telefone, hashDoCodigo(orgId, telefone, codigo), VALIDADE_DO_CODIGO_MIN, usuarioId])
  return { simulado: r.simulado, codigo: r.simulado ? codigo : undefined }
}

/** Confere (e gasta) o código. Cinco erros no mesmo código e ele morre. */
export async function conferirCodigo(orgId: string, telefone: string, codigo: unknown): Promise<boolean> {
  const c = String(codigo ?? '').replace(/\D/g, '')
  if (c.length !== 4) return false
  const linha = await q1<any>(
    `SELECT id, codigo_hash, tentativas FROM comanda_codigos
      WHERE org_id = $1 AND telefone = $2 AND usado_em IS NULL AND expira_em > now()
      ORDER BY criado_em DESC LIMIT 1`, [orgId, telefone])
  if (!linha || linha.tentativas >= TENTATIVAS) return false
  if (linha.codigo_hash !== hashDoCodigo(orgId, telefone, c)) {
    await q(`UPDATE comanda_codigos SET tentativas = tentativas + 1 WHERE id = $1`, [linha.id])
    return false
  }
  await q(`UPDATE comanda_codigos SET usado_em = now() WHERE id = $1`, [linha.id])
  return true
}
