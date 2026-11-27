/**
 * GET /api/comandas/gestao/links — os links dos funcionários (só o gerente).
 * O segredo do link não volta aqui: ele só aparece uma vez, quando é criado.
 */
import { exigirNivel } from '../../../utils/comandas'
import { q } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = exigirNivel(event, 'gerente')
  const linhas = await q<any>(
    `SELECT k.id, k.nome, k.criado_em, k.desativado_em, k.ultimo_uso_em, u.name AS criado_por, (k.pin_hash IS NOT NULL) AS tem_pin,
            (k.travado_ate > now()) AS travado,
            (SELECT COUNT(*) FROM comanda_lancamentos l WHERE l.link_id = k.id) AS pedidos
       FROM comanda_links k LEFT JOIN users u ON u.id = k.criado_por
      WHERE k.org_id = $1 ORDER BY (k.desativado_em IS NULL) DESC, k.criado_em DESC`, [c.orgId])
  return {
    links: linhas.map((k) => ({
      id: k.id, nome: k.nome, criadoEm: k.criado_em, criadoPor: k.criado_por, ativo: !k.desativado_em,
      desativadoEm: k.desativado_em, ultimoUsoEm: k.ultimo_uso_em, pedidos: Number(k.pedidos), temPin: !!k.tem_pin, travado: !!k.travado,
    })),
  }
})
