/**
 * POST /api/origem/visita — uma visita ao site, com a origem da chegada (052). É o "quem está
 * vendo" do tráfego pago e o denominador da conversão no relatório do evento.
 *
 * Público e silencioso: a resposta é sempre 204 (o navegador manda e esquece). Sem IP, sem nome — um
 * id aleatório do navegador e o da aba (`UNIQUE (visitante, aba)`: recarregar a página não conta de
 * novo). Vindo de outro site, ou acima do freio, simplesmente não grava.
 */
import { z } from 'zod'
import { q } from '../../utils/db'
import { OrigemDoNavegador } from '../../utils/origem'
import { mutacaoDeOutroSite } from '../../utils/caminho'
import { frearPortaPublica } from '../../utils/sessao'

const Entrada = z.object({
  visitante: z.string().min(8).max(64).regex(/^[a-z0-9-]+$/i),
  aba: z.string().min(8).max(64).regex(/^[a-z0-9-]+$/i),
  caminho: z.string().max(200),
  origem: OrigemDoNavegador.nullish(),
})

export default defineEventHandler(async (event) => {
  setResponseStatus(event, 204)
  if (mutacaoDeOutroSite(event)) return null
  try { frearPortaPublica(event, 'visita') } catch { return null }
  const p = Entrada.safeParse(await readBody(event).catch(() => null))
  if (!p.success) return null
  const { visitante, aba, caminho, origem } = p.data
  const slug = /^\/e\/([a-z0-9-]{1,120})/i.exec(caminho)?.[1] ?? null
  await q(
    `INSERT INTO site_visits (visitante, aba, caminho, evento_slug, tipo, fonte, meio, campanha, conteudo, termo, clique, referencia)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (visitante, aba) DO NOTHING`,
    [visitante, aba, caminho.slice(0, 200), slug, origem?.tipo ?? 'direto', origem?.fonte ?? null, origem?.meio ?? null,
     origem?.campanha ?? null, origem?.conteudo ?? null, origem?.termo ?? null, origem?.clique ?? null,
     origem?.referencia ?? null]).catch((e) => console.warn(`[visita] não gravou: ${e?.message ?? e}`))
  return null
})
