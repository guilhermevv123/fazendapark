/**
 * GET /api/e/:slug — a vitrine pública do evento.
 *
 * A rota responde uma pergunta só: o que o COMPRADOR pode ver e comprar AGORA.
 * Três regras valem o arquivo inteiro.
 *
 * 1. **Preço já precificado.** Vai o total que sai do bolso, não a face. Mandar
 *    a face e deixar o navegador somar a taxa é como o total da tela passa a
 *    divergir do cobrado: duas implementações da mesma regra, uma sempre
 *    desatualizada.
 *
 * 2. **Disponibilidade sai do estoque, não do otimismo.** `situacao` é
 *    calculada aqui, no servidor, a partir de quantity/sold/reserved e das
 *    datas do lote, e respeita o giro automático (ver `situacoesDoSetor`).
 *    Vitrine que anuncia "disponível" um lote esgotado não economiza clique:
 *    empurra o comprador até o CPF pra ele levar 409 na cara do checkout.
 *
 * 3. **Só sai o que é do comprador.** Nada de contagem exata de estoque, de
 *    status interno do evento nem de configuração do produtor (política de
 *    taxa, teto por CPF, agrupamento de tela). Resposta pública é superfície
 *    de ataque e é presente pra cambista: o que a vitrine não precisa mostrar,
 *    ela não devolve.
 *
 * As funções exportadas daqui são a ÚNICA definição de "o que está à venda".
 * `eventos-publicos.get.ts` importa as mesmas — a home e a página do evento
 * discordarem sobre o "a partir de" já aconteceu e é o tipo de divergência que
 * ninguém vê, porque cada tela, sozinha, parece certa.
 */
import { q, q1 } from '../../utils/db'
import { disponivel } from '../../utils/estoque'
import { emData } from '../../utils/cupom'
import { faceComDesconto, precificar, type ModoTaxa } from '../../utils/dinheiro'
import { cotaDeMeias } from '../../utils/meia-entrada'

/** Abaixo disto a vitrine avisa "últimas unidades" — faixa, nunca o número. */
export const LIMIAR_ULTIMAS = 10

/**
 * Quantos ingressos cabem num pedido quando o evento não disser outra coisa
 * (`events.max_per_order`).
 *
 * Sem um teto assim, o único freio é o `max_per_order` de CADA lote — e vinte
 * linhas de seis ingressos são cento e vinte ingressos num clique só. Não é
 * hipótese de cambista: é o jeito mais barato de esvaziar um lote e revender
 * no portão.
 *
 * Mora AQUI, e não no checkout, porque a vitrine precisa do mesmo número: é
 * ela que anuncia o teto de cada linha e trava o botão de pagar. O checkout
 * reexporta daqui — duas constantes iguais é como a tela passa a deixar
 * montar 20 no dia em que a porta começar a recusar acima de 10.
 */
export const TETO_PADRAO_POR_PEDIDO = 20

/**
 * Lote que a vitrine ONLINE pode mostrar. Fragmento único, usado pelas duas
 * rotas públicas: lote só de bilheteria aparecendo na página é venda que o
 * comprador monta e o checkout recusa por canal.
 */
export const LOTE_DA_VITRINE = `l.visible AND 'online' = ANY(l.channels)`

export type SituacaoDoLote =
  | 'disponivel' | 'ultimas' | 'esgotado' | 'encerrado' | 'em_breve' | 'fechado'

/**
 * A linha do banco, com os nomes do banco. É de propósito: a conta de estoque
 * mora em `disponivel()` (utils/estoque.ts) e recebe a linha como ela veio, sem
 * uma cópia intermediária em português que possa envelhecer sozinha.
 */
export interface LoteParaSituacao {
  quantity: number
  sold: number
  reserved: number
  starts_at: string | Date | null
  expires_at: string | Date | null
  /**
   * A ordem que o PRODUTOR deu ao lote dentro do setor (`lots.sort_order`) —
   * é ela que diz qual é o "1º lote". Opcional: quem não selecionar a coluna
   * cai na posição do array, que é o comportamento antigo. Ver o empate em
   * `situacoesDoSetor`.
   */
  sort_order?: number | null
  /**
   * Soma do que sobrou nas VARIAÇÕES do lote (inteira, meia...), ou `null`
   * quando o lote não tem variação nenhuma. Ver `restaNoLote`.
   */
  restaNasVariacoes?: number | null
}

export interface EventoParaVenda {
  status: string
  starts_at: string | Date
  sales_end_at: string | Date | null
  sales_end_minutes_after: number | null
  /**
   * Fim do evento. É `NOT NULL` no schema, mas fica OPCIONAL aqui porque nem
   * toda consulta o traz — quem não selecionar a coluna simplesmente não ganha
   * a trava, em vez de quebrar. Ver o aviso em `portaDeVenda`.
   */
  ends_at?: string | Date | null
  timezone?: string | null
}

/** Status em que o evento não é público — nem por link direto. */
const NAO_PUBLICADOS = new Set(['rascunho', 'oculto'])

/**
 * `is_private` NÃO entra aqui. Evento privado existe justamente pra abrir por
 * link direto (pré-venda fechada, evento corporativo); o que ele não faz é
 * aparecer em listagem — isso quem resolve é `eventos-publicos.get.ts`.
 */
export function estaPublicado(ev: { status: string }): boolean {
  return !NAO_PUBLICADOS.has(ev.status)
}

/**
 * Quando a venda fecha. O painel aceita data fixa OU "X minutos após o início"
 * — o CHECK do banco garante que só um dos dois está preenchido. Ler só o
 * `sales_end_at` deixa o evento vendendo depois de fechado, e é a mentira mais
 * cara da vitrine porque ela só aparece quando alguém já pagou.
 */
export function fimDasVendas(ev: EventoParaVenda): Date | null {
  if (ev.sales_end_at) return new Date(ev.sales_end_at)
  if (ev.sales_end_minutes_after != null) {
    return new Date(new Date(ev.starts_at).getTime() + Number(ev.sales_end_minutes_after) * 60_000)
  }
  return null
}

/** Por que a porta está fechada. Vocabulário interno, nunca sai na resposta. */
export type MotivoDeFechamento =
  | 'cancelado' | 'adiado' | 'encerrado' | 'nao_publicado'
  | 'evento_terminou' | 'prazo_encerrado'

export interface PortaDeVenda {
  aberta: boolean
  motivo: MotivoDeFechamento | null
  /** O que o comprador lê. `null` só quando a porta está aberta. */
  recado: string | null
}

/**
 * **A porta de venda do evento. Uma regra, um lugar.**
 *
 * Esta função é a ÚNICA definição de "este evento vende agora", e o `recado`
 * dela é a ÚNICA frase que explica o não. A vitrine (`vendasAbertas` /
 * `avisoDeVenda`) e o checkout (`POST /api/checkout`) chamam as duas o mesmo
 * código de propósito: cada um tinha a sua versão, e as duas discordavam.
 *
 * O que foi medido antes de existir uma regra só, com um evento que terminou
 * ontem e `status` ainda em `ativo` (o caso mais comum: ninguém volta no painel
 * pra encerrar evento que já passou):
 *
 *   • `GET /api/e/zz-porta-fim` → `vendasAbertas: true`, `avisoDeVenda: null`,
 *     lote `disponivel` com `maxPorCompra: 6` — a vitrine montava a compra;
 *   • `POST /api/checkout` no mesmo lote → 409 "Este evento terminou em
 *     20/09/2026".
 *
 * A vitrine anunciava o que a porta ao lado recusava, e o comprador só
 * descobria depois de digitar CPF e e-mail. A causa era literal: a vitrine
 * olhava só `fimDasVendas()` e o checkout olhava também `ends_at`.
 *
 * **Ordem das perguntas, e por que ela é essa:** o `status` vem primeiro
 * porque cancelado e adiado são notícias diferentes de "acabou o prazo" e o
 * comprador precisa da notícia, não do prazo. Depois `ends_at` — evento que
 * terminou não vende ingresso, tenha configuração de venda ou não, e esse é o
 * caso de quem não preenche nenhum dos campos de encerramento. Por último o
 * prazo de venda configurado.
 *
 * ⚠️ `ends_at` é opcional na interface porque `eventos-publicos.get.ts` (a
 * home, que não é desta trilha) não seleciona a coluna: lá a trava de evento
 * terminado não roda e a home segue listando evento que já passou. Está
 * relatado na entrega — é uma coluna a mais no SELECT daquele arquivo.
 */
export function portaDeVenda(ev: EventoParaVenda, agora = new Date()): PortaDeVenda {
  const fechada = (motivo: MotivoDeFechamento, recado: string): PortaDeVenda =>
    ({ aberta: false, motivo, recado })
  const fuso = ev.timezone || 'America/Bahia'

  if (ev.status === 'cancelado') return fechada('cancelado', 'Este evento foi cancelado.')
  if (ev.status === 'adiado') {
    return fechada('adiado', 'Este evento foi adiado. Aguarde a nova data.')
  }
  if (ev.status === 'encerrado') return fechada('encerrado', 'Este evento já aconteceu.')
  if (ev.status !== 'ativo') {
    return fechada('nao_publicado', 'As vendas deste evento não estão abertas.')
  }

  if (ev.ends_at && new Date(ev.ends_at) <= agora) {
    return fechada('evento_terminou',
      `Este evento terminou em ${emData(ev.ends_at, fuso)} e não vende mais ingresso. `
      + 'Veja as próximas datas na página do evento.')
  }

  const fim = fimDasVendas(ev)
  if (fim && fim <= agora) {
    return fechada('prazo_encerrado',
      `As vendas deste evento encerraram em ${emData(fim, fuso)}.`)
  }

  return { aberta: true, motivo: null, recado: null }
}

export function vendasAbertas(ev: EventoParaVenda, agora = new Date()): boolean {
  return portaDeVenda(ev, agora).aberta
}

/** As duas únicas situações em que o botão "+" pode existir. */
export function compravel(s: SituacaoDoLote): boolean {
  return s === 'disponivel' || s === 'ultimas'
}

/**
 * Quanto o lote ainda vende DE VERDADE.
 *
 * A prateleira do lote (`quantity − sold − reserved`) é UM teto; a soma das
 * variações é outro, e vale o menor dos dois. Um lote com 40 lugares livres e
 * todas as variações esgotadas não vende nada, e olhar só a prateleira fazia
 * dois estragos ao mesmo tempo: o lote aparecia "disponível" sem uma única
 * linha comprável e, com giro ligado, ele continuava sendo o VIGENTE — o lote
 * seguinte ficava em "em breve" pra sempre, enquanto a home já dava o evento
 * por esgotado. Duas telas, duas respostas, as duas parecendo certas.
 *
 * `restaNasVariacoes` nulo = lote sem variação; aí a conta do lote é a conta
 * toda.
 */
export function restaNoLote(l: LoteParaSituacao): number {
  const naPrateleira = disponivel(l)
  if (l.restaNasVariacoes == null) return naPrateleira
  return Math.min(naPrateleira, Math.max(Number(l.restaNasVariacoes), 0))
}

/**
 * Soma, por lote, o que sobrou nas variações. Devolve o mapa que as duas rotas
 * penduram na linha do lote antes de decidir situação.
 *
 * `restam` sobrepõe a conta de prateleira quando quem chama já sabe de um teto
 * menor — hoje só a cota legal de meia-entrada (ver `restamPorTipo`). Quem não
 * mandar segue com `quantity − sold`, que é o que a home faz.
 */
export function restaDasVariacoes(
  tipos: Array<{ lot_id: string; quantity: number; sold: number; restam?: number }>,
): Map<string, number> {
  const porLote = new Map<string, number>()
  for (const t of tipos) {
    const sobra = t.restam != null
      ? Math.max(Number(t.restam), 0)
      : Math.max(Number(t.quantity) - Number(t.sold), 0)
    porLote.set(t.lot_id, (porLote.get(t.lot_id) ?? 0) + sobra)
  }
  return porLote
}

export interface TipoComEspecie {
  id: string
  lot_id: string
  /** `ticket_types.kind` (db/015): 'inteira' | 'meia' | 'gratuito' */
  kind?: string | null
  quantity: number
  sold: number
}
export interface LoteComCota {
  id: string
  quantity: number
  half_quota_bps?: number | null
}

/**
 * Quanto cada variação ainda vende DE VERDADE.
 *
 * A prateleira do tipo (`quantity − sold`) não é o único teto da meia-entrada:
 * a **cota legal** de 40% (Decreto 8.537/2015) é um segundo, e ela é do LOTE,
 * somando todos os tipos de meia dele. O checkout já a respeitava — só a
 * vitrine não, e por isso ela oferecia o que a porta ao lado recusava.
 *
 * Medido antes desta função, com um lote de 10 lugares cujo tipo "Meia-entrada"
 * tinha `quantity = 10` (o produtor pode criar assim; nada impede):
 *
 *   • `GET /api/e/zz-porta-repro` → meia com `esgotado: false`,
 *     `maxPorCompra: 6` — a tela deixava montar 5 meias;
 *   • `POST /api/checkout` com 5 meias → 409 "Restaram 3 meias-entradas".
 *
 * O seed não mostrava isso por acaso: lá a meia tem estoque menor que a cota,
 * então a prateleira acabava primeiro e a cota nunca chegava a decidir nada.
 *
 * Um detalhe que o comentário precisa carregar: quando o lote tem DOIS tipos
 * de meia ("Meia estudante" e "Meia idoso"), a cota é compartilhada e aqui
 * cada um recebe o saldo inteiro dela. Comprar os dois na mesma compra ainda
 * pode estourar — e quem recusa, com o número certo, é `conferirCotaDeMeia` no
 * checkout. A vitrine não tem como saber a divisão antes de o comprador
 * escolher; o que ela não pode é oferecer meia com a cota JÁ zerada, e isso
 * esta função fecha.
 */
export function restamPorTipo(lotes: LoteComCota[], tipos: TipoComEspecie[]): Map<string, number> {
  const saida = new Map<string, number>()
  for (const l of lotes) {
    const doLote = tipos.filter((t) => t.lot_id === l.id)
    if (!doLote.length) continue
    const meiasVendidas = doLote
      .filter((t) => t.kind === 'meia')
      .reduce((s, t) => s + Math.max(Number(t.sold), 0), 0)
    const naCota = Math.max(
      cotaDeMeias(Number(l.quantity), Number(l.half_quota_bps ?? 4000)) - meiasVendidas, 0)

    for (const t of doLote) {
      const naPrateleira = Math.max(Number(t.quantity) - Number(t.sold), 0)
      saida.set(t.id, t.kind === 'meia' ? Math.min(naPrateleira, naCota) : naPrateleira)
    }
  }
  return saida
}

/** Situação de UM lote, sem olhar os vizinhos do setor. */
function situacaoSozinho(
  l: LoteParaSituacao,
  ctx: { vendasAbertas: boolean; agora: Date },
): SituacaoDoLote {
  const resta = restaNoLote(l)
  // Esgotado e encerrado vêm antes de "vendas fechadas": são fatos do lote e
  // continuam verdadeiros depois que o evento fecha. O comprador que volta na
  // página merece saber que acabou, não só que fechou.
  if (resta <= 0) return 'esgotado'
  if (l.expires_at && new Date(l.expires_at) <= ctx.agora) return 'encerrado'
  if (!ctx.vendasAbertas) return 'fechado'
  if (l.starts_at && new Date(l.starts_at) > ctx.agora) return 'em_breve'
  return resta <= LIMIAR_ULTIMAS ? 'ultimas' : 'disponivel'
}

/**
 * Giro de lote: qual lote do setor está VIGENTE agora.
 *
 * Com `auto_rotate_lots` ligado, o setor vende UM lote por vez — o primeiro da
 * ordem que ainda tem estoque, já abriu e não venceu. Os anteriores ficam com
 * o que aconteceu com eles (esgotado/encerrado) e os seguintes viram
 * "em breve": é o que o produtor quer dizer com "1º lote / 2º lote", e sem
 * isso a página vende o 2º lote mais caro com o 1º ainda na prateleira.
 *
 * Desligado, cada lote responde por si e quem controla a abertura é a coluna
 * `visible` — que é o que se quer quando o 2º lote só pode abrir numa data
 * combinada com o patrocinador.
 *
 * ## Empate na ordem não é "depois"
 *
 * Quem decide o que vem antes é `lots.sort_order`, a ordem que o PRODUTOR deu
 * — não a posição da linha no resultado. A diferença aparece quando o setor
 * tem lotes EMPATADOS: antes esta função comparava índices, então num setor
 * cujos lotes estão todos em `sort_order = 0` o Postgres é que escolhia, pela
 * ordem física das linhas, quem era o "1º lote" — e os outros dois viravam
 * "em breve" sem que ninguém tivesse dito isso. Medido:
 *
 *     ZZ LOTE A: disponivel | ZZ LOTE GRATIS: em_breve | ZZ LOTE B: em_breve
 *
 * Resposta tirada de ordem física é resposta que pode mudar sozinha: basta um
 * UPDATE reescrever uma linha pra ela trocar de lugar, e aí o mesmo evento
 * vende um lote diferente em dois carregamentos da página, sem nenhuma
 * mudança de dado. Um comprador vê "esgotando", o outro vê "em breve".
 *
 * Por isso o empate mantém cada lote respondendo por si: sem ordem declarada
 * não existe "1º/2º", e inventar uma é pior do que não ter. Produtor de
 * verdade nunca cai aqui — os dois caminhos que criam lote
 * (`admin/evento/index.post.ts` e `admin/evento/[id]/ingressos.post.ts`) já
 * gravam `sort_order` distinto (`il + 1`, `MAX(sort_order) + 1`), e
 * `ordenar.patch.ts` reescreve pela posição. Empate só nasce de INSERT cru.
 *
 * Recebe os lotes na ordem de `sort_order` e devolve a situação de cada um na
 * mesma ordem.
 */
export function situacoesDoSetor(
  lotes: LoteParaSituacao[],
  ctx: { vendasAbertas: boolean; giroAutomatico: boolean; agora: Date },
): SituacaoDoLote[] {
  const sozinhos = lotes.map((l) => situacaoSozinho(l, ctx))
  if (!ctx.giroAutomatico) return sozinhos

  // Sem a coluna selecionada, a posição do array faz as vezes de ordem — é o
  // que a home faz, e assim ela não muda de comportamento por causa daqui.
  const ordens = lotes.map((l, i) => (l.sort_order == null ? i : Number(l.sort_order)))

  // O vigente é o comprável de MENOR ordem, não o primeiro da lista: assim a
  // resposta não depende de a consulta ter vindo ordenada.
  let vigente = -1
  for (let i = 0; i < sozinhos.length; i++) {
    if (compravel(sozinhos[i]!) && (vigente < 0 || ordens[i]! < ordens[vigente]!)) vigente = i
  }
  if (vigente < 0) return sozinhos

  const ordemVigente = ordens[vigente]!
  return sozinhos.map((s, i) => (compravel(s) && ordens[i]! > ordemVigente ? 'em_breve' : s))
}

export interface LotePrecificavel {
  id: string
  price_cents: number
  situacao: SituacaoDoLote
}
export interface TipoPrecificavel {
  lot_id: string
  discount_bps: number
  quantity: number
  sold: number
  /** teto menor que a prateleira, quando existe (cota de meia) */
  restam?: number
}

/**
 * A frase que explica por que ESTE lote não vende agora — a mesma na vitrine e
 * no checkout.
 *
 * Existe porque a vitrine e o checkout davam respostas diferentes sobre o
 * mesmo lote: com giro automático ligado, o 2º lote aparecia `em_breve` com
 * `maxPorCompra: 0` na tela e o `POST /api/checkout` nele respondia **200**,
 * criando pedido (PED-VU93-GARV, 6600 centavos — medido). `reservar()` confere
 * visible/datas/estoque/canal e não tem como saber qual lote é o VIGENTE: isso
 * é decisão do setor, e mora aqui.
 *
 * Devolve `null` quando o lote é comprável — quem chama usa isso como "pode
 * seguir".
 */
export function recadoDeLoteFechado(
  situacao: SituacaoDoLote,
  lote: { nome: string; abreEm?: string | Date | null; encerrouEm?: string | Date | null },
  fuso = 'America/Bahia',
): string | null {
  if (compravel(situacao)) return null
  const nome = `"${lote.nome}"`
  switch (situacao) {
    case 'esgotado':
      return `${nome} esgotou. Escolha outra opção na página do evento — `
        + 'reserva não paga volta pra venda em alguns minutos.'
    case 'encerrado':
      return lote.encerrouEm
        ? `${nome} encerrou em ${emData(lote.encerrouEm, fuso)}. `
          + 'Escolha um lote que ainda esteja à venda na página do evento.'
        : `${nome} encerrou. Escolha um lote que ainda esteja à venda na página do evento.`
    case 'em_breve':
      return lote.abreEm
        ? `${nome} ainda não está à venda: ele abre em ${emData(lote.abreEm, fuso)}.`
        : `${nome} ainda não está à venda — o lote em vigor neste setor é outro. `
          + 'Atualize a página do evento e escolha o lote que está aberto.'
    default:
      return 'As vendas deste evento não estão abertas.'
  }
}

/**
 * O "a partir de" honesto: o menor total que alguém consegue PAGAR agora.
 *
 * Só entra lote comprável e tipo com estoque — anunciar o preço de um lote
 * esgotado é isca, e o comprador descobre na página seguinte. Também entra o
 * desconto do tipo (meia-entrada): sem ele a home dizia R$ 30,00 num evento
 * cuja meia sai por R$ 15,00.
 */
export function menorTotalCents(args: {
  lotes: LotePrecificavel[]
  tipos: TipoPrecificavel[]
  feeBps: number
  modo: ModoTaxa
}): number | null {
  let menor: number | null = null
  for (const l of args.lotes) {
    if (!compravel(l.situacao)) continue
    const tiposDoLote = args.tipos.filter((t) => t.lot_id === l.id)
    const faces = tiposDoLote.length
      ? tiposDoLote
          .filter((t) => (t.restam != null ? Number(t.restam) : Number(t.quantity) - Number(t.sold)) > 0)
          .map((t) => faceComDesconto(Number(l.price_cents), Number(t.discount_bps)))
      : [Number(l.price_cents)]
    for (const face of faces) {
      const total = precificar(face, args.feeBps, args.modo).totalCents
      if (menor === null || total < menor) menor = total
    }
  }
  return menor
}

/** O que apertou o teto de compra desta linha. Uma palavra, nunca o número. */
export type TetoPor = 'estoque' | 'pedido' | 'cpf'

/**
 * Os tetos DUROS que o checkout aplica e que não dependem de quem está
 * comprando. Todos opcionais: coluna não selecionada não vira trava.
 */
export interface TetosDeCompra {
  /** `events.max_per_order` — quantos ingressos cabem num pedido só */
  porPedido?: number | null
  /** `events.max_per_customer` */
  porCpfNoEvento?: number | null
  /** `sectors.max_per_customer` */
  porCpfNoSetor?: number | null
  /** `lots.max_per_document`, só quando `limit_by_document` */
  porCpfNoLote?: number | null
  /** `ticket_types.max_per_customer` */
  porCpfNoTipo?: number | null
}

/**
 * **O teto que a vitrine anuncia é o teto que a porta aceita.**
 *
 * `maxPorCompra` saía de `min(lots.max_per_order, estoque)` e ignorava os
 * OUTROS cinco tetos que o checkout confere. Nenhum deles depende de quem
 * está comprando: são máximos que ninguém, nem na primeira compra da vida,
 * consegue passar. O resultado medido, com CPF que nunca comprou nada:
 *
 *   • lote com `limit_by_document` e `max_per_document = 2` → vitrine
 *     `maxPorCompra: 6`; `POST /api/checkout` com 6 → 409 "Cada CPF leva no
 *     máximo 2 de \"ZZ LOTE 2 POR CPF\"";
 *   • evento com `max_per_order = 4` → vitrine `maxPorCompra: 6`; checkout
 *     com 6 → 409 "Cada pedido leva no máximo 4 ingressos";
 *   • evento com `max_per_customer = 3` → checkout com 4 → 409;
 *   • setor com `max_per_customer = 2` → checkout com 3 → 409;
 *   • tipo com `max_per_customer = 1` → checkout com 2 → 409.
 *
 * Ou seja: o "+" da tela subia até 6 e a porta recusava no 3, depois do CPF.
 * É o mesmo defeito do lote esgotado com teto cheio, só que por outra coluna.
 *
 * **Sobre o comentário do topo do arquivo ("nada de configuração do
 * produtor").** A regra continua valendo pro que é agenda interna — política
 * de taxa, status, agrupamento. O teto de compra é outra coisa: ele é do
 * COMPRADOR, ele já sai na resposta hoje (misturado com o estoque) e o
 * checkout o entrega em texto no primeiro 409. Esconder aqui não guarda
 * segredo nenhum de quem tenta; só empurra o honesto até o CPF pra levar não.
 * O que continua fora é o número exato de estoque e qual coluna apertou —
 * `tetoPor` é uma palavra ('pedido'/'cpf'), não a configuração.
 *
 * Tetos por CPF são teto de TODO mundo: quem já comprou tem menos, nunca
 * mais. Clampar por eles nunca oferece menos do que a porta aceitaria.
 */
export function tetoDeCompra(base: number, t: TetosDeCompra): { teto: number; por: TetoPor } {
  const positivo = (n: number | null | undefined) =>
    n != null && Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null

  let teto = Math.max(Math.floor(base), 0)
  let por: TetoPor = 'estoque'

  const aperta = (limite: number | null | undefined, quem: TetoPor) => {
    const n = positivo(limite)
    if (n != null && n < teto) { teto = n; por = quem }
  }

  aperta(t.porPedido, 'pedido')
  aperta(t.porCpfNoEvento, 'cpf')
  aperta(t.porCpfNoSetor, 'cpf')
  aperta(t.porCpfNoLote, 'cpf')
  aperta(t.porCpfNoTipo, 'cpf')

  return { teto, por }
}

/**
 * Por que a venda está fechada, em texto que o comprador entende.
 * É o `recado` de `portaDeVenda` — a MESMA frase que o checkout devolve.
 */
const avisoDeVendaFechada = (ev: any, agora: Date): string | null =>
  portaDeVenda(ev, agora).recado

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) throw createError({ statusCode: 400, statusMessage: 'Link de evento incompleto' })

  const ev = await q1<any>(
    `SELECT e.id, e.name, e.slug, e.description, e.status, e.starts_at, e.ends_at,
            e.sales_end_at, e.sales_end_minutes_after, e.hide_end_date, e.age_rating,
            e.ticket_noun, e.auto_rotate_lots, e.timezone,
            e.venue_name, e.address, e.address_number, e.neighborhood, e.city, e.state,
            e.is_online, e.banner_url, e.thumb_url,
            e.fee_bps, e.fee_mode_online,
            e.support_kind, e.support_value,
            -- Os dois tetos do EVENTO que o checkout confere
            -- (conferirTetoPorPedido / conferirTetoPorDocumento). Sem eles a
            -- vitrine anunciava 6 num evento que so deixa levar 4. Ver
            -- tetoDeCompra. (Sem crase em comentario de SQL: ela fecha a
            -- template literal e o arquivo inteiro para de compilar.)
            e.max_per_order, e.max_per_customer,
            o.name AS organizacao
       FROM events e JOIN organizations o ON o.id = e.org_id
      WHERE e.slug = $1`, [slug])

  // Rascunho e oculto não existem pro comprador — nem por link direto. O 404 é
  // o mesmo do slug inexistente de propósito: resposta diferente confirmaria
  // que o evento existe e está sendo preparado.
  if (!ev || !estaPublicado(ev)) {
    throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  }

  const agora = new Date()
  const abertas = vendasAbertas(ev, agora)
  const modo: ModoTaxa = ev.fee_mode_online
  const bps = Number(ev.fee_bps)
  // O MESMO número que `conferirTetoPorPedido` usa no checkout — inclusive o
  // padrão quando o produtor não configurou nada. Sai na resposta porque o
  // teto por LINHA não consegue dizer isso sozinho: duas linhas de 6 num
  // evento que só leva 6 passam as duas e estouram juntas.
  const maxPorPedido = Number(ev.max_per_order ?? TETO_PADRAO_POR_PEDIDO)

  const linhas = await q<any>(
    `SELECT s.id AS setor_id, s.name AS setor, s.kind, s.description AS setor_descricao,
            s.max_per_customer AS setor_max_por_cpf,
            ses.id AS sessao_id, ses.title AS sessao, ses.starts_at AS sessao_inicio,
            l.id AS lote_id, l.name AS lote, l.description, l.price_cents,
            l.quantity, l.sold, l.reserved, l.expires_at, l.starts_at,
            l.min_per_order, l.max_per_order, l.half_quota_bps, l.sort_order,
            -- Teto por CPF do LOTE: só vale com a caixinha marcada. Entra no
            -- teto anunciado porque o checkout recusa por ele (ver tetoDeCompra).
            l.limit_by_document, l.max_per_document
       FROM sectors s
       JOIN lots l ON l.sector_id = s.id AND ${LOTE_DA_VITRINE}
       LEFT JOIN event_sessions ses ON ses.id = s.session_id
      WHERE s.event_id = $1
      ORDER BY s.sort_order, l.sort_order`, [ev.id])

  const tipos = await q<any>(
    `SELECT tt.id, tt.lot_id, tt.name, tt.quantity, tt.sold, tt.discount_bps,
            tt.kind, tt.requires_document, tt.sort_order, tt.max_per_customer
       FROM ticket_types tt
       JOIN lots l ON l.id = tt.lot_id AND ${LOTE_DA_VITRINE}
       JOIN sectors s ON s.id = l.sector_id
      WHERE s.event_id = $1
      ORDER BY tt.sort_order`, [ev.id])

  // Quanto cada variação ainda vende, com a COTA LEGAL da meia já descontada.
  // Sem isto a vitrine anunciava meia que o checkout recusa por cota. Entra
  // antes de tudo porque é ele que alimenta as duas contas de baixo.
  const restamDoTipo = restamPorTipo(
    linhas.map((l: any) => ({ id: l.lote_id, quantity: l.quantity, half_quota_bps: l.half_quota_bps })),
    tipos)
  for (const t of tipos) t.restam = restamDoTipo.get(t.id) ?? 0

  // O teto das variações vai pendurado na linha ANTES de decidir situação: sem
  // ele o lote que só tem prateleira (e nenhuma variação pra vender) trava o
  // giro do setor. Ver `restaNoLote`.
  const restaPorLote = restaDasVariacoes(tipos)
  for (const l of linhas) l.restaNasVariacoes = restaPorLote.get(l.lote_id) ?? null

  // Agrupa primeiro: o giro de lote é uma decisão do SETOR, não da linha.
  const setores = new Map<string, { setor: any; linhas: any[] }>()
  for (const l of linhas) {
    if (!setores.has(l.setor_id)) setores.set(l.setor_id, { setor: l, linhas: [] })
    setores.get(l.setor_id)!.linhas.push(l)
  }

  const paraPreco: LotePrecificavel[] = []
  const saida = [...setores.values()].map(({ setor, linhas: doSetor }) => {
    const situacoes = situacoesDoSetor(doSetor, {
      vendasAbertas: abertas, giroAutomatico: ev.auto_rotate_lots, agora,
    })

    return {
      id: setor.setor_id,
      nome: setor.setor,
      descricao: setor.setor_descricao,
      tipo: setor.kind,
      sessao: setor.sessao
        ? { titulo: setor.sessao, inicio: setor.sessao_inicio }
        : null,
      lotes: doSetor.map((l, i) => {
        const situacao = situacoes[i]
        const resta = restaNoLote(l)
        const aberto = compravel(situacao)
        paraPreco.push({ id: l.lote_id, price_cents: Number(l.price_cents), situacao })

        // Teto de compra: nunca acima do que realmente dá pra vender. Lote
        // fora da prateleira vai a ZERO — o valor cheio que ficava aqui é o
        // que deixava a tela montar 6 ingressos de um lote esgotado.
        //
        // E nunca acima do que a PORTA aceita: os tetos de pedido e por CPF
        // entram aqui por `tetoDeCompra`, senão o "+" sobe até 6 num lote que
        // o checkout corta em 2 — medido, com CPF que nunca comprou nada.
        const doLote = tetoDeCompra(aberto ? Math.min(Number(l.max_per_order), resta) : 0, {
          porPedido: maxPorPedido,
          porCpfNoEvento: ev.max_per_customer,
          porCpfNoSetor: setor.setor_max_por_cpf,
          porCpfNoLote: l.limit_by_document ? l.max_per_document : null,
        })
        const maxDoLote = doLote.teto

        const tiposDoLote = tipos.filter((t) => t.lot_id === l.lote_id)
        const variacoes = (tiposDoLote.length ? tiposDoLote : [null]).map((t: any) => {
          const face = t
            ? faceComDesconto(Number(l.price_cents), Number(t.discount_bps))
            : Number(l.price_cents)
          const p = precificar(face, bps, modo)
          // Estoque do tipo é um segundo teto: a meia acaba antes do lote, e
          // marcar só o lote fazia a meia esgotada continuar somável. Em
          // `restam` a cota legal de 40% já está descontada (`restamPorTipo`).
          const restaTipo = t ? Math.max(Number(t.restam), 0) : resta
          // O teto por CPF do TIPO ("no máximo 2 meias por pessoa") é o último
          // a apertar: ele vale só nesta linha, e o do lote já veio junto.
          const daLinha = tetoDeCompra(
            aberto ? Math.min(maxDoLote, restaTipo) : 0,
            { porCpfNoTipo: t?.max_per_customer ?? null })
          return {
            tipoId: t?.id ?? null,
            nome: t?.name ?? null,
            exigeDocumento: t?.requires_document ?? false,
            // A espécie do tipo, e não um palpite da tela. A vitrine deduzia
            // "é meia" de `exigeDocumento`, e errava no ingresso de preço
            // cheio COM documento: pedia o motivo, o comprador preenchia, e o
            // checkout devolvia 422 `meia_em_inteira` no último clique. Aqui
            // quem responde é a coluna gerada `ticket_types.kind` (db/015),
            // que é a MESMA régua que o checkout usa pra exigir o motivo.
            ehMeia: t ? t.kind === 'meia' : false,
            faceCents: p.faceCents,
            taxaCents: p.feeCents,
            totalCents: p.totalCents,
            esgotado: resta <= 0 || restaTipo <= 0,
            maxPorCompra: daLinha.teto,
            // Uma PALAVRA, não a configuração: é ela que deixa a tela dizer
            // "cada CPF leva no máximo N" em vez de "só restam N", que seria
            // mentira sobre a prateleira.
            tetoPor: daLinha.por === 'estoque' ? doLote.por : daLinha.por,
          }
        })

        return {
          id: l.lote_id,
          nome: l.lote,
          descricao: l.description,
          situacao,
          minPorCompra: Number(l.min_per_order),
          maxPorCompra: maxDoLote,
          tetoPor: doLote.por,
          // Data só quando ela quer dizer algo pro comprador: contagem
          // regressiva do que está à venda e aviso do que ainda vai abrir. Fora
          // disso é a agenda interna do produtor.
          expiraEm: aberto ? l.expires_at : null,
          abreEm: situacao === 'em_breve' ? l.starts_at : null,
          variacoes,
        }
      }),
    }
  })

  return {
    evento: {
      // O id fica: ele já é público em todo ingresso emitido (o QR é
      // `DT1:<evento>:<código>:<assinatura>`) e é por ele que a portaria
      // confere. O que sai daqui é identificador, não configuração.
      id: ev.id,
      nome: ev.name,
      slug: ev.slug,
      descricao: ev.description,
      vendasAbertas: abertas,
      avisoDeVenda: avisoDeVendaFechada(ev, agora),
      // Quantos ingressos cabem num pedido, somando TODAS as linhas. A tela
      // precisa dele porque o teto por linha não fecha a conta do carrinho:
      // com `max_per_order = 6`, 6 inteiras + 6 meias passam nas duas linhas,
      // o botão "Pagar" acendia, e o 409 "você escolheu 12" só chegava depois
      // do CPF. É o teto DO COMPRADOR, e o checkout já o diz em texto no
      // primeiro não.
      maxPorPedido,
      inicio: ev.starts_at,
      fim: ev.hide_end_date ? null : ev.ends_at,
      encerraVendas: fimDasVendas(ev),
      classificacao: ev.age_rating,
      substantivo: ev.ticket_noun,
      organizacao: ev.organizacao,
      // `stream_url` fica DE FORA: o link da transmissão é o produto: quem não
      // comprou não recebe o endereço da sala junto com a vitrine.
      local: ev.is_online
        ? { online: true }
        : {
            online: false, nome: ev.venue_name,
            endereco: [ev.address, ev.address_number, ev.neighborhood].filter(Boolean).join(', '),
            cidade: ev.city, estado: ev.state,
          },
      banner: ev.banner_url,
      thumb: ev.thumb_url,
      suporte: ev.support_value ? { tipo: ev.support_kind, valor: ev.support_value } : null,
      aPartirDeCents: menorTotalCents({ lotes: paraPreco, tipos, feeBps: bps, modo }),
    },
    setores: saida,
  }
})
