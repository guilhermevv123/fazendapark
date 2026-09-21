/**
 * POST /api/admin/evento/:id/reenviar — "não chegou, manda de novo".
 *
 * É o chamado mais comum de qualquer bilheteria, e até agora a resposta do
 * guichê era "não tem como". As três coisas que ele precisa resolver:
 *
 * 1. **O e-mail sumiu** (spam, caixa cheia, provedor engasgado) — manda de
 *    novo pro mesmo endereço.
 * 2. **O e-mail está errado** (digitado no guichê, com fila na frente) — manda
 *    pro endereço certo, informado na hora. O cadastro do comprador NÃO é
 *    alterado em silêncio: quem manda pra outro endereço fica registrado no
 *    audit_log com nome e e-mail, porque isso é entregar ingresso pago a um
 *    terceiro e precisa ter dono.
 * 3. **"Será que foi?"** — a resposta diz pra onde foi, por qual transporte, e
 *    avisa em letras claras quando o envio foi SIMULADO (sem servidor de
 *    e-mail configurado, nada saiu da máquina). Dizer "enviado" quando não
 *    saiu é pior que dizer "não tem como".
 *
 * A entrega é tentada na hora e o resultado volta na resposta — o operador
 * está com o cliente na frente e precisa saber agora. Mas a linha da fila é
 * gravada ANTES: se o servidor de e-mail estiver fora, o reenvio não se perde,
 * fica na fila e sai sozinho quando voltar.
 */
import { z } from 'zod'
import { tx } from '../../../../utils/db'
import { PEDIDO_VIVO } from '../../../../utils/liquido'
import { enderecoValido } from '../../../../utils/email'
import { enfileirar, garantirWorker, processarUm } from '../../../../utils/envio'

const Entrada = z.object({
  /** UUID ou o código legível (PED-XXXX) — o guichê tem um dos dois na mão. */
  pedido: z.string().min(4).max(80),
  /** Endereço alternativo. Vazio = o cadastro do comprador. */
  email: z.string().max(160).nullish(),
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Janela em que um envio pendente é considerado "já vai sair". Acima dela a
 * fila está entalada e o pedido do operador assume a linha parada.
 */
const ESPERA_SEGUNDOS = 60

export default defineEventHandler(async (event) => {
  const eventoId = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Informe o pedido que deve ser reenviado.',
      data: p.error.flatten(),
    })
  }
  const usuario = (event.context as any).sessao
  const chave = p.data.pedido.trim()

  // Tudo que DECIDE roda dentro de uma transação com o pedido travado.
  //
  // Antes não rodava, e a guarda de duplo clique era decorativa: a rota lia
  // "tem envio pendente?" numa consulta e gravava na seguinte, sem nada entre
  // as duas. Dois cliques simultâneos liam os dois "não tem" antes de qualquer
  // um gravar e viravam dois e-mails — MEDIDO, 2 de 2 vezes com dois pedidos
  // em paralelo, 6 de 6 com seis. O teste sequencial não via nada disso porque
  // ele mesmo cria a linha pendente antes de chamar a rota.
  //
  // A trava é o `FOR UPDATE` na linha do PEDIDO, e não uma na fila: o que
  // precisa ser um de cada vez é a decisão "este pedido já tem envio a
  // caminho?", e ela é por pedido. Quem chega segundo espera, lê a linha que o
  // primeiro acabou de gravar, e ouve "já tem um a caminho".
  //
  // A entrega fica FORA — depois do COMMIT. Dentro, a linha da fila ainda não
  // existe pras outras conexões, e `processarUm()` (que reserva por outra
  // conexão) não acharia nada pra entregar.
  const decidido = await tx(async (c) => {
    // O recorte por event_id é o que impede reenviar o pedido de outro evento
    // da mesma organização passando o id na mão. A cerca de organização já foi
    // aplicada pelo middleware de tenant; esta é a de dentro.
    const { rows: achados } = await c.query(
      `SELECT o.id, o.code, o.status, o.org_id, o.event_id,
              (${PEDIDO_VIVO('o.')}) AS vale_ingresso,
              c.name AS comprador, c.email AS comprador_email,
              (SELECT count(*)::int FROM tickets t
                WHERE t.order_id = o.id AND t.status <> 'cancelado') AS ingressos
         FROM orders o
         LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.event_id = $2 AND ${UUID.test(chave) ? 'o.id = $1' : 'upper(o.code) = upper($1)'}
        FOR UPDATE OF o`,
      [chave, eventoId])
    const pedido = achados[0]

    if (!pedido) {
      throw createError({
        statusCode: 404,
        statusMessage: `Não achei o pedido ${chave} neste evento. Confira o código.`,
      })
    }

    if (!pedido.vale_ingresso) {
      throw createError({
        statusCode: 409,
        statusMessage: `O pedido ${pedido.code} está ${pedido.status.replace(/_/g, ' ')} — ` +
          'os ingressos dele não valem mais e não podem ser reenviados.',
      })
    }
    if (!pedido.ingressos) {
      throw createError({
        statusCode: 409,
        statusMessage: `O pedido ${pedido.code} não tem ingresso emitido para enviar.`,
      })
    }

    const destino = String(p.data.email ?? '').trim() || String(pedido.comprador_email ?? '').trim()
    if (!destino) {
      throw createError({
        statusCode: 422,
        statusMessage: `O pedido ${pedido.code} não tem e-mail cadastrado. ` +
          'Peça o endereço ao cliente e informe no campo ao lado.',
      })
    }
    if (!enderecoValido(destino)) {
      throw createError({
        statusCode: 422,
        statusMessage: `"${destino}" não parece um e-mail. Confira antes de mandar.`,
      })
    }

    // Nunca deixa DOIS envios do mesmo pedido pendentes ao mesmo tempo — dois
    // pendentes é o comprador recebendo o ingresso em duplicata e ligando pra
    // perguntar se foi cobrado duas vezes.
    const { rows: pendentes } = await c.query(
      `SELECT id, to_email, extract(epoch FROM now() - created_at)::int AS ha
         FROM email_sends
        WHERE order_id = $1 AND status IN ('na_fila','enviando')
        ORDER BY created_at DESC LIMIT 1`, [pedido.id])
    const emAndamento = pendentes[0]

    // Recém-criado quer dizer que ele ainda vai sair sozinho em segundos (a
    // confirmação automática do pagamento, ou o clique anterior deste mesmo
    // operador). Aí a resposta é esperar.
    if (emAndamento && emAndamento.ha < ESPERA_SEGUNDOS) {
      throw createError({
        statusCode: 409,
        statusMessage: `Já tem um envio a caminho para ${emAndamento.to_email} ` +
          `(pedido há ${emAndamento.ha}s). Espere ele terminar antes de mandar outro.`,
      })
    }

    // Parado há mais que isso, a fila está entalada — e é exatamente por isso
    // que o cliente está reclamando. O pedido do balcão ASSUME essa linha (com
    // o destino corrigido, se houver) em vez de criar uma segunda: assim o que
    // estava preso sai agora, e não sai duas vezes depois.
    let envioId: string
    const reaproveitado = Boolean(emAndamento)
    if (emAndamento) {
      await c.query(
        `UPDATE email_sends SET to_email = $2, to_name = $3, requested_by = $4,
                available_at = now() WHERE id = $1`,
        [emAndamento.id, destino, pedido.comprador ?? null, usuario?.usuarioId ?? null])
      envioId = emAndamento.id
    } else {
      envioId = await enfileirar({
        orgId: pedido.org_id,
        eventId: pedido.event_id,
        orderId: pedido.id,
        paraEmail: destino,
        paraNome: pedido.comprador,
        origem: 'reenvio',
        pedidoPor: usuario?.usuarioId ?? null,
      }, c)
    }

    await c.query(
      `INSERT INTO audit_log (org_id, user_id, entity, entity_id, action, after)
       VALUES ($1,$2,'order',$3,'reenvio_email',$4::jsonb)`,
      [pedido.org_id, usuario?.usuarioId ?? null, pedido.id, JSON.stringify({
        envio: envioId,
        para: destino,
        trocouDestino: destino.toLowerCase() !== String(pedido.comprador_email ?? '').toLowerCase(),
        assumiuEnvioParado: reaproveitado,
        por: usuario?.email ?? null,
      })])

    return { pedido, destino, envioId, reaproveitado }
  })

  const { pedido, destino, envioId, reaproveitado } = decidido

  // Mantém a fila andando depois que esta requisição terminar — inclusive
  // para a confirmação automática que o gatilho enfileirou.
  garantirWorker()

  const r = await processarUm(`reenvio:${usuario?.email ?? 'painel'}`, envioId)

  if (!r) {
    // Outro trabalhador pegou a linha entre o INSERT e a tentativa. Não é
    // erro: o e-mail está saindo, só não por esta requisição.
    return {
      ok: true, envio: envioId, para: destino, status: 'na_fila',
      mensagem: `Reenvio de ${pedido.code} colocado na fila para ${destino}.`,
    }
  }

  if (!r.ok) {
    // A linha continua na fila (ou marcada como falha) com o erro gravado —
    // a resposta só repete o que ficou registrado.
    throw createError({
      statusCode: 502,
      statusMessage: r.status === 'na_fila'
        ? `${r.erro} Deixei na fila e vou tentar de novo sozinho.`
        : `${r.erro} Não vou tentar de novo — resolva e mande outra vez.`,
      data: { envio: envioId, status: r.status },
    })
  }

  return {
    ok: true,
    envio: envioId,
    pedido: pedido.code,
    para: destino,
    ingressos: pedido.ingressos,
    assumiuEnvioParado: reaproveitado,
    via: r.via,
    simulado: r.via === 'simulado',
    arquivo: r.arquivo ?? null,
    mensagem: r.via === 'simulado'
      ? `Modo simulado: o e-mail de ${pedido.code} foi gravado em ${r.arquivo} e NÃO saiu ` +
        'da máquina. Configure SMTP_URL no servidor para enviar de verdade.'
      : `Ingressos do pedido ${pedido.code} reenviados para ${destino}.`,
  }
})
