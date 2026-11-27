/**
 * POST /api/comandas/cardapio/padrao — cria o cardápio padrão (e os pontos padrão) de uma vez.
 * Só cria o que ainda não existe com o mesmo nome: apertar duas vezes não duplica nada.
 */
import { exigirNivel, registrar } from '../../../utils/comandas'
import { CARDAPIO_PADRAO, PONTOS_PADRAO } from '../../../utils/comandas-cardapio'
import { tx } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const c = exigirNivel(event, 'gerente')
  let itens = 0
  await tx(async (cl) => {
    let ordemCat = 0
    for (const bloco of CARDAPIO_PADRAO) {
      ordemCat++
      const cat = (await cl.query(
        `INSERT INTO comanda_categorias (org_id, nome, ordem) VALUES ($1,$2,$3)
         ON CONFLICT (org_id, nome) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`, [c.orgId, bloco.categoria, ordemCat])).rows[0]
      let ordem = 0
      for (const it of bloco.itens) {
        ordem++
        const r = await cl.query(
          `INSERT INTO comanda_itens (org_id, categoria_id, nome, preco_cents, maior_18, ordem)
           SELECT $1,$2,$3,$4,$5,$6 WHERE NOT EXISTS (SELECT 1 FROM comanda_itens WHERE org_id = $1 AND lower(nome) = lower($3))`,
          [c.orgId, cat.id, it.nome, Math.round(it.preco * 100), !!it.maior18, ordem])
        itens += r.rowCount ?? 0
      }
    }
    let ordemP = 0
    for (const ponto of PONTOS_PADRAO) {
      ordemP++
      await cl.query(
        `INSERT INTO comanda_pontos (org_id, nome, ordem, categorias)
         VALUES ($1,$2,$3, (SELECT array_agg(id) FROM comanda_categorias WHERE org_id = $1 AND nome = ANY($4::text[])))
         ON CONFLICT (org_id, nome) DO NOTHING`, [c.orgId, ponto.nome, ordemP, ponto.categorias])
    }
    await registrar(cl, c, { acao: 'cardapio', descricao: `Usou o cardápio padrão: ${itens} itens criados` })
  })
  return { criados: itens }
})
