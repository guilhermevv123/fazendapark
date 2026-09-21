/**
 * carrinhoDaVitrine.ts — as regras do carrinho da página pública.
 *
 * Mora fora do `.vue` por um motivo só: regra escrita dentro de `<script
 * setup>` não tem como ficar vermelha num teste. O que está aqui é exatamente
 * o que o comprador consegue MONTAR antes de o servidor ter chance de recusar
 * — teto por variação, mínimo do lote e a declaração de meia-entrada. Se
 * qualquer uma sumir daqui, o comprador só descobre no 409/422 com o cartão na
 * mão, e é isso que o teste de mutação enxerga (app/composables/
 * carrinhoDaVitrine.test.ts compra de verdade pela HTTP).
 *
 * O que este arquivo NÃO faz: preço. Nenhuma conta de centavo nasce aqui — a
 * vitrine já recebe `faceCents`/`taxaCents`/`totalCents` prontos do servidor
 * (server/api/e/[slug].get.ts) e o checkout relê tudo do banco. Somar é o que
 * a tela faz; decidir quanto custa, não.
 */
import { MOTIVOS, motivoValido } from '../../server/utils/meia-entrada'

/** Uma linha comprável da vitrine (inteira, meia…), como a rota devolve. */
export interface VariacaoDaVitrine {
  tipoId: string | null
  nome: string | null
  exigeDocumento: boolean
  faceCents: number
  taxaCents: number
  totalCents: number
  esgotado: boolean
  maxPorCompra: number
}

export interface LoteDaVitrine {
  id: string
  nome: string
  situacao: string
  minPorCompra: number
  maxPorCompra: number
  variacoes: VariacaoDaVitrine[]
}

/** O que o comprador declarou pra levar meia-entrada. */
export interface DeclaracaoDeMeia {
  motivo: string
  documento: string
}

/**
 * Uma linha do pedido já montada — é isto que atravessa o `sessionStorage`
 * entre a vitrine e o pagamento, então é chata de propósito: só tipos que
 * sobrevivem a um `JSON.stringify`, nada de referência pro objeto do lote.
 */
export interface LinhaDoPedido {
  loteId: string
  tipoId: string | null
  quantidade: number
  /** só pra tela do pagamento conseguir repetir o resumo */
  nome: string
  setor: string
  unitFaceCents: number
  unitTaxaCents: number
  unitTotalCents: number
  /** a vitrine pediu declaração de meia nesta linha? */
  pedeMeia: boolean
  declaracao: DeclaracaoDeMeia | null
}

/** A versão do formato acima. Carrinho de build velha volta pra vitrine. */
export const VERSAO_DO_CARRINHO = 2

export const chaveDaLinha = (loteId: string, tipoId: string | null | undefined) =>
  `${loteId}|${tipoId ?? ''}`

/**
 * Quantos desta linha cabem numa compra.
 *
 * É o teto da VARIAÇÃO, não o do lote: a meia acaba antes do lote inteiro, e
 * clampar pelo lote deixava a tela somar meia esgotada até o checkout recusar.
 * Os dois números vêm do servidor já descontados do estoque — o navegador
 * nunca inventa disponibilidade.
 */
export function tetoDaLinha(lote: any, v: any): number {
  const doLote = Number(lote?.maxPorCompra ?? 0)
  const daVariacao = Number(v?.maxPorCompra ?? doLote)
  const teto = Math.min(
    Number.isFinite(doLote) ? doLote : 0,
    Number.isFinite(daVariacao) ? daVariacao : 0,
  )
  return Math.max(teto, 0)
}

/**
 * O mínimo do LOTE (`lots.min_per_order`).
 *
 * Quem segura isto é só a tela: o checkout confere teto, cota e estoque, mas
 * não tem conferência de mínimo. Por isso o "+" já entra no mínimo em vez de
 * em 1 — deixar o comprador montar 1 num lote de mínimo 4 seria oferecer uma
 * compra que ninguém iria honrar no portão.
 */
export function minimoDaLinha(lote: any): number {
  const m = Math.floor(Number(lote?.minPorCompra ?? 1))
  return Number.isFinite(m) && m > 1 ? m : 1
}

/**
 * Por que esta linha não dá pra comprar agora — em português, ou `null` quando
 * dá. O caso que ninguém espera é o terceiro: lote com mínimo 4 e 2 na
 * prateleira não vende nada, e sem dizer isso o "+" fica travado sem motivo
 * visível.
 */
export function impedimentoDaLinha(lote: any, v: any): string | null {
  const teto = tetoDaLinha(lote, v)
  if (v?.esgotado || teto <= 0) return 'Esgotado'
  const min = minimoDaLinha(lote)
  if (min > teto) {
    return `Mínimo de ${min} por compra, e só restam ${teto}`
  }
  return null
}

/**
 * O "+" e o "−" da vitrine, com mínimo e teto juntos.
 *
 * Sair do zero pula direto pro mínimo do lote, e descer abaixo do mínimo tira
 * a linha do carrinho em vez de parar num número que não pode ser comprado.
 */
export function ajustarQuantidade(atual: number, delta: number, lote: any, v: any): number {
  const teto = tetoDaLinha(lote, v)
  const min = minimoDaLinha(lote)
  if (teto <= 0 || min > teto) return 0
  const bruto = Math.floor(Number(atual) || 0) + delta
  if (bruto <= 0) return 0
  if (bruto < min) return delta > 0 ? min : 0
  return Math.min(bruto, teto)
}

/**
 * Esta variação é meia-entrada — ou seja, o comprador precisa declarar POR QUE
 * tem direito (server/utils/meia-entrada.ts)?
 *
 * A regra de verdade é a coluna gerada `ticket_types.kind`
 * (db/015_meia_entrada.sql): desconto de 100% é gratuidade, desconto > 0 COM
 * documento é meia, o resto é inteira. A vitrine pública não recebe
 * `discount_bps` nem `kind` — recebe `exigeDocumento` e o preço já
 * precificado. Então dá pra reproduzir duas das três pernas:
 *
 *   • gratuidade sai por `totalCents === 0` (face zero não paga taxa);
 *   • "exige documento" é o campo que separa meia-entrada de promoção.
 *
 * Fica de fora um caso só: ingresso de preço cheio COM documento exigido
 * (`discount_bps = 0` e `requires_document`), que o banco classifica como
 * inteira e esta função chama de meia. Aí o checkout devolve 422
 * `meia_em_inteira` — e a tela de pagamento reenvia sem a declaração em vez de
 * deixar o comprador preso numa tela que pede o que o servidor recusa. Ver
 * `itensDoCheckout(..., { semDeclaracao: true })`.
 *
 * Quando a rota pública passar a devolver a espécie, esta função lê o valor do
 * banco e o parágrafo acima morre.
 */
export function pedeDeclaracaoDeMeia(v: any): boolean {
  return Boolean(v?.exigeDocumento) && Number(v?.totalCents ?? 0) > 0
}

/**
 * O que ainda falta na declaração desta linha, em texto que o comprador
 * resolve sozinho — ou `null` quando está completa.
 *
 * A lista de motivos e o "precisa do número?" saem de
 * server/utils/meia-entrada.ts, o MESMO módulo que o checkout consulta pra
 * recusar. Copiar os motivos pra cá faria a tela oferecer um motivo que o
 * servidor não conhece, e o comprador levaria 422 depois de preencher tudo.
 */
export function faltaNaDeclaracao(d: DeclaracaoDeMeia | null | undefined): string | null {
  const motivo = String(d?.motivo ?? '').trim()
  if (!motivo) return 'Escolha o motivo da meia-entrada'
  if (!motivoValido(motivo)) return 'Escolha um dos motivos previstos em lei'
  if (MOTIVOS[motivo].exigeNumero && !String(d?.documento ?? '').trim()) {
    return `Informe o número da ${MOTIVOS[motivo].documento}`
  }
  return null
}

/** Tudo que impede o carrinho de virar pedido, uma frase por linha travada. */
export function pendenciasDoCarrinho(linhas: LinhaDoPedido[]): string[] {
  const saida: string[] = []
  for (const l of linhas) {
    if (!l.pedeMeia) continue
    const falta = faltaNaDeclaracao(l.declaracao)
    if (falta) saida.push(`${l.nome}: ${falta.toLowerCase()}`)
  }
  return saida
}

/**
 * O corpo que vai pro `POST /api/checkout`.
 *
 * Só id, quantidade e a declaração — **nenhum preço**. Checkout que aceita
 * valor do navegador é checkout onde o comprador escolhe quanto pagar.
 *
 * `semDeclaracao` é a saída pro caso descrito em `pedeDeclaracaoDeMeia`: o
 * servidor disse que esta linha não é meia-entrada, então a tela reenvia sem a
 * declaração em vez de insistir num campo que o servidor recusa.
 */
export function itensDoCheckout(
  linhas: LinhaDoPedido[],
  opcoes: { semDeclaracao?: boolean } = {},
) {
  return linhas.map((l) => {
    const item: Record<string, unknown> = {
      lotId: l.loteId,
      ticketTypeId: l.tipoId ?? null,
      quantidade: l.quantidade,
    }
    if (!opcoes.semDeclaracao && l.pedeMeia && l.declaracao?.motivo) {
      item.meia = {
        motivo: l.declaracao.motivo,
        documento: String(l.declaracao.documento ?? '').trim() || undefined,
      }
    }
    return item
  })
}

/**
 * Pra onde mandar quem abriu o pagamento sem carrinho.
 *
 * Dois caminhos chegam aqui pelo mesmo buraco: F5 na tela de "deu certo" (o
 * `dt:pedido` é apagado no instante do pagamento, de propósito — se ficasse, a
 * próxima compra da aba reabriria o pedido velho em vez de cobrar o novo) e
 * link colado direto na barra. O primeiro é quem ACABOU DE PAGAR: devolver
 * essa pessoa pra "escolha seus ingressos" é o sistema dando a entender que a
 * compra não passou, e é assim que nasce a ligação pra bilheteria.
 *
 * Volta pra vitrine em tudo que não for um pagamento desta mesma aba E deste
 * mesmo evento — carimbo de outro evento mandaria o comprador pro ingresso
 * errado.
 */
export function destinoSemCarrinho(slug: string, pago: any): string {
  if (pago && pago.slug === slug && pago.pedido) return `/ingressos/${pago.pedido}`
  return `/e/${slug}`
}

/**
 * O carimbo de "esta aba pagou", que vai pra `dt:pago` — ou `null` quando a
 * resposta ainda não fecha um pagamento.
 *
 * Existe porque o carimbo tinha DOIS donos na tela de pagamento e só um deles
 * carimbava. O pedido vira `pago` por dois caminhos diferentes:
 *
 *   1. o vigia de 4 em 4 segundos vê `/api/pedido/:id` virar `pago` (PIX,
 *      cartão) — esse gravava;
 *   2. o PRÓPRIO `POST /api/checkout` já responde `status: 'pago'`, sem
 *      cobrança nenhuma, quando o total fecha em zero
 *      (server/api/checkout.post.ts: `if (total.totalCents === 0)`). É o
 *      ingresso de espécie `gratuito` — o "Criança até 3 anos" do parque — e o
 *      cupom de 100% num evento que absorve a taxa. Esse NÃO gravava.
 *
 * No caminho 2 a tela mostrava "Ingressos emitidos" com `dt:carrinho` já
 * apagado, `dt:pedido` nunca escrito e `dt:pago` vazio: F5 caía em
 * `destinoSemCarrinho(slug, null)` e devolvia pra "Escolha seus ingressos"
 * quem acabou de receber o ingresso — medido no navegador, pedido
 * PED-VM23-Q742. Uma função só, chamada pelos dois caminhos, é o que impede o
 * terceiro caminho de nascer sem carimbo.
 */
export function carimboDePago(
  slug: string, resposta: any, codigoConhecido?: string | null,
): { slug: string; pedido: string } | null {
  if (!resposta || resposta.status !== 'pago') return null
  const codigo = String(resposta.pedido ?? codigoConhecido ?? '').trim()
  // Sem código não há pra onde mandar ninguém, e meio carimbo é pior que
  // nenhum: `destinoSemCarrinho` teria que adivinhar.
  return codigo ? { slug, pedido: codigo } : null
}

/**
 * Soma do carrinho, em centavos inteiros.
 *
 * Face e taxa saem separadas porque a tela mostra as duas: o total já vem com
 * a taxa dentro, e o comprador precisa ver quanto dela é taxa ANTES do último
 * clique. Taxa que só aparece no fim do checkout é a maior fonte de abandono
 * medida no painel de origem.
 */
export function totaisDoCarrinho(linhas: LinhaDoPedido[]) {
  let face = 0, taxa = 0, total = 0, n = 0
  for (const l of linhas) {
    const q = Math.floor(Number(l.quantidade) || 0)
    face += Math.round(Number(l.unitFaceCents) || 0) * q
    taxa += Math.round(Number(l.unitTaxaCents) || 0) * q
    total += Math.round(Number(l.unitTotalCents) || 0) * q
    n += q
  }
  return { face, taxa, total, n }
}
