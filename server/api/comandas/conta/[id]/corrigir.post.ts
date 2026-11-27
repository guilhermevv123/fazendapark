/**
 * POST /api/comandas/conta/<id>/corrigir — toda correção de uma conta, num lugar só.
 *
 * `{ acao, motivo, pin?, ...campos da ação }`. Nada é apagado: item errado vira cancelado
 * (e o certo entra apontando pra ele), pagamento errado vira anulado, e cada ato vai pra
 * linha do tempo com quem fez, quando e o motivo.
 *
 * Quem pode:
 * - o ATENDENTE desfaz o próprio item dentro do prazo (`minutos_para_desfazer`);
 * - o CAIXA troca/move/junta, troca pulseira, marca menor, edita o nome;
 * - o GERENTE (ou o PIN dele digitado no tablet) faz o resto: cancelar fora do prazo,
 *   desconto, reabrir, anular pagamento, mudar limite, perdoar.
 */
import type { PoolClient } from 'pg'
import {
  configDaComanda, contaFinal, ctx, exigirGerente, nivelCobre, reaisTexto, recusa, registrar,
  resumoDaComanda, soltarPulseiras, SQL_PAGO, texto, uidLimpo, type ContextoDaComanda,
} from '../../../../utils/comandas'
import { tx } from '../../../../utils/db'

type Corpo = Record<string, any> & { acao?: string; motivo?: string; pin?: string }

export default defineEventHandler(async (event) => {
  const c = ctx(event)
  const id = String(getRouterParam(event, 'id') ?? '')
  const b = (await readBody<Corpo>(event)) ?? {}
  const acao = String(b.acao ?? '')
  const motivo = texto(b.motivo, 200)
  const config = await configDaComanda(c.orgId)

  const precisaMotivo = () => { if (!motivo || motivo.length < 3) recusa('Escreva o motivo da correção.', 'motivo') }
  const precisaCaixa = () => { if (!nivelCobre(c.nivel, 'caixa')) recusa('Isto é feito no caixa ou pelo gerente.', 'so_caixa') }

  let destinoId: string | null = null
  await tx(async (cl) => {
    const conta = (await cl.query(`SELECT * FROM comandas WHERE org_id = $1 AND id = $2 FOR UPDATE`, [c.orgId, id])).rows[0]
    if (!conta) throw createError({ statusCode: 404, statusMessage: 'Conta não encontrada.' })
    const aberta = conta.situacao === 'aberta'
    const item = async (linhaId: unknown) => {
      const r = (await cl.query(
        `SELECT i.*, l.atendente_id, l.feito_em FROM comanda_lancamento_itens i JOIN comanda_lancamentos l ON l.id = i.lancamento_id
          WHERE i.id = $1 AND i.comanda_id = $2 FOR UPDATE OF i`, [String(linhaId ?? ''), id])).rows[0]
      if (!r) recusa('Item não encontrado nesta conta.', 'item')
      if (r.cancelado) recusa('Este item já foi cancelado.', 'item_cancelado')
      return r
    }
    /** atendente no prazo, no próprio item → sozinho; senão, gerente */
    const autorizarItem = async (linha: any) => {
      const dele = linha.atendente_id === c.usuarioId
      const noPrazo = Date.now() - new Date(linha.feito_em).getTime() <= config.minutosParaDesfazer * 60_000
      if (nivelCobre(c.nivel, 'caixa') && aberta) return null
      if (dele && noPrazo && aberta) return null
      return exigirGerente(c, b.pin)
    }
    const cancelar = async (linha: any, porque: string) => {
      await cl.query(`UPDATE comanda_lancamento_itens SET cancelado = true, cancelado_em = now(), cancelado_por = $2, cancelado_motivo = $3
                       WHERE id = $1`, [linha.id, c.usuarioId, porque])
    }
    const nomeG = (g: any) => (g && g.id !== c.usuarioId ? ` — liberado por ${g.nome}` : '')

    switch (acao) {
      /* ---------------------------------------------------------------- itens */
      case 'cancelar_item': {
        precisaMotivo()
        const linha = await item(b.itemId)
        const g = await autorizarItem(linha)
        await cancelar(linha, motivo!)
        await registrar(cl, c, { comandaId: id, acao: 'cancelar_item',
          descricao: `Cancelou ${linha.quantidade}× ${linha.nome} (${reaisTexto(linha.preco_cents * linha.quantidade)}) — motivo: ${motivo}${nomeG(g)}` })
        break
      }
      case 'quantidade': {
        precisaMotivo()
        const linha = await item(b.itemId)
        const nova = Math.trunc(Number(b.quantidade))
        if (!Number.isInteger(nova) || nova < 1 || nova > 999) recusa('Quantidade inválida.', 'quantidade')
        if (nova === linha.quantidade) recusa('A quantidade é a mesma.', 'igual')
        const g = await autorizarItem(linha)
        await cancelar(linha, `corrigido: quantidade ${linha.quantidade} → ${nova}. ${motivo}`)
        await cl.query(
          `INSERT INTO comanda_lancamento_itens (org_id, lancamento_id, comanda_id, item_id, nome, preco_cents, quantidade, substitui_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [c.orgId, linha.lancamento_id, id, linha.item_id, linha.nome, linha.preco_cents, nova, linha.id])
        await registrar(cl, c, { comandaId: id, acao: 'corrigir_quantidade',
          descricao: `${linha.nome}: quantidade ${linha.quantidade} → ${nova} — motivo: ${motivo}${nomeG(g)}` })
        break
      }
      case 'trocar_item': {
        precisaMotivo()
        const linha = await item(b.itemId)
        const novo = (await cl.query(`SELECT * FROM comanda_itens WHERE org_id = $1 AND id = $2`, [c.orgId, String(b.novoItemId ?? '')])).rows[0]
        if (!novo) recusa('Escolha o item certo do cardápio.', 'novo_item')
        const qtd = Number.isInteger(Number(b.quantidade)) && Number(b.quantidade) > 0 ? Number(b.quantidade) : linha.quantidade
        const g = await autorizarItem(linha)
        await cancelar(linha, `trocado por ${novo.nome}. ${motivo}`)
        await cl.query(
          `INSERT INTO comanda_lancamento_itens (org_id, lancamento_id, comanda_id, item_id, nome, preco_cents, quantidade, substitui_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [c.orgId, linha.lancamento_id, id, novo.id, novo.nome, novo.preco_cents, qtd, linha.id])
        await registrar(cl, c, { comandaId: id, acao: 'trocar_item',
          descricao: `Trocou ${linha.quantidade}× ${linha.nome} por ${qtd}× ${novo.nome} — motivo: ${motivo}${nomeG(g)}` })
        break
      }
      case 'desconto_item': {
        precisaMotivo()
        const linha = await item(b.itemId)
        const g = await exigirGerente(c, b.pin)
        const d = Math.trunc(Number(b.descontoCents))
        const cheio = linha.preco_cents * linha.quantidade
        if (!Number.isInteger(d) || d < 0 || d > cheio) recusa(`Desconto entre R$ 0 e ${reaisTexto(cheio)}.`, 'desconto')
        await cl.query(`UPDATE comanda_lancamento_itens SET desconto_cents = $2, desconto_motivo = $3 WHERE id = $1`, [linha.id, d, motivo])
        await registrar(cl, c, { comandaId: id, acao: 'desconto_item',
          descricao: `Desconto de ${reaisTexto(d)} em ${linha.nome} — motivo: ${motivo}${nomeG(g)}` })
        break
      }
      case 'mover_itens': {
        precisaCaixa(); precisaMotivo()
        const ids: string[] = (Array.isArray(b.itens) ? b.itens : []).map(String)
        if (!ids.length) recusa('Escolha os itens para mover.', 'itens')
        if (conta.situacao !== 'aberta') recusa('Só dá para mover itens de uma conta aberta.', 'situacao')
        const pagoOrigem = Number((await cl.query(`SELECT ${SQL_PAGO} AS pg FROM comandas c WHERE c.id = $1`, [id])).rows[0].pg)
        if (pagoOrigem > 0) recusa('Esta conta já tem pagamento. Anule o pagamento antes de mover itens.', 'ja_tem_pagamento')
        destinoId = await acharDestino(cl, c, b, id)
        const dest = (await cl.query(`SELECT * FROM comandas WHERE id = $1 FOR UPDATE`, [destinoId])).rows[0]
        if (dest.situacao !== 'aberta') recusa(`A conta ${dest.numero} não está aberta.`, 'destino_fechada')
        const movidos = (await cl.query(
          `UPDATE comanda_lancamento_itens SET comanda_id = $3
            WHERE comanda_id = $1 AND id = ANY($2::uuid[]) AND NOT cancelado
            RETURNING nome, quantidade, preco_cents`, [id, ids, destinoId])).rows
        if (!movidos.length) recusa('Nenhum item válido para mover.', 'itens')
        const lista = movidos.map((m: any) => `${m.quantidade}× ${m.nome}`).join(', ')
        await registrar(cl, c, { comandaId: id, acao: 'mover_saida',
          descricao: `Moveu para a conta ${dest.numero} (${dest.nome}): ${lista} — motivo: ${motivo}` })
        await registrar(cl, c, { comandaId: destinoId, acao: 'mover_entrada',
          descricao: `Recebeu da conta ${conta.numero} (${conta.nome}): ${lista} — motivo: ${motivo}` })
        break
      }
      case 'juntar': {
        // "pagar tudo junto": tudo desta conta passa pra outra; a pulseira desta continua
        // valendo e passa a lançar na outra
        precisaCaixa()
        if (!aberta) recusa('Só dá para juntar uma conta aberta.', 'nao_aberta')
        destinoId = await acharDestino(cl, c, b, id)
        const dest = (await cl.query(`SELECT * FROM comandas WHERE id = $1 FOR UPDATE`, [destinoId])).rows[0]
        if (dest.situacao !== 'aberta') recusa(`A conta ${dest.numero} não está aberta.`, 'destino_fechada')
        const pago = Number((await cl.query(`SELECT ${SQL_PAGO} AS p FROM comandas c WHERE c.id = $1`, [id])).rows[0].p)
        if (pago > 0) recusa('Esta conta já tem pagamento. Feche ela antes, ou anule o pagamento.', 'tem_pagamento')
        await cl.query(`UPDATE comanda_lancamento_itens SET comanda_id = $2 WHERE comanda_id = $1`, [id, destinoId])
        await cl.query(`UPDATE comanda_lancamentos SET comanda_id = $2 WHERE comanda_id = $1`, [id, destinoId])
        // as pulseiras desta conta passam a apontar pra conta que pagou
        const pulseiras = (await cl.query(`SELECT pulseira_id FROM comanda_vinculos WHERE comanda_id = $1 AND fim_em IS NULL`, [id])).rows
        await soltarPulseiras(cl, c, id, 'juntada')
        for (const p of pulseiras) {
          await cl.query(`INSERT INTO comanda_vinculos (org_id, comanda_id, pulseira_id, inicio_por) VALUES ($1,$2,$3,$4)`,
            [c.orgId, destinoId, p.pulseira_id, c.usuarioId])
        }
        await cl.query(`UPDATE comandas SET situacao = 'juntada', juntada_em = $2, fechada_em = now(), fechada_por = $3 WHERE id = $1`,
          [id, destinoId, c.usuarioId])
        await registrar(cl, c, { comandaId: id, acao: 'juntar_saida', descricao: `Conta juntada na conta ${dest.numero} (${dest.nome}): tudo passou para lá.` })
        await registrar(cl, c, { comandaId: destinoId, acao: 'juntar_entrada',
          descricao: `Recebeu tudo da conta ${conta.numero} (${conta.nome}). A pulseira de ${conta.nome} agora lança aqui.` })
        break
      }
      case 'desconto_conta': {
        precisaMotivo()
        const g = await exigirGerente(c, b.pin)
        const d = Math.trunc(Number(b.descontoCents))
        if (!Number.isInteger(d) || d < 0) recusa('Desconto inválido.', 'desconto')
        await cl.query(`UPDATE comandas SET desconto_cents = $2, desconto_motivo = $3 WHERE id = $1`, [id, d, motivo])
        await registrar(cl, c, { comandaId: id, acao: 'desconto_conta', descricao: `Desconto na conta: ${reaisTexto(d)} — motivo: ${motivo}${nomeG(g)}` })
        break
      }

      /* ---------------------------------------------------------------- conta */
      case 'reabrir': {
        precisaMotivo()
        const g = await exigirGerente(c, b.pin)
        if (!['paga', 'paga_depois', 'nao_paga', 'cobrada', 'perdoada'].includes(conta.situacao)) recusa('Esta conta não está fechada.', 'nao_fechada')
        await cl.query(`UPDATE comandas SET situacao = 'aberta', fechada_em = NULL, fechada_por = NULL WHERE id = $1`, [id])
        await registrar(cl, c, { comandaId: id, acao: 'reabrir',
          descricao: `Conta reaberta (estava "${conta.situacao}") — motivo: ${motivo}${nomeG(g)}. Para lançar de novo, ligue uma pulseira a ela.` })
        break
      }
      case 'anular_pagamento': {
        precisaMotivo()
        const g = await exigirGerente(c, b.pin)
        const p = (await cl.query(`SELECT * FROM comanda_pagamentos WHERE id = $1 AND comanda_id = $2 AND NOT anulado`, [String(b.pagamentoId ?? ''), id])).rows[0]
        if (!p) recusa('Pagamento não encontrado.', 'pagamento')
        await cl.query(`UPDATE comanda_pagamentos SET anulado = true, anulado_em = now(), anulado_por = $2, anulado_motivo = $3 WHERE id = $1`,
          [p.id, c.usuarioId, motivo])
        // conta fechada que perde pagamento volta a ficar aberta (agora falta dinheiro nela)
        if (conta.situacao === 'paga' || conta.situacao === 'paga_depois') {
          await cl.query(`UPDATE comandas SET situacao = 'aberta', fechada_em = NULL, fechada_por = NULL WHERE id = $1`, [id])
        }
        await registrar(cl, c, { comandaId: id, acao: 'anular_pagamento',
          descricao: `Anulou o pagamento de ${reaisTexto(p.valor_cents)} (${p.forma}) — motivo: ${motivo}${nomeG(g)}` })
        break
      }
      case 'forma_pagamento': {
        // marcou "débito" e era "crédito": troca a forma sem mexer no valor
        precisaCaixa(); precisaMotivo()
        const nova = String(b.forma ?? '')
        if (!['dinheiro', 'pix', 'debito', 'credito'].includes(nova)) recusa('Forma inválida.', 'forma')
        const p = (await cl.query(`SELECT * FROM comanda_pagamentos WHERE id = $1 AND comanda_id = $2 AND NOT anulado`, [String(b.pagamentoId ?? ''), id])).rows[0]
        if (!p) recusa('Pagamento não encontrado.', 'pagamento')
        await cl.query(`UPDATE comanda_pagamentos SET forma = $2, recebido_cents = CASE WHEN $2 = 'dinheiro' THEN recebido_cents END WHERE id = $1`, [p.id, nova])
        await registrar(cl, c, { comandaId: id, acao: 'forma_pagamento',
          descricao: `Pagamento de ${reaisTexto(p.valor_cents)}: forma ${p.forma} → ${nova} — motivo: ${motivo}` })
        break
      }
      case 'perdoar': {
        precisaMotivo()
        const g = await exigirGerente(c, b.pin)
        if (!['nao_paga', 'cobrada', 'aberta'].includes(conta.situacao)) recusa('Só dá para perdoar uma conta não paga.', 'situacao')
        await cl.query(`UPDATE comandas SET situacao = 'perdoada', encerrada_em = now(), encerrada_por = $2, encerrada_motivo = $3,
                               fechada_em = COALESCE(fechada_em, now()) WHERE id = $1`, [id, c.usuarioId, motivo])
        await soltarPulseiras(cl, c, id, 'encerrada')
        await registrar(cl, c, { comandaId: id, acao: 'perdoar', descricao: `Conta perdoada (não será cobrada) — motivo: ${motivo}${nomeG(g)}` })
        break
      }
      case 'limite': {
        const g = await exigirGerente(c, b.pin)
        const novo = Math.trunc(Number(b.limiteCents))
        if (!Number.isInteger(novo) || novo < 0) recusa('Limite inválido.', 'limite')
        await cl.query(`UPDATE comandas SET limite_cents = $2 WHERE id = $1`, [id, novo])
        await registrar(cl, c, { comandaId: id, acao: 'limite',
          descricao: `Limite ${reaisTexto(conta.limite_cents)} → ${novo ? reaisTexto(novo) : 'sem limite'}${nomeG(g)}` })
        break
      }
      case 'menor': {
        precisaCaixa()
        const menor = !!b.menor
        await cl.query(`UPDATE comandas SET menor_de_idade = $2 WHERE id = $1`, [id, menor])
        await registrar(cl, c, { comandaId: id, acao: 'menor', descricao: menor ? 'Marcada como pulseira de MENOR (sem itens +18)' : 'Deixou de ser pulseira de menor' })
        break
      }
      case 'dados': {
        precisaCaixa()
        const nome = texto(b.nome, 120)
        if (!nome) recusa('O nome não pode ficar vazio.', 'nome')
        const obs = texto(b.observacao, 300)
        await cl.query(`UPDATE comandas SET nome = $2, observacao = $3 WHERE id = $1`, [id, nome, obs])
        await registrar(cl, c, { comandaId: id, acao: 'dados', descricao: `Dados editados: nome "${conta.nome}" → "${nome}"${obs !== conta.observacao ? ' (observação mudou)' : ''}` })
        break
      }

      /* ---------------------------------------------------------------- pulseira */
      case 'trocar_pulseira': {
        // perdeu a pulseira: bloqueia a velha e liga uma nova na MESMA conta (nada se perde)
        precisaCaixa()
        if (conta.situacao !== 'aberta') recusa('Só dá para ligar pulseira em conta aberta. Reabra a conta antes.', 'nao_aberta')
        const uid = uidLimpo(b.uid)
        if (!uid) recusa('Encoste a pulseira nova no leitor.', 'sem_pulseira')
        const perdida = b.perdida !== false
        let pu = (await cl.query(`SELECT * FROM comanda_pulseiras WHERE org_id = $1 AND uid = $2 FOR UPDATE`, [c.orgId, uid])).rows[0]
        if (!pu) {
          pu = (await cl.query(`INSERT INTO comanda_pulseiras (org_id, uid, criado_por) VALUES ($1,$2,$3) RETURNING *`, [c.orgId, uid, c.usuarioId])).rows[0]
        }
        if (pu.bloqueada || pu.descartada) recusa('A pulseira nova está bloqueada. Use outra.', 'bloqueada')
        if ((await cl.query(`SELECT 1 FROM comanda_vinculos WHERE pulseira_id = $1 AND fim_em IS NULL`, [pu.id])).rows[0]) {
          recusa('A pulseira nova já está em outra conta.', 'em_uso')
        }
        const velhas = (await cl.query(
          `SELECT v.pulseira_id, pu.uid FROM comanda_vinculos v JOIN comanda_pulseiras pu ON pu.id = v.pulseira_id
            WHERE v.comanda_id = $1 AND v.fim_em IS NULL`, [id])).rows
        await soltarPulseiras(cl, c, id, perdida ? 'perdida' : 'trocada')
        if (perdida) {
          for (const v of velhas) {
            await cl.query(`UPDATE comanda_pulseiras SET bloqueada = true, motivo = $2 WHERE id = $1`,
              [v.pulseira_id, `perdida na conta ${conta.numero}`])
          }
        }
        await cl.query(`INSERT INTO comanda_vinculos (org_id, comanda_id, pulseira_id, inicio_por) VALUES ($1,$2,$3,$4)`,
          [c.orgId, id, pu.id, c.usuarioId])
        await registrar(cl, c, { comandaId: id, acao: 'trocar_pulseira',
          descricao: velhas.length
            ? `Pulseira ${velhas.map((v: any) => v.uid).join(', ')} ${perdida ? 'PERDIDA e bloqueada' : 'trocada'}; nova pulseira ${uid}`
            : `Pulseira ${uid} ligada à conta` })
        break
      }

      default:
        recusa('Correção desconhecida.', 'acao')
    }
  })

  return {
    conta: await resumoDaComanda(c.orgId, id),
    destino: destinoId ? await resumoDaComanda(c.orgId, destinoId) : null,
  }
})

/** A conta de destino: pelo id, pelo número ou pela pulseira encostada. */
async function acharDestino(cl: PoolClient, c: ContextoDaComanda, b: Corpo, origem: string): Promise<string> {
  let id: string | null = null
  if (b.destinoId) {
    id = (await cl.query(`SELECT id FROM comandas WHERE org_id = $1 AND id::text = $2`, [c.orgId, String(b.destinoId)])).rows[0]?.id ?? null
  } else if (b.destinoNumero) {
    id = (await cl.query(`SELECT id FROM comandas WHERE org_id = $1 AND numero = $2`, [c.orgId, Number(b.destinoNumero)])).rows[0]?.id ?? null
  } else if (b.destinoUid) {
    const uid = uidLimpo(b.destinoUid)
    id = (await cl.query(
      `SELECT v.comanda_id FROM comanda_vinculos v JOIN comanda_pulseiras pu ON pu.id = v.pulseira_id
        WHERE pu.org_id = $1 AND pu.uid = $2 AND v.fim_em IS NULL`, [c.orgId, uid])).rows[0]?.comanda_id ?? null
  }
  if (!id) recusa('Conta de destino não encontrada. Encoste a pulseira dela ou digite o número.', 'destino')
  id = await contaFinal(cl, c.orgId, id!)
  if (id === origem) recusa('A conta de destino é a mesma conta.', 'mesma')
  return id
}

