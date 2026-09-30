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
import { reais } from './formato'

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
  /**
   * O mínimo do LOTE e o nome dele (B32): o mínimo vale pela soma das linhas
   * do mesmo lote (2 inteiras + 2 meias num lote de mínimo 4 compram).
   * Opcionais: carrinho gravado antes deles continua valendo.
   */
  minDoLote?: number
  lote?: string
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

/** A variação sai de graça (face zero não paga taxa: o total da vitrine vem 0). */
export function ehGratis(v: any): boolean {
  return v != null && v.totalCents != null && Number(v.totalCents) === 0
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
 * O mínimo que ESTA linha precisa, dado o que as outras linhas do mesmo lote
 * já têm (B32). O mínimo é do LOTE: com 2 meias no carrinho, as inteiras de um
 * lote de mínimo 4 começam em 2, não em 4. Era linha a linha, na tela e no
 * servidor, e 2 + 2 não comprava.
 */
export function minimoDestaLinha(lote: any, outrasDoLote = 0): number {
  return Math.max(1, minimoDaLinha(lote) - Math.max(0, Math.floor(Number(outrasDoLote) || 0)))
}

/**
 * Por que esta linha não dá pra comprar agora — em português, ou `null` quando
 * dá. O caso que ninguém espera é o terceiro: lote com mínimo 4 e 2 na
 * prateleira não vende nada, e sem dizer isso o "+" fica travado sem motivo
 * visível.
 */
export function impedimentoDaLinha(lote: any, v: any, outrasDoLote = 0): string | null {
  const teto = tetoDaLinha(lote, v)
  if (v?.esgotado || teto <= 0) return 'Esgotado'
  const min = minimoDestaLinha(lote, outrasDoLote)
  if (min > teto) {
    return `Mínimo de ${minimoDaLinha(lote)} por compra, e só restam ${teto}`
  }
  return null
}

/**
 * O "+" e o "−" da vitrine, com mínimo e teto juntos.
 *
 * Sair do zero pula direto pro mínimo (o que falta pro mínimo do LOTE, contando
 * as outras linhas dele), e descer abaixo dele tira a linha do carrinho em vez
 * de parar num número que não pode ser comprado.
 */
export function ajustarQuantidade(
  atual: number, delta: number, lote: any, v: any, outrasDoLote = 0,
): number {
  const teto = tetoDaLinha(lote, v)
  const min = minimoDestaLinha(lote, outrasDoLote)
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
  // Só o motivo de credencial numerada tem o campo do número na tela. Nos outros, o
  // número que sobrou de uma troca de motivo (Estudante → Idoso) está ESCONDIDO: cobrar
  // dele seria travar a pessoa num campo que ela não vê (e `itensDoCheckout` não o manda).
  if (!MOTIVOS[motivo].exigeNumero) return null
  const documento = String(d?.documento ?? '').trim()
  if (!documento) return `Informe o número da ${MOTIVOS[motivo].documento}`
  // A porta recusa menos de 3 (`meia.documento` em checkout.post.ts): com 2 letras
  // a pessoa só descobria na ÚLTIMA tela, num 400 (matriz 23). A vitrine diz aqui.
  if (documento.length < 3) {
    return `O número da ${MOTIVOS[motivo].documento} tem pelo menos 3 caracteres`
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
  // B32: o mínimo é do lote, pela soma das linhas dele
  const porLote = new Map<string, { n: number; min: number; nome: string }>()
  for (const l of linhas) {
    const min = Math.floor(Number(l.minDoLote ?? 1))
    if (!(min > 1)) continue
    const atual = porLote.get(l.loteId) ?? { n: 0, min, nome: l.lote ?? l.nome }
    atual.n += Math.floor(Number(l.quantidade) || 0)
    porLote.set(l.loteId, atual)
  }
  for (const { n, min, nome } of porLote.values()) {
    if (n > 0 && n < min) saida.push(`${nome}: o mínimo por compra é ${min} — faltam ${min - n}`)
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
      // O número só vai com o motivo que tem o campo na tela: trocar de Estudante pra
      // Idoso escondia o campo com o número dentro, e ele ia junto — gravado num ingresso
      // de idoso, ou recusado pela porta (menos de 3) sem a pessoa ver onde corrigir.
      const comNumero = MOTIVOS[l.declaracao.motivo]?.exigeNumero === true
      item.meia = {
        motivo: l.declaracao.motivo,
        documento: comNumero ? String(l.declaracao.documento ?? '').trim() || undefined : undefined,
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
  // estorno parcial é venda de pé (B01): quem está nele também tem ingresso
  if (!resposta || !pedidoVivo(resposta.status)) return null
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

/* ===================================================================== */
/*  O RESTO DA COMPRA PÚBLICA — funções puras que as telas usam           */
/* ===================================================================== */

/**
 * A data no FUSO DO EVENTO (B24). `toLocaleString` sem `timeZone` escreve na
 * hora de quem abre: o servidor (America/Bahia) e o celular de quem está em
 * Manaus desenhavam horas diferentes — a hidratação trocava o texto e o
 * horário do evento saía errado. Fuso torto cai no do parque.
 */
export function dataNoFuso(
  v: string | number | Date | null | undefined, fuso?: string | null,
  estilo: 'extenso' | 'curta' = 'extenso',
): string {
  if (v == null || v === '') return '—'
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  const opcoes: Intl.DateTimeFormatOptions = estilo === 'curta'
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }
  try {
    return d.toLocaleString('pt-BR', { ...opcoes, timeZone: fuso || 'America/Bahia' })
  } catch {
    return d.toLocaleString('pt-BR', { ...opcoes, timeZone: 'America/Bahia' })
  }
}

/**
 * O código do promoter do link (`/e/<slug>?promoter=CODE`, B07) — ou `null`.
 * O link que o painel gera nunca era lido: a venda não ia pro promoter.
 */
export function codigoDePromoter(v: unknown): string | null {
  const s = String(Array.isArray(v) ? v[0] ?? '' : v ?? '').trim().toUpperCase()
  return /^[A-Z0-9_-]{1,40}$/.test(s) ? s : null
}

/** O carrinho gravado no `sessionStorage` (`dt:carrinho`). */
export interface CarrinhoGuardado {
  versao: number
  slug: string
  linhas: LinhaDoPedido[]
  totais: { face: number; taxa: number; total: number; n: number }
  promoter?: string | null
}

/**
 * O carrinho do jeito que vai pro `sessionStorage`.
 *
 * `comDocumento: false` é o que a vitrine grava a cada mudança (B19, pra o F5
 * não zerar a seleção): o número da carteirinha da meia fica de fora — dado
 * pessoal não precisa sobreviver ao F5. No clique de "Ir para pagamento" vai
 * inteiro, porque o checkout precisa dele.
 */
export function carrinhoParaGuardar(
  slug: string, linhas: LinhaDoPedido[], promoter: string | null,
  opcoes: { comDocumento: boolean },
): CarrinhoGuardado {
  return {
    versao: VERSAO_DO_CARRINHO,
    slug,
    linhas: linhas.map((l) => ({
      ...l,
      declaracao: l.declaracao
        ? { motivo: l.declaracao.motivo, documento: opcoes.comDocumento ? l.declaracao.documento : '' }
        : null,
    })),
    totais: totaisDoCarrinho(linhas),
    promoter: promoter ?? null,
  }
}

/**
 * De volta do F5 (ou do "← Voltar" do pagamento): o carrinho guardado vira
 * quantidades de novo — mas só o que a vitrine de AGORA ainda vende, e nunca
 * acima do teto de agora. Linha que sumiu, esgotou ou fechou fica de fora
 * (a vitrine é quem sabe o estoque; o `sessionStorage` só lembra a intenção).
 */
export function restaurarCarrinho(salvo: any, slug: string, setores: any[]): {
  quantidades: Record<string, number>
  declaracoes: Record<string, DeclaracaoDeMeia>
} {
  const quantidades: Record<string, number> = {}
  const declaracoes: Record<string, DeclaracaoDeMeia> = {}
  if (!salvo || salvo.versao !== VERSAO_DO_CARRINHO || salvo.slug !== slug || !Array.isArray(salvo.linhas)) {
    return { quantidades, declaracoes }
  }
  const lotes = new Map<string, any>()
  for (const s of setores ?? []) for (const l of s?.lotes ?? []) lotes.set(l.id, l)
  for (const linha of salvo.linhas) {
    const lote = lotes.get(linha?.loteId)
    if (!lote || !['disponivel', 'ultimas'].includes(lote.situacao)) continue
    const v = (lote.variacoes ?? []).find((x: any) => (x.tipoId ?? null) === (linha.tipoId ?? null))
    if (!v || v.esgotado) continue
    const n = Math.min(Math.floor(Number(linha.quantidade) || 0), tetoDaLinha(lote, v))
    if (n <= 0) continue
    const k = chaveDaLinha(lote.id, v.tipoId)
    quantidades[k] = n
    if (linha.declaracao) {
      declaracoes[k] = {
        motivo: String(linha.declaracao.motivo ?? ''),
        documento: String(linha.declaracao.documento ?? ''),
      }
    }
  }
  return { quantidades, declaracoes }
}

/* ------------------------------------------------ a tela de pagamento */

/**
 * O `id` do campo na tela de pagamento para o nome que o SERVIDOR usa em
 * `data.campo` (B11/B12). Os dois vocabulários só divergem em dois: o servidor
 * diz `documento`/`telefone`, a tela tem `#cpf`/`#tel`.
 */
const CAMPO_NA_TELA: Record<string, string> = { documento: 'cpf', telefone: 'tel' }
export const idDoCampo = (campo: string | null | undefined): string =>
  CAMPO_NA_TELA[String(campo ?? '')] ?? String(campo ?? '')

/** Os limites do formulário — os MESMOS do `Entrada` de `server/api/checkout.post.ts`. */
export const LIMITES_DO_FORMULARIO = {
  nome: 120, email: 254, instagram: 120, rua: 120, numero: 20, bairro: 80, cidade: 80, cupom: 40,
} as const

/**
 * O que a tela confere ANTES de gastar uma ida ao servidor (B11) — e o que o
 * "Continuar sem o cupom" também passa a conferir (B18: ele chamava o
 * pagamento por fora do `submit`, sem a validação do formulário, e o pedido
 * nascia sem cidade nem UF). Devolve o primeiro problema, na ordem da tela.
 */
export function conferirAntesDePagar(d: {
  nome: string; email: string; documento: string; telefone: string
  cidade: string; estado: string
}): { campo: string; recado: string } | null {
  const nome = d.nome.trim()
  if (nome.length < 3) return { campo: 'nome', recado: 'Digite o nome completo, como está no documento.' }
  if (nome.length > LIMITES_DO_FORMULARIO.nome) {
    return { campo: 'nome', recado: `O nome passou do limite de ${LIMITES_DO_FORMULARIO.nome} caracteres. Abrevie.` }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email.trim())) {
    return { campo: 'email', recado: 'Confira o e-mail: ele precisa ter o formato nome@provedor.com.br.' }
  }
  if (d.documento.replace(/\D/g, '').length !== 11) {
    return { campo: 'cpf', recado: 'CPF inválido. Confira os 11 números.' }
  }
  const tel = d.telefone.replace(/\D/g, '')
  if (tel && tel.length !== 10 && tel.length !== 11) {
    return { campo: 'tel', recado: 'Confira o celular: DDD + número (ex.: (73) 99999-0000).' }
  }
  if (d.cidade.trim().length < 2) return { campo: 'cidade', recado: 'Diga em que cidade você mora.' }
  if (!d.estado) return { campo: 'estado', recado: 'Escolha o estado (a sigla, ex.: BA).' }
  return null
}

/**
 * As parcelas do cartão sobre o total que VAI SER COBRADO — com o cupom
 * (B21: o rótulo usava o total antes do desconto) — e dizendo que não há
 * juros: o checkout manda `totalValue` ao Asaas, e é esse o total que o
 * comprador paga, dividido. O piso de R$ 5,00 por parcela é do Asaas (a porta
 * aplica a mesma conta: `maxParcelas` em checkout.post.ts).
 */
export function opcoesDeParcela(totalCents: number, pisoCents = 500): { n: number; rotulo: string }[] {
  const total = Math.max(0, Math.round(Number(totalCents) || 0))
  const max = Math.max(1, Math.min(12, Math.floor(total / pisoCents)))
  return Array.from({ length: max }, (_, i) => {
    const n = i + 1
    return { n, rotulo: n === 1 ? `À vista — ${reais(total)}` : `${n}× de ${reais(Math.ceil(total / n))} sem juros` }
  })
}

/**
 * O que a cobrança diz quando o pedido não está mais só "aguardando" (B34).
 * Sem estes ramos o cartão em análise de risco via o relógio zerar, "Tempo de
 * reserva esgotado", e a tela seguia consultando sem explicar nada.
 */
export function situacaoDaCobranca(status: string | null | undefined):
  { titulo: string; frase: string; final: boolean } | null {
  switch (status) {
    case 'em_analise':
      return { titulo: 'Pagamento em análise', final: false,
        frase: 'O cartão está em análise de segurança pela operadora. Não pague de novo: quando a '
          + 'análise terminar, esta tela muda sozinha — e a reserva fica de pé enquanto isso.' }
    // `estornado_parcial` NÃO entra aqui (B01): o estorno parcial devolve parte
    // do dinheiro e não cancela ingresso nenhum — a venda segue de pé, e a
    // tela trata como paga.
    case 'estornado':
      return { titulo: 'Pagamento devolvido', final: true,
        frase: 'O valor deste pedido foi devolvido. Os ingressos dele não valem na entrada.' }
    case 'chargeback':
    case 'disputa':
      return { titulo: 'Pagamento contestado', final: true,
        frase: 'O pagamento deste pedido foi contestado junto ao cartão. Fale com a bilheteria com o número do pedido.' }
    default:
      return null
  }
}

/** Os status em que a venda está de pé — a MESMA lista de `PEDIDO_VIVO` (server/utils/liquido.ts). */
export const STATUS_VIVOS = ['pago', 'estornado_parcial'] as const
export const pedidoVivo = (status: string | null | undefined) =>
  (STATUS_VIVOS as readonly string[]).includes(String(status ?? ''))

/* ===================================================================== */
/*  ESTADOS DE ERRO E SITUAÇÃO DO PEDIDO — as frases que não podem mentir */
/* ===================================================================== */

/**
 * O que houve com a consulta de uma página pública — ou `null` quando deu
 * certo (B10).
 *
 * Evento, pedido e transferência diziam "não encontrado" pra QUALQUER falha.
 * Com o banco fora do ar, quem tinha o link certo lia que o evento não existe
 * (ou que o pedido que ele pagou sumiu) — e ia embora, ou comprava de novo.
 * Só o 404 é "não existe"; o 429 é o freio de consulta (B15); o resto é a
 * bilheteria que não respondeu.
 */
export type FalhaDaConsulta = 'nao_encontrado' | 'freio' | 'fora_do_ar'
export function falhaDaConsulta(erro: any): FalhaDaConsulta | null {
  if (!erro) return null
  const status = Number(erro?.statusCode ?? erro?.status ?? erro?.response?.status ?? 0)
  if (status === 404 || status === 400) return 'nao_encontrado'
  if (status === 429) return 'freio'
  return 'fora_do_ar'
}

/**
 * A página de erro do site (`app/error.vue`, B25) — em português, dizendo o
 * que houve e pra onde ir. Sem ela o Nuxt mostrava a própria tela, em inglês.
 */
export function paginaDeErro(status: unknown, caminho = ''): {
  titulo: string; frase: string; tentarDeNovo: boolean; voltar: { para: string; rotulo: string }
} {
  const s = Number(status) || 500
  const p = String(caminho ?? '')
  const voltar = p.startsWith('/admin')
    ? { para: '/admin', rotulo: 'Voltar ao painel' }
    : { para: '/', rotulo: 'Ver os eventos à venda' }
  if (s === 404) {
    if (p.startsWith('/e/')) {
      return { titulo: 'Evento não encontrado', tentarDeNovo: false, voltar,
        frase: 'Confira o link ou fale com quem te mandou. Se ele veio por mensagem, às vezes a '
          + 'última parte do endereço fica de fora.' }
    }
    if (p.startsWith('/ingressos/')) {
      return { titulo: 'Pedido não encontrado', tentarDeNovo: false, voltar,
        frase: 'Confira o código do pedido: ele está no e-mail da compra e começa com PED-.' }
    }
    if (p.startsWith('/transferencia/')) {
      return { titulo: 'Link não encontrado', tentarDeNovo: false, voltar,
        frase: 'Confira se o endereço veio completo. Se veio por mensagem, às vezes a última parte '
          + 'do link fica de fora.' }
    }
    return { titulo: 'Página não encontrada', tentarDeNovo: false, voltar,
      frase: 'O endereço pode estar errado, ou esta página saiu do ar.' }
  }
  if (s >= 400 && s < 500) {
    return { titulo: 'Não deu para abrir esta página', tentarDeNovo: false, voltar,
      frase: 'O endereço pode estar incompleto. Volte ao início e tente de novo.' }
  }
  return { titulo: 'A bilheteria não respondeu agora', tentarDeNovo: true, voltar,
    frase: 'Não é com você: o sistema não conseguiu responder. Tente de novo em alguns instantes.' }
}

/**
 * Qual caminho deu erro, pra `paginaDeErro` escolher a frase. No navegador vale
 * a BARRA DE ENDEREÇO: numa navegação do próprio site que falhou (a vitrine
 * lança 404 num link seguido pelo roteador), a rota "atual" do Nuxt ainda é a
 * página de antes — medido no E2E: o evento que não existe lia "Página não
 * encontrada". No servidor vale a rota da requisição; `error.url` (a URL
 * inteira) é a última rede.
 */
export function caminhoDoErro(o: {
  enderecoDoNavegador?: string | null; rota?: string | null; url?: string | null
}): string {
  if (o.enderecoDoNavegador) return o.enderecoDoNavegador
  if (o.rota) return o.rota
  try { return new URL(String(o.url ?? ''), 'http://x').pathname } catch { return '' }
}

/**
 * "Endereço — Cidade/UF", sem pedaço solto (B31): evento sem logradouro
 * renderizava " — Cidade/UF", com o travessão na frente de nada.
 */
export function enderecoDoLocal(l: {
  endereco?: string | null; cidade?: string | null; estado?: string | null
} | null | undefined): string {
  if (!l) return ''
  const limpo = (x: unknown) => String(x ?? '').trim()
  const cidade = [limpo(l.cidade), limpo(l.estado)].filter(Boolean).join('/')
  return [limpo(l.endereco), cidade].filter(Boolean).join(' — ')
}

/**
 * A situação do pedido na página `/ingressos/<código>` (B01, B10): o selo, se
 * os ingressos aparecem, e a frase no lugar deles.
 *
 * Todo status que não era 'pago' lia "Este pedido ainda não foi pago" — o
 * estornado, o cancelado, o que expirou, o cartão recusado e o contestado. E o
 * estorno PARCIAL, cujos ingressos continuam valendo, dizia que o pedido não
 * foi pago.
 */
export interface SituacaoDoPedido {
  selo: { texto: string; classe: string }
  /** a venda está de pé: os ingressos aparecem, com QR */
  vivo: boolean
  /** o que dizer no lugar dos ingressos (ou em cima deles, no estorno parcial) */
  frase: string | null
  /** o rótulo do valor: "Total pago" só quando foi pago */
  rotuloDoTotal: string
}
export function situacaoDoPedido(
  status: string | null | undefined,
  extra: { estornadoCents?: number | null; pagoSemIngresso?: boolean } = {},
): SituacaoDoPedido {
  const fora = (texto: string, classe: string, frase: string | null): SituacaoDoPedido =>
    ({ selo: { texto, classe }, vivo: false, frase, rotuloDoTotal: 'Total' })
  switch (status) {
    case 'pago':
      return { selo: { texto: 'PAGO', classe: 'selo-ok' }, vivo: true, frase: null, rotuloDoTotal: 'Total pago' }
    case 'estornado_parcial': {
      const volta = Math.max(0, Math.round(Number(extra.estornadoCents) || 0))
      return {
        selo: { texto: 'PAGO · DEVOLUÇÃO PARCIAL', classe: 'selo-ok' }, vivo: true, rotuloDoTotal: 'Total pago',
        frase: `${volta > 0 ? `${reais(volta)} deste pedido foram devolvidos` : 'Parte do valor deste pedido foi devolvida'}. `
          + 'Os ingressos abaixo continuam valendo na entrada.',
      }
    }
    case 'aguardando_pagamento':
      return fora('AGUARDANDO PAGAMENTO', 'selo-alerta',
        'Este pedido ainda não foi pago, então os ingressos não foram emitidos.')
    case 'em_analise':
      return fora('EM ANÁLISE', 'selo-alerta',
        'O pagamento no cartão está em análise de segurança pela operadora. Não pague de novo: '
        + 'quando a análise terminar, os ingressos aparecem nesta página.')
    case 'expirado':
      // PIX pago depois do prazo e sem lugar: a página tem um bloco próprio
      // pra isso — "expirou" seria mentir pra quem pagou
      if (extra.pagoSemIngresso) return fora('PAGAMENTO RECEBIDO', 'selo-alerta', null)
      return fora('EXPIRADO', 'selo-neutro',
        'O prazo para pagar este pedido acabou e os ingressos voltaram para a venda. Se você pagou '
        + 'há pouco, toque em Atualizar daqui a alguns minutos; se não pagou, é só fazer uma nova compra.')
    case 'cancelado':
      return fora('CANCELADO', 'selo-erro',
        'Este pedido foi cancelado e os ingressos dele não valem na entrada. Se foi engano, fale com '
        + 'a bilheteria com o número do pedido.')
    case 'falhou':
      return fora('NÃO APROVADO', 'selo-erro',
        'O pagamento deste pedido não foi aprovado e nenhum ingresso foi emitido. Você pode fazer '
        + 'uma nova compra com outra forma de pagamento.')
    case 'estornado':
      return fora('DEVOLVIDO', 'selo-erro',
        'O valor deste pedido foi devolvido e os ingressos dele foram cancelados: não valem na entrada.')
    case 'chargeback':
    case 'disputa':
      return fora('CONTESTADO', 'selo-erro',
        'O pagamento deste pedido foi contestado junto à operadora do cartão, e os ingressos estão '
        + 'suspensos enquanto isso. Fale com a bilheteria com o número do pedido.')
    default:
      return fora(String(status ?? '').replace(/_/g, ' ').toUpperCase() || 'PEDIDO', 'selo-neutro',
        'Este pedido não foi concluído.')
  }
}
