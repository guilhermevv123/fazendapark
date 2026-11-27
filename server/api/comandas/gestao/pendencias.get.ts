/**
 * GET /api/comandas/gestao/pendencias — pedidos que chegaram (de tablet sem internet) depois
 * de a conta já estar fechada. Nada some: o gerente decide se cobra ou cancela.
 */
import { exigirNivel } from '../../../utils/comandas'
import { q } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = exigirNivel(event, 'gerente')
  const linhas = await q<any>(
    `SELECT l.id, l.feito_em, l.recebido_em, l.mesa, c.id AS comanda_id, c.numero, c.nome, c.situacao,
            c.responsavel_nome, c.responsavel_telefone, u.name AS atendente,
            (SELECT string_agg(i.quantidade || '× ' || i.nome, ', ') FROM comanda_lancamento_itens i
              WHERE i.lancamento_id = l.id AND NOT i.cancelado) AS itens,
            (SELECT COALESCE(SUM(i.preco_cents * i.quantidade - i.desconto_cents), 0) FROM comanda_lancamento_itens i
              WHERE i.lancamento_id = l.id AND NOT i.cancelado) AS valor
       FROM comanda_lancamentos l JOIN comandas c ON c.id = l.comanda_id LEFT JOIN LATERAL (SELECT COALESCE((SELECT k.nome FROM comanda_links k WHERE k.id = l.link_id), (SELECT x.name FROM users x WHERE x.id = l.atendente_id)) AS name) u ON true
      WHERE l.org_id = $1 AND l.chegou_depois_de_fechada AND l.pendencia_resolvida_em IS NULL
      ORDER BY l.feito_em`, [c.orgId])
  return {
    pendencias: linhas.map((l) => ({
      id: l.id, feitoEm: l.feito_em, recebidoEm: l.recebido_em, mesa: l.mesa, comandaId: l.comanda_id,
      numero: Number(l.numero), nome: l.nome, situacao: l.situacao, responsavelNome: l.responsavel_nome,
      responsavelTelefone: l.responsavel_telefone, atendente: l.atendente, itens: l.itens ?? '—', valorCents: Number(l.valor),
    })),
  }
})
