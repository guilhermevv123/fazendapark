/**
 * reconciliacao.ts — bater o que a plataforma diz que recebeu contra o
 * extrato do gateway.
 *
 * ## O defeito que isto fecha
 *
 * Hoje ninguém consegue responder "o que a plataforma diz que recebeu bate
 * com o extrato do Asaas?". O webhook é a ÚNICA porta por onde a plataforma
 * descobre que o dinheiro entrou (ver `api/webhooks/asaas.post.ts`), e toda
 * porta única tem o mesmo modo de falha: quando uma entrega se perde, o
 * dinheiro existe no banco do Asaas e não existe no nosso. O pedido fica
 * `expirado`, o ingresso não é emitido, o comprador chega no portão com o
 * comprovante na mão — e a descoberta acontece pelo pior caminho possível:
 * alguém reclamando.
 *
 * O inverso é mais raro e mais grave: pedido `pago` aqui sem pagamento
 * confirmado lá. Ali o dinheiro ENTROU no relatório, no borderô e no teto do
 * saque sem ter entrado na conta — e o saque tira do caixa da plataforma.
 *
 * ## A régua é a mesma do resto do sistema
 *
 * Duas, na verdade, e elas precisam concordar:
 *
 * - **Do nosso lado**, `PEDIDO_VIVO()` de `utils/liquido.ts`: pedido com
 *   dinheiro a apurar é `pago` OU `estornado_parcial`. Um `WHERE status =
 *   'pago'` aqui faria todo pedido com estorno parcial aparecer como
 *   "recebido no Asaas e não pago aqui" — a tela inventaria uma divergência
 *   por devolução de R$ 20.
 *
 * - **Do lado do gateway**, a MESMA lista, traduzida pelo `traduzirStatus()`
 *   que o webhook já usa. `RECEIVED`/`CONFIRMED`/`RECEIVED_IN_CASH` viram
 *   `pago`, `PARTIALLY_REFUNDED` vira `estornado_parcial`. Escrever uma
 *   segunda lista aqui seria a sexta cópia da conta do líquido, só que da
 *   régua de status: no dia em que um dos lados mudar, a tela acusa
 *   divergência onde não tem. `STATUS_VIVOS` abaixo é a lista, e o teste
 *   prova que ela é a mesma dos dois lados.
 *
 * - **Quem entra na conferência** é `asaas_payment_id IS NOT NULL`, nunca o
 *   canal nem a forma de pagamento. Venda em dinheiro no guichê não tem o que
 *   conferir com o Asaas: ela nunca passou por lá. A régua é a mesma do teto
 *   do saque, pelo mesmo motivo (ver `SQL_LIQUIDO_GATEWAY`).
 *
 * ## Bruto, não líquido
 *
 * O que se compara com o extrato é o que o COMPRADOR pagou (`total_cents`),
 * porque é isso que vira uma cobrança no Asaas. O líquido do produtor
 * (`total − platform − refunded`) é outra pergunta e tem tela própria; quem
 * confundir as duas vai ver "divergência" em 100% das linhas, no tamanho
 * exato da taxa. A tela diz "cobrado", não "líquido", de propósito.
 *
 * O `netValue` do Asaas também não serve de comparação: ele é o valor menos a
 * taxa DO ASAAS, que não é a nossa `platform_cents`.
 */
import { PEDIDO_VIVO } from './liquido'
import { ambienteDaChave, reaisParaCentavos, traduzirStatus, type ConfigAsaas } from './asaas'

/* ===================================================== o que é "tem dinheiro" */

/**
 * Os status que ainda têm dinheiro a apurar — nos DOIS lados.
 *
 * Do nosso lado é o conteúdo de `PEDIDO_VIVO()`; do lado do gateway é o que
 * `traduzirStatus()` devolve pras cobranças que receberam. O teste amarra as
 * duas pontas nesta constante.
 */
export const STATUS_VIVOS = ['pago', 'estornado_parcial'] as const

/**
 * A cobrança do gateway ainda tem dinheiro nosso?
 *
 * `apagada` entra na conta pelo mesmo motivo que entra no webhook: numa
 * cobrança APAGADA o Asaas manda `deleted: true` com o `status` ainda em
 * `PENDING`. Lida só pelo status, ela viraria "aguardando" em vez de
 * "cancelada" — e um pedido pago aqui contra uma cobrança apagada lá é
 * exatamente o caso grave que esta tela existe pra achar.
 */
export function cobrancaTemDinheiro(c: { statusCru: string; apagada?: boolean }): boolean {
  if (c.apagada) return false
  const nosso = traduzirStatus(c.statusCru)
  return (STATUS_VIVOS as readonly string[]).includes(nosso ?? '')
}

/* ============================================================== os dois lados */

/** Um pedido nosso, do jeito que a conferência precisa ler. */
export interface PedidoNosso {
  id: string
  codigo: string
  eventoId: string | null
  evento: string | null
  status: string
  /** `PEDIDO_VIVO()` aplicado no banco — nunca recalculado aqui */
  vivo: boolean
  cobrancaId: string | null
  /** o que o comprador pagou */
  totalCents: number
  /** o que já voltou pro comprador */
  estornadoCents: number
  pagoEm: string | null
  criadoEm: string | null
}

/** Uma cobrança do extrato, já traduzida pra centavos inteiros. */
export interface CobrancaDoExtrato {
  id: string
  /** `null` quando o extrato não trouxe o valor — e aí NÃO é zero */
  valorCents: number | null
  estornadoCents: number
  statusCru: string
  apagada: boolean
  /** ainda tem dinheiro (a mesma régua dos dois lados) */
  temDinheiro: boolean
  pagoEm: string | null
  /** nosso `order.id`, quando a cobrança nasceu com ele */
  referenciaExterna: string | null
}

/**
 * Lê uma cobrança crua do gateway (ou do payload guardado de um webhook).
 *
 * Reais → centavos passa por `reaisParaCentavos()` de `utils/asaas.ts`, que é
 * o único lugar do sistema onde essa conversão mora. Valor ausente vira
 * `null`, não zero: cobrança de R$ 0,00 e cobrança sem valor informado são
 * coisas diferentes, e tratar a segunda como a primeira produz uma
 * divergência de valor no tamanho do pedido inteiro.
 */
export function lerCobranca(bruta: any): CobrancaDoExtrato {
  const statusCru = String(bruta?.status ?? '')
  const apagada = bruta?.deleted === true
  const ref = typeof bruta?.externalReference === 'string' && bruta.externalReference.trim()
    ? String(bruta.externalReference).trim()
    : null
  return {
    id: String(bruta?.id ?? ''),
    valorCents: reaisParaCentavos(bruta?.value),
    estornadoCents: reaisParaCentavos(bruta?.refundedValue) ?? 0,
    statusCru,
    apagada,
    temDinheiro: cobrancaTemDinheiro({ statusCru, apagada }),
    pagoEm: bruta?.paymentDate ?? bruta?.clientPaymentDate ?? bruta?.confirmedDate ?? null,
    referenciaExterna: ref,
  }
}

/* ======================================================= as três divergências */

export type TipoDivergencia =
  /** o Asaas recebeu e aqui o pedido não está vivo (ou não existe) */
  | 'webhook_perdido'
  /** o pedido está pago aqui e lá não há pagamento confirmado */
  | 'sem_cobranca_no_asaas'
  /** os dois sabem do pagamento, e os valores não batem */
  | 'valor_diferente'
  /** mais de um pedido nosso aponta para a MESMA cobrança do gateway */
  | 'cobranca_repetida'

export interface Acao {
  chave: 'reprocessar_evento' | 'conferir_pedido' | 'conferir_valor' | 'conferir_duplicidade'
  rotulo: string
  comoFazer: string
}

/**
 * Divergência sem caminho de ação é fofoca: a tela mostra o problema e a
 * pessoa fecha a aba. Cada tipo sai daqui já com o que fazer, escrito pra
 * quem vai ler às 21h com fila na frente.
 */
export const CATALOGO: Record<TipoDivergencia, {
  rotulo: string
  gravidade: 'grave' | 'atencao'
  oQueE: string
  acao: Acao
}> = {
  webhook_perdido: {
    rotulo: 'O Asaas recebeu e aqui não consta',
    gravidade: 'grave',
    oQueE: 'O dinheiro entrou na conta e a plataforma não soube: o aviso do Asaas '
      + 'se perdeu. O comprador pagou e não recebeu ingresso.',
    acao: {
      chave: 'reprocessar_evento',
      rotulo: 'Reprocessar o aviso',
      comoFazer: 'Se o aviso está guardado aqui (a linha diz "aviso guardado"), reenvie o '
        + 'payload dele para POST /api/webhooks/asaas — o mesmo caminho da entrega original, '
        + 'com a mesma trava contra emitir duas vezes. Se nunca chegou, peça o reenvio no '
        + 'painel do Asaas (Integrações › Webhooks › Fila) pelo id da cobrança.',
    },
  },
  sem_cobranca_no_asaas: {
    rotulo: 'Pago aqui, sem pagamento no Asaas',
    gravidade: 'grave',
    oQueE: 'A plataforma conta este dinheiro no relatório, no borderô e no teto do saque, '
      + 'e o Asaas não confirma o recebimento. Sacar antes de resolver tira do caixa da '
      + 'plataforma.',
    acao: {
      chave: 'conferir_pedido',
      rotulo: 'Conferir o pedido antes de transferir',
      comoFazer: 'Abra o pedido e confira o id da cobrança contra o painel do Asaas. As duas '
        + 'causas comuns: o pedido foi marcado como pago por fora do gateway, ou o id gravado '
        + 'aqui é de outra conta/ambiente (chave de sandbox conferida contra produção acusa '
        + 'TODAS as linhas assim). Até resolver, não inclua este valor numa transferência.',
    },
  },
  cobranca_repetida: {
    rotulo: 'A mesma cobrança em mais de um pedido',
    gravidade: 'grave',
    oQueE: 'Dois ou mais pedidos daqui apontam para a MESMA cobrança do Asaas. O dinheiro '
      + 'entrou uma vez só e a plataforma conta ele uma vez por pedido: o relatório, o borderô '
      + 'e o teto do saque ficam maiores do que o extrato — e o saque tira a diferença do caixa '
      + 'da plataforma.',
    acao: {
      chave: 'conferir_duplicidade',
      rotulo: 'Achar o pedido que ficou com o id de outro',
      comoFazer: 'Abra os pedidos desta linha e veja no painel do Asaas de quem é a cobrança: o '
        + 'campo externalReference dela guarda o id do pedido que a criou. O outro pedido está '
        + 'com o id de cobrança alheio — corrija o PEDIDO, nunca apague a cobrança, que é do '
        + 'comprador que pagou. Até resolver, não inclua este valor numa transferência.',
    },
  },
  valor_diferente: {
    rotulo: 'Valor diferente',
    gravidade: 'atencao',
    oQueE: 'Os dois lados sabem do pagamento e discordam do valor — em geral um estorno '
      + 'que o Asaas registrou e o nosso pedido não.',
    acao: {
      chave: 'conferir_valor',
      rotulo: 'Reprocessar o aviso de estorno',
      comoFazer: 'Quando a diferença está na coluna de estorno, o aviso de devolução não foi '
        + 'processado: reenvie o evento (PAYMENT_REFUNDED / PAYMENT_PARTIALLY_REFUNDED) para '
        + 'POST /api/webhooks/asaas. Quando a diferença está no valor cobrado, o pedido foi '
        + 'alterado depois de criada a cobrança — aí o certo é o financeiro olhar o pedido.',
    },
  },
}

export interface Divergencia {
  tipo: TipoDivergencia
  gravidade: 'grave' | 'atencao'
  rotulo: string
  cobrancaId: string | null
  pedidoId: string | null
  pedidoCodigo: string | null
  eventoId: string | null
  evento: string | null
  nossoStatus: string | null
  statusNoGateway: string | null
  /** o que a plataforma diz que entrou, já descontado o que ela sabe que voltou */
  nossoCents: number | null
  /** o mesmo número do lado do gateway */
  gatewayCents: number | null
  /** gateway − nosso: positivo = tem dinheiro lá que não está aqui */
  diferencaCents: number
  quando: string | null
  explicacao: string
  acao: Acao
}

/** Pedido que a conferência não conseguiu conferir, e por quê. */
export interface NaoConferido {
  pedidoId: string
  pedidoCodigo: string
  cobrancaId: string | null
  eventoId: string | null
  nossoCents: number
  motivo: string
}

export interface EntradaDaComparacao {
  pedidos: PedidoNosso[]
  extrato: CobrancaDoExtrato[]
  /**
   * O extrato lista TODAS as cobranças do período? Só o Asaas de verdade
   * lista. Com `false`, um pedido vivo que não aparece no extrato vira "não
   * conferido" em vez de "grave" — dizer que o dinheiro sumiu quando a
   * verdade é "não olhei" é pior do que não ter a tela.
   */
  extratoCompleto: boolean
  /**
   * Cobranças que o gateway disse NÃO EXISTIR quando perguntamos pelo id.
   * Essas são graves mesmo com extrato parcial: a resposta veio.
   */
  ausentesConfirmadas?: Set<string>
  /** ids que nem a listagem trouxe nem deu pra perguntar (teto de consultas) */
  naoPerguntadas?: Set<string>
}

export interface ResultadoDaComparacao {
  divergencias: Divergencia[]
  naoConferidos: NaoConferido[]
  totais: {
    pedidos: number
    /** o que a plataforma diz que recebeu pelo gateway, líquido de estorno */
    nossoCents: number
    cobrancas: number
    /** o mesmo número pelo extrato */
    gatewayCents: number
    /** gateway − nosso */
    diferencaCents: number
    conferidos: number
    webhookPerdido: number
    semCobranca: number
    valorDiferente: number
    /** a mesma cobrança reivindicada por mais de um pedido nosso */
    cobrancaRepetida: number
    naoConferidos: number
    /**
     * O que não foi conferido, EM DINHEIRO.
     *
     * Sem este número a tela põe "Diferença −R$ 16.139,75" em vermelho ao lado
     * de "Divergências 0" e "179 pedidos não conferidos": a maior acusação da
     * tela sai do que ela não olhou. `diferencaCents` só quer dizer alguma
     * coisa quando isto aqui é zero.
     */
    naoConferidosCents: number
  }
}

/**
 * A comparação. Pura de propósito: sem banco, sem rede, sem `h3`.
 *
 * É o que deixa o teste exercitar os três casos sem depender do gateway estar
 * no ar — e o que impede a regra de acabar escrita dentro da rota, onde só um
 * teste de ponta a ponta alcançaria.
 */
export function comparar(e: EntradaDaComparacao): ResultadoDaComparacao {
  const ausentesConfirmadas = e.ausentesConfirmadas ?? new Set<string>()
  const naoPerguntadas = e.naoPerguntadas ?? new Set<string>()

  // Uma cobrança pode ter MAIS DE UM dono aqui: `orders.asaas_payment_id` só
  // passou a ser único na migração 025, e id errado digitado à mão continua
  // possível em pedido antigo. Guardar um pedido por cobrança (`Map<string,
  // PedidoNosso>`) fazia o segundo dono sumir do laço do gateway, cair no
  // último ramo do nosso laço — o que diz "a cobrança existe e NÃO tem
  // dinheiro" — e sair como GRAVE com a frase que se contradiz sozinha: o
  // Asaas diz "RECEIVED" e a linha afirma que o dinheiro não entrou.
  const porCobranca = new Map<string, PedidoNosso[]>()
  const porPedido = new Map<string, PedidoNosso>()
  for (const p of e.pedidos) {
    if (p.cobrancaId) {
      const donos = porCobranca.get(p.cobrancaId)
      if (donos) donos.push(p)
      else porCobranca.set(p.cobrancaId, [p])
    }
    porPedido.set(p.id, p)
  }

  const extratoPorId = new Map<string, CobrancaDoExtrato>()
  const extratoPorReferencia = new Map<string, CobrancaDoExtrato>()
  for (const c of e.extrato) {
    if (!c.id) continue
    extratoPorId.set(c.id, c)
    if (c.referenciaExterna) extratoPorReferencia.set(c.referenciaExterna, c)
  }

  const divergencias: Divergencia[] = []
  const naoConferidos: NaoConferido[] = []
  /** pedidos já julgados pelo laço do gateway — o nosso laço não repete */
  const julgados = new Set<string>()

  /**
   * "Não conferido" é uma lista de PEDIDOS, não de tentativas.
   *
   * Duas cobranças podem apontar para o mesmo pedido — a que ele gravou em
   * `asaas_payment_id` e a que o gateway criou com o `externalReference` dele
   * (PIX pedido de novo, por exemplo). Se as duas vierem sem valor no extrato,
   * o laço de baixo empilha o MESMO pedido duas vezes: o KPI conta 2 onde
   * existe 1, `naoConferidosCents` soma o pedido duas vezes — e é esse número
   * que a tela usa pra dizer o tamanho do que não olhou, então ele fica maior
   * que o caixa — e `conferidos` (vivos − não conferidos) chega a ficar
   * NEGATIVO. Um pedido entra uma vez, com o primeiro motivo que apareceu.
   */
  const jaSemConferir = new Set<string>()
  const semConferir = (n: NaoConferido) => {
    if (jaSemConferir.has(n.pedidoId)) return
    jaSemConferir.add(n.pedidoId)
    naoConferidos.push(n)
  }

  let gatewayCents = 0

  /* ------------------------------------------------- 1. o lado do gateway */
  for (const c of e.extrato) {
    // Todos os pedidos que reivindicam esta cobrança: os que gravaram o id
    // dela e o que ela aponta por `externalReference`. Dois nomes diferentes
    // para a mesma cobrança continuam sendo dois donos.
    const donos = [...(porCobranca.get(c.id) ?? [])]
    const porReferencia = c.referenciaExterna ? porPedido.get(c.referenciaExterna) : undefined
    if (porReferencia && !donos.some((p) => p.id === porReferencia.id)) donos.push(porReferencia)
    const pedido = donos[0]

    if (!c.temDinheiro) {
      // Cobrança sem dinheiro (pendente, vencida, apagada, estornada por
      // inteiro) só vira divergência quando o pedido daqui está vivo — e esse
      // julgamento é o do laço de baixo, que enxerga TODOS os nossos pedidos,
      // inclusive os que nem aparecem neste extrato.
      continue
    }

    const doGateway = (c.valorCents ?? 0) - c.estornadoCents
    gatewayCents += doGateway

    for (const p of donos) julgados.add(p.id)

    // ---------------------------------------------- a mesma cobrança em dois pedidos
    if (donos.length > 1) {
      // O dinheiro entrou UMA vez; do nosso lado ele é contado uma vez por
      // pedido vivo. A diferença da linha é o tamanho exato do que a
      // plataforma inventou — e é ela que não pode entrar numa transferência.
      const vivos = donos.filter((p) => p.vivo)
      const nosso = vivos.reduce((s, p) => s + p.totalCents - p.estornadoCents, 0)
      const lista = donos.map((p) => `${p.codigo} (${p.status})`).join(', ')
      divergencias.push(montar('cobranca_repetida', {
        cobrancaId: c.id,
        pedidoId: pedido!.id,
        pedidoCodigo: pedido!.codigo,
        eventoId: pedido!.eventoId,
        evento: pedido!.evento,
        nossoStatus: pedido!.status,
        statusNoGateway: c.statusCru,
        nossoCents: vivos.length ? nosso : null,
        gatewayCents: doGateway,
        diferencaCents: doGateway - nosso,
        quando: c.pagoEm ?? pedido!.pagoEm,
        explicacao: `${donos.length} pedidos apontam para esta mesma cobrança: ${lista}. `
          + (vivos.length > 1
            ? `O Asaas pagou uma vez e a plataforma está contando ${vivos.length} vezes.`
            : vivos.length === 1
              ? 'Só um deles está pago aqui; o outro ficou com o id de cobrança alheio.'
              : 'Nenhum deles está pago aqui, e não dá pra saber qual dos dois o comprador '
                + 'pagou — reprocessar o aviso às cegas emite ingresso do pedido errado.'),
      }))
      continue
    }

    // ---------------------------------------------- webhook perdido
    if (!pedido || !pedido.vivo) {
      divergencias.push(montar('webhook_perdido', {
        cobrancaId: c.id,
        pedidoId: pedido?.id ?? null,
        pedidoCodigo: pedido?.codigo ?? null,
        eventoId: pedido?.eventoId ?? null,
        evento: pedido?.evento ?? null,
        nossoStatus: pedido?.status ?? null,
        statusNoGateway: c.statusCru,
        // Aqui o pedido NUNCA está vivo (é a condição deste ramo), então do
        // nosso lado não há dinheiro nenhum: `null` vira "—" na tela. Mostrar
        // o total do pedido expirado punha 66 / 66 / 66 nas três colunas da
        // MESMA linha — nosso, gateway e diferença sem fechar a conta — e
        // ainda discordava do KPI, que não conta pedido morto.
        nossoCents: null,
        gatewayCents: doGateway,
        diferencaCents: doGateway,
        quando: c.pagoEm,
        explicacao: !pedido
          ? 'O Asaas recebeu esta cobrança e não existe pedido nenhum com este id aqui. '
            + 'Ou o pedido foi apagado, ou a cobrança é de outro sistema que usa a mesma conta.'
          : `O Asaas recebeu esta cobrança e o pedido aqui está "${pedido.status}": `
            + 'o ingresso não foi emitido e o comprador pagou.',
      }))
      continue
    }

    // ---------------------------------------------- valor diferente
    if (c.valorCents == null) {
      semConferir({
        pedidoId: pedido.id, pedidoCodigo: pedido.codigo, cobrancaId: c.id,
        eventoId: pedido.eventoId, nossoCents: pedido.totalCents - pedido.estornadoCents,
        motivo: 'o extrato não trouxe o valor desta cobrança',
      })
      continue
    }

    const nosso = pedido.totalCents - pedido.estornadoCents
    if (pedido.totalCents !== c.valorCents || pedido.estornadoCents !== c.estornadoCents) {
      const cobradoDiferente = pedido.totalCents !== c.valorCents
      const estornoDiferente = pedido.estornadoCents !== c.estornadoCents
      divergencias.push(montar('valor_diferente', {
        cobrancaId: c.id,
        pedidoId: pedido.id,
        pedidoCodigo: pedido.codigo,
        eventoId: pedido.eventoId,
        evento: pedido.evento,
        nossoStatus: pedido.status,
        statusNoGateway: c.statusCru,
        nossoCents: nosso,
        gatewayCents: doGateway,
        diferencaCents: doGateway - nosso,
        quando: c.pagoEm ?? pedido.pagoEm,
        explicacao: cobradoDiferente && estornoDiferente
          ? 'O valor cobrado e o valor estornado estão diferentes nos dois lados.'
          : cobradoDiferente
            ? 'A cobrança no Asaas não tem o mesmo valor do pedido aqui.'
            : 'O Asaas registrou um estorno que o pedido aqui não tem: '
              + 'o aviso de devolução não foi processado.',
      }))
    }
  }

  /* ---------------------------------------------------- 2. o nosso lado */
  let nossoCents = 0
  let pedidosVivos = 0
  for (const p of e.pedidos) {
    if (!p.vivo) continue
    pedidosVivos++
    const nosso = p.totalCents - p.estornadoCents
    nossoCents += nosso

    if (julgados.has(p.id)) continue

    const c = (p.cobrancaId ? extratoPorId.get(p.cobrancaId) : undefined)
      ?? extratoPorReferencia.get(p.id)

    if (!p.cobrancaId && !c) {
      // Pedido sem cobrança no gateway é dinheiro que entrou direto no bolso
      // do produtor (nota no guichê, pix na chave dele). Nunca passou pelo
      // Asaas, então não há o que conferir — e acusar divergência aqui seria
      // a tela chamando de sumiço o dinheiro que está na gaveta.
      continue
    }

    if (!c) {
      const confirmadaAusente = !!p.cobrancaId && ausentesConfirmadas.has(p.cobrancaId)
      // `naoPerguntada` vale SOZINHA, e não só quando o extrato é parcial.
      // Extrato do período completo não quer dizer "olhei esta cobrança": a
      // listagem corta por `paymentDate`, e quem ficou de fora dela só é
      // conferido pela consulta por id — que para no teto. Enquanto isto
      // dependia de `extratoCompleto`, todo pedido além do 40º ia direto pra
      // divergência mais grave da tela sem ninguém ter perguntado nada ao
      // gateway: a conferência acusando o que não olhou, que é justamente o
      // que este arquivo existe pra não fazer.
      const naoPerguntada = !!p.cobrancaId && naoPerguntadas.has(p.cobrancaId)
      if (!confirmadaAusente && (naoPerguntada || !e.extratoCompleto)) {
        semConferir({
          pedidoId: p.id, pedidoCodigo: p.codigo, cobrancaId: p.cobrancaId,
          eventoId: p.eventoId, nossoCents: nosso,
          motivo: naoPerguntada
            ? 'o extrato não lista esta cobrança e o teto de consultas '
              + 'por id foi atingido: ninguém perguntou por ela'
            : 'o extrato desta fonte não conhece esta cobrança',
        })
        continue
      }
      divergencias.push(montar('sem_cobranca_no_asaas', {
        cobrancaId: p.cobrancaId,
        pedidoId: p.id,
        pedidoCodigo: p.codigo,
        eventoId: p.eventoId,
        evento: p.evento,
        nossoStatus: p.status,
        statusNoGateway: null,
        nossoCents: nosso,
        gatewayCents: null,
        diferencaCents: -nosso,
        quando: p.pagoEm,
        explicacao: confirmadaAusente
          ? 'O pedido está pago aqui e o Asaas respondeu que esta cobrança não existe.'
          : 'O pedido está pago aqui e esta cobrança não apareceu no extrato do período.',
      }))
      continue
    }

    // A cobrança existe — e aqui ela é, quase sempre, a que NÃO tem dinheiro
    // (pendente, vencida, apagada, estornada por inteiro) com o pedido vivo
    // deste lado.
    //
    // O `temDinheiro` só cai neste ramo quando o laço do gateway já deu o
    // dinheiro desta cobrança a OUTRO pedido: é a cobrança repetida chegando
    // por um caminho diferente. Escrever a frase de "não entrou" em cima de um
    // `RECEIVED` é a linha se contradizendo dentro dela mesma — a tela diz o
    // status do gateway e, ao lado, que o dinheiro não entrou.
    const doGateway = (c.valorCents ?? 0) - c.estornadoCents
    divergencias.push(montar(c.temDinheiro ? 'cobranca_repetida' : 'sem_cobranca_no_asaas', {
      cobrancaId: c.id || p.cobrancaId,
      pedidoId: p.id,
      pedidoCodigo: p.codigo,
      eventoId: p.eventoId,
      evento: p.evento,
      nossoStatus: p.status,
      statusNoGateway: c.statusCru,
      nossoCents: nosso,
      gatewayCents: c.temDinheiro ? doGateway : 0,
      diferencaCents: (c.temDinheiro ? doGateway : 0) - nosso,
      quando: p.pagoEm,
      explicacao: c.apagada
        ? 'O pedido está pago aqui e a cobrança foi APAGADA no Asaas.'
        : c.temDinheiro
          ? `O Asaas diz "${c.statusCru}" nesta cobrança, e ela já está contada em outro `
            + 'pedido daqui: o mesmo dinheiro está sendo somado duas vezes.'
          : `O pedido está pago aqui e o Asaas diz "${c.statusCru}": o dinheiro não entrou.`,
    }))
  }

  const conta = (t: TipoDivergencia) => divergencias.filter((d) => d.tipo === t).length

  return {
    divergencias,
    naoConferidos,
    totais: {
      pedidos: pedidosVivos,
      nossoCents,
      cobrancas: e.extrato.filter((c) => c.temDinheiro).length,
      gatewayCents,
      diferencaCents: gatewayCents - nossoCents,
      conferidos: pedidosVivos - naoConferidos.length,
      webhookPerdido: conta('webhook_perdido'),
      semCobranca: conta('sem_cobranca_no_asaas'),
      valorDiferente: conta('valor_diferente'),
      cobrancaRepetida: conta('cobranca_repetida'),
      naoConferidos: naoConferidos.length,
      naoConferidosCents: naoConferidos.reduce((s, n) => s + n.nossoCents, 0),
    },
  }
}

/* ================================== o que a tela pode AFIRMAR no fim das contas */

export interface Veredito {
  /** dá pra dizer, em voz alta, que os dois lados foram comparados? */
  conferido: boolean
  /** a frase curta que fica colada no número — nunca vazia */
  selo: string
  /** o tom da tela: `ok` só quando conferiu de verdade e fechou */
  tom: 'ok' | 'alerta' | 'erro'
}

/**
 * O veredito da conferência, numa palavra e num tom.
 *
 * Existe porque o número maior da tela mentia calado. Sem credencial do Asaas
 * o extrato vem vazio, nenhuma comparação acontece, e "Divergências 0" era
 * pintado de VERDE (`text-ok`, medido em `rgb(18,128,92)`) ao lado de "213
 * pedido(s) não conferidos" em 12px cinza. Quem passa o olho lê o verde: a
 * tela de conferência dizia "está tudo certo" sobre o que ela não olhou.
 *
 * A régua é simples e não tem meio-termo: só o extrato do Asaas DE VERDADE,
 * inteiro, sem erro e sem pedido sobrando autoriza a palavra "fecha". Gateway
 * simulado não é o Asaas — é o que sobrou de webhook guardado nesta máquina —
 * e por isso nunca sai `ok`, nem com zero divergência.
 */
export function vereditoDaConferencia(e: {
  fonte: 'asaas' | 'simulado' | 'indisponivel'
  completa: boolean
  erro: string | null
  naoConferidos: number
  divergencias: number
}): Veredito {
  if (e.erro) {
    return { conferido: false, tom: 'erro', selo: 'Nada foi conferido: o Asaas não respondeu' }
  }
  if (e.fonte === 'indisponivel') {
    return { conferido: false, tom: 'erro', selo: 'Nada foi conferido: não há extrato nenhum' }
  }
  if (e.fonte === 'simulado') {
    return {
      conferido: false,
      tom: 'alerta',
      selo: 'Gateway simulado — isto NÃO é o extrato do Asaas',
    }
  }
  if (!e.completa || e.naoConferidos > 0) {
    return {
      conferido: false,
      tom: 'alerta',
      selo: e.naoConferidos > 0
        ? `Conferência incompleta: ${e.naoConferidos} pedido(s) sem conferir`
        : 'Conferência incompleta: o período não foi lido inteiro',
    }
  }
  if (e.divergencias > 0) {
    return { conferido: true, tom: 'erro', selo: `${e.divergencias} divergência(s) no período` }
  }
  return { conferido: true, tom: 'ok', selo: 'Conferido contra o extrato do Asaas: os dois lados fecham' }
}

/** Preenche rótulo, gravidade e ação a partir do catálogo — num lugar só. */
function montar(
  tipo: TipoDivergencia,
  d: Omit<Divergencia, 'tipo' | 'gravidade' | 'rotulo' | 'acao'>,
): Divergencia {
  const c = CATALOGO[tipo]
  return { tipo, gravidade: c.gravidade, rotulo: c.rotulo, acao: c.acao, ...d }
}

/* ====================================================== o recorte no banco */

/**
 * O nosso lado da conferência.
 *
 * Três decisões dentro da consulta:
 *
 * 1. `vivo` sai de `PEDIDO_VIVO()`, a mesma expressão do borderô e do teto do
 *    saque. Não é `status = 'pago'` — ver o cabeçalho do arquivo.
 * 2. `LEFT JOIN events`: pedido de evento apagado sumiria da conferência num
 *    JOIN comum, em silêncio. É justamente o pedido órfão que interessa aqui.
 * 3. A janela é `COALESCE(paid_at, created_at)`. O pedido que o Asaas recebeu
 *    e nós não processamos NÃO tem `paid_at`; filtrar só por ele esconderia a
 *    divergência que a tela existe pra achar.
 */
export const SQL_PEDIDOS_DO_PERIODO = `
  SELECT o.id, o.code, o.event_id, e.name AS evento, o.status,
         (${PEDIDO_VIVO('o.')}) AS vivo,
         o.asaas_payment_id, o.total_cents, o.refunded_cents,
         o.paid_at, o.created_at
    FROM orders o
    LEFT JOIN events e ON e.id = o.event_id
   WHERE o.org_id = $1
     AND o.asaas_payment_id IS NOT NULL
     AND COALESCE(o.paid_at, o.created_at) >= $2
     AND COALESCE(o.paid_at, o.created_at) < $3
     AND ($4::uuid IS NULL OR o.event_id = $4::uuid)
   ORDER BY COALESCE(o.paid_at, o.created_at) DESC`

/**
 * Os pedidos que o EXTRATO apontou e que a janela não pegou.
 *
 * Sem isto, uma cobrança paga às 23h50 de ontem cujo pedido nasceu às 23h40
 * apareceria como "o Asaas recebeu e não existe pedido aqui" — divergência
 * grave inventada pela borda da janela. A cerca de organização continua: id
 * de fora da org não vira linha.
 */
export const SQL_PEDIDOS_POR_CHAVE = `
  SELECT o.id, o.code, o.event_id, e.name AS evento, o.status,
         (${PEDIDO_VIVO('o.')}) AS vivo,
         o.asaas_payment_id, o.total_cents, o.refunded_cents,
         o.paid_at, o.created_at
    FROM orders o
    LEFT JOIN events e ON e.id = o.event_id
   WHERE o.org_id = $1
     AND (o.asaas_payment_id = ANY($2::text[])
          OR o.id = ANY($3::uuid[]))`

/**
 * O extrato possível SEM credencial: o que o gateway já nos contou.
 *
 * Não é o extrato do Asaas e a tela diz isso com todas as letras. É o payload
 * cru das entregas de webhook (`payment_events`), que é a única palavra do
 * gateway guardada nesta máquina — e é onde mora o caso mais comum de
 * verdade: a entrega chegou, falhou no meio e ficou com `processed_at` nulo.
 *
 * `DISTINCT ON` pega a ÚLTIMA entrega de cada cobrança: uma cobrança gera
 * CONFIRMED, depois RECEIVED, depois REFUNDED — o estado dela é o do último
 * evento, não o do primeiro.
 *
 * O `JOIN orders` é a cerca de organização: `payment_events` não tem
 * `org_id`, e sem a junção o extrato de um cliente mostraria cobrança de
 * outro. O preço é que cobrança órfã (sem pedido nenhum) não aparece nesta
 * fonte — está escrito na tela, junto do aviso de que a fonte é parcial.
 *
 * O recorte de período é o MESMO do nosso lado (`COALESCE(paid_at,
 * created_at)` do pedido), e não é enfeite: sem ele esta fonte devolve o
 * histórico inteiro da organização, a tela promete "01/09 a 30/09" e mostra o
 * caixa de sempre — a venda de março volta pela chave da cobrança
 * (`SQL_PEDIDOS_POR_CHAVE`) e entra nos dois KPIs do período. Cortar pelo
 * pedido, e não pela data em que a entrega do webhook chegou, é o que mantém
 * os dois lados falando do mesmo conjunto: um evento de estorno que chega
 * semanas depois continua pertencendo à venda dele.
 */
export const SQL_EXTRATO_SIMULADO = `
  SELECT DISTINCT ON (pe.external_id)
         pe.external_id AS id,
         pe.payload -> 'payment' AS pagamento,
         pe.event_name,
         pe.created_at
    FROM payment_events pe
    JOIN orders o ON o.asaas_payment_id = pe.external_id
   WHERE pe.provider = 'asaas'
     AND pe.external_id IS NOT NULL
     AND o.org_id = $1
     AND ($2::uuid IS NULL OR o.event_id = $2::uuid)
     AND COALESCE(o.paid_at, o.created_at) >= $3
     AND COALESCE(o.paid_at, o.created_at) < $4
   ORDER BY pe.external_id, pe.created_at DESC`

/**
 * O aviso do gateway que está guardado aqui pra cada cobrança — é o que
 * transforma "reprocessar este evento" de conselho em instrução: a linha diz
 * se o payload existe, quantas tentativas já levou e qual foi o erro.
 *
 * `payment_events` não tem `org_id`, e esta era a ÚNICA consulta do arquivo
 * que atravessava a tabela sem a cerca que as outras usam. Não vazava porque
 * os ids vinham de consultas já cercadas — ou seja, a defesa morava em quem
 * chamava. Defesa que depende do chamador não é defesa: basta a próxima
 * chamada nascer com uma lista de ids de outra procedência (um filtro na URL,
 * um reprocessamento em lote) pra a linha de outro produtor aparecer aqui,
 * com o erro e o payload dele. A cerca agora é da consulta.
 *
 * O `EXISTS` em vez de `JOIN`: é uma semijunção, então cobrança repetida (a
 * que a migração 025 passou a barrar, mas que pedido antigo ainda pode ter)
 * não multiplica linha por baixo do `DISTINCT ON`. Os dois caminhos de posse
 * contam — o pedido que gravou o id da cobrança e o pedido que o próprio
 * webhook carimbou em `order_id` — porque a cobrança pode ter sido achada por
 * `externalReference`, sem o id nunca ter ido parar no pedido.
 */
export const SQL_AVISOS_GUARDADOS = `
  SELECT DISTINCT ON (pe.external_id)
         pe.external_id, pe.id, pe.event_name, pe.processed_at, pe.attempts, pe.error
    FROM payment_events pe
   WHERE pe.provider = 'asaas' AND pe.external_id = ANY($1::text[])
     AND EXISTS (SELECT 1 FROM orders o
                  WHERE o.org_id = $2
                    AND (o.asaas_payment_id = pe.external_id OR o.id = pe.order_id))
   ORDER BY pe.external_id, pe.created_at DESC`

/** Converte a linha do banco no formato que a comparação lê. */
export function pedidoDaLinha(l: any): PedidoNosso {
  return {
    id: String(l.id),
    codigo: String(l.code),
    eventoId: l.event_id ?? null,
    evento: l.evento ?? null,
    status: String(l.status),
    vivo: l.vivo === true,
    cobrancaId: l.asaas_payment_id ?? null,
    totalCents: Number(l.total_cents),
    estornadoCents: Number(l.refunded_cents),
    pagoEm: l.paid_at ?? null,
    criadoEm: l.created_at ?? null,
  }
}

/* ================================================== a janela, em dia local */

export interface Janela {
  de: string
  ate: string
  /** instante de início, no fuso de quem opera */
  inicio: Date
  /** instante EXCLUSIVO de fim: o dia seguinte ao `ate`, à meia-noite local */
  fim: Date
  dias: number
}

const DIA = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Lê `?de=&ate=` como DIA DE CALENDÁRIO local e devolve os instantes.
 *
 * `new Date('2026-09-01')` nasce à meia-noite UTC — 20:59 do dia 31/08 na
 * Bahia. Uma conferência que começa três horas antes do que a tela promete
 * puxa as vendas da noite anterior pra dentro do período e não fecha com o
 * extrato do Asaas, que corta por dia de calendário. Por isso o construtor
 * com ano/mês/dia separados, que é local, e nunca `new Date(texto)`.
 */
export function lerJanela(deBruto: unknown, ateBruto: unknown, hoje = new Date()): Janela {
  const padraoAte = diaLocal(hoje)
  const padraoDe = diaLocal(new Date(hoje.getFullYear(), hoje.getMonth(), 1))

  const de = DIA.test(String(deBruto ?? '')) ? String(deBruto) : padraoDe
  const ate = DIA.test(String(ateBruto ?? '')) ? String(ateBruto) : padraoAte

  if (de > ate) {
    throw new Error('A data inicial é depois da final. Confira o período.')
  }

  const inicio = meiaNoiteLocal(de)
  const fim = meiaNoiteLocal(ate)
  fim.setDate(fim.getDate() + 1)
  const dias = Math.round((fim.getTime() - inicio.getTime()) / 86_400_000)
  return { de, ate, inicio, fim, dias }
}

function meiaNoiteLocal(dia: string): Date {
  const [, a, m, d] = DIA.exec(dia)!
  return new Date(Number(a), Number(m) - 1, Number(d), 0, 0, 0, 0)
}

/** `YYYY-MM-DD` do relógio LOCAL — nunca `toISOString().slice(0,10)`. */
export function diaLocal(d: Date): string {
  const mes = String(d.getMonth() + 1).padStart(2, '0')
  const dia = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mes}-${dia}`
}

/* ============================================== o extrato de verdade (HTTP) */

export class ErroDoExtrato extends Error {
  constructor(public readonly status: number, msg: string) {
    super(msg)
    this.name = 'ErroDoExtrato'
  }
}

/**
 * Transporte injetável: a listagem e a consulta por id recebem o buscador em
 * vez de chamarem `fetch` direto. É o que deixa o teste exercitar os três
 * casos sem gateway no ar — e sem inventar uma segunda implementação da
 * comparação só pro teste.
 */
export type Buscador = (caminho: string) => Promise<any>

// Mesmas bases de `utils/asaas.ts`. Estão repetidas porque lá elas não são
// exportadas e aquele arquivo está fora desta entrega — quando as duas se
// encontrarem, o lugar certo é o de lá.
const PROD_URL = 'https://api.asaas.com/v3'
const SANDBOX_URL = 'https://api-sandbox.asaas.com/v3'

export function ambienteDaConfig(cfg: ConfigAsaas): 'production' | 'sandbox' {
  return ambienteDaChave(cfg.apiKey) || cfg.environment || 'sandbox'
}

export function buscadorDoAsaas(cfg: ConfigAsaas): Buscador {
  const base = ambienteDaConfig(cfg) === 'production' ? PROD_URL : SANDBOX_URL
  return async (caminho: string) => {
    const res = await fetch(`${base}${caminho}`, {
      headers: {
        access_token: cfg.apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'diamond-tickets',
      },
      signal: AbortSignal.timeout(20_000),
    })
    const texto = await res.text()
    let json: any = null
    try { json = texto ? JSON.parse(texto) : null } catch { /* corpo não-JSON */ }

    // O Asaas devolve 200 com `errors[]` em alguns caminhos: confiar só no
    // status deixa passar erro como sucesso (a mesma lição de utils/asaas.ts).
    const erros = json?.errors
    if (!res.ok || (Array.isArray(erros) && erros.length)) {
      const msg = Array.isArray(erros) && erros.length
        ? erros.map((x: any) => x.description || x.code).join('; ')
        : `HTTP ${res.status}`
      const dica = res.status === 401
        ? ' (401 costuma ser chave de um ambiente batendo na URL do outro)'
        : ''
      throw new ErroDoExtrato(res.status, `Asaas: ${msg}${dica}`)
    }
    return json
  }
}

/** teto de páginas: período largo demais vira aviso na tela, não espera infinita */
export const MAX_PAGINAS = 20
export const POR_PAGINA = 100
/** teto de consultas por id, pelo mesmo motivo */
export const MAX_CONSULTAS_POR_ID = 40

/**
 * O extrato do período: as cobranças que o Asaas diz ter RECEBIDO entre as
 * duas datas.
 *
 * O filtro é `paymentDate` — a data em que o dinheiro entrou —, e não
 * `dateCreated`: o operador está conferindo o caixa de um período, não a
 * agenda de cobranças emitidas. Cobrança criada em agosto e paga em setembro
 * é dinheiro de setembro nos dois lados.
 *
 * `truncado` volta `true` quando o teto de páginas foi atingido: aí a tela
 * PRECISA dizer que não leu tudo, senão os pedidos que sobraram viram
 * "divergência grave" por falta de página.
 */
export async function listarCobrancas(
  buscador: Buscador, janela: Janela,
): Promise<{ cobrancas: CobrancaDoExtrato[]; truncado: boolean; total: number }> {
  const cobrancas: CobrancaDoExtrato[] = []
  let offset = 0
  let truncado = false
  let total = 0

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const r = await buscador(
      `/payments?paymentDate%5Bge%5D=${janela.de}&paymentDate%5Ble%5D=${janela.ate}`
      + `&limit=${POR_PAGINA}&offset=${offset}`)
    const linhas: any[] = Array.isArray(r?.data) ? r.data : []
    for (const l of linhas) cobrancas.push(lerCobranca(l))
    total = Number(r?.totalCount ?? cobrancas.length)

    if (!r?.hasMore || !linhas.length) return { cobrancas, truncado: false, total }
    offset += POR_PAGINA
    truncado = pagina === MAX_PAGINAS - 1
  }
  return { cobrancas, truncado, total }
}

/**
 * Pergunta ao gateway, um a um, pelas cobranças que a listagem não trouxe.
 *
 * É esta consulta que separa "o Asaas não conhece esta cobrança" (grave, e a
 * resposta veio do gateway) de "não apareceu na listagem do período" — que
 * acontece sozinho quando o pagamento foi confirmado um dia antes do recorte.
 * Sem ela, todo pedido na borda da janela viraria denúncia.
 */
export async function conferirPorId(
  buscador: Buscador, ids: string[],
): Promise<{
  achadas: CobrancaDoExtrato[]
  ausentes: Set<string>
  naoPerguntadas: Set<string>
  erro: string | null
}> {
  const achadas: CobrancaDoExtrato[] = []
  const ausentes = new Set<string>()
  const naoPerguntadas = new Set<string>()
  let erro: string | null = null

  for (const [i, id] of ids.entries()) {
    if (i >= MAX_CONSULTAS_POR_ID) { naoPerguntadas.add(id); continue }
    try {
      achadas.push(lerCobranca(await buscador(`/payments/${encodeURIComponent(id)}`)))
    } catch (e: any) {
      if (e instanceof ErroDoExtrato && e.status === 404) {
        // O gateway respondeu, e a resposta é "não existe". Isso é achado, não
        // falha: vira divergência grave com nome.
        ausentes.add(id)
        continue
      }
      // Qualquer outra falha (rede, 401, 500) NÃO vira acusação: o pedido sai
      // como não conferido e a tela diz por quê.
      naoPerguntadas.add(id)
      erro = erro ?? (e?.message ?? String(e))
    }
  }
  return { achadas, ausentes, naoPerguntadas, erro }
}
