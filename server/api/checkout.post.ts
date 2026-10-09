/**
 * POST /api/checkout — monta o pedido, segura o estoque e cria a cobrança.
 *
 * Regra que governa o arquivo: **preço nunca vem do navegador**. O cliente diz
 * QUAIS lotes e QUANTOS; todo valor é relido do banco e recalculado aqui. Um
 * checkout que aceita `price` do front é um checkout onde o cliente escolhe
 * quanto pagar — e isso não aparece em teste nenhum, só no fechamento do mês.
 *
 * Ordem das operações, de propósito:
 *   1. fora da transação, só o que não decide nada sozinho: janela de venda,
 *      preços lidos do banco, teto de ingressos por pedido (aritmética pura)
 *   2. transação: teto por CPF → reserva estoque → cliente → cupom →
 *      grava pedido → COMMIT
 *   3. fora da transação: chama o Asaas e grava o retorno
 *
 * Cada limite é decidido COM A SUA TRAVA NA MÃO, dentro da transação que grava
 * o pedido. Limite conferido antes da transação passa em teste sequencial e
 * não segura nada: duas requisições leem "ainda cabe" no mesmo milissegundo e
 * as duas gravam.
 *
 * A chamada do gateway fica FORA da transação porque chamada externa dentro de
 * transação segura lock de linha pelo tempo da rede do terceiro. Numa virada
 * de lote isso trava a fila inteira.
 */
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { db, q, q1, tx } from '../utils/db'
import { CadastroInvalido, prepararCadastro, type Cadastro } from '../utils/cadastro'
import {
  EstoqueInsuficiente, liberar, LoteIndisponivel, prazoDeReserva, reservar,
} from '../utils/estoque'
import { faceDoTipo, somarPedido, type ModoTaxa } from '../utils/dinheiro'
import { beneficioDeFidelidade, travarCpfNaFidelidade, type BeneficioNoPedido } from '../utils/fidelidade'
import {
  aplicarCupom, CupomRecusado, PEDIDO_EM_PE, resgatarCupom, type Cupom,
} from '../utils/cupom'
import {
  acharOuCriarCliente, aplicarCobrancaConsultada, cartaoNoSiteLigado, centavosParaReais, cobrancaDoPedidoNoAsaas,
  criarCobranca, criarCobrancaComCartao, ErroAsaas, falhaPassageiraDoAsaas, pagamentoOnline, pagamentoPeloAsaas,
  type NovaCobranca,
  qrCodePix, recusaDeDadoDoComprador, telefoneParaAsaas, valorDaCobranca, vencimentoEmDias,
  type ConfigAsaas,
} from '../utils/asaas'
import { baseDoSite } from '../utils/envio'
import { conferirFreio, frearPortaPublica, ipDaRequisicao, marcarNoFreio } from '../utils/sessao'
import { conferirCartao, soDigitosDoCartao } from '../../app/composables/cartao'
import {
  conferirCotaDeMeia, CotaDeMeiaEsgotada, documentoExigido, MOTIVOS,
  MOTIVOS_EM_TEXTO, motivoValido,
} from '../utils/meia-entrada'
import {
  compravel, estaPublicado, LOTE_DA_VITRINE, portaDeVenda, recadoDeLoteFechado,
  restaDasVariacoes, restamPorTipo, situacoesDoSetor, TETO_PADRAO_POR_PEDIDO,
  type SituacaoDoLote,
} from './e/[slug].get'
import { gerarCodigo } from '../utils/ingresso'
import { cpfValido } from '../utils/documento'
import * as simulado from '../utils/gateway-simulado'
import { pixPeloMercadoPago } from '../utils/mercadopago-conta'
import { gerarPixDoPedido, type PixDoPedido } from '../utils/mercadopago'
import { compradorDaConta, contaDaSessaoDoCliente } from '../utils/conta-do-cliente'
import { TETO_POR_COMPRA } from '../utils/limite-de-compra'
import { diaDoCorteOnline, recadoDaVendaOnlineEncerrada, vendeOnlineAgora } from '../utils/dias-de-uso'

/**
 * Quantos ingressos cabem num pedido quando o evento não disser outra coisa.
 *
 * Mora em `e/[slug].get.ts` porque a VITRINE também precisa dele: ela anuncia
 * o teto de cada linha e trava o botão de pagar, e um segundo `= 20` aqui
 * seria duas verdades sobre o mesmo limite — a tela deixando montar 20 no dia
 * em que a porta passar a recusar acima de 10. Continua reexportado daqui
 * porque é aqui que ele recusa.
 */
export { TETO_PADRAO_POR_PEDIDO }

/**
 * Piso de cada parcela no cartão. É do Asaas (R$ 5,00): parcela menor ele
 * recusa, e a recusa chega DEPOIS de o comprador ter escolhido.
 *
 * A MESMA conta mora em `app/pages/e/[slug]/pagamento.vue` (`maxParcelas`) —
 * a tela oferece, a porta garante. O teste `checkout-parcelas.test.ts` lê o
 * número da tela e compara com este: se um mudar sem o outro, fica vermelho.
 */
export const PARCELA_MINIMA_CENTS = 500

/** Quantas parcelas cabem neste total: de 1 a 12, sem parcela abaixo do piso. */
export function maxParcelas(totalCents: number): number {
  return Math.max(1, Math.min(12, Math.floor(Number(totalCents) / PARCELA_MINIMA_CENTS)))
}

/**
 * As parcelas que vão de fato pro pedido e pro gateway.
 *
 * PIX é sempre à vista: parcelas num PIX viravam CARNÊ no Asaas (uma cobrança
 * por mês), e o webhook só entrega o ingresso na última — o comprador pagaria
 * a primeira e ficaria sem ingresso. No cartão, o pedido acima do teto é
 * LIMITADO ao teto e não recusado: a tela calcula o teto sobre o total antes
 * do cupom, e o cupom pode baixar o total depois da escolha — recusar ali é
 * derrubar uma compra por um desconto que o próprio comprador ganhou.
 */
export function parcelasDoPedido(forma: 'pix' | 'credito', pedidas: number, totalCents: number): number {
  if (forma !== 'credito') return 1
  return Math.min(Math.max(1, Math.floor(Number(pedidas) || 1)), maxParcelas(totalCents))
}

export const Entrada = z.object({
  eventSlug: z.string().min(1),
  itens: z.array(z.object({
    lotId: z.string().uuid(),
    ticketTypeId: z.string().uuid().nullish(),
    quantidade: z.number().int().positive().max(TETO_POR_COMPRA),
    /**
     * Declaração de meia-entrada da LINHA.
     *
     * É por linha e não por ingresso porque a linha é a unidade que o
     * comprador escolhe na vitrine ("2 meias de estudante"). Quem compra duas
     * meias por motivos diferentes manda duas linhas do mesmo tipo — o
     * checkout já soma linhas repetidas em todo teto e em toda reserva.
     *
     * `motivo` é validado contra a lista da lei em utils/meia-entrada.ts e não
     * por `z.enum` de propósito: o recado precisa dizer QUAIS motivos existem,
     * e o erro do Zod diria só "invalid enum value".
     */
    meia: z.object({
      motivo: z.string().min(1).max(40),
      documento: z.string().trim().min(3).max(40).optional(),
    }).nullish(),
  })).min(1).max(20),
  /**
   * Quem compra. Com a CONTA do cliente na sessão (034) este bloco é ignorado: quem compra é o
   * dono da conta. Sem conta ele ainda vale — só onde a organização não exige a conta.
   */
  comprador: z.object({
    nome: z.string().min(3).max(120),
    email: z.string().email(),
    documento: z.string().min(11).max(18),
    telefone: z.string().min(10).max(20).optional(),
    /**
     * O cadastro completo do formulário do site. TUDO opcional AQUI de
     * propósito: a rota também serve quem chega sem ele (integração antiga,
     * teste, o balcão de outro jeito) e recusar por falta de Instagram seria
     * derrubar venda. Quem EXIGE é a página. O que chega passa por
     * `prepararCadastro`, que é a única porta de validação desses campos.
     */
    nascimento: z.string().max(10).optional(),
    instagram: z.string().max(120).optional(),
    endereco: z.object({
      cep: z.string().max(12).optional(),
      rua: z.string().max(120).optional(),
      numero: z.string().max(20).optional(),
      bairro: z.string().max(80).optional(),
      cidade: z.string().max(80).optional(),
      estado: z.string().max(2).optional(),
      complemento: z.string().max(80).optional(),
    }).optional(),
    /**
     * IGNORADA desde 27/09 (B17). Não existe login de cliente: a senha era
     * coleta sem finalidade (LGPD) e deixava qualquer um gravar a PRIMEIRA
     * senha de um e-mail alheio — a conta nasceria com a senha do invasor no
     * dia em que o login existisse. Continua aceita no corpo só pra página
     * antiga em cache não levar 400; nada dela é conferido nem gravado.
     */
    senha: z.string().max(200).optional(),
    /** `true`/`false` só quando a pessoa marcou/desmarcou; ausente NÃO mexe no consentimento. */
    aceitaNovidades: z.boolean().optional(),
  }).optional(),
  cupom: z.string().max(40).optional(),
  promoter: z.string().max(40).optional(),
  // `debito` é o cartão à vista: a fatura do Asaas de CREDIT_CARD é quem oferece o débito (a API
  // não recebe dado de cartão de débito). Por dentro vira `credito` em 1×.
  forma: z.enum(['pix', 'credito', 'debito']).default('pix'),
  parcelas: z.number().int().min(1).max(12).default(1),
  /**
   * Cartão de CRÉDITO digitado no site (05/10), só com `CARTAO_NO_SITE=1` — desligado, é ignorado e
   * o cartão vai pela fatura do Asaas como sempre. Débito nunca vem aqui (a API não aceita). Sai do
   * corpo logo depois do parse: não entra em `dados`, não é gravado nem logado.
   */
  cartao: z.object({
    numero: z.string().max(25),
    titular: z.string().max(40),
    mes: z.string().max(2),
    ano: z.string().max(4),
    cvv: z.string().max(4),
    cep: z.string().max(9),
    numeroEndereco: z.string().max(10),
    /** o cartão é de outra pessoa: o CPF dela (o antifraude do banco confere titular e CPF) */
    cpfTitular: z.string().max(14).optional(),
  }).optional(),
})

export default defineEventHandler(async (event) => {
  // B03: a porta pública mais cara do sistema — cada pedido segura estoque e
  // fala com o Asaas — não tinha freio nenhum. Antes de qualquer trabalho.
  frearPortaPublica(event, 'checkout')

  const body = await readBody(event)
  const p = Entrada.safeParse(body)
  if (!p.success) throw recusaDeFormato(p.error)
  // A conta do cliente (034): com ela na sessão, quem compra é o DONO DA CONTA, e o `comprador`
  // do corpo é ignorado. Sem ela, só passa onde a organização não exige a conta (conferido depois
  // de ler o evento).
  const conta = await contaDaSessaoDoCliente(event)
  const comprador = conta ? compradorDaConta(conta) : p.data.comprador
  if (!comprador) {
    throw createError({ statusCode: 401, statusMessage: 'Entre na sua conta para comprar.',
      data: { tipo: 'conta' } })
  }
  const debito = p.data.forma === 'debito'
  const { cartao: cartaoDoCorpo, ...semCartao } = p.data
  const dados = {
    ...semCartao, comprador,
    forma: (debito ? 'credito' : p.data.forma) as 'pix' | 'credito',
    parcelas: debito ? 1 : p.data.parcelas,
  }
  const documento = dados.comprador.documento.replace(/\D/g, '')
  if (!cpfValido(documento)) {
    throw createError({ statusCode: 400, statusMessage: 'CPF inválido. Confira os 11 números.',
      data: { tipo: 'cadastro', campo: 'documento' } })
  }
  // Cartão no site: conferido ANTES de reservar lugar (a mesma conta da tela, composables/cartao.ts).
  const cartao = !debito && dados.forma === 'credito' && cartaoDoCorpo && cartaoNoSiteLigado()
    ? conferirCartaoDoCorpo(cartaoDoCorpo, documento)
    : null

  // B04: quem testa dicionário de cupom não usa o checkout de atalho; e o
  // balde de INGRESSOS é o que segura o estoque de verdade (B03) — pedido de
  // um é barato, sessenta lugares presos por um script não.
  if (dados.cupom) conferirFreio(event, 'cupom_errado')
  const ingressosPedidos = dados.itens.reduce((soma, i) => soma + i.quantidade, 0)
  conferirFreio(event, 'checkout_ingressos', ingressosPedidos)

  // O cadastro é conferido ANTES de qualquer trava. A senha NÃO entra (B17):
  // sem login de cliente ela não tem finalidade — ver o campo no `Entrada`.
  let cadastro: Cadastro
  try {
    cadastro = prepararCadastro({ ...dados.comprador, senha: null }, {
      email: dados.comprador.email, documento })
  } catch (e) {
    if (e instanceof CadastroInvalido) {
      throw createError({ statusCode: 400, statusMessage: e.message,
        data: { tipo: 'cadastro', campo: e.campo } })
    }
    throw e
  }

  // ------------------------------------------------------------- 1. evento
  const ev = await q1<any>(
    `SELECT e.*, o.asaas_api_key, o.asaas_env, o.asaas_wallet, o.mp_access_token, o.mp_test,
            o.customer_account_required
       FROM events e JOIN organizations o ON o.id = e.org_id
      WHERE e.slug = $1`, [dados.eventSlug])
  // Rascunho e oculto: o MESMO 404 do slug que não existe, igual à vitrine.
  // Um 409 aqui ("As vendas deste evento não estão abertas") contra um 404 no
  // slug inventado é um oráculo: dá pra varrer nomes de slug e descobrir qual
  // lançamento está montado no painel antes do anúncio. A vitrine esconde
  // isso de propósito (`estaPublicado`) e a porta tem que esconder igual.
  if (!ev || !estaPublicado(ev)) {
    throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  }

  // A MESMA porta da vitrine, com a MESMA frase (server/api/e/[slug].get.ts).
  // Enquanto eram duas funções, a vitrine dava um evento terminado ontem por
  // `vendasAbertas: true` e o checkout respondia 409 nele — a tela montava a
  // compra e o não chegava depois do CPF.
  const porta = portaDeVenda(ev)
  if (!porta.aberta) {
    throw createError({ statusCode: 409, statusMessage: porta.recado!,
      data: { tipo: 'venda_fechada', motivo: porta.motivo } })
  }

  // A conta é da organização: a de um parque não compra no outro.
  if (conta && conta.orgId !== ev.org_id) {
    throw createError({ statusCode: 401, statusMessage: 'Entre com a sua conta deste site para comprar.',
      data: { tipo: 'conta' } })
  }
  if (!conta && ev.customer_account_required) {
    throw createError({ statusCode: 401, statusMessage: 'Entre na sua conta para comprar.',
      data: { tipo: 'conta' } })
  }

  // --------------------------------------------- 2. preços, lidos do banco
  const lotIds = [...new Set(dados.itens.map((i) => i.lotId))]
  const lotes = await q<any>(
    `SELECT l.id, l.name, l.price_cents, l.sector_id,
            l.limit_by_document, l.max_per_document,
            s.event_id, s.kind
       FROM lots l JOIN sectors s ON s.id = l.sector_id
      WHERE l.id = ANY($1::uuid[])`, [lotIds])
  const porLote = new Map(lotes.map((l) => [l.id, l]))
  for (const it of dados.itens) {
    const l = porLote.get(it.lotId)
    if (!l) throw createError({ statusCode: 404, statusMessage: 'Lote não encontrado' })
    if (l.event_id !== ev.id) {
      // lote de outro evento no mesmo pedido: ou é bug de front ou é tentativa
      throw createError({ statusCode: 400, statusMessage: 'Lote não pertence a este evento' })
    }
  }

  const tipoIds = dados.itens.map((i) => i.ticketTypeId).filter(Boolean) as string[]
  // `max_per_customer` entra aqui porque a conferência lá embaixo lê ele: a
  // coluna existe desde o schema e o SELECT não a trazia, então o teto por
  // tipo ("no máximo 2 meias por CPF") era `undefined` e nunca recusava nada.
  // Limite que não recusa é pior que limite nenhum — o produtor configura,
  // vê na tela e acredita.
  const tipos = tipoIds.length
    ? await q<any>(`SELECT id, lot_id, name, kind, discount_bps, price_cents, requires_document, max_per_customer,
                           valid_dates::text[] AS dias
                      FROM ticket_types WHERE id = ANY($1::uuid[])`, [tipoIds])
    : []
  const porTipo = new Map(tipos.map((t) => [t.id, t]))

  // Lote que tem variação (inteira/meia/…) só vende COM a variação. Sem esta
  // porta, um item sem `ticketTypeId` num lote de meia e inteira passava pelo
  // preço cheio do lote, sem sair da cota de nenhum tipo — a soma das
  // variações deixava de fechar com o lote e a meia podia "sobrar" com o lote
  // esgotado. A vitrine sempre manda o tipo; quem chega sem ele montou a
  // requisição na mão.
  const lotesComTipo = await q<{ lot_id: string }>(
    `SELECT DISTINCT lot_id FROM ticket_types WHERE lot_id = ANY($1::uuid[])`, [lotIds])
  const exigeTipo = new Set(lotesComTipo.map((r) => r.lot_id))
  for (const it of dados.itens) {
    if (!it.ticketTypeId && exigeTipo.has(it.lotId)) {
      throw createError({ statusCode: 400,
        statusMessage: `Escolha o tipo de ingresso de "${porLote.get(it.lotId)!.name}" `
          + '(inteira, meia-entrada…) antes de pagar.',
        data: { tipo: 'tipo_obrigatorio', lotId: it.lotId } })
    }
  }

  // PRAZO DA VENDA ONLINE (dono, 09/10): o ingresso de um dia não vende pelo site depois da
  // meia-noite que começa esse dia — a MESMA régua da vitrine (`vendeOnlineAgora`). Quem montou a
  // compra antes da virada e pagou depois leva o não aqui, antes de qualquer reserva ou cobrança.
  for (const it of dados.itens) {
    const dias = it.ticketTypeId ? porTipo.get(it.ticketTypeId)?.dias : null
    if (!vendeOnlineAgora(dias, ev.starts_at, ev.timezone)) {
      throw createError({ statusCode: 409,
        statusMessage: recadoDaVendaOnlineEncerrada(diaDoCorteOnline(dias, ev.starts_at, ev.timezone)),
        data: { tipo: 'venda_online_encerrada', lotId: it.lotId, ticketTypeId: it.ticketTypeId ?? null } })
    }
  }

  const modo: ModoTaxa = ev.fee_mode_online
  const linhas = dados.itens.map((it) => {
    const lote = porLote.get(it.lotId)!
    let face = Number(lote.price_cents)
    if (it.ticketTypeId) {
      const t = porTipo.get(it.ticketTypeId)
      if (!t) throw createError({ statusCode: 404, statusMessage: 'Tipo de ingresso não encontrado' })
      if (t.lot_id !== it.lotId) {
        throw createError({ statusCode: 400, statusMessage: 'Tipo de ingresso não é deste lote' })
      }
      // preço próprio ABAIXO do lote é desconto ("Criança R$ 20"): não acumula com o Volte Mais, igual à meia
      t.abaixoDoLote = t.price_cents != null && Number(t.price_cents) < face
      face = faceDoTipo(face, Number(t.discount_bps), Number(ev.fee_bps), modo, (t.price_cents == null ? null : Number(t.price_cents)))
    }
    return { quantidade: it.quantidade, faceUnitCents: face }
  })

  // ------------------------------------------- 3. teto de ingressos por pedido
  conferirTetoPorPedido(ev, dados.itens)

  // ---------------------------------- 3a. dá pra cobrar online? (PROD-06)
  // Sem jeito de cobrar, a recusa sai AQUI — antes de reservar estoque e de
  // gravar cadastro. Era no último clique, com o formulário inteiro preenchido,
  // o cadastro já gravado e o lugar reservado e devolvido. Pedido que pode
  // fechar em zero (cupom, lote gratuito) não precisa de gateway: só recusa
  // quando há face a cobrar e nenhum cupom que possa zerá-la — o cupom é
  // conferido lá dentro, e o que sobrar é recusado depois dele.
  // Pela FORMA escolhida: o Pix pode sair pelo Mercado Pago (28/09); o cartão, só pelo Asaas.
  const online = pagamentoOnline(ev, dados.forma)
  if (!online.ok) {
    const face = linhas.reduce((soma, l) => soma + l.faceUnitCents * l.quantidade, 0)
    // Volte Mais (037) configurado como "retorno grátis" (100%) zera o pedido sem gateway nenhum —
    // a mesma exceção do cupom. A conta aqui é só a PRÉVIA (sem trava); quem decide é a transação.
    const zeraPelaFidelidade = face > 0 && !dados.cupom && !!conta
      && await fidelidadeZeraOPedido(ev, documento, dados.itens, linhas, porTipo, face)
    if (face > 0 && !dados.cupom && !zeraPelaFidelidade) {
      console.warn(`[checkout] pagamento online indisponível em ${ev.slug}: ${online.motivo}`)
      throw createError({ statusCode: 503, statusMessage: online.recado,
        data: { tipo: 'pagamento_indisponivel', motivo: online.motivo } })
    }
  }

  // ------------------------------- 3b. quem declarou direito a meia-entrada
  // Aritmética pura sobre o que já foi lido do banco: pode ficar aqui fora.
  // A COTA não — ela é soma sobre o lote e só decide coisa com a trava do
  // lote na mão, lá dentro da transação.
  const meia = conferirDeclaracoesDeMeia(dados.itens, porLote, porTipo)

  let promoter: any = null
  if (dados.promoter) {
    promoter = await q1<any>(
      `SELECT * FROM promoters WHERE event_id = $1 AND upper(code) = upper($2) AND active = true`,
      [ev.id, dados.promoter])
    // promoter inválido não derruba a venda: só não credita ninguém
  }

  // ---------- 4. transação: tetos + reserva + cupom + grava pedido ---------
  //
  // O que mudou de lugar, e por quê: o teto por CPF e o cupom eram conferidos
  // AQUI FORA, antes da transação. Os dois passavam em teste sequencial e não
  // seguravam nada — duas requisições do mesmo CPF (ou do mesmo cupom) leem
  // "ainda cabe" no mesmo milissegundo e as duas gravam. É o jeito mais barato
  // de furar os dois limites, e é exatamente o que um script de cambista faz.
  // Agora cada decisão é tomada com a sua própria trava na mão, dentro da
  // mesma transação que grava o pedido.
  //
  // A ORDEM DAS TRAVAS é fixa e vale pra todo mundo que vende (aqui e no
  // balcão): CPF → lotes → cliente → cupom. Duas transações que peguem os
  // mesmos dois recursos em ordens opostas travam uma na outra pra sempre.
  const codigo = gerarCodigo('PED')
  // Até quando este pedido segura o lote. A janela é do evento; o clamp mora
  // em prazoDeReserva pra um `hold_minutes` torto não virar `Invalid Date` no
  // INSERT (pedido não nasce) nem reserva de semanas (lugar preso).
  const expiraEm = prazoDeReserva(ev.hold_minutes)

  const pedido = await tx(async (c) => {
    await conferirTetoPorDocumento(c, ev, dados.itens, documento, porLote, porTipo, linhas)

    // Volte Mais (037): o desconto de fidelidade é decidido AQUI, com a trava do CPF no programa
    // na mão — duas abas do mesmo cliente não gastam o mesmo retorno. Só com a CONTA na sessão (o
    // CPF é o dela, não o do corpo) e sem cupom (não acumulam). A regra inteira mora em
    // utils/fidelidade.ts; aqui só entram as linhas com a face JÁ do tipo (meia não recebe).
    let fidelidade: BeneficioNoPedido | null = null
    if (conta) {
      await travarCpfNaFidelidade(c, ev.org_id, documento)
      fidelidade = await beneficioDeFidelidade(c, {
        orgId: ev.org_id, evento: { id: ev.id, inicio: ev.starts_at, fuso: ev.timezone }, documento,
        linhas: dados.itens.map((it, i) => {
          const t = it.ticketTypeId ? porTipo.get(it.ticketTypeId) : null
          return { faceUnitCents: linhas[i]!.faceUnitCents, quantidade: it.quantidade,
                   tipoComDesconto: !!t && (Number(t.discount_bps) > 0 || !!t.requires_document || !!t.abaixoDoLote) }
        }),
        temCupom: !!dados.cupom,
      })
    }
    const comFidelidade = fidelidade?.aplica ? fidelidade : null

    // O que a vitrine mostra fechado, a porta recusa — e com a frase dela.
    // Vem antes de `reservar` porque é uma pergunta de outra natureza ("este
    // lote está à venda?") e porque o recado dela é mais útil que "Lote não
    // está disponível": ele diz qual lote abrir no lugar.
    await conferirVitrine(c, ev, dados.itens)

    await reservar(c, dados.itens.map((i) => ({
      lotId: i.lotId, ticketTypeId: i.ticketTypeId ?? null, quantidade: i.quantidade,
    })), { canal: 'online' })

    // A cota de meia, com a trava do lote já na mão (`reservar` travou cada
    // lote e em Postgres a trava dura até o COMMIT). Vem DEPOIS da reserva de
    // propósito: a reserva já somou este pedido em `ticket_types.sold`, então
    // o que se conta aqui é o mundo COM esta venda dentro — que é a pergunta
    // certa ("se passar, estoura?"). Conferir antes é o furo clássico: dois
    // compradores leem "ainda cabe" no mesmo milissegundo e os dois gravam.
    for (const [lotId, quantas] of [...meia.porLote].sort((a, b) => a[0].localeCompare(b[0]))) {
      await conferirCotaDeMeia(c, lotId, quantas)
    }

    // O CLIENTE — quem é dono do e-mail, e o que dá pra escrever nele ANTES de
    // pagar. As regras moram em `gravarCliente`, logo abaixo do handler.
    const cliente = await gravarCliente(c, {
      orgId: ev.org_id, email: dados.comprador.email.toLowerCase(), documento,
      nome: dados.comprador.nome, telefone: dados.comprador.telefone ?? null, cadastro,
    })

    // O cupom é o ÚLTIMO a ser travado, depois do cliente, porque o balcão
    // pega esses dois na mesma ordem (utils não, rota: pdv/venda.post.ts).
    // Inverter aqui criaria o abraço mortal clássico entre as duas rotas.
    const cupom: Cupom | null = dados.cupom
      ? await resgatarCupom(c, {
          eventId: ev.id, codigo: dados.cupom, documento,
          lotIdsDoPedido: dados.itens.map((i) => i.lotId),
          fuso: ev.timezone,
        })
      : null

    // Fidelidade e cupom não acumulam (o benefício nem é calculado com cupom): um OU outro.
    const total = comFidelidade
      ? somarPedido(linhas, Number(ev.fee_bps), modo, { kind: 'fixo', value: comFidelidade.cents })
      : aplicarCupom(linhas, Number(ev.fee_bps), modo, cupom)
    // Sobre o total JÁ com cupom: é ele que o gateway parcela.
    const parcelas = parcelasDoPedido(dados.forma, dados.parcelas, total.totalCents)

    // `cadastro_pendente` (B14, db/028): o formulário inteiro vai com o PEDIDO,
    // e o gatilho `pedido_pago_aplica_cadastro` passa pro cadastro quando o
    // pedido vira 'pago' — inclusive o consentimento de novidades, que agora só
    // vale com a compra paga. O que foi escrito no cliente antes disso é só o
    // que ninguém precisou provar (ver `gravarCliente`).
    const ord = await c.query(
      `INSERT INTO orders (org_id, event_id, customer_id, code, status, channel,
                           face_cents, fee_cents, platform_cents, discount_cents, total_cents,
                           payment_method, installments, promo_code_id, promoter_id, expires_at,
                           cadastro_pendente, customer_account_id,
                           loyalty_program_id, loyalty_discount_cents)
       VALUES ($1,$2,$3,$4,'aguardando_pagamento','online',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
               $15::jsonb, $16, $17, $18)
       RETURNING id, code`,
      [ev.org_id, ev.id, cliente.id, codigo,
       total.faceCents, total.feeCents, total.platformCents, total.discountCents, total.totalCents,
       dados.forma === 'pix' ? 'pix' : 'credito', parcelas,
       cupom?.id ?? null, promoter?.id ?? null, expiraEm,
       JSON.stringify(cadastroPendente({
         documento, nome: dados.comprador.nome, telefone: dados.comprador.telefone ?? null, cadastro,
       })), conta?.id ?? null,
       comFidelidade?.programa.id ?? null, comFidelidade ? total.discountCents : 0])

    for (let i = 0; i < dados.itens.length; i++) {
      const it = dados.itens[i]
      const l = total.linhas[i]
      // O motivo e o documento entram na MESMA linha da venda. Daqui o
      // gatilho da migração 015 os carimba em cada ingresso emitido — é o
      // ingresso, e não o pedido, que chega na mão da portaria.
      const d = meia.porItem[i]
      await c.query(
        `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity,
                                  unit_face_cents, unit_fee_cents, unit_total_cents,
                                  half_reason, half_document, half_document_required)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [ord.rows[0].id, it.lotId, it.ticketTypeId ?? null, it.quantidade,
         l.faceCents, l.feeCents, l.totalCents,
         d?.motivo ?? null, d?.documento ?? null, d?.exigido ?? null])
    }

    // Placar, não trava: quem responde "quantas vezes este cupom já foi
    // usado" é a contagem em `orders` (utils/cupom.ts). Este número segue
    // gravado porque as telas do painel mostram ele.
    if (cupom) await c.query(`UPDATE promo_codes SET uses = uses + 1 WHERE id = $1`, [cupom.id])

    return { id: ord.rows[0].id, code: ord.rows[0].code, customerId: cliente.id,
             asaasCustomerId: cliente.asaas_customer_id, total, parcelas,
             fidelidade: comFidelidade
               ? { nome: comFidelidade.programa.nome, descontoCents: total.discountCents,
                   ingressos: comFidelidade.ingressos, restantesDepois: comFidelidade.restantesDepois,
                   consumacaoBps: comFidelidade.programa.consumacao_bps }
               : null }
  }).catch((e) => {
    if (e instanceof CupomRecusado) {
      // código que não existe é o sinal de dicionário (B04)
      if (e.motivo === 'inexistente') marcarNoFreio(event, 'cupom_errado')
      throw createError({ statusCode: e.status, statusMessage: e.recado,
        data: { tipo: 'cupom', motivo: e.motivo } })
    }
    if (e instanceof EstoqueInsuficiente) {
      // `e.message` é texto de log ("Lote X: pedido 2, disponível 1"). Quem lê
      // isto é alguém com o cartão na mão, ou o operador do guichê com fila
      // atrás: tem que dizer o que sobrou e o que fazer agora.
      throw createError({ statusCode: 409, statusMessage: recadoDeEstoque(e),
        data: { tipo: 'estoque', disponivel: e.disponivel } })
    }
    if (e instanceof LoteIndisponivel) {
      throw createError({ statusCode: 409, statusMessage: e.message, data: { tipo: 'lote' } })
    }
    if (e instanceof CotaDeMeiaEsgotada) {
      // `e.message` é log ("cota 200, já vendidas 200, pedido 1"). Quem lê a
      // tela é o comprador: `e.recado` diz que a inteira do mesmo lote
      // continua à venda, que é a saída que ele tem.
      throw createError({ statusCode: 409, statusMessage: e.recado,
        data: { tipo: 'cota_meia', cota: e.cota, restavam: e.restavam } })
    }
    // Trava de DIA, que mora no banco (gatilho `sessao_confere_vaga`, db/016):
    // capacidade da sessão, dia que o lote não vende, dia de outro evento.
    //
    // `23514` sozinho não serve como assinatura — é o mesmo SQLSTATE de todo
    // CHECK do schema, e CHECK que estoura É bug nosso e merece o 500. O que
    // separa os dois é `routine`: `exec_stmt_raise` só aparece quando o RAISE
    // partiu de uma função NOSSA, ou seja, quando a mensagem foi escrita para
    // quem está no guichê. Medido antes disto: segundo pedido num dia de
    // capacidade 2 respondia `HTTP 500 {"statusMessage":"Server Error"}` e
    // engolia a frase boa ("O dia 05/12 09:00 não comporta mais 1 pessoa(s):
    // restam 0 de 2 lugares. Ofereça outro dia ou outro horário."), que já
    // existia e nunca chegava na tela.
    if (e?.code === '23514' && e?.routine === 'exec_stmt_raise') {
      throw createError({ statusCode: 409, statusMessage: e.message,
        data: { tipo: 'sessao' } })
    }
    throw e
  })

  // O pedido nasceu e o estoque está reservado: agora conta no balde de
  // ingressos deste endereço (B03).
  marcarNoFreio(event, 'checkout_ingressos', ingressosPedidos)

  // A conta fechada saiu de dentro da transação: é ela que foi gravada no
  // pedido, com o cupom já travado e o teto de desconto já aplicado. Recalcular
  // aqui fora daria uma segunda verdade sobre o mesmo dinheiro.
  const total = pedido.total

  // Pedido gratuito (cortesia/100% off) não passa por gateway.
  if (total.totalCents === 0) {
    await confirmarGratuito(pedido.id)
    return { ok: true, pedido: pedido.code, pedidoId: pedido.id, status: 'pago', totalCents: 0,
             fidelidade: pedido.fidelidade }
  }

  // ----------------------------------- 6. gateway, FORA da transação ------
  const cfg: ConfigAsaas = {
    apiKey: ev.asaas_api_key, environment: ev.asaas_env, walletId: ev.asaas_wallet,
  }

  // Sem jeito de cobrar (sem chave, ou chave de teste em produção — PROD-06):
  // o pedido morre liberando o estoque. Só chega aqui o pedido COM cupom (o
  // resto foi recusado antes da transação) que não fechou em zero. Na máquina,
  // com PAGAMENTO_SIMULADO=1, o fluxo segue por um gateway de mentira pra a
  // tela poder ser exercitada ponta a ponta.
  if (!online.ok) {
    await desfazer(pedido.id, `pagamento online indisponível: ${online.motivo}`)
    throw createError({ statusCode: 503, statusMessage: online.recado,
      data: { tipo: 'pagamento_indisponivel', motivo: online.motivo } })
  }
  // Pix com o Mercado Pago ligado na organização: sai de lá (0,99%). Antes do simulado de
  // propósito — o MP de mentira do teste (`MERCADOPAGO_API_URL`) roda sem chave do Asaas.
  if (dados.forma === 'pix' && pixPeloMercadoPago(ev).ok) {
    const peloMp = await cobrarPixNoMercadoPago(pedido, ev, total, dados, expiraEm, documento)
    if (peloMp) return peloMp
    // o MP falhou e o Asaas está de pé: o Pix deste pedido sai por ele (segue abaixo)
  }
  if (!cfg.apiKey) return await cobrarSimulado(pedido, ev, total, dados, expiraEm)

  let cobranca: any
  try {
    const clienteNoAsaas = async () => {
      const id = await acharOuCriarCliente(cfg, {
        name: dados.comprador.nome, email: dados.comprador.email,
        cpfCnpj: documento, ...telefoneParaAsaas(dados.comprador.telefone),
      })
      await q(`UPDATE customers SET asaas_customer_id = $2 WHERE id = $1`, [pedido.customerId, id])
      return id
    }
    const cobrancaCom = (customer: string) => ({
      customer,
      billingType: dados.forma === 'pix' ? 'PIX' : 'CREDIT_CARD',
      // à vista vai `value`; parcelado vai `installmentCount` + `totalValue` (ver valorDaCobranca)
      ...valorDaCobranca(total.totalCents, pedido.parcelas),
      // Data, não hora: o Asaas não aceita vencimento em minutos, então a
      // cobrança sobrevive à reserva (`hold_minutes`). Quem fecha essa janela
      // é `cancelarCobrancasDeExpirados` (a varredura cancela a cobrança do
      // pedido que expirou) e, pro PIX pago no vão, a emissão refaz a reserva
      // — ver `emissao.ts`.
      dueDate: vencimentoEmDias(1),
      description: `${ev.name} — pedido ${pedido.code}`,
      externalReference: pedido.id,       // é isto que liga o webhook ao pedido
      ...retornoDaFatura(pedido.code),
    } as NovaCobranca)
    const novaCobranca = (customer: string) => cartao
      ? criarCobrancaComCartao(cfg, cobrancaCom(customer), {
          creditCard: cartao.creditCard,
          creditCardHolderInfo: {
            ...cartao.titular, email: dados.comprador.email,
            phone: String(dados.comprador.telefone ?? '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, ''),
          },
          remoteIp: ipDaRequisicao(event) || event.node.req.socket?.remoteAddress || '',
        })
      : criarCobranca(cfg, cobrancaCom(customer))

    const asaasCustomer = pedido.asaasCustomerId || await clienteNoAsaas()
    try {
      cobranca = await novaCobranca(asaasCustomer)
    } catch (e) {
      // O `asaas_customer_id` guardado pode ser de OUTRA conta ou de outro ambiente (o cliente
      // criado no sandbox, e a chave trocada pra produção): o Asaas recusa a cobrança por
      // "cliente inválido" e o comprador recebia "tente de novo" pra sempre. Uma vez só: acha (ou
      // cria) o cliente NESTA conta, grava, e tenta de novo.
      if (!pedido.asaasCustomerId || !clienteRecusado(e)) throw e
      cobranca = await novaCobranca(await clienteNoAsaas())
    }
  } catch (e: any) {
    // Cartão no site sem resposta (prazo, rede, 5xx): o cartão PODE ter sido cobrado — a doc manda
    // perguntar antes de qualquer outra coisa. Achou a cobrança: segue com ela, como se tivesse
    // respondido. Não achou: aí sim desfaz.
    const achada = cartao && falhaPassageiraDoAsaas(e)
      ? await cobrancaDoPedidoNoAsaas(cfg, pedido.id).catch(() => null)
      : null
    if (achada) {
      cobranca = achada
    } else {
    // Gateway caiu: devolve o estoque na hora. Sem isso, cada erro do Asaas
    // queima ingresso que ninguém comprou até a varredura de expirados passar.
    await desfazer(pedido.id, `Asaas: ${e.message}`)
    // Cartão recusado pelo banco (400, a cobrança nem foi criada): o motivo do Asaas, pra pessoa
    // conferir os dados ou usar outro cartão. O lugar já voltou.
    if (cartao && e instanceof ErroAsaas && e.status >= 400 && e.status < 500 && !recusaDeDadoDoComprador(e)) {
      throw createError({ statusCode: 422, statusMessage: recadoDoCartaoRecusado(e),
        data: { tipo: 'cartao_recusado' } })
    }
    if (cartao && falhaPassageiraDoAsaas(e)) {
      throw createError({ statusCode: 502, statusMessage: 'O banco não respondeu a tempo. Confira no app do seu '
        + 'banco se a compra aparece antes de tentar de novo — se aparecer, o ingresso chega por e-mail.',
        data: { tipo: 'cartao_sem_resposta' } })
    }
    // B12: recusa de DADO do comprador (celular, e-mail, CPF, nome) diz qual
    // campo e o que o gateway disse — tentar de novo igual daria o mesmo.
    const recusa = recusaDeDadoDoComprador(e)
    if (recusa) {
      throw createError({ statusCode: 422, statusMessage: recusa.recado,
        data: { tipo: 'cadastro', campo: recusa.campo, origem: 'gateway' } })
    }
    throw createError({ statusCode: 502, statusMessage: 'Não foi possível gerar a cobrança. Tente de novo.' })
    }
  }

  let pix: { encodedImage?: string; payload?: string } | null = null
  if (dados.forma === 'pix') {
    try { pix = await qrCodePix(cfg, cobranca.id) } catch { pix = null }
  }

  // `invoice_url` (B08): a fatura do cartão fica no PEDIDO, não só na memória
  // da aba — a página do pedido oferece o link de qualquer aparelho.
  //
  // `asaas_installment_id` (041): no parcelado, `cobranca` é a 1ª PARCELA e o
  // `installment` é o parcelamento inteiro. Jogar ele fora fazia estorno e
  // cancelamento agirem só na 1ª parcela.
  await q(
    `UPDATE orders SET asaas_payment_id = $2, pix_payload = $3, pix_qr_base64 = $4,
                       invoice_url = $5, asaas_installment_id = $6
      WHERE id = $1`,
    [pedido.id, cobranca.id, pix?.payload ?? null, pix?.encodedImage ?? null,
     cobranca.invoiceUrl ?? null, String(cobranca.installment ?? '').trim() || null])

  // Cartão no site aprovado na hora (CONFIRMED): o ingresso sai agora, pelo MESMO caminho do webhook
  // (chave poll:<cobrança>:<status> — o aviso que chegar depois é repetido e não emite de novo).
  let statusDoPedido = 'aguardando_pagamento'
  if (cartao && ['CONFIRMED', 'RECEIVED'].includes(String(cobranca.status ?? '').toUpperCase())) {
    const d = await aplicarCobrancaConsultada({ pedidoId: pedido.id, cobranca }).catch(() => null)
    if (d?.ok) statusDoPedido = (await q1<any>(`SELECT status FROM orders WHERE id = $1`, [pedido.id]))?.status ?? statusDoPedido
  }

  return {
    ok: true,
    pedido: pedido.code,
    pedidoId: pedido.id,
    status: statusDoPedido,
    expiraEm: expiraEm.toISOString(),
    totalCents: total.totalCents,
    parcelas: pedido.parcelas,
    faceCents: total.faceCents,
    feeCents: total.feeCents,
    descontoCents: total.discountCents,
    fidelidade: pedido.fidelidade,
    pagamento: {
      forma: dados.forma,
      pixPayload: pix?.payload ?? null,
      pixQrBase64: pix?.encodedImage ?? null,
      linkFatura: cobranca.invoiceUrl ?? null,
      // cartão digitado no site: a tela não abre a fatura — espera o banco (análise, 3DS) ou já é pago
      cartaoNoSite: !!cartao,
    },
  }
})

/**
 * O cartão do corpo, conferido pela MESMA conta da tela (`app/composables/cartao.ts`) e no formato
 * do Asaas. Errado → 422 com o campo e a frase, antes de reservar lugar (ninguém segura ingresso com
 * cartão que nem passa no dígito verificador). O número não aparece em frase nenhuma.
 */
function conferirCartaoDoCorpo(c: NonNullable<z.infer<typeof Entrada>['cartao']>, documentoDoComprador: string) {
  const recusa = (campo: string, recado: string) =>
    createError({ statusCode: 422, statusMessage: recado, data: { tipo: 'cartao', campo } })
  const conf = conferirCartao({ numero: c.numero, titular: c.titular, mes: c.mes, ano: c.ano, cvv: c.cvv })
  if (conf.numero) throw recusa('numero', conf.numero)
  if (conf.titular) throw recusa('titular', conf.titular)
  if (conf.validade) throw recusa('validade', conf.validade)
  if (conf.cvv) throw recusa('cvv', conf.cvv)
  const cep = c.cep.replace(/\D/g, '')
  if (cep.length !== 8) throw recusa('cep', 'CEP com 8 números (o do endereço da fatura do cartão).')
  const numeroEndereco = c.numeroEndereco.trim()
  if (!numeroEndereco) throw recusa('numeroEndereco', 'Número do endereço da fatura do cartão (ou "S/N").')
  const cpfTitular = (c.cpfTitular ?? '').replace(/\D/g, '')
  if (cpfTitular && !cpfValido(cpfTitular)) throw recusa('cpfTitular', 'CPF do titular do cartão inválido.')
  return {
    creditCard: {
      holderName: c.titular.trim().toUpperCase(),
      number: soDigitosDoCartao(c.numero),
      expiryMonth: c.mes.padStart(2, '0'),
      expiryYear: c.ano,
      ccv: soDigitosDoCartao(c.cvv, 4),
    },
    titular: {
      name: c.titular.trim(),
      cpfCnpj: cpfTitular || documentoDoComprador,
      postalCode: cep,
      addressNumber: numeroEndereco.slice(0, 10),
    },
  }
}

/** A recusa do banco em português, sem o "Asaas:" da frente e sem nada que pareça dado do cartão. */
function recadoDoCartaoRecusado(e: ErroAsaas): string {
  const erros: any[] = Array.isArray(e.detalhes?.errors) ? e.detalhes.errors : []
  const frase = erros.map((x) => String(x?.description ?? '').trim()).filter(Boolean).join(' ')
    .replace(/\d{6,}/g, '').slice(0, 240)
  return `Cartão não aprovado${frase ? `: ${frase}` : '.'} Confira os dados ou use outro cartão — o seu lugar foi liberado, é só tentar de novo.`
}

/**
 * O Pix pelo Mercado Pago — mesmo retorno do caminho do Asaas, pra tela não saber de onde veio.
 *
 * Nada do Asaas é tocado: nem cliente, nem cobrança. O id do MP vai pra `mp_payment_id` (e NUNCA
 * pra `asaas_payment_id`, que é a régua de "o dinheiro está no Asaas" — ver db/033).
 *
 * MP caiu: com o Asaas de pé (ou o simulado, na máquina), devolve `null` e o Pix sai pelo caminho
 * de sempre — o comprador não perde a compra porque um dos dois gateways piscou. Sem plano B,
 * devolve o estoque na hora, como o caminho do Asaas. Nos dois casos a falha fica na trilha do
 * pedido (`pix_mp_falhou`), que a saúde conta: MP falhando em silêncio seria tarifa de Asaas
 * paga sem ninguém saber por quê.
 */
async function cobrarPixNoMercadoPago(
  pedido: any, ev: any, total: any, dados: any, expiraEm: Date, documento: string,
) {
  let pix: PixDoPedido
  try {
    pix = await gerarPixDoPedido({
      org: { id: ev.org_id, mp_access_token: ev.mp_access_token, mp_test: ev.mp_test },
      pedido: { id: pedido.id, code: pedido.code },
      valorCents: total.totalCents,
      descricao: `${ev.name} — pedido ${pedido.code}`,
      expiraEm,
      comprador: { email: dados.comprador.email, nome: dados.comprador.nome, cpf: documento },
    })
  } catch (e: any) {
    const motivo = e?.message ?? String(e)
    const planoB = simulado.ligado() || pagamentoPeloAsaas(ev).ok
    await q(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1, 'order', $2, 'pix_mp_falhou', $3::jsonb)`,
      [ev.org_id, pedido.id, JSON.stringify({ pedido: pedido.code, erro: motivo, saiuPor: planoB ? 'asaas' : null })],
    ).catch(() => {})
    console.warn(`[checkout] Pix do pedido ${pedido.code} no Mercado Pago falhou`
      + `${planoB ? ' — saindo pelo Asaas' : ''}: ${motivo}`)
    if (planoB) return null
    await desfazer(pedido.id, `Mercado Pago: ${motivo}`)
    throw createError({ statusCode: 502, statusMessage: 'Não foi possível gerar o PIX. Tente de novo.' })
  }

  await q(
    `UPDATE orders SET mp_payment_id = $2, pix_payload = $3, pix_qr_base64 = $4, invoice_url = NULL
      WHERE id = $1`,
    [pedido.id, pix.paymentId, pix.copiaECola, pix.qrBase64])

  return {
    ok: true,
    pedido: pedido.code,
    pedidoId: pedido.id,
    status: 'aguardando_pagamento',
    expiraEm: expiraEm.toISOString(),
    totalCents: total.totalCents,
    parcelas: pedido.parcelas,
    faceCents: total.faceCents,
    feeCents: total.feeCents,
    descontoCents: total.discountCents,
    fidelidade: pedido.fidelidade,
    pagamento: {
      forma: 'pix',
      pixPayload: pix.copiaECola,
      pixQrBase64: pix.qrBase64,
      linkFatura: null,
    },
  }
}

/**
 * Mesmo retorno do caminho real, com cobrança de mentira. Fica numa função
 * separada pra o caminho de produção acima continuar legível sem `if` de
 * ambiente no meio.
 */
async function cobrarSimulado(
  pedido: any, ev: any, total: any, dados: any, expiraEm: Date,
) {
  const cobranca = await simulado.criarCobrancaSimulada({
    value: centavosParaReais(total.totalCents),
    description: `${ev.name} — pedido ${pedido.code}`,
    externalReference: pedido.id,
  })
  const pix = dados.forma === 'pix'
    ? await simulado.pixSimulado(centavosParaReais(total.totalCents), pedido.code)
    : null
  // o cartão do simulado também tem "fatura" (B08): sem ela o caminho do cartão
  // não tinha como ser exercitado na máquina
  const fatura = dados.forma === 'credito' ? simulado.faturaSimulada(pedido.code) : null

  await q(
    `UPDATE orders SET asaas_payment_id = $2, pix_payload = $3, pix_qr_base64 = $4, invoice_url = $5
      WHERE id = $1`,
    [pedido.id, cobranca.id, pix?.payload ?? null, pix?.encodedImage ?? null, fatura])

  return {
    ok: true,
    pedido: pedido.code,
    pedidoId: pedido.id,
    status: 'aguardando_pagamento',
    expiraEm: expiraEm.toISOString(),
    totalCents: total.totalCents,
    parcelas: pedido.parcelas,
    faceCents: total.faceCents,
    feeCents: total.feeCents,
    descontoCents: total.discountCents,
    fidelidade: pedido.fidelidade,
    simulado: true,
    pagamento: {
      forma: dados.forma,
      pixPayload: pix?.payload ?? null,
      pixQrBase64: pix?.encodedImage ?? null,
      linkFatura: fatura,
    },
  }
}

/**
 * O que o comprador lê quando o ingresso acabou entre a página e o botão.
 *
 * O número vem do estoque relido COM a trava do lote na mão (utils/estoque.ts):
 * se viesse de antes da trava, esta frase diria "sobrou 1" bem na hora em que
 * a recusa foi por não ter sobrado nenhum — e aí o comprador tenta de novo, lê
 * a mesma coisa, e abre chamado dizendo que o site está quebrado.
 */
function recadoDeEstoque(e: EstoqueInsuficiente): string {
  // "opção" e não "lote": o que acabou tanto pode ser o lote quanto um tipo
  // dentro dele (meia-entrada). `e.nome` já diz qual dos dois, e `e.disponivel`
  // é o saldo DAQUELA prateleira — mandar o comprador trocar de lote quando o
  // que faltou foi a meia é conselho que falha de novo.
  if (e.disponivel <= 0) {
    return `O último ingresso de "${e.nome}" saiu enquanto você preenchia os dados. `
      + 'Escolha outra opção ou tente de novo em alguns minutos: reserva não paga volta pra venda.'
  }
  const resta = e.disponivel === 1 ? 'Restou 1 ingresso' : `Restaram ${e.disponivel} ingressos`
  return `${resta} de "${e.nome}" e você pediu ${e.pedido}. `
    + `Mude a quantidade para ${e.disponivel} ou escolha outra opção.`
}

/**
 * A recusa de FORMATO do corpo, com o campo e o que fazer (B11).
 *
 * Era `400 "Dados inválidos"` com o `flatten()` do Zod no `data` — a tela não
 * lia aquilo e mostrava só a frase, então quem digitou o celular sem DDD, ou
 * uma rua de 121 letras, ou 2 letras no documento da meia, não sabia o que
 * corrigir. Agora sai UMA frase (a do primeiro problema, na ordem do
 * formulário) e `data.campo` com o nome que a página usa pra marcar o campo —
 * o mesmo vocabulário de `CadastroInvalido` (`utils/cadastro.ts`).
 */
const CAMPOS_DO_FORMULARIO: Record<string, { campo: string; rotulo: string }> = {
  'comprador.nome': { campo: 'nome', rotulo: 'o nome' },
  'comprador.email': { campo: 'email', rotulo: 'o e-mail' },
  'comprador.documento': { campo: 'documento', rotulo: 'o CPF' },
  'comprador.telefone': { campo: 'telefone', rotulo: 'o celular' },
  'comprador.nascimento': { campo: 'nascimento', rotulo: 'a data de nascimento' },
  'comprador.instagram': { campo: 'instagram', rotulo: 'o Instagram' },
  'comprador.endereco.cep': { campo: 'cep', rotulo: 'o CEP' },
  'comprador.endereco.rua': { campo: 'rua', rotulo: 'a rua' },
  'comprador.endereco.numero': { campo: 'numero', rotulo: 'o número' },
  'comprador.endereco.bairro': { campo: 'bairro', rotulo: 'o bairro' },
  'comprador.endereco.cidade': { campo: 'cidade', rotulo: 'a cidade' },
  'comprador.endereco.estado': { campo: 'estado', rotulo: 'o estado' },
  'comprador.endereco.complemento': { campo: 'complemento', rotulo: 'o complemento' },
  cupom: { campo: 'cupom', rotulo: 'o cupom' },
  promoter: { campo: 'promoter', rotulo: 'o código do promoter' },
}

const inicial = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

export function recusaDeFormato(erro: z.ZodError) {
  const issue = erro.issues[0]
  const caminho = issue?.path ?? []
  let campo: string | null = null
  let item: number | undefined
  let frase: string

  // `itens.N.meia.documento` / `itens.N.meia.motivo`: o que a pessoa digita
  // na linha da meia-entrada
  if (caminho[0] === 'itens' && typeof caminho[1] === 'number' && caminho[2] === 'meia') {
    item = caminho[1]
    if (caminho[3] === 'documento') {
      campo = 'meia_documento'
      frase = 'Confira o documento da meia-entrada: digite o número da carteirinha ou do '
        + 'documento, de 3 a 40 caracteres.'
    } else {
      campo = 'meia_motivo'
      frase = 'Escolha o motivo da meia-entrada.'
    }
  } else {
    const alvo = CAMPOS_DO_FORMULARIO[caminho.join('.')]
    if (!alvo) {
      // O resto (lote, tipo, quantidade, forma, parcelas) quem monta é a tela,
      // não a pessoa: recusa aqui é página velha ou requisição feita à mão.
      frase = 'Não deu pra ler o pedido. Recarregue a página e monte a compra de novo.'
    } else {
      campo = alvo.campo
      const i = issue as any
      if (campo === 'email') {
        frase = 'Confira o e-mail: ele precisa ter o formato nome@provedor.com.br.'
      } else if (campo === 'nome' && i.code === 'too_small') {
        frase = 'Digite o nome completo, como está no documento.'
      } else if (campo === 'documento') {
        frase = 'CPF inválido. Confira os 11 números.'
      } else if (campo === 'telefone') {
        frase = 'Confira o celular: DDD + número (ex.: (73) 99999-0000).'
      } else if (i.code === 'too_big') {
        frase = `${inicial(alvo.rotulo)} passou do limite de ${i.maximum} caracteres. Abrevie.`
      } else if (i.code === 'too_small') {
        frase = `${inicial(alvo.rotulo)} está curto demais: use pelo menos ${i.minimum} caracteres.`
      } else if (i.code === 'invalid_type' && i.received === 'undefined') {
        frase = `Preencha ${alvo.rotulo}.`
      } else {
        frase = `Confira ${alvo.rotulo}.`
      }
    }
  }
  return createError({ statusCode: 400, statusMessage: frase,
    data: { tipo: 'cadastro', campo, ...(item !== undefined ? { item } : {}) } })
}

/**
 * O cliente do pedido — e o que se escreve nele ANTES de pagar (B14).
 *
 * O checkout gravava o cadastro inteiro na hora do formulário. O formulário
 * não prova que o e-mail é de quem digitou, e isso dava duas coisas:
 *
 *   1. **O e-mail sequestrado.** O primeiro CPF digitado com um e-mail ficava
 *      carimbado na linha pra sempre: bastava gerar um checkout com o e-mail de
 *      alguém e um CPF válido qualquer, sem pagar, e o dono de verdade levava
 *      "Este e-mail já está cadastrado com outro CPF" toda vez que tentasse
 *      comprar.
 *   2. **O cadastro reescrito.** Quem sabia e-mail + CPF reescrevia nome,
 *      telefone, nascimento, Instagram, endereço e o CONSENTIMENTO de
 *      novidades da pessoa, sem pagar nada.
 *
 * A régua agora é o pagamento: custa dinheiro no nome de alguém. O formulário
 * inteiro vai pro PEDIDO (`cadastro_pendente`, db/028) e só passa pro cadastro
 * quando o pedido vira 'pago'. Aqui, antes de pagar, só o mínimo pra o pedido
 * ter dono:
 *
 *   · e-mail novo → nasce com nome, CPF e telefone. Sem consentimento, sem
 *     senha, sem o resto (chega no pagamento);
 *   · cliente sem CPF (nasceu no balcão) → o CPF é preenchido, como sempre
 *     foi: é ele que conta o teto por CPF e o uso de cupom;
 *   · mesmo CPF → nada muda aqui. O cadastro novo vale no pagamento;
 *   · CPF diferente, e o e-mail NUNCA pagou nada e não tem pedido de pé → o
 *     e-mail é de quem chegou agora: a linha troca de CPF e o perfil de antes
 *     (que ninguém provou) é zerado, inclusive o cliente do Asaas, que foi
 *     criado com o CPF antigo. É isso que devolve o e-mail ao dono quando um
 *     desconhecido o usou sem pagar;
 *   · CPF diferente, e o e-mail já pagou (ou tem pedido de pé) → 409, como
 *     antes. O pedido de pé segura o CPF porque o teto e o cupom contam pelo
 *     CPF da linha do cliente: trocar agora mudaria de dono o que está em jogo.
 *
 * A linha do cliente é TRAVADA antes da decisão (`FOR UPDATE`), e o "já pagou
 * / tem pedido de pé" é lido num segundo comando, DEPOIS da trava: em READ
 * COMMITTED cada comando enxerga o que foi confirmado até ele começar, então
 * o pedido que outra compra do mesmo e-mail acabou de gravar entra na conta.
 */
async function gravarCliente(c: PoolClient, d: {
  orgId: string; email: string; documento: string; nome: string
  telefone: string | null; cadastro: Cadastro
}): Promise<{ id: string; asaas_customer_id: string | null }> {
  const novo = await c.query(
    `INSERT INTO customers (org_id, name, email, document, phone)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (org_id, email) DO NOTHING
     RETURNING id, asaas_customer_id`,
    [d.orgId, d.nome, d.email, d.documento, d.telefone])
  if (novo.rows[0]) return novo.rows[0]

  const { rows: [cli] } = await c.query(
    `SELECT id, document, asaas_customer_id FROM customers
      WHERE org_id = $1 AND email = $2 FOR UPDATE`, [d.orgId, d.email])
  if (!cli.document) {
    await c.query(`UPDATE customers SET document = $2 WHERE id = $1`, [cli.id, d.documento])
    return cli
  }
  if (cli.document === d.documento) return cli

  const { rows: [situacao] } = await c.query(
    `SELECT EXISTS (SELECT 1 FROM orders WHERE customer_id = $1 AND paid_at IS NOT NULL) AS pagou,
            EXISTS (SELECT 1 FROM orders WHERE customer_id = $1 AND status = ANY($2::text[])) AS de_pe`,
    [cli.id, PEDIDO_EM_PE as unknown as string[]])
  if (situacao.pagou || situacao.de_pe) {
    // Sem nenhum pedaço do CPF gravado: esta resposta sai pra quem digitar
    // QUALQUER e-mail, e "final 42" junto do e-mail de outra pessoa é dado
    // pessoal dela entregue a um desconhecido. Quem é o dono sabe o próprio CPF.
    throw createError({ statusCode: 409,
      statusMessage: 'Este e-mail já está cadastrado com outro CPF. '
        + 'Use o CPF do cadastro ou outro e-mail.',
      data: { tipo: 'email_de_outro_cpf' } })
  }

  await c.query(
    `UPDATE customers SET document = $2, name = $3, phone = $4,
            birth_date = NULL, instagram = NULL,
            zip_code = NULL, street = NULL, address_number = NULL, neighborhood = NULL,
            city = NULL, state = NULL, address_complement = NULL,
            password_hash = NULL, registered_at = NULL,
            marketing_opt_in = false, marketing_opt_in_at = NULL,
            asaas_customer_id = NULL
      WHERE id = $1`,
    [cli.id, d.documento, d.nome, d.telefone])
  // Sem o CPF de ninguém no registro: o que importa pra quem investiga é que
  // o e-mail mudou de dono, e quando.
  await c.query(
    `INSERT INTO audit_log (entity, entity_id, action, after)
     VALUES ('customer', $1, 'email_reassumido', $2::jsonb)`,
    [cli.id, JSON.stringify({ motivo: 'CPF novo; o anterior nunca pagou e não tinha pedido de pé' })])
  return { id: cli.id, asaas_customer_id: null }
}

/**
 * O formulário do cadastro como ele vai pro pedido (`orders.cadastro_pendente`).
 * Quem lê é o gatilho `aplicar_cadastro_do_pedido_pago` (db/028): as chaves
 * daqui são o contrato com ele.
 *
 * `cadastroDoSite` é o que marca "cadastrado pelo site" (`registered_at`, o
 * filtro de clientes): era a senha, que saiu (B17). Quem mandou nascimento ou
 * endereço passou pelo formulário completo da página.
 */
export function cadastroPendente(d: {
  documento: string; nome: string; telefone: string | null; cadastro: Cadastro
}) {
  const e = d.cadastro.endereco
  return {
    documento: d.documento,
    nome: d.nome,
    telefone: d.telefone,
    nascimento: d.cadastro.nascimento,
    instagram: d.cadastro.instagram,
    endereco: e ? { ...e } : null,
    aceitaNovidades: d.cadastro.aceitaNovidades,
    cadastroDoSite: !!(d.cadastro.nascimento || e),
  }
}

/** Desfaz pedido que não virou cobrança: libera estoque e marca como falhou. */
async function desfazer(orderId: string, motivo: string) {
  await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT lot_id AS "lotId", ticket_type_id AS "ticketTypeId", quantity AS quantidade
         FROM order_items WHERE order_id = $1`, [orderId])
    await liberar(c, rows)
    await c.query(
      `UPDATE orders SET status = 'falhou', canceled_at = now() WHERE id = $1`, [orderId])
    await c.query(
      `INSERT INTO audit_log (entity, entity_id, action, after)
       VALUES ('order', $1, 'falhou', $2::jsonb)`,
      [orderId, JSON.stringify({ motivo })])
  })
}

async function confirmarGratuito(orderId: string) {
  const { emitirIngressos } = await import('../utils/emissao')
  await emitirIngressos(orderId)
}

/**
 * O lote que a VITRINE mostra fechado, o checkout recusa — com a frase dela.
 *
 * `reservar()` (utils/estoque.ts) confere o que dá pra ver olhando a linha do
 * lote: visível, dentro das datas, no canal certo, com estoque. O que ele não
 * tem como saber é **qual lote do setor está vigente**: com `auto_rotate_lots`
 * ligado o setor vende um lote por vez, e isso é uma decisão do SETOR — só
 * aparece olhando os lotes irmãos, na ordem de `sort_order`.
 *
 * Sem esta conferência, o medido era: vitrine com o 2º lote em `em_breve` e
 * `maxPorCompra: 0`, e o `POST /api/checkout` naquele mesmo lote respondendo
 * **200** com pedido criado (PED-VU93-GARV, 6600 centavos). O comprador que
 * montasse a requisição na mão — ou a tela, num F5 na virada — comprava o lote
 * mais caro antes da hora, ou o mais barato depois dela.
 *
 * **Por que aqui dentro da transação e sem `FOR UPDATE`:** a decisão de giro
 * lê os lotes irmãos, que esta transação não trava (travar o setor inteiro
 * faria a venda do evento virar fila de um por vez). Ela roda na transação pra
 * enxergar o mundo já confirmado, e o que ela decide é "qual lote está à
 * venda", não "cabe mais um" — quem responde a segunda, com a trava na mão e
 * até o COMMIT, continua sendo `reservar()`. Uma leitura defasada aqui erra no
 * único instante em que o lote vigente está virando, e erra para o lado certo:
 * a venda segue e o estoque decide.
 */
async function conferirVitrine(c: PoolClient, ev: any, itens: any[]) {
  const lotIds = [...new Set(itens.map((i) => i.lotId))]
  const DOS_MESMOS_SETORES =
    `l.sector_id IN (SELECT sector_id FROM lots WHERE id = ANY($1::uuid[]))`

  // Os lotes IRMÃOS entram na consulta de propósito: sem eles não existe
  // "vigente", e `situacoesDoSetor` devolveria todo lote como se estivesse
  // sozinho no setor — que é exatamente o furo.
  const { rows: lotes } = await c.query(
    `SELECT l.id, l.name, l.sector_id, l.quantity, l.sold, l.reserved,
            l.starts_at, l.expires_at, l.half_quota_bps, l.sort_order
       FROM lots l
      WHERE ${DOS_MESMOS_SETORES} AND ${LOTE_DA_VITRINE}
      ORDER BY l.sector_id, l.sort_order`, [lotIds])
  if (!lotes.length) return

  const { rows: tipos } = await c.query(
    `SELECT tt.id, tt.lot_id, tt.kind, tt.quantity, tt.sold
       FROM ticket_types tt
       JOIN lots l ON l.id = tt.lot_id
      WHERE ${DOS_MESMOS_SETORES} AND ${LOTE_DA_VITRINE}`, [lotIds])

  const restam = restamPorTipo(lotes, tipos)
  for (const t of tipos) (t as any).restam = restam.get(t.id) ?? 0
  const restaPorLote = restaDasVariacoes(tipos)
  for (const l of lotes) l.restaNasVariacoes = restaPorLote.get(l.id) ?? null

  const porSetor = new Map<string, any[]>()
  for (const l of lotes) {
    if (!porSetor.has(l.sector_id)) porSetor.set(l.sector_id, [])
    porSetor.get(l.sector_id)!.push(l)
  }

  const agora = new Date()
  const situacao = new Map<string, SituacaoDoLote>()
  for (const doSetor of porSetor.values()) {
    // `vendasAbertas: true` porque a porta do EVENTO já foi decidida lá em
    // cima por `portaDeVenda` — se estivesse fechada, esta função nem rodava.
    const ss = situacoesDoSetor(doSetor, {
      vendasAbertas: true, giroAutomatico: ev.auto_rotate_lots, agora,
    })
    doSetor.forEach((l, i) => situacao.set(l.id, ss[i]))
  }

  for (const lotId of lotIds) {
    const s = situacao.get(lotId)
    // Lote fora da vitrine (invisível, ou só de bilheteria) não é caso desta
    // função: quem recusa é `reservar()`, que tem a frase do canal.
    if (!s || compravel(s)) continue
    const l = lotes.find((x) => x.id === lotId)!
    throw createError({ statusCode: 409,
      statusMessage: recadoDeLoteFechado(
        s, { nome: l.name, abreEm: l.starts_at, encerrouEm: l.expires_at },
        ev.timezone)!,
      data: { tipo: 'lote_fora_da_vitrine', situacao: s } })
  }
}

/**
 * Quantos ingressos cabem num pedido só, somando todos os lotes.
 *
 * O `max_per_order` do LOTE já existia e segura uma linha de cada vez — o que
 * não segurava nada era o pedido inteiro: vinte linhas de seis ingressos
 * passavam como vinte pedidos de seis. Quem faz isso não é família grande, é
 * script.
 */
function conferirTetoPorPedido(ev: any, itens: any[]) {
  const teto = Number(ev.max_per_order ?? TETO_PADRAO_POR_PEDIDO)
  const pedidos = itens.reduce((s, i) => s + i.quantidade, 0)
  if (pedidos > teto) {
    throw createError({ statusCode: 409,
      statusMessage: `Cada pedido leva no máximo ${teto} ingressos e você escolheu ${pedidos}. `
        + `Tire ${pedidos - teto} da lista — ou faça o resto em outra compra.`,
      data: { tipo: 'teto_por_pedido', teto, pedidos } })
  }
}

interface DeclaracaoDeMeia {
  motivo: string
  documento: string | null
  /** o que a portaria vai pedir — congelado aqui e gravado no ingresso */
  exigido: string
}

/**
 * Quem está comprando meia-entrada, e com que direito.
 *
 * Meia-entrada é obrigação legal com comprovação na entrada (Lei 12.933/2013 e
 * as leis de idoso/juventude). Vender meia sem saber o motivo é vender um
 * ingresso que a portaria não tem como conferir: o operador olha o papel, vê
 * "Meia-entrada", e não sabe se pede carteira de estudante, RG de quem tem
 * 60+ ou ID Jovem. Na prática ou deixa entrar sem conferir nada — e aí metade
 * do parque entra pela metade do preço — ou barra quem tinha direito.
 *
 * Por isso o motivo é OBRIGATÓRIO no tipo de espécie 'meia', e recusado nos
 * outros: motivo gravado numa inteira só faria a portaria pedir documento de
 * quem não precisa.
 *
 * Devolve, de uma passada só, o que cada linha declarou e quantas meias cada
 * LOTE está levando — este segundo número é o que a cota confere lá dentro da
 * transação.
 */
function conferirDeclaracoesDeMeia(
  itens: any[], porLote: Map<string, any>, porTipo: Map<string, any>,
): { porItem: (DeclaracaoDeMeia | null)[]; porLote: Map<string, number> } {
  const porItem: (DeclaracaoDeMeia | null)[] = []
  const meiasPorLote = new Map<string, number>()

  for (const it of itens) {
    const tipo = it.ticketTypeId ? porTipo.get(it.ticketTypeId) : null
    const ehMeia = tipo?.kind === 'meia'
    const declarado = it.meia ?? null

    if (!ehMeia) {
      if (declarado) {
        const nome = tipo?.name ?? porLote.get(it.lotId)?.name ?? 'este ingresso'
        throw createError({ statusCode: 422,
          statusMessage: `"${nome}" não é meia-entrada, então não precisa de motivo. `
            + 'Tire a declaração de meia deste item ou escolha a opção de meia-entrada.',
          data: { tipo: 'meia_em_inteira' } })
      }
      porItem.push(null)
      continue
    }

    if (!declarado?.motivo) {
      throw createError({ statusCode: 422,
        statusMessage: `Para levar "${tipo.name}" escolha o motivo da meia-entrada: `
          + `${MOTIVOS_EM_TEXTO}. A portaria confere o documento desse motivo na entrada.`,
        data: { tipo: 'meia_sem_motivo', motivos: Object.keys(MOTIVOS) } })
    }
    if (!motivoValido(declarado.motivo)) {
      throw createError({ statusCode: 422,
        statusMessage: `"${declarado.motivo}" não dá direito a meia-entrada. `
          + `Os motivos previstos em lei são: ${MOTIVOS_EM_TEXTO}.`,
        data: { tipo: 'meia_motivo_invalido', motivos: Object.keys(MOTIVOS) } })
    }

    const regra = MOTIVOS[declarado.motivo]
    const documento = declarado.documento?.trim() || null
    if (regra.exigeNumero && !documento) {
      throw createError({ statusCode: 422,
        statusMessage: `Informe o número do documento: ${regra.documento}. `
          + 'É ele que a portaria vai conferir com o seu na entrada.',
        data: { tipo: 'meia_sem_documento', motivo: declarado.motivo } })
    }

    porItem.push({ motivo: declarado.motivo, documento, exigido: documentoExigido(declarado.motivo) })
    meiasPorLote.set(it.lotId, (meiasPorLote.get(it.lotId) ?? 0) + it.quantidade)
  }

  return { porItem, porLote: meiasPorLote }
}

/**
 * Teto de compra por CPF, na cascata evento → setor → lote → tipo.
 * A regra mais específica ganha, que é como a Zig faz e é o que o produtor
 * espera: "no evento pode 10, mas deste camarote só 2".
 *
 * ## Duas coisas que estavam erradas aqui
 *
 * **1. Só o teto do evento olhava o passado.** Setor e tipo comparavam o
 * limite com a quantidade DESTE pedido — então "máximo 2 por CPF no camarote"
 * era na verdade "máximo 2 por pedido", e quem quisesse dez fazia cinco
 * compras. Agora todos os quatro somam o que o CPF já tem no evento.
 *
 * **2. A conferência ficava fora da transação.** Duas requisições do mesmo CPF
 * chegando juntas liam as duas "ainda cabe" e gravavam as duas. `SELECT` não
 * tranca nada, e não existe uma linha de "CPF neste evento" pra trancar com
 * `FOR UPDATE` — por isso a trava aqui é `pg_advisory_xact_lock`, que serializa
 * exatamente o par (evento, CPF) e some sozinha no COMMIT. Dois CPFs
 * diferentes nunca se esperam; o mesmo CPF entra em fila de um.
 *
 * A trava é a PRIMEIRA coisa da função, antes de qualquer leitura, pelo mesmo
 * motivo de `reservar()`: conferir antes de travar passa em teste sequencial e
 * não serializa nada.
 */
async function conferirTetoPorDocumento(
  c: PoolClient, ev: any, itens: any[], documento: string,
  porLote: Map<string, any>, porTipo: Map<string, any>,
  linhas: { quantidade: number; faceUnitCents: number }[] = [],
) {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [ev.id, documento])

  // 30/09: o limite de 1 ingresso GRÁTIS por CPF saiu (pedido do dono). O grátis segue o mesmo
  // teto por CPF do evento (quando o organizador configura), igual ao pago.

  // O que este CPF já tem no evento, quebrado por setor/lote/tipo numa
  // consulta só. `JOIN customers` (e não LEFT) de propósito: pedido sem
  // cliente não tem CPF e não pode ser atribuído a ninguém.
  const { rows: jaTem } = await c.query(
    `SELECT l.sector_id, oi.lot_id, oi.ticket_type_id, SUM(oi.quantity)::int AS n
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN lots l         ON l.id = oi.lot_id
       JOIN customers cu   ON cu.id = o.customer_id
      WHERE o.event_id = $1 AND cu.document = $2
        AND o.status = ANY($3::text[])
      GROUP BY 1, 2, 3`,
    [ev.id, documento, PEDIDO_EM_PE as unknown as string[]])

  const somar = (linhas: any[], chave: (l: any) => string | null) => {
    const m = new Map<string, number>()
    for (const l of linhas) {
      const k = chave(l)
      if (k) m.set(k, (m.get(k) ?? 0) + Number(l.n))
    }
    return m
  }
  const antesNoSetor = somar(jaTem, (l) => l.sector_id)
  const antesNoLote = somar(jaTem, (l) => l.lot_id)
  const antesNoTipo = somar(jaTem, (l) => l.ticket_type_id)
  const antesNoEvento = jaTem.reduce((s: number, l: any) => s + Number(l.n), 0)

  const agoraPorSetor = new Map<string, number>()
  const agoraPorLote = new Map<string, number>()
  const agoraPorTipo = new Map<string, number>()
  let agora = 0
  for (const i of itens) {
    const l = porLote.get(i.lotId)
    agora += i.quantidade
    agoraPorSetor.set(l.sector_id, (agoraPorSetor.get(l.sector_id) ?? 0) + i.quantidade)
    agoraPorLote.set(i.lotId, (agoraPorLote.get(i.lotId) ?? 0) + i.quantidade)
    if (i.ticketTypeId) {
      agoraPorTipo.set(i.ticketTypeId, (agoraPorTipo.get(i.ticketTypeId) ?? 0) + i.quantidade)
    }
  }

  /** O recado diz o teto, o que a pessoa já tem e o que dá pra levar agora. */
  const recusar = (teto: number, antes: number, onde: string) => {
    const cabe = Math.max(teto - antes, 0)
    throw createError({ statusCode: 409,
      statusMessage: antes === 0
        ? `Cada CPF leva no máximo ${teto} ${onde}. Diminua a quantidade para seguir.`
        : `Cada CPF leva no máximo ${teto} ${onde}, e este CPF já tem ${antes}. `
          + (cabe > 0 ? `Ainda dá para levar ${cabe}.` : 'Não dá para levar mais nenhum.'),
      data: { tipo: 'teto_por_cpf', teto, antes, cabe } })
  }

  if (ev.max_per_customer && antesNoEvento + agora > Number(ev.max_per_customer)) {
    recusar(Number(ev.max_per_customer), antesNoEvento, 'ingressos neste evento')
  }

  if (agoraPorSetor.size) {
    const { rows: setores } = await c.query(
      `SELECT id, name, max_per_customer FROM sectors WHERE id = ANY($1::uuid[])`,
      [[...agoraPorSetor.keys()]])
    for (const s of setores) {
      if (!s.max_per_customer) continue
      const antes = antesNoSetor.get(s.id) ?? 0
      if (antes + agoraPorSetor.get(s.id)! > Number(s.max_per_customer)) {
        recusar(Number(s.max_per_customer), antes, `ingressos do setor ${s.name}`)
      }
    }
  }

  // Lote: `limit_by_document` e `max_per_document` estão no schema desde o
  // começo e ninguém lia. O produtor marcava a caixinha na tela do lote e o
  // limite não existia — limite que não recusa é pior que limite nenhum.
  for (const [lotId, n] of agoraPorLote) {
    const l = porLote.get(lotId)
    if (!l?.limit_by_document || !l.max_per_document) continue
    const antes = antesNoLote.get(lotId) ?? 0
    if (antes + n > Number(l.max_per_document)) {
      recusar(Number(l.max_per_document), antes, `de "${l.name}"`)
    }
  }

  // tipo (sobrepõe os de cima)
  for (const [tipoId, n] of agoraPorTipo) {
    const t = porTipo.get(tipoId)
    if (!t?.max_per_customer) continue
    const antes = antesNoTipo.get(tipoId) ?? 0
    if (antes + n > Number(t.max_per_customer)) {
      recusar(Number(t.max_per_customer), antes, `de ${t.name}`)
    }
  }
}


// Re-exportado porque o balcão e os testes já importavam daqui. A regra em si
// mora em utils/documento.ts, uma cópia só pros dois caixas.
export { cpfValido }

/**
 * A fidelidade (037) zera ESTE pedido? Só pra pré-checagem de "dá pra cobrar online" — sem trava;
 * a decisão de verdade é tomada de novo dentro da transação, com o CPF travado.
 */
async function fidelidadeZeraOPedido(
  ev: any, documento: string, itens: { ticketTypeId?: string | null; quantidade: number }[],
  linhas: { faceUnitCents: number; quantidade: number }[], porTipo: Map<string, any>, face: number,
): Promise<boolean> {
  const b = await beneficioDeFidelidade(db(), {
    orgId: ev.org_id, evento: { id: ev.id, inicio: ev.starts_at, fuso: ev.timezone }, documento, temCupom: false,
    linhas: itens.map((it, i) => {
      const t = it.ticketTypeId ? porTipo.get(it.ticketTypeId) : null
      return { faceUnitCents: linhas[i]!.faceUnitCents, quantidade: it.quantidade,
               tipoComDesconto: !!t && (Number(t.discount_bps) > 0 || !!t.requires_document || !!t.abaixoDoLote) }
    }),
  })
  return b.aplica && b.cents >= face
}

/**
 * O Asaas recusou a cobrança por causa do CLIENTE (inexistente nesta conta, ou de outro ambiente)?
 * A doc devolve 400 com `errors[{ code: 'invalid_customer' … }]` ("Cliente inválido ou não
 * informado"); 404 em `customer` cobre a variação. Recusa de outro campo não entra: recriar o
 * cliente não conserta valor, vencimento nem celular.
 */
function clienteRecusado(e: unknown): boolean {
  if (!(e instanceof ErroAsaas) || ![400, 404].includes(e.status)) return false
  const erros = (e.detalhes as any)?.errors
  return Array.isArray(erros) && erros.some((x: any) =>
    /customer/i.test(String(x?.code ?? '')) || /cliente/i.test(String(x?.description ?? '')))
}

/**
 * A volta da fatura pro pedido depois do pagamento (`callback.successUrl` do Asaas).
 *
 * DESLIGADO por padrão: o Asaas só aceita a `successUrl` num domínio cadastrado na conta (Minha
 * Conta → Informações → site), e com o domínio fora do cadastro ele RECUSA A COBRANÇA inteira —
 * ligar antes do dono cadastrar seria derrubar toda venda de cartão. Liga com
 * `ASAAS_CALLBACK_LIGADO=1` e um `PUBLIC_BASE_URL` válido; sem os dois, a cobrança sai sem callback
 * (como sempre saiu).
 */
function retornoDaFatura(codigo: string): { callback?: { successUrl: string; autoRedirect: boolean } } {
  if (process.env.ASAAS_CALLBACK_LIGADO !== '1') return {}
  const base = baseDoSite()
  if (!base) return {}
  return { callback: { successUrl: `${base}/ingressos/${encodeURIComponent(codigo)}`, autoRedirect: true } }
}
