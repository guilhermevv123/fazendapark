/**
 * POST /api/comandas/cardapio — cria e edita o cardápio e os pontos de venda. Só gerente.
 *
 * `{ tipo: 'categoria' | 'item' | 'ponto', id?, ...campos }`: sem `id` cria, com `id` edita.
 * Item não se apaga (já pode estar em conta antiga): desativa (`ativo: false`) e some do
 * tablet. Mudar o preço não muda conta antiga — cada item da conta guarda o preço da hora.
 */
import { exigirNivel, reaisTexto, recusa, registrar, texto } from '../../utils/comandas'
import { q, q1 } from '../../utils/db'

/** emoji escolhido no cadastro (até 16 caracteres; vazio = o tablet escolhe pelo nome) */
const icone = (v: unknown) => typeof v === 'string' && v.trim() ? [...v.trim()].slice(0, 4).join('').slice(0, 16) : null

export default defineEventHandler(async (event) => {
  const c = exigirNivel(event, 'gerente')
  const b = (await readBody<Record<string, any>>(event)) ?? {}
  const id = b.id ? String(b.id) : null
  try {
    if (b.tipo === 'categoria') {
      const nome = texto(b.nome, 40)
      if (!nome) recusa('Dê um nome à categoria.', 'nome')
      const r = id
        ? await q1(`UPDATE comanda_categorias SET nome = $3, ordem = COALESCE($4, ordem), ativo = COALESCE($5, ativo), icone = $6
                     WHERE org_id = $1 AND id::text = $2 RETURNING id`, [c.orgId, id, nome, num(b.ordem), bool(b.ativo), icone(b.icone)])
        : await q1(`INSERT INTO comanda_categorias (org_id, nome, ordem, icone) VALUES ($1,$2,
                      COALESCE($3, (SELECT COALESCE(MAX(ordem),0)+1 FROM comanda_categorias WHERE org_id = $1)), $4) RETURNING id`,
        [c.orgId, nome, num(b.ordem), icone(b.icone)])
      await registrar(null, c, { acao: 'cardapio', descricao: `${id ? 'Editou' : 'Criou'} a categoria ${nome}` })
      return { id: (r as any)?.id }
    }
    if (b.tipo === 'item') {
      const nome = texto(b.nome, 60)
      const preco = Math.trunc(Number(b.precoCents))
      if (!nome) recusa('Dê um nome ao item.', 'nome')
      if (!Number.isInteger(preco) || preco < 0 || preco > 100_000_00) recusa('Preço inválido.', 'preco')
      const cat = await q1(`SELECT id FROM comanda_categorias WHERE org_id = $1 AND id::text = $2`, [c.orgId, String(b.categoriaId ?? '')])
      if (!cat) recusa('Escolha a categoria do item.', 'categoria')
      if (id) {
        const antes = await q1<any>(`SELECT nome, preco_cents FROM comanda_itens WHERE org_id = $1 AND id::text = $2`, [c.orgId, id])
        if (!antes) recusa('Item não encontrado.', 'item')
        await q1(`UPDATE comanda_itens SET nome = $3, preco_cents = $4, categoria_id = $5, maior_18 = $6, esgotado = $7, ativo = $8,
                         ordem = COALESCE($9, ordem), icone = $10, atualizado_em = now() WHERE org_id = $1 AND id::text = $2 RETURNING id`,
        [c.orgId, id, nome, preco, (cat as any).id, !!b.maior18, !!b.esgotado, b.ativo !== false, num(b.ordem), icone(b.icone)])
        await registrar(null, c, { acao: 'cardapio',
          descricao: `Editou ${antes.nome}` + (Number(antes.preco_cents) !== preco ? ` — preço ${reaisTexto(Number(antes.preco_cents))} → ${reaisTexto(preco)}` : '')
            + (b.esgotado ? ' (esgotado)' : '') + (b.ativo === false ? ' (desativado)' : '') })
        return { id }
      }
      const r = await q1<any>(
        `INSERT INTO comanda_itens (org_id, categoria_id, nome, preco_cents, maior_18, esgotado, ordem, icone)
         VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, (SELECT COALESCE(MAX(ordem),0)+1 FROM comanda_itens WHERE org_id = $1)), $8) RETURNING id`,
        [c.orgId, (cat as any).id, nome, preco, !!b.maior18, !!b.esgotado, num(b.ordem), icone(b.icone)])
      await registrar(null, c, { acao: 'cardapio', descricao: `Criou o item ${nome} (${reaisTexto(preco)})` })
      return { id: r.id }
    }
    if (b.tipo === 'ponto' && b.excluir) {
      // Local sem nenhuma venda: apaga de vez. Com venda: só desativa — os relatórios antigos
      // continuam mostrando onde cada coisa foi vendida.
      const p = await q1<any>(`SELECT p.id, p.nome, EXISTS (SELECT 1 FROM comanda_lancamentos l WHERE l.ponto_id = p.id) AS vendeu
                                 FROM comanda_pontos p WHERE p.org_id = $1 AND p.id::text = $2`, [c.orgId, String(id ?? '')])
      if (!p) recusa('Local não encontrado.', 'ponto')
      if (p.vendeu) await q1(`UPDATE comanda_pontos SET ativo = false WHERE id = $1 RETURNING id`, [p.id])
      else await q1(`DELETE FROM comanda_pontos WHERE id = $1 RETURNING id`, [p.id])
      await registrar(null, c, { acao: 'cardapio', descricao: `Excluiu o local de venda ${p.nome}${p.vendeu ? ' (tinha vendas: ficou só no histórico)' : ''}` })
      return { id: p.id, apagado: !p.vendeu }
    }
    if (b.tipo === 'ponto') {
      const nome = texto(b.nome, 60)
      if (!nome) recusa('Dê um nome ao local de venda.', 'nome')
      // categorias que o local vende: lista de ids desta organização, ou null = vende tudo
      let categorias: string[] | null = null
      if (Array.isArray(b.categorias)) {
        const pedidas = b.categorias.map(String).filter((x: string) => /^[0-9a-f-]{36}$/i.test(x))
        categorias = pedidas.length
          ? (await q<any>(`SELECT id FROM comanda_categorias WHERE org_id = $1 AND id::text = ANY($2::text[])`, [c.orgId, pedidas])).map((r) => r.id)
          : []
        if (!categorias.length) recusa('Marque pelo menos uma categoria que este local vende (ou "Vende tudo").', 'categorias')
      }
      const r = id
        ? await q1(`UPDATE comanda_pontos SET nome = $3, ativo = COALESCE($4, ativo),
                            categorias = CASE WHEN $6 THEN $5::uuid[] ELSE categorias END
                     WHERE org_id = $1 AND id::text = $2 RETURNING id`, [c.orgId, id, nome, bool(b.ativo), categorias, 'categorias' in b])
        : await q1(`INSERT INTO comanda_pontos (org_id, nome, ordem, categorias) VALUES ($1,$2,
                      (SELECT COALESCE(MAX(ordem),0)+1 FROM comanda_pontos WHERE org_id = $1), $3) RETURNING id`, [c.orgId, nome, categorias])
      await registrar(null, c, { acao: 'cardapio',
        descricao: `${id ? 'Editou' : 'Criou'} o local de venda ${nome}${b.ativo === false ? ' (desativado)' : ''}` })
      return { id: (r as any)?.id }
    }
  } catch (e: any) {
    if (e?.code === '23505') recusa('Já existe um com esse nome.', 'duplicado')
    throw e
  }
  recusa('Tipo desconhecido.', 'tipo')
})

const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Math.trunc(Number(v)))
const bool = (v: unknown) => (typeof v === 'boolean' ? v : null)
