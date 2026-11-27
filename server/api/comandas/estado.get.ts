/**
 * GET /api/comandas/estado?pendentes=N — o que o tablet guarda pra trabalhar SEM internet.
 *
 * Cardápio, pontos de venda e as contas abertas com a pulseira de cada uma. O tablet chama
 * isto a cada poucos segundos com rede; sem rede, usa a última cópia. `pendentes` é quantos
 * pedidos ele ainda tem na fila (vira o aviso "tablet do João com 3 pedidos sem enviar").
 */
import { configDaComanda, ctx, sinalDoAparelho, SQL_PULSEIRA_ATIVA, SQL_TOTAL } from '../../utils/comandas'
import { q } from '../../utils/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = ctx(event)
  sinalDoAparelho(c, Number(getQuery(event).pendentes ?? 0))
  const config = await configDaComanda(c.orgId)

  const [pontos, categorias, itens, contas] = await Promise.all([
    q<any>(`SELECT id, nome, categorias FROM comanda_pontos WHERE org_id = $1 AND ativo ORDER BY ordem, nome`, [c.orgId]),
    q<any>(`SELECT id, nome, icone FROM comanda_categorias WHERE org_id = $1 AND ativo ORDER BY ordem, nome`, [c.orgId]),
    q<any>(`SELECT i.id, i.categoria_id, i.nome, i.icone, i.preco_cents, i.maior_18, i.esgotado
              FROM comanda_itens i JOIN comanda_categorias k ON k.id = i.categoria_id
             WHERE i.org_id = $1 AND i.ativo AND k.ativo ORDER BY i.ordem, i.nome`, [c.orgId]),
    q<any>(`SELECT c.id, c.numero, c.nome, c.responsavel_nome, c.limite_cents, c.menor_de_idade,
                   ${SQL_TOTAL} AS total_cents, ${SQL_PULSEIRA_ATIVA} AS pulseira
              FROM comandas c WHERE c.org_id = $1 AND c.situacao = 'aberta'`, [c.orgId]),
  ])

  return {
    agora: new Date().toISOString(),
    // `pontoFixo`: a pessoa atende só nesses locais (056) — o tablet não deixa escolher outro
    eu: { nome: c.nome, nivel: c.nivel, master: c.master, pontoFixo: !!c.pontos?.length },
    config,
    pontos: c.pontos?.length ? pontos.filter((p) => c.pontos!.includes(p.id)) : pontos,
    categorias,
    itens: itens.map((i) => ({ id: i.id, categoriaId: i.categoria_id, nome: i.nome, icone: i.icone, precoCents: Number(i.preco_cents),
      maior18: i.maior_18, esgotado: i.esgotado })),
    contas: contas.map((r) => ({ id: r.id, numero: Number(r.numero), nome: r.nome, responsavelNome: r.responsavel_nome,
      limiteCents: Number(r.limite_cents), menorDeIdade: r.menor_de_idade, totalCents: Number(r.total_cents),
      pulseira: r.pulseira })),
  }
})
