/**
 * GET /api/comandas/conta/<id> — a conta inteira: cada item com data, hora, quem lançou e de
 * onde; os pagamentos; as pulseiras que ela já teve; o grupo; e a linha do tempo completa.
 */
import { configDaComanda, ctx, grupoDaConta, nivelCobre, resumoDaComanda } from '../../../utils/comandas'
import { q, q1 } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = ctx(event)
  const id = String(getRouterParam(event, 'id') ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404, statusMessage: 'Conta não encontrada.' })
  const conta = await resumoDaComanda(c.orgId, id)
  if (!conta) throw createError({ statusCode: 404, statusMessage: 'Conta não encontrada.' })

  const [extra, itens, pagamentos, pulseiras, historico, grupo, config] = await Promise.all([
    q1<any>(`SELECT c.responsavel_email, c.responsavel_documento, c.observacao, c.desconto_cents, c.desconto_motivo,
                    c.juntada_em, c.ticket_id, c.encerrada_motivo, c.cobrada_em,
                    o.code AS pedido_codigo, t.code AS ingresso_codigo,
                    ua.name AS aberta_por, uf.name AS fechada_por, pa.nome AS aberta_no_ponto,
                    (SELECT j.numero FROM comandas j WHERE j.id = c.juntada_em) AS juntada_numero
               FROM comandas c
               LEFT JOIN orders o ON o.id = c.order_id
               LEFT JOIN tickets t ON t.id = c.ticket_id
               LEFT JOIN users ua ON ua.id = c.aberta_por
               LEFT JOIN users uf ON uf.id = c.fechada_por
               LEFT JOIN comanda_pontos pa ON pa.id = c.aberta_no_ponto
              WHERE c.id = $1`, [id]),
    q<any>(`SELECT i.id, i.nome, i.preco_cents, i.quantidade, i.desconto_cents, i.desconto_motivo,
                   i.cancelado, i.cancelado_em, i.cancelado_motivo, uc.name AS cancelado_por, i.substitui_id,
                   l.id AS lancamento_id, l.feito_em, l.recebido_em, l.feito_sem_internet, l.mesa, l.cliente_nome, l.observacao,
                   l.chegou_depois_de_fechada, l.atendente_id, l.preparo,
                   ua.name AS atendente, p.nome AS ponto,
                   (l.comanda_id <> i.comanda_id) AS veio_de_outra
              FROM comanda_lancamento_itens i
              JOIN comanda_lancamentos l ON l.id = i.lancamento_id
              LEFT JOIN LATERAL (SELECT COALESCE((SELECT k.nome FROM comanda_links k WHERE k.id = l.link_id), (SELECT x.name FROM users x WHERE x.id = l.atendente_id)) AS name) ua ON true
              LEFT JOIN users uc ON uc.id = i.cancelado_por
              LEFT JOIN comanda_pontos p ON p.id = l.ponto_id
             WHERE i.comanda_id = $1
             ORDER BY l.feito_em, i.id`, [id]),
    q<any>(`SELECT p.id, p.forma, p.valor_cents, p.recebido_cents, p.feito_em, p.anulado, p.anulado_em, p.anulado_motivo,
                   u.name AS feito_por, ua.name AS anulado_por
              FROM comanda_pagamentos p
              LEFT JOIN LATERAL (SELECT COALESCE((SELECT k.nome FROM comanda_links k WHERE k.id = p.link_id), (SELECT x.name FROM users x WHERE x.id = p.feito_por)) AS name) u ON true
              LEFT JOIN users ua ON ua.id = p.anulado_por
             WHERE p.comanda_id = $1 ORDER BY p.feito_em`, [id]),
    q<any>(`SELECT pu.uid, pu.rotulo, v.inicio_em, v.fim_em, v.fim_motivo
              FROM comanda_vinculos v JOIN comanda_pulseiras pu ON pu.id = v.pulseira_id
             WHERE v.comanda_id = $1 ORDER BY v.inicio_em`, [id]),
    q<any>(`SELECT quando, quem_nome, aparelho, acao, descricao FROM comanda_historico
             WHERE comanda_id = $1 ORDER BY quando, id`, [id]),
    grupoDaConta(c.orgId, conta),
    configDaComanda(c.orgId),
  ])

  const agora = Date.now()
  return {
    conta: {
      ...conta,
      responsavelEmail: extra?.responsavel_email ?? null,
      responsavelDocumento: extra?.responsavel_documento ?? null,
      observacao: extra?.observacao ?? null,
      descontoCents: Number(extra?.desconto_cents ?? 0),
      descontoMotivo: extra?.desconto_motivo ?? null,
      juntadaEm: extra?.juntada_em ?? null,
      juntadaNumero: extra?.juntada_numero ? Number(extra.juntada_numero) : null,
      pedidoCodigo: extra?.pedido_codigo ?? null,
      ingressoCodigo: extra?.ingresso_codigo ?? null,
      abertaPor: extra?.aberta_por ?? null,
      fechadaPor: extra?.fechada_por ?? null,
      abertaNoPonto: extra?.aberta_no_ponto ?? null,
      encerradaMotivo: extra?.encerrada_motivo ?? null,
      cobradaEm: extra?.cobrada_em ?? null,
    },
    itens: itens.map((i) => ({
      id: i.id, nome: i.nome, precoCents: Number(i.preco_cents), quantidade: i.quantidade,
      subtotalCents: Number(i.preco_cents) * i.quantidade - Number(i.desconto_cents),
      descontoCents: Number(i.desconto_cents), descontoMotivo: i.desconto_motivo,
      cancelado: i.cancelado, canceladoEm: i.cancelado_em, canceladoPor: i.cancelado_por, canceladoMotivo: i.cancelado_motivo,
      substituiId: i.substitui_id, lancamentoId: i.lancamento_id, feitoEm: i.feito_em, recebidoEm: i.recebido_em,
      semInternet: i.feito_sem_internet, mesa: i.mesa, cliente: i.cliente_nome, observacao: i.observacao, aposFechar: i.chegou_depois_de_fechada,
      atendente: i.atendente, ponto: i.ponto, preparo: i.preparo, veioDeOutra: i.veio_de_outra,
      // o atendente desfaz sozinho o PRÓPRIO pedido dentro do prazo
      desfazSozinho: !i.cancelado && i.atendente_id === c.usuarioId
        && agora - new Date(i.feito_em).getTime() <= config.minutosParaDesfazer * 60_000,
    })),
    pagamentos: pagamentos.map((p) => ({
      id: p.id, forma: p.forma, valorCents: Number(p.valor_cents),
      recebidoCents: p.recebido_cents == null ? null : Number(p.recebido_cents),
      trocoCents: p.recebido_cents == null ? null : Number(p.recebido_cents) - Number(p.valor_cents),
      feitoEm: p.feito_em, feitoPor: p.feito_por, anulado: p.anulado, anuladoEm: p.anulado_em,
      anuladoPor: p.anulado_por, anuladoMotivo: p.anulado_motivo,
    })),
    pulseiras: pulseiras.map((p) => ({ uid: p.uid, rotulo: p.rotulo, inicioEm: p.inicio_em, fimEm: p.fim_em, fimMotivo: p.fim_motivo })),
    historico: historico.map((h) => ({ quando: h.quando, quem: h.quem_nome, aparelho: h.aparelho, acao: h.acao, descricao: h.descricao })),
    grupo,
    pode: {
      fechar: nivelCobre(c.nivel, 'caixa') || config.atendenteFechaConta,
      corrigir: nivelCobre(c.nivel, 'caixa'),
      gerente: c.nivel === 'gerente',
    },
    config: { avisoContaAltaCents: config.avisoContaAltaCents, minutosParaDesfazer: config.minutosParaDesfazer },
  }
})
