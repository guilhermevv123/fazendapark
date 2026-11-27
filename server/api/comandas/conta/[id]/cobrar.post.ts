/**
 * POST /api/comandas/conta/<id>/cobrar — manda a cobrança pro WhatsApp do RESPONSÁVEL (quem
 * comprou o ingresso, ou quem confirmou o telefone na abertura).
 *
 * Nunca sai sozinho: o gerente revisa a ficha e aperta o botão. `{ enviar: false }` só monta
 * o texto (pra tela mostrar antes). A resposta traz também o link `wa.me` pra quem preferir
 * mandar do próprio celular.
 */
import { exigirNivel, reaisTexto, recusa, registrar, resumoDaComanda } from '../../../../utils/comandas'
import { enviarWhatsapp } from '../../../../utils/comandas-whatsapp'
import { q } from '../../../../utils/db'

export default defineEventHandler(async (event) => {
  const c = exigirNivel(event, 'gerente')
  const id = String(getRouterParam(event, 'id') ?? '')
  const b = (await readBody<{ enviar?: boolean; chavePix?: string }>(event)) ?? {}
  const conta = await resumoDaComanda(c.orgId, id)
  if (!conta) throw createError({ statusCode: 404, statusMessage: 'Conta não encontrada.' })
  if (!['nao_paga', 'cobrada'].includes(conta.situacao)) recusa('Só se cobra conta marcada como não paga.', 'situacao')
  if (!conta.responsavelTelefone) recusa('Esta conta não tem telefone do responsável.', 'sem_telefone')

  const itens = await q<any>(
    `SELECT i.nome, SUM(i.quantidade) AS qtd, SUM(i.preco_cents * i.quantidade - i.desconto_cents) AS total
       FROM comanda_lancamento_itens i WHERE i.comanda_id = $1 AND NOT i.cancelado GROUP BY i.nome ORDER BY i.nome`, [id])
  const data = new Date(conta.abertaEm).toLocaleDateString('pt-BR', { timeZone: 'America/Bahia' })
  const primeiro = conta.responsavelNome.trim().split(/\s+/)[0]
  const quem = conta.nome !== conta.responsavelNome ? `a conta de *${conta.nome}*, do seu grupo,` : 'a sua conta'
  const pix = String(b.chavePix ?? '').trim()
  const texto = [
    `Olá, ${primeiro}! Aqui é do *Conquista Park*.`,
    ``,
    `No dia ${data}, ${quem} no bar ficou em aberto: *${reaisTexto(conta.faltaCents)}*.`,
    ``,
    ...itens.map((i) => `• ${i.qtd}× ${i.nome} — ${reaisTexto(Number(i.total))}`),
    ``,
    pix ? `Você pode pagar por Pix: *${pix}*. Depois, é só mandar o comprovante aqui.` : `Responda esta mensagem para combinarmos o pagamento.`,
    `Obrigado!`,
  ].join('\n')
  const link = `https://wa.me/55${conta.responsavelTelefone}?text=${encodeURIComponent(texto)}`

  if (!b.enviar) return { texto, link, simulado: false, enviado: false }

  let simulado = false
  try {
    simulado = (await enviarWhatsapp(conta.responsavelTelefone, texto, `comanda-cobranca:${conta.numero}`)).simulado
  } catch {
    recusa('Não consegui mandar pelo WhatsApp do parque agora. Use o botão "Abrir no meu WhatsApp".', 'whatsapp_falhou', { link })
  }
  // só marca "cobrada" se ainda deve: o cliente pode ter pago enquanto a mensagem saía
  await q(`UPDATE comandas SET situacao = 'cobrada', cobrada_em = now(), cobrada_por = $2
            WHERE id = $1 AND org_id = $3 AND situacao IN ('nao_paga', 'cobrada')`, [id, c.usuarioId, c.orgId])
  await registrar(null, c, { comandaId: id, acao: 'cobrar',
    descricao: `Cobrança de ${reaisTexto(conta.faltaCents)} enviada no WhatsApp para ${conta.responsavelNome} (${conta.responsavelTelefone})${simulado ? ' [modo de teste]' : ''}` })
  return { texto, link, simulado, enviado: true, conta: await resumoDaComanda(c.orgId, id) }
})
