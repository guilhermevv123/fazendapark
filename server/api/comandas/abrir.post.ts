/**
 * POST /api/comandas/abrir — abre a conta e liga a pulseira a ela.
 *
 * Dois caminhos, e os dois terminam com um contato CONFIRMADO de quem responde pela conta:
 *
 * - `modo: 'ingresso'` + `qr` ou `codigoIngresso`: o responsável é quem COMPROU (o contato
 *   que pagou pelo Asaas). Quem usa a pulseira pode ser outra pessoa do grupo
 *   ("Acompanhante 2 de João"); a cobrança vai pro João.
 * - `modo: 'manual'` + nome/telefone (+ CPF): o código de 4 números enviado ao WhatsApp
 *   precisa voltar certo. Sem ele, só o PIN do gerente abre (e a conta fica marcada como
 *   "dados não confirmados").
 *
 * Abrir conta precisa de internet: é a confirmação do contato que segura a cobrança.
 */
import {
  configDaComanda, ctx, documentoLimpo, liberacaoDoGerente, recusa, registrar, resumoDaComanda,
  telefoneLimpo, texto, uidLimpo,
} from '../../utils/comandas'
import { acharIngresso } from '../../utils/comandas-ingresso'
import { conferirCodigo } from '../../utils/comandas-whatsapp'
import { tx } from '../../utils/db'

interface Corpo {
  uid?: string
  modo?: 'ingresso' | 'manual' | 'rapido'
  qr?: string
  codigoIngresso?: string
  nome?: string
  telefone?: string
  documento?: string
  codigo?: string
  menor?: boolean
  limiteCents?: number
  observacao?: string
  pontoId?: string
  pin?: string
}

export default defineEventHandler(async (event) => {
  const c = ctx(event)
  const b = (await readBody<Corpo>(event)) ?? {}
  const uid = uidLimpo(b.uid)
  if (!uid) recusa('Encoste a pulseira no leitor para abrir a conta.', 'sem_pulseira')
  const config = await configDaComanda(c.orgId)

  let dados: {
    nome: string; responsavelNome: string; telefone: string | null; email: string | null; documento: string | null
    origem: 'ingresso' | 'whatsapp' | 'gerente' | 'atendimento'; confirmados: boolean
    ticketId: string | null; orderId: string | null; customerId: string | null
  }

  if (b.modo === 'ingresso') {
    const t = await acharIngresso(c.orgId, { qr: b.qr, codigo: b.codigoIngresso })
    if (t.jaTemConta) {
      recusa(`Este ingresso já tem a conta ${t.jaTemConta.numero} aberta (${t.jaTemConta.nome}). Use a pulseira dela ou troque a pulseira no caixa.`, 'ingresso_ja_tem_conta')
    }
    dados = {
      nome: texto(b.nome, 120) ?? t.nomeSugerido,
      responsavelNome: t.responsavel.nome,
      telefone: telefoneLimpo(t.responsavel.telefone),
      email: t.responsavel.email ?? null,
      documento: t.responsavel.documento ?? null,
      origem: 'ingresso',
      confirmados: true,
      ticketId: t.ingresso.id,
      orderId: t.orderId,
      customerId: t.customerId,
    }
  } else if (b.modo === 'rapido') {
    // Pulseira nova no meio de um pedido (pedido do dono, 11/11/2026): a conta abre na hora,
    // só com o nome que o atendente digitou, e o pedido é gravado. O contato fica "não
    // confirmado" — o caixa completa os dados quando o cliente for pagar.
    const nome = texto(b.nome, 60)
    if (!nome || nome.length < 2) recusa('Digite o nome do cliente.', 'nome')
    dados = { nome, responsavelNome: nome, telefone: telefoneLimpo(b.telefone) ?? null, email: null, documento: null,
      origem: 'atendimento', confirmados: false, ticketId: null, orderId: null, customerId: null }
  } else {
    const nome = texto(b.nome, 120)
    const fone = telefoneLimpo(b.telefone)
    if (!nome || nome.length < 3) recusa('Digite o nome completo do cliente.', 'nome')
    if (!fone) recusa('Telefone inválido. Digite com DDD.', 'telefone')
    const doc = b.documento ? documentoLimpo(b.documento) : null
    if (b.documento && !doc) recusa('CPF inválido. São 11 números.', 'documento')
    let origem: 'whatsapp' | 'gerente' = 'whatsapp'
    let confirmados = true
    if (config.exigeCodigoWhatsapp) {
      const certo = b.codigo ? await conferirCodigo(c.orgId, fone, b.codigo) : false
      if (!certo) {
        // sem o código, só o gerente (ou o PIN dele) abre — e a conta fica marcada
        const g = b.pin || c.nivel === 'gerente' ? await liberacaoDoGerente(c, b.pin) : null
        if (!g) recusa(b.codigo ? 'Código errado ou vencido. Peça um novo.' : 'Falta o código que chegou no WhatsApp do cliente.', 'codigo')
        origem = 'gerente'
        confirmados = false
      }
    }
    dados = { nome, responsavelNome: nome, telefone: fone, email: null, documento: doc, origem, confirmados,
      ticketId: null, orderId: null, customerId: null }
  }

  const limite = Number.isInteger(b.limiteCents) && b.limiteCents! >= 0 ? b.limiteCents! : config.limitePadraoCents
  if (limite !== config.limitePadraoCents && c.nivel !== 'gerente') {
    const g = await liberacaoDoGerente(c, b.pin)
    if (!g) recusa('Só o gerente muda o limite da conta.', 'precisa_gerente')
  }

  const id = await tx(async (cl) => {
    // a pulseira: cadastrada, livre e não bloqueada. Pulseira nova no caixa/gerente é cadastrada na hora.
    let pu = (await cl.query(`SELECT * FROM comanda_pulseiras WHERE org_id = $1 AND uid = $2 FOR UPDATE`, [c.orgId, uid])).rows[0]
    if (!pu) {
      pu = (await cl.query(`INSERT INTO comanda_pulseiras (org_id, uid, criado_por) VALUES ($1,$2,$3) RETURNING *`,
        [c.orgId, uid, c.usuarioId])).rows[0]
      await registrar(cl, c, { acao: 'pulseira_cadastrada', descricao: `Pulseira ${uid} cadastrada na abertura de conta` })
    }
    if (pu.descartada) recusa('Esta pulseira foi descartada. Use outra.', 'descartada')
    if (pu.bloqueada) recusa('Esta pulseira está bloqueada. Chame o gerente.', 'bloqueada')
    const emUso = (await cl.query(`SELECT 1 FROM comanda_vinculos WHERE pulseira_id = $1 AND fim_em IS NULL`, [pu.id])).rows[0]
    if (emUso) recusa('Esta pulseira já está numa conta aberta. Encoste de novo para ver.', 'em_uso')

    const nova = (await cl.query(
      `INSERT INTO comandas (org_id, nome, responsavel_nome, responsavel_telefone, responsavel_email, responsavel_documento,
                             origem, dados_confirmados, ticket_id, order_id, customer_id, limite_cents, menor_de_idade,
                             observacao, aberta_por, aberta_no_ponto)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
               (SELECT id FROM comanda_pontos WHERE org_id = $1 AND id::text = $16))
       RETURNING id, numero`,
      [c.orgId, dados.nome, dados.responsavelNome, dados.telefone, dados.email, dados.documento, dados.origem,
        dados.confirmados, dados.ticketId, dados.orderId, dados.customerId, limite, !!b.menor,
        texto(b.observacao, 300), c.usuarioId, String(b.pontoId ?? '')])).rows[0]
    await cl.query(`INSERT INTO comanda_vinculos (org_id, comanda_id, pulseira_id, inicio_por) VALUES ($1,$2,$3,$4)`,
      [c.orgId, nova.id, pu.id, c.usuarioId])
    await registrar(cl, c, {
      comandaId: nova.id,
      acao: 'abrir',
      descricao: `Conta ${nova.numero} aberta para ${dados.nome} com a pulseira ${uid}`
        + (dados.origem === 'ingresso' ? ` — responsável ${dados.responsavelNome} (comprador do ingresso)` : '')
        + (dados.origem === 'whatsapp' ? ' — telefone confirmado pelo código no WhatsApp' : '')
        + (dados.origem === 'gerente' ? ' — ABERTA SEM CÓDIGO, liberada pelo gerente' : '')
        + (b.menor ? ' — pulseira de MENOR (sem itens +18)' : ''),
      detalhes: { uid, origem: dados.origem, limiteCents: limite },
    })
    return nova.id as string
  })

  return { conta: await resumoDaComanda(c.orgId, id) }
})
