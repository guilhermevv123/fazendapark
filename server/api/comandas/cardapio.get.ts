/** GET /api/comandas/cardapio — o cardápio inteiro pra gestão (inclui inativo e esgotado) e os pontos. */
import { exigirNivel } from '../../utils/comandas'
import { q } from '../../utils/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = exigirNivel(event, 'caixa')
  const [categorias, itens, pontos] = await Promise.all([
    q<any>(`SELECT id, nome, icone, ordem, ativo FROM comanda_categorias WHERE org_id = $1 ORDER BY ordem, nome`, [c.orgId]),
    q<any>(`SELECT i.id, i.categoria_id, i.nome, i.icone, i.foto, i.preco_cents, i.maior_18, i.esgotado, i.ativo, i.ordem, i.atualizado_em,
                   (SELECT COUNT(*) FROM comanda_lancamento_itens li WHERE li.item_id = i.id AND NOT li.cancelado) AS vendidos
              FROM comanda_itens i WHERE i.org_id = $1 ORDER BY i.ordem, i.nome`, [c.orgId]),
    q<any>(`SELECT p.id, p.nome, p.ativo, p.ordem, p.categorias, p.criado_em,
                   (SELECT COUNT(*) FROM comanda_lancamentos l WHERE l.ponto_id = p.id) AS pedidos
              FROM comanda_pontos p WHERE p.org_id = $1 ORDER BY p.ativo DESC, p.ordem, p.nome`, [c.orgId]),
  ])
  return {
    categorias,
    itens: itens.map((i) => ({ id: i.id, categoriaId: i.categoria_id, nome: i.nome, icone: i.icone, foto: i.foto, precoCents: Number(i.preco_cents),
      maior18: i.maior_18, esgotado: i.esgotado, ativo: i.ativo, ordem: i.ordem, atualizadoEm: i.atualizado_em,
      vendidos: Number(i.vendidos) })),
    pontos,
  }
})
