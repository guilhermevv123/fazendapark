/**
 * cancelamento.ts — o dia em que o evento não acontece.
 *
 * Chuva forte no parque, show cancelado, data que mudou. Os status
 * 'cancelado' e 'adiado' estavam no CHECK de events desde a migração 001 e
 * nenhum fluxo usava: o operador trocava o status na mão, o ingresso continuava
 * passando no leitor da portaria e o dinheiro continuava parado. É por causa
 * deste dia que o dinheiro fica retido até 2 dias depois do evento
 * (`utils/retencao.ts`) — mas o "devolver" nunca tinha sido escrito.
 *
 * ## Por que fila, e não um laço dentro do handler
 *
 * Um evento de parque tem milhares de pedidos pagos. Um laço chamando o
 * gateway pedido a pedido dentro da requisição estoura o prazo de qualquer
 * proxy, e a queda no meio é pior do que não ter começado: ninguém sabe onde
 * parou nem quem já recebeu. Aqui o cancelamento grava a INTENÇÃO — uma linha
 * por pedido, num `INSERT ... SELECT` só, dentro da mesma transação que muda o
 * evento — e devolve. Quem conversa com o banco do cliente é o trabalhador de
 * fundo, uma linha por vez, com nova tentativa e espera crescente.
 *
 * ## Estornar duas vezes não pode devolver em dobro
 *
 * Três camadas, porque nenhuma sozinha basta:
 *
 * 1. **`UNIQUE (order_id)` na fila.** Cancelar o evento duas vezes (ou cancelar
 *    o evento depois de o comprador já ter desistido) não cria a segunda linha.
 * 2. **A reserva atômica** (`SQL_RESERVA_ESTORNO`): `UPDATE ... WHERE id =
 *    (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`. Dois trabalhadores no ar
 *    é o caso normal, e ler com SELECT pra marcar depois deixa os dois lerem a
 *    MESMA linha antes de qualquer um marcar.
 * 3. **O `UPDATE` condicional em `orders`** (`SQL_MARCA_PEDIDO_ESTORNADO`). É a
 *    camada que protege contra o outro caminho: o estorno que a gente pede
 *    volta do Asaas como `PAYMENT_REFUNDED`, e o webhook grava o mesmo dinheiro
 *    em `refunded_cents`. Como aqui o valor é SOMADO (a fila devolve o que
 *    faltava, não o total — pedido com estorno parcial de R$ 20 já tem R$ 20
 *    em `refunded_cents`), sem a condição os dois caminhos somariam o mesmo
 *    dinheiro duas vezes e o líquido do produtor ficaria negativo sozinho.
 *
 * ## O pedido só vira 'estornado' quando o dinheiro SAI
 *
 * Enquanto a linha está na fila, o pedido segue 'pago' — que é a verdade: o
 * dinheiro ainda está na plataforma. O INGRESSO, esse sim, morre na hora do
 * cancelamento: quem não pode entrar não pode entrar enquanto o estorno anda.
 *
 * ## A janela do arrependimento (CDC art. 49)
 *
 * Compra a distância dá 7 dias de arrependimento. Em bilheteria o mercado lê
 * isso junto com a antecedência: vale enquanto faltarem mais de 7 dias pro
 * evento — depois disso o ingresso devolvido não tem mais como ser revendido.
 * É a reclamação nº 1 contra ticketeira no Procon, e a plataforma não tinha o
 * caminho. Compra no BALCÃO não é compra a distância e não entra: a pessoa viu
 * o que levou, ali, com o produto na mão.
 */
import type { Pool, PoolClient } from 'pg'
import { db, q, q1 } from './db'
import { PEDIDO_VIVO } from './liquido'
import { buscarCobranca, estornar, valorEstornadoCents, type ConfigAsaas } from './asaas'

/** Conexão OU pool: a reserva é um comando só e roda bem nos dois. */
type Executor = Pool | PoolClient

/* ------------------------------------------------------------- vocabulário */

export type MotivoDoEstorno = 'evento_cancelado' | 'evento_adiado' | 'arrependimento'
export type StatusDoEstorno = 'na_fila' | 'estornando' | 'estornado' | 'na_mao' | 'falhou'

export interface LinhaEstorno {
  id: string
  org_id: string
  event_id: string
  order_id: string
  cancellation_id: string | null
  reason: MotivoDoEstorno
  amount_cents: number
  asaas_payment_id: string | null
  status: StatusDoEstorno
  attempts: number
  max_attempts: number
  /** recibo do gateway. Preenchido = o dinheiro JÁ saiu por esta linha. */
  gateway_refund_id: string | null
  /** quanto o gateway confirmou que devolveu. > 0 = o dinheiro JÁ saiu. */
  refunded_cents: number
}

const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

/* --------------------------------------------- a janela do arrependimento */

/** CDC art. 49: sete dias corridos a contar da compra. */
export const DIAS_DE_ARREPENDIMENTO = 7

/**
 * Antecedência mínima do evento pra desistência valer. Mesma conta de 7 dias,
 * por outro motivo: com o evento em cima, o lugar devolvido não é mais
 * revendável e a devolução vira prejuízo puro do produtor.
 */
export const DIAS_DE_ANTECEDENCIA = 7

const DIA_MS = 86_400_000

export interface PedidoParaArrependimento {
  canal: string
  status: string
  compradoEm: Date | string | null
  eventoComecaEm: Date | string
  /** quanto ainda há pra devolver; zero (cortesia) não tem arrependimento */
  aDevolverCents: number
}

export interface VeredictoArrependimento {
  disponivel: boolean
  /** escrito pro comprador, não pro log: por que pode, ou por que não pode */
  motivo: string
  /** até quando a janela fica aberta, quando ela existe */
  prazoAte: Date | null
}

/**
 * Pode desistir da compra e receber o dinheiro de volta?
 *
 * Puro de propósito: a tela precisa dizer ANTES do clique por que está ou não
 * disponível, e a rota precisa recusar com a MESMA frase. Quando essa regra
 * mora dentro da rota, a tela copia — e a cópia envelhece.
 */
export function avaliarArrependimento(
  p: PedidoParaArrependimento, agora = new Date(),
): VeredictoArrependimento {
  const inicio = new Date(p.eventoComecaEm)
  const compra = p.compradoEm ? new Date(p.compradoEm) : null
  const prazoAte = compra ? new Date(compra.getTime() + DIAS_DE_ARREPENDIMENTO * DIA_MS) : null

  if (p.status !== 'pago' && p.status !== 'estornado_parcial') {
    return {
      disponivel: false, prazoAte,
      motivo: p.status === 'estornado' || p.status === 'cancelado'
        ? 'Esta compra já foi cancelada.'
        : `Esta compra está como "${p.status}" e não há o que devolver.`,
    }
  }

  if (p.aDevolverCents <= 0) {
    return {
      disponivel: false, prazoAte,
      motivo: 'Esta compra não tem valor a devolver (cortesia ou já estornada por inteiro).',
    }
  }

  // Compra no guichê não é compra a distância: a pessoa escolheu com o
  // produto na frente dela. O art. 49 não alcança, e prometer que alcança na
  // tela é pior do que não oferecer.
  if (p.canal !== 'online') {
    return {
      disponivel: false, prazoAte,
      motivo: 'A desistência em 7 dias vale para compra pela internet. '
        + 'Esta foi feita presencialmente — procure a bilheteria do evento.',
    }
  }

  if (prazoAte && agora.getTime() > prazoAte.getTime()) {
    return {
      disponivel: false, prazoAte,
      motivo: `O prazo de arrependimento é de ${DIAS_DE_ARREPENDIMENTO} dias a contar da compra `
        + `e terminou em ${prazoAte.toLocaleDateString('pt-BR')}.`,
    }
  }

  const faltamDias = (inicio.getTime() - agora.getTime()) / DIA_MS
  if (faltamDias <= DIAS_DE_ANTECEDENCIA) {
    return {
      disponivel: false, prazoAte,
      motivo: faltamDias <= 0
        ? 'O evento já começou — não há mais desistência.'
        : `A desistência vale até ${DIAS_DE_ANTECEDENCIA} dias antes do evento, `
          + `e ele começa em ${Math.ceil(faltamDias)} dia(s).`,
    }
  }

  return {
    disponivel: true, prazoAte,
    motivo: `Compra pela internet dentro dos ${DIAS_DE_ARREPENDIMENTO} dias de arrependimento`
      + (prazoAte ? ` (até ${prazoAte.toLocaleDateString('pt-BR')})` : '')
      + ` e com mais de ${DIAS_DE_ANTECEDENCIA} dias para o evento.`,
  }
}

/* --------------------------------------------------------- travas em SQL */

/**
 * Trava a linha do evento. Duas pessoas cancelando o mesmo evento ao mesmo
 * tempo é raro, mas cancelar e adiar ao mesmo tempo produz um evento que está
 * nos dois estados — e os ingressos seguem a decisão de quem escreveu por
 * último enquanto o dinheiro segue a do outro.
 */
export const SQL_TRAVA_EVENTO = `
  SELECT id, org_id, name, status, starts_at, ends_at, postponed_from, choice_deadline
    FROM events WHERE id = $1 FOR UPDATE`

/**
 * A virada do evento pra cancelado, em UMA instrução condicional.
 *
 * `status <> 'cancelado'` é a trava: o segundo disparo devolve zero linhas e
 * quem chama sabe que não foi ele que cancelou, sem ter lido nada antes.
 */
export const SQL_CANCELA_EVENTO = `
  UPDATE events
     SET status = 'cancelado', canceled_at = now(), cancel_reason = $2, updated_at = now()
   WHERE id = $1 AND status <> 'cancelado'
   RETURNING id, status`

/**
 * Adia: data nova, situação 'adiado', a data velha guardada e o prazo da
 * escolha do comprador aberto.
 *
 * `postponed_from` só é escrito na PRIMEIRA vez (COALESCE): num segundo
 * adiamento o que interessa continua sendo a data que a pessoa comprou.
 * Evento já cancelado não se remarca — ressuscitar um evento cancelado
 * devolveria validade a ingresso que já foi estornado.
 */
export const SQL_ADIA_EVENTO = `
  UPDATE events
     SET status = 'adiado',
         postponed_from = COALESCE(postponed_from, starts_at),
         starts_at = $2, ends_at = $3,
         choice_deadline = $4,
         cancel_reason = $5,
         updated_at = now()
   WHERE id = $1 AND status <> 'cancelado'
   RETURNING id, status, starts_at, ends_at, postponed_from, choice_deadline`

/**
 * As sessões andam junto com o evento, pelo MESMO deslocamento.
 *
 * Sem isto, adiar o evento do parque em duas semanas deixa as sessões diárias
 * na data velha: o ingresso "vale na data nova" no cabeçalho e continua
 * amarrado à sessão do dia que não vai existir — e o leitor da portaria recusa
 * com "fora da sessão" no dia certo.
 */
export const SQL_DESLOCA_SESSOES = `
  UPDATE event_sessions
     SET starts_at = starts_at + $2::interval,
         ends_at   = ends_at   + $2::interval
   WHERE event_id = $1
   RETURNING id`

/** Ingresso de evento cancelado morre. 'usado' não é tocado: a pessoa entrou. */
export const SQL_MATA_INGRESSOS_DO_EVENTO = `
  UPDATE tickets SET status = 'cancelado', canceled_at = now()
   WHERE event_id = $1 AND status = 'valido'
   RETURNING id`

/** O mesmo, para um pedido só (desistência do comprador). */
export const SQL_MATA_INGRESSOS_DO_PEDIDO = `
  UPDATE tickets SET status = 'cancelado', canceled_at = now()
   WHERE order_id = $1 AND status = 'valido'
   RETURNING id`

/**
 * A varredura que enche a fila: UMA instrução para milhares de pedidos.
 *
 * Quatro coisas dentro dela:
 *  • `PEDIDO_VIVO()` no recorte — nunca `status = 'pago'`: o pedido com
 *    estorno parcial ainda tem dinheiro a devolver, e um `WHERE status =
 *    'pago'` o deixaria de fora em silêncio (ver utils/liquido.ts).
 *  • o valor é `total − já devolvido`, não o total: devolver o total de um
 *    pedido que já teve R$ 20 estornados manda R$ 20 a mais do que entrou.
 *  • `total_cents > refunded_cents` — cortesia e pedido já devolvido por
 *    inteiro não entram na lista de quem tem dinheiro a receber.
 *  • `ON CONFLICT DO NOTHING` sobre `UNIQUE (order_id)` — cancelar duas vezes
 *    não cria a segunda linha, e é isso que impede a devolução em dobro.
 */
export const SQL_ENFILEIRA_ESTORNO_DO_EVENTO = `
  INSERT INTO refund_jobs (org_id, event_id, order_id, cancellation_id, reason,
                           amount_cents, asaas_payment_id, requested_by)
  SELECT o.org_id, o.event_id, o.id, $2, $3,
         o.total_cents - o.refunded_cents, o.asaas_payment_id, $4
    FROM orders o
   WHERE o.event_id = $1
     AND ${PEDIDO_VIVO('o.')}
     AND o.total_cents > o.refunded_cents
  ON CONFLICT (order_id) DO NOTHING
  RETURNING id, amount_cents`

/** A mesma linha, para um pedido só. */
export const SQL_ENFILEIRA_ESTORNO_DE_UM_PEDIDO = `
  INSERT INTO refund_jobs (org_id, event_id, order_id, cancellation_id, reason,
                           amount_cents, asaas_payment_id, requested_by)
  SELECT o.org_id, o.event_id, o.id, $3, $2,
         o.total_cents - o.refunded_cents, o.asaas_payment_id, $4
    FROM orders o
   WHERE o.id = $1
     AND ${PEDIDO_VIVO('o.')}
     AND o.total_cents > o.refunded_cents
  ON CONFLICT (order_id) DO NOTHING
  RETURNING id, amount_cents`

/**
 * A reserva atômica da fila. Exportada porque o teste de concorrência precisa
 * rodar EXATAMENTE este comando — um teste que reimplementa a reserva prova a
 * cópia dele, não a que roda em produção.
 *
 * $1 = quem está reservando, $2 = um id específico ou NULL pro próximo da fila.
 *
 *  • `status = 'na_fila' AND available_at <= now()` respeita a espera de quem
 *    falhou e ainda está de castigo;
 *  • **pedido por id fura a espera**: o financeiro apertando "tentar de novo"
 *    está com o cliente na linha;
 *  • `status = 'estornando' AND claimed_at < now() - 5 min` resgata a linha que
 *    ficou presa porque o processo morreu no meio — sem isso um kill -9 come o
 *    estorno pra sempre. A carência vale TAMBÉM no pedido por id: furar ela
 *    aqui seria o financeiro clicando em cima de uma execução viva, que é
 *    exatamente o jeito de mandar o dinheiro duas vezes;
 *  • **`status = 'falhou'` só pelo id.** Este ramo faltava, e sem ele o
 *    comentário acima era mentira: quem estourou `max_attempts` virava
 *    'falhou' e nenhum "tentar de novo" alcançava a linha — o botão respondia
 *    "nada a fazer" e o dinheiro do comprador ficava preso pra sempre, com a
 *    linha parada na tela dizendo o erro de ontem. A reserva por id é a única
 *    porta: ela não entra na varredura automática (que continua só em
 *    'na_fila' e no resgate dos 5 minutos), então um erro permanente não vira
 *    laço infinito contra o gateway.
 *  • `SKIP LOCKED` faz o segundo trabalhador pegar OUTRA linha em vez de
 *    esperar por esta.
 */
export const SQL_RESERVA_ESTORNO = `
  UPDATE refund_jobs SET
    status = 'estornando',
    attempts = attempts + 1,
    claimed_at = now(),
    claimed_by = $1
  WHERE id = (
    SELECT id FROM refund_jobs
     WHERE ($2::uuid IS NULL OR id = $2::uuid)
       AND ( (status = 'na_fila' AND (available_at <= now() OR $2::uuid IS NOT NULL))
          OR (status = 'estornando' AND claimed_at < now() - interval '5 minutes')
          OR (status = 'falhou' AND $2::uuid IS NOT NULL) )
     ORDER BY available_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  RETURNING *`

/**
 * O dinheiro entrando na conta do pedido. **A trava está no `WHERE`.**
 *
 * `refunded_cents` é SOMADO porque a fila devolve o que faltava, não o total:
 * um pedido com estorno parcial de R$ 20 já carrega esses R$ 20. E por ser
 * soma, a condição de status é a única coisa entre o sistema e a devolução em
 * dobro — o webhook do Asaas grava ESTE MESMO estorno quando ele volta como
 * PAYMENT_REFUNDED, e sem `status IN ('pago','estornado_parcial')` os dois
 * caminhos somam o mesmo dinheiro duas vezes. O líquido do produtor fica
 * negativo sozinho, e ninguém consegue explicar de onde saiu.
 *
 * Zero linhas de volta não é erro: quer dizer que o outro caminho chegou
 * primeiro e o dinheiro já está contado.
 */
export const SQL_MARCA_PEDIDO_ESTORNADO = `
  UPDATE orders
     SET status = 'estornado',
         refunded_at = now(),
         canceled_at = COALESCE(canceled_at, now()),
         refunded_cents = refunded_cents + $2
   WHERE id = $1 AND status IN ('pago','estornado_parcial')
   RETURNING id, refunded_cents, total_cents`

/* ------------------------------------------------ estoque de volta */

/**
 * Devolve à prateleira o que um pedido segurava, e o uso do cupom junto.
 *
 * Só faz sentido quando o EVENTO continua de pé (desistência do comprador,
 * escolha por reembolso num adiamento): o lugar volta a ser vendável. No
 * evento cancelado o estoque é deixado como está de propósito — ninguém vai
 * vender de novo, e zerar `sold` apagaria do relatório quanto tinha sido
 * vendido até a hora do cancelamento.
 *
 * Ordem determinística por `lot_id` pelo mesmo motivo da reserva: dois
 * cancelamentos pegando os mesmos dois lotes em ordens opostas travam um no
 * outro pra sempre.
 */
export async function devolverEstoqueDoPedido(c: PoolClient, orderId: string): Promise<void> {
  const { rows: itens } = await c.query(
    `SELECT lot_id, ticket_type_id, quantity
       FROM order_items WHERE order_id = $1 ORDER BY lot_id`, [orderId])

  for (const i of itens) {
    // GREATEST porque estoque é contagem, não histórico: se um caminho antigo
    // já tiver devolvido, parar no zero é melhor que ficar negativo e quebrar
    // o CHECK do lote pra todo mundo que vender depois.
    await c.query(`UPDATE lots SET sold = GREATEST(sold - $2, 0) WHERE id = $1`,
      [i.lot_id, i.quantity])
    if (i.ticket_type_id) {
      await c.query(`UPDATE ticket_types SET sold = GREATEST(sold - $2, 0) WHERE id = $1`,
        [i.ticket_type_id, i.quantity])
    }
  }

  // cupom usado numa compra desfeita não foi usado
  await c.query(
    `UPDATE promo_codes SET uses = GREATEST(uses - 1, 0)
      WHERE id = (SELECT promo_code_id FROM orders WHERE id = $1)`, [orderId])
}

/* ----------------------------------------------------------- o estornador */

export interface PedidoDeEstorno {
  jobId: string
  orgId: string
  orderId: string
  paymentId: string
  valorCents: number
  tentativa: number
}

/** O que o trabalhador chama pra mandar o dinheiro de volta. */
export type Estornador = (p: PedidoDeEstorno) => Promise<{ id?: string | null }>

/** O que o gateway já devolveu DESTA cobrança, somando tudo que não foi cancelado. */
export interface ConferenciaDeEstorno {
  devolvidoCents: number
  reciboId: string | null
}

/**
 * A pergunta "este estorno já saiu?" — a parede que falta quando o recibo não
 * pôde ser gravado. Lançar é a resposta "não dá pra saber", e quem chama trata
 * como "não mande de novo" (ver `processarUmEstorno`).
 */
export type Conferidor = (p: PedidoDeEstorno) => Promise<ConferenciaDeEstorno>

let estornadorInjetado: Estornador | null = null
let conferidorInjetado: Conferidor | null = null

/**
 * Troca o estornador em tempo de execução. Existe por dois motivos: o teste
 * precisa de um que FALHA de propósito (pra exercitar a nova tentativa), e
 * trocar o Asaas por um segundo provedor depois não pode exigir mexer na fila.
 *
 * O segundo parâmetro troca junto a CONFERÊNCIA (o "já saiu?"), porque os dois
 * falam com o mesmo gateway e trocar um sem o outro deixaria a parede olhando
 * pro provedor errado. Omitir volta pro conferidor de verdade.
 */
export function usarEstornador(e: Estornador | null, c: Conferidor | null = null) {
  estornadorInjetado = e
  conferidorInjetado = c
}

/** A configuração do Asaas da organização do pedido, ou o erro que diz o que fazer. */
async function configDaOrg(orgId: string): Promise<ConfigAsaas> {
  const org = await q1<any>(
    `SELECT asaas_api_key, asaas_env, asaas_wallet FROM organizations WHERE id = $1`, [orgId])
  const cfg: ConfigAsaas = {
    apiKey: org?.asaas_api_key, environment: org?.asaas_env, walletId: org?.asaas_wallet,
  }
  if (!cfg.apiKey) {
    throw new Error('esta organização está sem o Asaas configurado — '
      + 'cadastre a chave em Configurações da organização e mande tentar de novo')
  }
  return cfg
}

/** O estornador de verdade: a chave do Asaas é a da organização do pedido. */
const estornarNoAsaas: Estornador = async (p) => {
  // Cobrança de mentira (gateway simulado, PAGAMENTO_SIMULADO=1) não tem o que
  // estornar — e o prefixo `sim_` é justamente o que deixa isso auditável.
  if (p.paymentId.startsWith('sim_')) return { id: `sim_refund_${p.orderId}` }

  const r: any = await estornar(await configDaOrg(p.orgId), p.paymentId, p.valorCents)
  return { id: r?.id ?? null }
}

/**
 * Quanto o gateway já devolveu desta cobrança — a pergunta antes de mandar de
 * novo. A cobrança carrega `refundedValue` (acumulado) e a lista `refunds[]`;
 * `valorEstornadoCents` já sabe ler as duas formas, inclusive descartando o
 * estorno CANCELADO.
 */
const conferirNoAsaas: Conferidor = async (p) => {
  if (p.paymentId.startsWith('sim_')) return { devolvidoCents: 0, reciboId: null }

  const cobranca: any = await buscarCobranca(await configDaOrg(p.orgId), p.paymentId)
  const lista = Array.isArray(cobranca?.refunds) ? cobranca.refunds : []
  const ultimo = [...lista].reverse()
    .find((r: any) => String(r?.status ?? '').toUpperCase() !== 'CANCELLED')
  return {
    devolvidoCents: valorEstornadoCents(cobranca) ?? 0,
    reciboId: ultimo?.id ? String(ultimo.id) : null,
  }
}

const estornarAgora = (p: PedidoDeEstorno) => (estornadorInjetado ?? estornarNoAsaas)(p)
const conferirAgora = (p: PedidoDeEstorno) => (conferidorInjetado ?? conferirNoAsaas)(p)

/* ------------------------------------------------------------- processar */

export interface ResultadoEstorno {
  id: string
  ok: boolean
  status: StatusDoEstorno
  pedidoId: string
  valorCents: number
  tentativa: number
  /** o outro caminho (webhook) já tinha contado este dinheiro */
  jaContado?: boolean
  /** o dinheiro já tinha saído numa tentativa anterior: nada foi mandado agora */
  adotado?: boolean
  erro?: string
}

export async function reservarProximoEstorno(
  exec: Executor, trabalhador: string, id?: string | null,
): Promise<LinhaEstorno | null> {
  const r = await exec.query(SQL_RESERVA_ESTORNO, [trabalhador, id ?? null])
  return (r.rows[0] as LinhaEstorno) ?? null
}

/** 30 s, 1 min, 2 min, 4 min… com teto de 1 h. */
export function esperaSegundos(tentativa: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, tentativa - 1))
}

/**
 * Pega UMA linha da fila e leva até o fim. `null` quando não havia nada a
 * fazer — é assim que o laço sabe parar.
 *
 * A reserva é comando próprio, FORA de transação longa, de propósito: manter a
 * linha travada durante a conversa com o gateway prenderia uma conexão do pool
 * pelo tempo do timeout do outro lado, e numa devolução de milhares de pedidos
 * isso é o pool inteiro.
 *
 * A ordem é gateway primeiro, banco depois. Se fosse o contrário e o processo
 * morresse no meio, o pedido ficaria marcado como estornado sem o dinheiro ter
 * saído — e a falta só apareceria no extrato do comprador, semanas depois.
 * Do jeito que está, a falha possível é a oposta: dinheiro devolvido e linha
 * ainda 'estornando', que o resgate de 5 minutos reprocessa e o `WHERE` de
 * `SQL_MARCA_PEDIDO_ESTORNADO` impede de contar duas vezes.
 *
 * ## A parte que o `WHERE` NÃO segurava: o gateway chamado duas vezes
 *
 * `SQL_MARCA_PEDIDO_ESTORNADO` impede o dinheiro de ser CONTADO duas vezes no
 * pedido. Não impede o dinheiro de SAIR duas vezes. Enquanto a chamada ao
 * gateway e a gravação estiveram dentro do mesmo `try`, uma falha na gravação
 * (pool cheio, banco fora, lock preso) era tratada como falha do gateway: a
 * linha voltava pra fila e a tentativa seguinte chamava `estornar()` de novo,
 * com o dinheiro da primeira já na conta do comprador. Devolução em dobro, de
 * verdade, sem nada vermelho em lugar nenhum. A API de estorno do Asaas não
 * tem chave de idempotência — quem tem que lembrar somos nós.
 *
 * Três paredes, e cada uma cobre o buraco da anterior:
 *
 * 1. **O recibo é gravado ANTES do resto**, numa transação minúscula que só
 *    toca `refund_jobs` (`anotarRecibo`). Ela não encosta em `orders`, então
 *    não espera lock de ninguém: é a escrita com a maior chance de passar
 *    quando o resto já está engasgando.
 * 2. **Recibo na linha = não chama o gateway.** A retentativa vê
 *    `gateway_refund_id`/`refunded_cents` e vai direto fechar o registro.
 * 3. **Sem recibo, mas com tentativa anterior, PERGUNTA antes de mandar.** É a
 *    mesma regra da fila de saque (`executarPayoutReivindicado`): sem um "não
 *    existe" claro do gateway, não se cria. Se a pergunta não puder ser feita,
 *    a linha volta pra fila com o erro escrito — nunca um segundo estorno no
 *    escuro.
 *
 * E a falha na gravação parou de ser tratada como falha do gateway: quando o
 * dinheiro saiu, a linha NÃO volta pra fila. Fica 'estornando' com o recibo, e
 * o resgate dos 5 minutos volta pra fechar só o registro.
 */
export async function processarUmEstorno(
  trabalhador = 'padrao', id?: string | null,
): Promise<ResultadoEstorno | null> {
  const linha = await reservarProximoEstorno(db(), trabalhador, id)
  if (!linha) return null

  // ------------------------------------------- quanto FALTA agora, não ontem
  //
  // `amount_cents` é uma FOTO do minuto do cancelamento, e a fila anda depois
  // — um evento de parque leva minutos pra drenar. Se um estorno parcial cair
  // nesse meio tempo (o comprador tinha pedido antes, o webhook do Asaas
  // registra agora), a foto ficou velha: o pedido continua em `PEDIDO_VIVO()`,
  // o `WHERE status IN ('pago','estornado_parcial')` de
  // `SQL_MARCA_PEDIDO_ESTORNADO` casa, e a soma devolveria o valor cheio por
  // cima do que já tinha voltado. Medido: pedido de R$ 1.000 com R$ 200 já
  // estornados terminava com R$ 1.200 devolvidos — a plataforma pedindo ao
  // banco R$ 200 a mais do que deve, e o líquido do produtor
  // (`total − platform − refunded`) negativo sozinho. Não existe CHECK no
  // banco segurando isso.
  //
  // A leitura é aqui e não dentro da transação de `gravarDevolucao` de
  // propósito: quem precisa do número certo é a CHAMADA AO GATEWAY, que
  // acontece antes dela.
  const agora = await q1<{ total_cents: string; refunded_cents: string }>(
    `SELECT total_cents, refunded_cents FROM orders WHERE id = $1`, [linha.order_id])
  const jaNoPedido = agora ? Number(agora.refunded_cents) : 0
  const falta = agora ? Number(agora.total_cents) - jaNoPedido : Number(linha.amount_cents)
  const valor = Math.max(0, Math.min(Number(linha.amount_cents), falta))

  const pedidoDeEstorno: PedidoDeEstorno = {
    jobId: linha.id, orgId: linha.org_id, orderId: linha.order_id,
    paymentId: linha.asaas_payment_id ?? '', valorCents: valor, tentativa: linha.attempts,
  }

  // ------------------------------- parede 2: o dinheiro já saiu por esta linha
  // Recibo gravado (ou valor confirmado) numa tentativa anterior que não
  // conseguiu fechar o registro. Chamar o gateway aqui é devolver em dobro.
  const reciboGuardado = linha.gateway_refund_id
  const confirmadoAntes = Number(linha.refunded_cents) || 0
  if (reciboGuardado || confirmadoAntes > 0) {
    return await fecharLinha(linha, confirmadoAntes || valor, reciboGuardado, 'estornado', true)
  }

  // Já voltou tudo por outra porta (webhook, estorno manual no painel do
  // Asaas). A linha fecha sem conversar com o gateway: mandar um estorno de
  // zero é um erro do outro lado, e insistir é girar em brasa.
  if (valor <= 0) {
    const r = await fecharLinha(linha, 0, null, 'estornado', false)
    return { ...r, jaContado: true }
  }

  // ---------------------------------------- dinheiro que não passou por aqui
  // Venda em espécie no guichê, pix na chave do próprio produtor: a plataforma
  // não tem de onde tirar pra mandar de novo (ver utils/liquido.ts). A linha
  // continua na lista com o nome certo — quem devolve é o produtor, na mão.
  if (!linha.asaas_payment_id) {
    return await fecharLinha(linha, valor, null, 'na_mao', false)
  }

  // ------------------------- parede 3: retentativa PERGUNTA antes de mandar
  // `attempts` é somado pela própria reserva, então `> 1` quer dizer "esta
  // linha já esteve na mão de alguém". É o único caso em que o dinheiro pode
  // ter saído sem ter sobrado registro — e é a janela inteira da devolução em
  // dobro. Sem uma resposta do gateway, não se manda de novo.
  if (linha.attempts > 1) {
    let conferido: ConferenciaDeEstorno
    try {
      conferido = await conferirAgora(pedidoDeEstorno)
    } catch (e: any) {
      return await devolverAFila(linha, valor,
        `Não consegui confirmar no gateway se a devolução de ${brl(valor)} já saiu, `
        + `e por isso NÃO mandei de novo: ${e?.message ?? e}`)
    }
    if (conferido.devolvidoCents >= jaNoPedido + valor) {
      return await fecharLinha(linha, valor, conferido.reciboId, 'estornado', true)
    }
  }

  let recibo: { id?: string | null }
  try {
    recibo = await estornarAgora(pedidoDeEstorno)
  } catch (e: any) {
    return await devolverAFila(linha, valor, legivel(e, valor))
  }

  // ------------------------------------------------ o dinheiro SAIU. Daqui
  // pra baixo nada volta pra fila: o que falta é registro, não devolução.
  await anotarRecibo(linha.id, recibo?.id ?? null, valor).catch(() => {})
  return await fecharLinha(linha, valor, recibo?.id ?? null, 'estornado', false)
}

/**
 * Parede 1: o recibo entra na linha ANTES de qualquer coisa que possa demorar.
 *
 * Transação de um comando só, e só em `refund_jobs`. Não encosta em `orders`
 * de propósito — é justamente o lock dessa tabela que pode estar preso quando
 * a gravação grande falha. `COALESCE` porque recibo não se reescreve.
 *
 * `refunded_cents` entra junto e vale como marca mesmo quando o gateway
 * responde sem id: "o gateway confirmou que devolveu tanto" é o que a
 * retentativa precisa saber pra não mandar de novo.
 */
async function anotarRecibo(jobId: string, reciboId: string | null, valor: number) {
  await q(
    `UPDATE refund_jobs
        SET gateway_refund_id = COALESCE(gateway_refund_id, $2),
            refunded_cents = GREATEST(refunded_cents, $3),
            claimed_at = now()
      WHERE id = $1`, [jobId, reciboId, valor])
}

/** Volta pra fila com espera, ou desiste no teto. Só pra falha do GATEWAY. */
async function devolverAFila(
  linha: LinhaEstorno, valor: number, erro: string,
): Promise<ResultadoEstorno> {
  const desiste = linha.attempts >= linha.max_attempts
  await q(
    `UPDATE refund_jobs
        SET status = $2, last_error = $3, claimed_at = NULL,
            available_at = CASE WHEN $2 = 'na_fila'
                                THEN now() + make_interval(secs => $4)
                                ELSE available_at END
      WHERE id = $1`,
    [linha.id, desiste ? 'falhou' : 'na_fila', erro, esperaSegundos(linha.attempts)])

  return {
    id: linha.id, ok: false, status: desiste ? 'falhou' : 'na_fila',
    pedidoId: linha.order_id, valorCents: valor, tentativa: linha.attempts, erro,
  }
}

/**
 * Fecha o registro do dinheiro que já saiu (ou que nunca vai sair por aqui).
 *
 * Falhar aqui NÃO é falhar a devolução: o dinheiro está com o comprador. A
 * linha fica 'estornando' com o recibo e o erro escrito, e o resgate dos 5
 * minutos volta pra fechar — sem tocar no gateway, por causa da parede 2.
 * Voltar pra fila aqui era o defeito: a fila chama o gateway de novo.
 */
async function fecharLinha(
  linha: LinhaEstorno, valor: number, reciboId: string | null,
  status: 'estornado' | 'na_mao', adotado: boolean,
): Promise<ResultadoEstorno> {
  try {
    const jaContado = await gravarDevolucao(linha, valor, reciboId, status)
    return {
      id: linha.id, ok: true, status, pedidoId: linha.order_id,
      valorCents: valor, tentativa: linha.attempts, jaContado,
      ...(adotado ? { adotado: true } : {}),
    }
  } catch (e: any) {
    const cru = String(e?.message ?? e)
    const erro = reciboId || adotado || status === 'estornado'
      ? `A devolução de ${brl(valor)} saiu no gateway`
        + (reciboId ? ` (recibo ${reciboId})` : '')
        + `, mas o registro não fechou: ${cru}. `
        + 'O dinheiro NÃO sai de novo — a fila volta sozinha só para gravar.'
      : `Não consegui registrar a devolução de ${brl(valor)}: ${cru}`
    // `claimed_at` pro passado: o resgate dos 5 minutos alcança esta linha na
    // próxima varredura em vez de esperar mais um ciclo inteiro.
    await q(
      `UPDATE refund_jobs
          SET last_error = $2, claimed_at = now() - interval '5 minutes'
        WHERE id = $1`, [linha.id, erro]).catch(() => {})
    return {
      id: linha.id, ok: false, status: 'estornando', pedidoId: linha.order_id,
      valorCents: valor, tentativa: linha.attempts, erro,
      ...(adotado ? { adotado: true } : {}),
    }
  }
}

/**
 * Fecha a linha da fila e soma o dinheiro no pedido, no MESMO commit.
 *
 * Devolve `true` quando o pedido já não estava mais 'pago' — ou seja, quando o
 * webhook do Asaas chegou primeiro com este mesmo estorno. Nesse caso o job
 * fecha do mesmo jeito (o dinheiro saiu), mas nada é somado de novo.
 *
 * `lock_timeout` não é enfeite: sem ele, uma linha de pedido travada por outra
 * transação prende ESTA conexão do pool pelo tempo que o outro lado quiser.
 * Numa devolução de milhares de pedidos isso é o pool inteiro parado — e o
 * erro que o timeout produz é tratado pelo chamador como "falta registro", não
 * como "falta devolver", que é a diferença entre esperar e pagar duas vezes.
 */
async function gravarDevolucao(
  linha: LinhaEstorno, valor: number, reciboId: string | null,
  status: 'estornado' | 'na_mao',
): Promise<boolean> {
  const c = await db().connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL lock_timeout = '10s'`)
    const pedido = await c.query(SQL_MARCA_PEDIDO_ESTORNADO, [linha.order_id, valor])
    const jaContado = pedido.rowCount === 0
    await c.query(
      `UPDATE refund_jobs
          SET status = $2, refunded_cents = $3, gateway_refund_id = COALESCE($4, gateway_refund_id),
              done_at = now(), claimed_at = NULL, last_error = NULL
        WHERE id = $1`,
      [linha.id, status, valor, reciboId])
    await c.query('COMMIT')
    return jaContado
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

/**
 * Mensagem escrita pra quem atende o cliente, não pro log. "HTTP 400" não
 * ajuda ninguém no telefone; "o banco recusou a devolução" ajuda.
 */
export function legivel(e: any, valorCents: number): string {
  const cru = String(e?.message ?? e ?? 'erro desconhecido')
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timeout|fetch failed/i.test(cru)) {
    return `Não consegui falar com o banco para devolver ${brl(valorCents)}: ${cru}`
  }
  return `Não consegui devolver ${brl(valorCents)}: ${cru}`
}

/** Varre a fila até acabar (ou até o teto). Devolve o que fez. */
export async function processarFilaDeEstorno(
  limite = 50, trabalhador = 'fila',
): Promise<ResultadoEstorno[]> {
  const feitos: ResultadoEstorno[] = []
  for (let i = 0; i < limite; i++) {
    const r = await processarUmEstorno(trabalhador)
    if (!r) break
    feitos.push(r)
  }
  return feitos
}

/* ------------------------------------------------------------ o painel */

export interface ResumoDaFila {
  naFila: number
  estornando: number
  estornado: number
  naMao: number
  falhou: number
  aDevolverCents: number
  devolvidoCents: number
  naMaoCents: number
}

/**
 * Como está a devolução deste evento, em números que a tela mostra.
 *
 * `FILTER` por soma, nunca um `WHERE status = ...` recortando a consulta
 * inteira: o mesmo motivo de sempre — um recorte no `WHERE` some com as
 * linhas antes de qualquer soma chegar nelas.
 */
export async function resumoDaFila(eventId: string): Promise<ResumoDaFila> {
  const r = await q1<any>(
    `SELECT
       count(*) FILTER (WHERE status = 'na_fila')::int    AS na_fila,
       count(*) FILTER (WHERE status = 'estornando')::int AS estornando,
       count(*) FILTER (WHERE status = 'estornado')::int  AS estornado,
       count(*) FILTER (WHERE status = 'na_mao')::int     AS na_mao,
       count(*) FILTER (WHERE status = 'falhou')::int     AS falhou,
       COALESCE(SUM(amount_cents) FILTER (
         WHERE status IN ('na_fila','estornando','falhou')), 0)::bigint AS a_devolver,
       COALESCE(SUM(refunded_cents) FILTER (WHERE status = 'estornado'), 0)::bigint AS devolvido,
       COALESCE(SUM(amount_cents)   FILTER (WHERE status = 'na_mao'), 0)::bigint    AS na_mao_cents
     FROM refund_jobs WHERE event_id = $1`, [eventId])

  return {
    naFila: r?.na_fila ?? 0,
    estornando: r?.estornando ?? 0,
    estornado: r?.estornado ?? 0,
    naMao: r?.na_mao ?? 0,
    falhou: r?.falhou ?? 0,
    aDevolverCents: Number(r?.a_devolver ?? 0),
    devolvidoCents: Number(r?.devolvido ?? 0),
    naMaoCents: Number(r?.na_mao_cents ?? 0),
  }
}

/* -------------------------------------------------------- trabalhador */

let relogio: ReturnType<typeof setInterval> | null = null
let rodando = false

export const INTERVALO_MS = Number(process.env.DT_ESTORNO_INTERVALO_MS || 15_000)

/**
 * Liga o trabalhador de fundo. Idempotente: chamar dez vezes não cria dez laços.
 *
 * `unref()` pra não segurar o processo vivo — sem isso, o mesmo laço que mantém
 * a devolução andando em produção travaria o `vitest` no fim da suíte.
 */
export function garantirWorkerDeEstorno(): boolean {
  if (relogio || process.env.DT_ESTORNO_WORKER === 'off') return false
  relogio = setInterval(() => {
    if (rodando) return   // varredura anterior ainda não terminou
    rodando = true
    processarFilaDeEstorno()
      .then((f) => {
        // Só fala quando fez alguma coisa: "0 estornos" a cada 15 s esconde o
        // dia em que 300 falharem de uma vez.
        const ruins = f.filter((r) => !r.ok)
        if (f.length) {
          console.log(`[estorno] ${f.length - ruins.length} devolvido(s)`
            + (ruins.length ? `, ${ruins.length} com falha: ${ruins[0].erro}` : ''))
        }
      })
      .catch((e) => console.error('[estorno] varredura falhou:', e?.message ?? e))
      .finally(() => { rodando = false })
  }, INTERVALO_MS)
  relogio.unref?.()
  return true
}

export function pararWorkerDeEstorno() {
  if (relogio) clearInterval(relogio)
  relogio = null
}

// Sobe junto com quem importar este módulo. `DT_ESTORNO_WORKER=off` desliga —
// é o que o teste usa pra decidir na mão quando a fila anda.
garantirWorkerDeEstorno()
