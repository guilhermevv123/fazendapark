/**
 * POST /api/admin/payout/executar — tira o dinheiro da plataforma e manda pro
 * produtor. É a outra metade de `POST /api/admin/evento/:id/financeiro`.
 *
 * Aquela rota GRAVA o pedido com status 'solicitada' e para, de propósito: um
 * handler que chama o banco no meio do clique fica sem resposta quando o
 * gateway demora, o operador clica de novo e o produtor recebe duas vezes.
 * Só que ninguém executava a fila — o pedido ficava 'solicitada' para sempre e
 * o dinheiro nunca saía. Esta rota é quem executa.
 *
 * ## Quem pode
 *
 * Ninguém classificou `/api/admin/payout` em `utils/papeis.ts`, e isso é a
 * decisão, não o esquecimento: rota não classificada só abre pro master (ver
 * `areaDaRota`, que devolve `null` e `decidirAcesso`, que nega `null` pra todo
 * mundo menos ele). Mandar dinheiro embora é ato de dono.
 *
 * **A cerca de organização não cobre este caminho.** O `middleware/02.tenant`
 * só cerca `/api/admin/evento/:id` e `/api/admin/pedido/:id`, que têm o id na
 * URL. Aqui não tem id de recurso nenhum: a fila é escolhida pelo `org_id` da
 * SESSÃO, e ele entra em toda consulta — inclusive na reivindicação, que é
 * `WHERE id = $1 AND org_id = $2`. Sem isso, um master de uma produtora
 * executaria (e receberia) o saque de outra.
 *
 * ## A ordem, e por que ela é essa
 *
 * 1. reconcilia as linhas PRESAS (execução morta no meio, sem id de
 *    transferência) — antes de pegar fila nova, pra não empilhar dúvida;
 * 2. pega as 'solicitada', uma a uma, com reivindicação atômica;
 * 3. pergunta ao gateway pela chave de idempotência, cria só se não existir,
 *    grava o que voltou.
 *
 * Nenhuma transação fica aberta durante a conversa com o gateway. As três
 * paredes contra o pagamento duplo estão explicadas em `utils/asaas.ts`.
 */
import { z } from 'zod'
import {
  MINUTOS_DE_CARENCIA, SQL_FILA_DE_PAYOUTS, SQL_PAYOUTS_EM_VOO,
  SQL_PAYOUTS_MANUAIS, SQL_PAYOUTS_PRESOS, conferirPayoutEmVoo,
  executarPayoutReivindicado, reconciliarPayoutPreso, reivindicarPayout, transferidorAsaas,
  type ConfigAsaas, type ResultadoDoPayout, type Transferidor,
} from '../../../utils/asaas'
import { autorDaRequisicao, registrarAuditoria } from '../../../utils/auditoria'
import { db, q, q1 } from '../../../utils/db'
import { ligado } from '../../../utils/gateway-simulado'

const Entrada = z.object({
  /** quantos saques processar nesta chamada; a fila continua na próxima */
  limite: z.number().int().min(1).max(50).optional(),
  /** executar UM saque específico (o botão "tentar de novo" da tela) */
  payoutId: z.string().uuid().nullish(),
})

const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default defineEventHandler(async (event) => {
  const corpo = await readBody(event).catch(() => ({}))
  const p = Entrada.safeParse(corpo ?? {})
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const limite = p.data.limite ?? 10
  const alvo = p.data.payoutId ?? null

  const autor = autorDaRequisicao(event)
  const orgId = autor.orgId

  const org = await q1<any>(
    `SELECT asaas_api_key, asaas_env, asaas_wallet FROM organizations WHERE id = $1`, [orgId])
  const cfg: ConfigAsaas = {
    apiKey: org?.asaas_api_key, environment: org?.asaas_env, walletId: org?.asaas_wallet,
  }

  // Sem credencial não há transferência. Em produção isso é indisponibilidade e
  // a fila espera — inventar um caminho alternativo aqui seria marcar saque
  // como pago sem dinheiro nenhum ter saído. Só na máquina, com
  // PAGAMENTO_SIMULADO=1, o fluxo anda por um gateway de mentira pra a fila
  // poder ser exercitada ponta a ponta (mesma trava do checkout).
  const simulado = !cfg.apiKey && ligado()
  if (!cfg.apiKey && !simulado) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Transferência indisponível: esta organização ainda não tem o Asaas configurado. '
        + 'Cadastre a chave em Organização antes de executar a fila de saques.',
    })
  }
  const transferidor: Transferidor = simulado ? transferidorSimulado() : transferidorAsaas(cfg)

  const pool = db()
  const resultados: ResultadoDoPayout[] = []
  const reconciliados: ResultadoDoPayout[] = []
  const conferidos: ResultadoDoPayout[] = []

  // ------------------------------------------------ 1. o que ficou preso
  const presos = await q<any>(SQL_PAYOUTS_PRESOS, [orgId, MINUTOS_DE_CARENCIA, limite])
  for (const preso of presos) {
    const r = await reconciliarPayoutPreso(pool, preso, transferidor)
    reconciliados.push(r)
    await auditar(autor, r, 'reconciliada', simulado)
  }

  // ------------------------------------------- 2. o que já saiu e está em voo
  // PIX quase nunca volta DONE na primeira resposta. Sem esta passada o saque
  // ficaria 'processando' pra sempre: o dinheiro na conta do produtor e o
  // painel dizendo "em andamento".
  const emVoo = await q<any>(SQL_PAYOUTS_EM_VOO, [orgId, limite])
  for (const voando of emVoo) {
    const r = await conferirPayoutEmVoo(pool, voando, transferidor)
    conferidos.push(r)
    if (r.status !== 'processando') await auditar(autor, r, acaoDoResultado(r), simulado)
  }

  // ------------------------------------------------------- 3. a fila nova
  const fila = await q<{ id: string }>(SQL_FILA_DE_PAYOUTS, [orgId, alvo, limite])

  for (const linha of fila) {
    // A reivindicação é a trava: quem não levar a linha simplesmente não
    // executa. Nada de checar antes se está livre — a checagem resolveria o
    // caso enfileirado e esconderia a ausência da trava do próprio teste.
    const payout = await reivindicarPayout(pool, linha.id, orgId)
    if (!payout) continue

    const r = await executarPayoutReivindicado(pool, payout, transferidor)
    resultados.push(r)
    await auditar(autor, r, acaoDoResultado(r), simulado)
  }

  const manuais = await q1<any>(SQL_PAYOUTS_MANUAIS, [orgId])

  const conta = (s: ResultadoDoPayout['status']) =>
    resultados.filter((r) => r.status === s).length

  // 'processando' quer dizer duas coisas muito diferentes e só o `erro`
  // separa: COM número de transferência e sem erro, o dinheiro saiu e está no
  // trilho do banco; SEM número e com erro, o gateway não disse se saiu e a
  // linha ficou comprometida esperando resposta (ver `devolverOuFalhar`).
  // Somar as duas em "transferências enviadas (R$ …)" põe na tela um valor
  // que ninguém garante ter saído.
  const semDesfecho = resultados.filter((r) => r.status === 'processando' && r.erro)
  const enviados = resultados.filter(
    (r) => r.status === 'concluida' || (r.status === 'processando' && !r.erro))
  const enviadoCents = enviados.reduce((a, r) => a + r.valorCents, 0)

  return {
    ok: true,
    simulado,
    processados: resultados.length,
    concluidos: conta('concluida'),
    emVoo: enviados.length - conta('concluida'),
    semDesfecho: semDesfecho.length,
    semDesfechoCents: semDesfecho.reduce((a, r) => a + r.valorCents, 0),
    falhados: conta('falhou'),
    devolvidos: conta('solicitada'),
    reconciliados: reconciliados.length,
    conferidos: conferidos.length,
    /** quantos saíram do 'em voo' com desfecho nesta passada */
    desfechos: conferidos.filter((r) => r.status !== 'processando').length,
    enviadoCents,
    aguardandoManual: Number(manuais?.n ?? 0),
    aguardandoManualCents: Number(manuais?.soma ?? 0),
    resultados: [...reconciliados, ...conferidos, ...resultados],
    mensagem: mensagemDoOperador(resultados, reconciliados, conferidos, Number(manuais?.n ?? 0),
      Number(manuais?.soma ?? 0), enviadoCents),
  }
})

/** o ato como ele entra na auditoria — minúsculo e sem espaço, como manda `registrarAuditoria` */
function acaoDoResultado(r: ResultadoDoPayout): string {
  if (r.status === 'concluida') return 'transferida'
  // 'processando' com erro e sem número de transferência não é "em voo": é o
  // gateway não tendo dito se transferiu. Carimbar `em_voo` na auditoria faria
  // o registro afirmar que o dinheiro saiu, que é justamente o que não se sabe.
  if (r.status === 'processando') return r.erro && !r.transferencia ? 'sem_desfecho' : 'em_voo'
  if (r.status === 'falhou') return 'falhou'
  return 'devolvida_para_fila'
}

/**
 * Transferência sem registro de quem mandou é o pior campo pra faltar numa
 * auditoria de dinheiro — e a falha também entra: "por que o produtor não
 * recebeu" é a mesma pergunta com o sinal trocado.
 */
async function auditar(
  autor: any, r: ResultadoDoPayout, acao: string, simulado: boolean,
) {
  await registrarAuditoria({
    autor,
    entidade: 'payout',
    entidadeId: r.id,
    acao,
    depois: {
      code: r.code,
      valorCents: r.valorCents,
      transferencia: r.transferencia,
      gatewayStatus: r.gatewayStatus,
      adotada: r.adotada,
      erro: r.erro,
      simulado,
    },
  }).catch((e) => {
    // A auditoria não pode derrubar a execução: o dinheiro já saiu, e perder a
    // resposta faria a próxima execução perguntar de novo ao gateway. Some no
    // log do servidor, que é onde isso é investigado.
    console.error('[payout] falhou ao auditar', r.id, e?.message)
  })
}

/** A frase que o operador lê na tela, com o dinheiro em reais e o que falta fazer. */
function mensagemDoOperador(
  feitos: ResultadoDoPayout[], reconciliados: ResultadoDoPayout[],
  conferidos: ResultadoDoPayout[], manuais: number, manuaisCents: number, enviadoCents: number,
): string {
  const partes: string[] = []
  // "enviada" é só o que o gateway confirmou ter recebido: concluída, ou em
  // voo COM número de transferência. A linha que ficou 'processando' porque o
  // gateway não respondeu tem frase própria, abaixo — juntar as duas diria ao
  // operador que saiu um dinheiro que ninguém garante ter saído.
  const enviados = feitos.filter(
    (r) => r.status === 'concluida' || (r.status === 'processando' && !r.erro)).length

  if (enviados) {
    partes.push(`${enviados} ${enviados === 1 ? 'transferência enviada' : 'transferências enviadas'}`
      + ` (${brl(enviadoCents)}).`)
  }
  const semDesfecho = feitos.filter((r) => r.status === 'processando' && r.erro)
  if (semDesfecho.length) {
    const soma = semDesfecho.reduce((a, r) => a + r.valorCents, 0)
    partes.push(`${semDesfecho.length} ${semDesfecho.length === 1 ? 'saque' : 'saques'} `
      + `(${brl(soma)}) ${semDesfecho.length === 1 ? 'ficou' : 'ficaram'} sem resposta do gateway: `
      + 'o valor segue comprometido e vamos perguntar de novo a cada execução. '
      + 'Confira no painel do Asaas antes de liberar este saldo.')
  }
  const falhados = feitos.filter((r) => r.status === 'falhou')
  if (falhados.length) {
    partes.push(`${falhados.length} não ${falhados.length === 1 ? 'saiu' : 'saíram'}: `
      + `${falhados[0].erro ?? 'o gateway recusou'}`)
  }
  const devolvidos = feitos.filter((r) => r.status === 'solicitada').length
  if (devolvidos) {
    partes.push(`${devolvidos} ${devolvidos === 1 ? 'voltou' : 'voltaram'} para a fila e `
      + `${devolvidos === 1 ? 'será tentada' : 'serão tentadas'} de novo.`)
  }
  if (reconciliados.length) {
    partes.push(`${reconciliados.length} ${reconciliados.length === 1 ? 'saque interrompido foi conferido' : 'saques interrompidos foram conferidos'} no gateway.`)
  }
  const fechados = conferidos.filter((r) => r.status === 'concluida').length
  if (fechados) {
    partes.push(`${fechados} ${fechados === 1 ? 'transferência anterior caiu' : 'transferências anteriores caíram'} na conta do beneficiário.`)
  }
  const devolvidasPeloBanco = conferidos.filter((r) => r.status === 'falhou').length
  if (devolvidasPeloBanco) {
    partes.push(`${devolvidasPeloBanco} ${devolvidasPeloBanco === 1 ? 'transferência voltou' : 'transferências voltaram'} do banco: `
      + `${conferidos.find((r) => r.status === 'falhou')?.erro ?? 'confira o destino cadastrado'}`)
  }
  const aindaEmVoo = conferidos.filter((r) => r.status === 'processando').length
  if (aindaEmVoo) {
    partes.push(`${aindaEmVoo} ${aindaEmVoo === 1 ? 'transferência segue' : 'transferências seguem'} em processamento no banco.`)
  }
  if (manuais) {
    partes.push(`${manuais} ${manuais === 1 ? 'saque' : 'saques'} para conta bancária `
      + `(${brl(manuaisCents)}) ${manuais === 1 ? 'aguarda' : 'aguardam'} transferência manual: `
      + 'o cadastro guarda o banco como texto livre.')
  }
  return partes.length ? partes.join(' ') : 'Nenhum saque pendente para executar.'
}

/**
 * Gateway de mentira, com a MESMA forma do verdadeiro — inclusive a busca pela
 * chave de idempotência, que é o que o executor usa pra não pagar duas vezes.
 * Guardado por `ligado()`: nunca em produção, e só com PAGAMENTO_SIMULADO=1.
 * O id nasce com prefixo `sim_trf_`, então dá pra varrer o banco e provar que
 * nenhuma transferência de verdade passou por aqui.
 */
function transferidorSimulado(): Transferidor {
  return {
    async achar(chave: string) {
      const linha = await q1<any>(
        `SELECT asaas_transfer_id FROM payouts
          WHERE idempotency_key = $1 AND asaas_transfer_id IS NOT NULL`, [chave])
      return linha?.asaas_transfer_id
        ? { id: linha.asaas_transfer_id, status: 'DONE', externalReference: chave }
        : null
    },
    async criar(corpo) {
      return {
        id: `sim_trf_${corpo.externalReference.replace('payout_', '')}`,
        status: 'DONE',
        value: corpo.value,
        externalReference: corpo.externalReference,
      }
    },
    async conferir(id: string) {
      return { id, status: 'DONE' }
    },
  }
}
