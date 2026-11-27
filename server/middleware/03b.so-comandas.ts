/**
 * Login "só das comandas" (056): o funcionário que o dono cria em Comandas → Equipe e regras
 * entra no app do tablet e em mais nada. Recusa o resto do que é de equipe: o painel
 * (`/api/admin`) e a portaria (`/api/checkin`, `/api/portaria`). As comandas
 * (`/api/comandas`) e o próprio login (`/api/auth`) seguem.
 *
 * Roda depois do 03 (ordem do nome: `03.papel` < `03b.so-comandas`).
 */
import { caminhoDaRota } from '../utils/caminho'
import { q1 } from '../utils/db'
import { lerSessao } from '../utils/sessao'

const fechado = (c: string) => c.startsWith('/api/admin/') || c === '/api/checkin' || c.startsWith('/api/portaria/')

export default defineEventHandler(async (event) => {
  if (!fechado(caminhoDaRota(event))) return
  const sessao = (event.context as any).sessao ?? await lerSessao(event)
  if (!sessao?.usuarioId) return
  let soComandas = false
  try {
    const a = await q1<{ so_comandas: boolean }>(`SELECT so_comandas FROM comanda_acessos WHERE user_id = $1`, [sessao.usuarioId])
    soComandas = !!a?.so_comandas
  } catch (e: any) {
    // banco ainda sem a 055/056 (tabela ou coluna faltando): ninguém é "só comandas" ainda
    if (e?.code !== '42P01' && e?.code !== '42703') throw e
  }
  if (soComandas) throw createError({ statusCode: 403, statusMessage: 'Este login é só das comandas: use o app do tablet.' })
})
