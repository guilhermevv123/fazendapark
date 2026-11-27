/**
 * GET /api/comandas/gestao/pedidos — todos os pedidos de um período, um por linha.
 *
 * Filtros: de, ate (padrão hoje), ponto (id do local), atendente (id), q (cliente, mesa,
 * nome da conta, pulseira ou item), situacao ('cancelado' | 'sem_internet' | 'depois_de_fechada').
 * Devolve até 500 pedidos, mais novos primeiro, com os itens de cada um.
 */
import { exigirNivel, intervaloDoDia } from '../../../utils/comandas'
import { q } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = exigirNivel(event, 'gerente')
  const qy = getQuery(event)
  const de = intervaloDoDia(qy.de)
  let ate = intervaloDoDia(qy.ate ?? de.dia)
  if (ate.dia < de.dia) ate = de

  const par: unknown[] = [c.orgId, de.inicio, ate.fim]
  const filtros: string[] = []
  const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null
  if (uuid(qy.ponto)) { par.push(qy.ponto); filtros.push(`l.ponto_id::text = $${par.length}`) }
  if (uuid(qy.atendente)) { par.push(qy.atendente); filtros.push(`l.atendente_id::text = $${par.length}`) }
  const busca = typeof qy.q === 'string' ? qy.q.trim().slice(0, 60) : ''
  if (busca) {
    par.push(`%${busca}%`)
    const k = `$${par.length}`
    filtros.push(`(l.cliente_nome ILIKE ${k} OR l.mesa ILIKE ${k} OR c.nome ILIKE ${k} OR l.pulseira_uid ILIKE ${k}
                   OR c.numero::text ILIKE ${k} OR EXISTS (SELECT 1 FROM comanda_lancamento_itens x WHERE x.lancamento_id = l.id AND x.nome ILIKE ${k}))`)
  }
  if (qy.situacao === 'cancelado') filtros.push(`EXISTS (SELECT 1 FROM comanda_lancamento_itens x WHERE x.lancamento_id = l.id AND x.cancelado)`)
  if (qy.situacao === 'sem_internet') filtros.push('l.feito_sem_internet')
  if (qy.situacao === 'depois_de_fechada') filtros.push('l.chegou_depois_de_fechada')

  const linhas = await q<any>(
    `SELECT l.id, l.feito_em, l.recebido_em, l.mesa, l.cliente_nome, l.observacao, l.pulseira_uid, l.aparelho,
            l.feito_sem_internet, l.chegou_depois_de_fechada, l.preparo,
            c.id AS comanda_id, c.numero, c.nome AS conta_nome, c.situacao AS conta_situacao,
            p.nome AS ponto, u.name AS atendente, lib.name AS liberado_por,
            COALESCE(json_agg(json_build_object('nome', i.nome, 'quantidade', i.quantidade, 'precoCents', i.preco_cents,
                     'descontoCents', i.desconto_cents, 'cancelado', i.cancelado, 'motivo', i.cancelado_motivo) ORDER BY i.nome), '[]') AS itens
       FROM comanda_lancamentos l
       JOIN comandas c ON c.id = l.comanda_id
       LEFT JOIN comanda_pontos p ON p.id = l.ponto_id
       LEFT JOIN LATERAL (SELECT COALESCE((SELECT k.nome FROM comanda_links k WHERE k.id = l.link_id), (SELECT x.name FROM users x WHERE x.id = l.atendente_id)) AS name) u ON true
       LEFT JOIN users lib ON lib.id = l.limite_liberado_por
       LEFT JOIN comanda_lancamento_itens i ON i.lancamento_id = l.id
      WHERE l.org_id = $1 AND l.feito_em BETWEEN $2 AND $3 ${filtros.map((f) => `AND ${f}`).join(' ')}
      GROUP BY l.id, c.id, p.nome, u.name, lib.name
      ORDER BY l.feito_em DESC
      LIMIT 500`, par)

  return {
    de: de.dia,
    ate: ate.dia,
    pedidos: linhas.map((l) => {
      const itens = (l.itens as any[]).filter((i) => i.nome)
      const valor = itens.filter((i) => !i.cancelado).reduce((s, i) => s + i.precoCents * i.quantidade - i.descontoCents, 0)
      return {
        id: l.id, feitoEm: l.feito_em, recebidoEm: l.recebido_em, mesa: l.mesa, cliente: l.cliente_nome, observacao: l.observacao,
        pulseira: l.pulseira_uid, ponto: l.ponto, atendente: l.atendente, liberadoPor: l.liberado_por,
        semInternet: l.feito_sem_internet, depoisDeFechada: l.chegou_depois_de_fechada, preparo: l.preparo,
        comandaId: l.comanda_id, numero: Number(l.numero), contaNome: l.conta_nome, contaSituacao: l.conta_situacao,
        itens, valorCents: valor, temCancelado: itens.some((i) => i.cancelado),
      }
    }),
    limite: 500,
  }
})
