/**
 * AS SETE TELAS DO DINHEIRO PRECISAM DIZER O MESMO NÚMERO.
 *
 * O produtor abre o borderô e vê um total; abre o financeiro do evento e vê
 * outro; abre o financeiro da organização e vê um terceiro; abre relatórios e
 * vê um quarto; abre o painel do evento e vê um quinto; abre o extrato e vê um
 * sexto; abre a lista de vendas e vê um sétimo. Nenhuma das sete está
 * "quebrada" — cada uma fazia a própria conta. É o pior defeito possível numa
 * tela de dinheiro, porque não tem sintoma: não estoura, não loga, não deixa
 * teste vermelho. Só produz uma ligação perguntando qual dos números é o certo.
 *
 * O padrão do defeito é um só: **`WHERE status = 'pago'` numa consulta que
 * soma dinheiro**. O pedido com estorno PARCIAL — que o webhook marca
 * `estornado_parcial`, com o valor devolvido já em `refunded_cents` — some
 * INTEIRO antes de qualquer `FILTER` alcançá-lo. Uma devolução de R$ 20 apaga
 * um pedido de R$ 850 de uma tela e deixa ele de pé na outra.
 *
 * Por isso a fixture abaixo tem exatamente os casos que o seed não produz:
 * taxa repassada, taxa absorvida, cupom, estorno parcial, estorno total e
 * pedido que nunca virou dinheiro. Com só o que o seed tem (taxa repassada,
 * sem cupom, sem estorno), as rotas batem mesmo com a conta errada — que foi
 * como o defeito sobreviveu até aqui.
 *
 * ## O que esta grade passou a cobrir depois da verificação
 *
 * A primeira versão travava borderô, os dois financeiros e relatórios, e
 * deixava de fora três telas que tinham sido corrigidas junto. Arrancar a
 * correção de cada uma não deixava NENHUM teste vermelho — medido:
 *
 * 1. **O painel do evento (`/dashboard`) somava dinheiro.** Com a régua de
 *    volta em `status = 'pago'` o painel dizia R$ 1.000,00 e as outras quatro
 *    diziam R$ 1.830,00 no MESMO evento, com a suíte inteira verde. Agora o
 *    painel entra na mesma comparação das outras — é a quinta tela.
 * 2. **"Ticket médio" queria dizer duas coisas.** Relatórios divide o cobrado
 *    por PEDIDO (a regra escrita no cabeçalho de `relatorios.get.ts`: quem
 *    leva 6 é um cliente, não seis) e o painel dividia por INGRESSO. Medido no
 *    evento semeado: R$ 88,00 numa tela e R$ 43,47 na outra, com o mesmo nome.
 * 3. **O gasto do comprador se multiplicava pelo número de ingressos.** Com
 *    `JOIN tickets` na mesma consulta o pedido aparecia uma vez por ingresso e
 *    a soma contava o mesmo pedido N vezes; a fixture tem um comprador com 4
 *    ingressos num pedido só justamente pra isso ficar vermelho.
 * 4. **O cupom custava valores diferentes em duas telas.** A tela de cupons e
 *    o bloco `porCupom` de relatórios respondem à mesma pergunta.
 *
 * O último caso é o público: quantas pessoas entraram sai do livro da porta
 * (`entries`, `sum(people)`), e não do ingresso emitido. Uma mesa de 4 é um
 * ingresso e quatro pessoas dentro do parque.
 *
 * ## O que a terceira passagem descobriu: o título prometia mais do que cobria
 *
 * Esta grade dizia "as cinco telas do dinheiro" e "CADA campo comparável bate
 * entre as telas", e comparava CINCO: o extrato (`/extrato`) e a lista de
 * vendas (`/vendas`) mostram os mesmos campos e nunca tinham entrado. Medido
 * na fixture com a grade inteira verde:
 *
 * 1. **A devolução de relatórios discordava das outras seis.** Borderô,
 *    painel, financeiro do evento, extrato, vendas e financeiro da
 *    organização diziam R$ 240,00 de devolvido; `/relatorios` dizia R$ 20,00,
 *    porque recortava a devolução por `PEDIDO_VIVO`. A pergunta é "quanto
 *    voltou pro comprador" e o pedido estornado POR INTEIRO devolveu dinheiro
 *    do mesmo jeito — ele só não tem mais líquido a apurar.
 * 2. **O financeiro da ORGANIZAÇÃO recortava face, taxa e contagem por
 *    `'pago'`.** Só o líquido tinha sido consertado. Medido: face R$ 1.800,00
 *    na linha da organização contra R$ 2.750,00 no borderô/painel/relatórios,
 *    com o líquido igual nas quatro — a mesma linha mostrando uma face MENOR
 *    que o próprio líquido.
 * 3. **`ticketMedioCents` seguia sem régua no nome em `/relatorios`** depois
 *    que o painel renomeou os dois campos dele.
 *
 * Daí este arquivo passar a abrir as SETE portas. A única que NÃO bate campo a
 * campo é o `/extrato`, de propósito e com a diferença provada aqui: ele é
 * extrato de MOVIMENTO e inclui todo pedido que mexeu dinheiro
 * (`pago`, `estornado`, `estornado_parcial`, `chargeback`, `disputa`), não só
 * o que ainda tem líquido a apurar. Por isso a face dele é maior — e o caso
 * abaixo exige que seja maior EXATAMENTE pela face dos pedidos que mexeram
 * dinheiro e não estão vivos, lida do banco. "Diferente" sem número é o mesmo
 * que não testar.
 *
 * ## Login com e-mail SÓ deste arquivo, inclusive o master da casa
 *
 * A versão anterior logava com `dono@fazendapark.com.br` pra ler o evento
 * semeado. Esse é o e-mail cuja senha `autenticacao.test.ts` erra DE PROPÓSITO
 * (é o caso dele), e o freio de força bruta conta oito falhas por e-mail em 15
 * minutos. Resultado medido na suíte inteira: o login voltava 429 e o caso do
 * evento semeado ficava VERMELHO sem nada de dinheiro ter mudado — vermelho
 * por motivo que não é o defeito é vermelho que ninguém olha. Mesma armadilha
 * que `papeis.test.ts` e `auditoria.test.ts` já documentam. Aqui o master da
 * casa é um usuário de fixture, na organização do evento semeado, com e-mail
 * que ninguém mais usa, apagado no `afterAll`.
 *
 * Fixture própria, ids fixos, apagada no fim. O evento semeado é só LIDO.
 * Sem servidor de dev no ar, o teste PULA em vez de falhar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

const ORG = '0000ca11-0000-4000-8000-000000000001'
const EVENTO = '0000ca11-0000-4000-8000-000000000002'
const USUARIO = '0000ca11-0000-4000-8000-000000000003'
const SETOR = '0000ca11-0000-4000-8000-000000000004'
const LOTE = '0000ca11-0000-4000-8000-000000000005'
const INGRESSO = '0000ca11-0000-4000-8000-000000000006'
const ENTRADA = '0000ca11-0000-4000-8000-000000000007'
const EMAIL = 'dono.contagem@teste.invalido'

/** o master da CASA, pra ler o evento semeado sem queimar o e-mail do dono */
const USUARIO_CASA = '0000ca11-0000-4000-8000-000000000008'
const EMAIL_CASA = 'dono.casa.contagem@teste.invalido'

/** o comprador que leva o grupo — 4 ingressos num pedido só */
const COMPRADOR = '0000ca11-0000-4000-8000-000000000009'
/** o cupom, que a tela de cupons e o relatório precisam cobrar igual */
const CUPOM = '0000ca11-0000-4000-8000-00000000000a'

/** o guichê e o caixa aberto: é onde o dinheiro do balcão aparece duas vezes */
const PONTO = '0000ca11-0000-4000-8000-00000000000b'
const TURNO = '0000ca11-0000-4000-8000-00000000000c'

/**
 * Um evento SÓ pra janela de data, com dois pedidos em horas fixas.
 *
 * Ele existe separado porque o teste do botão "Hoje" precisa de pedidos em
 * instantes escolhidos a dedo (23h30 de um dia, 00h30 do seguinte) e isso
 * envenenaria todos os totais do evento de cima.
 */
const EVENTO_JANELA = '0000ca11-0000-4000-8000-00000000000d'

/**
 * Um evento SÓ pro balcão SEM guichê cadastrado.
 *
 * Também é separado, e pelo mesmo motivo do de cima: a venda órfã mudaria
 * todos os totais do evento principal. Aqui ele tem exatamente duas vendas de
 * bilheteria — uma com ponto, uma sem — que é o par mínimo pra provar que a
 * tela de PDV conta as duas.
 */
const EVENTO_BALCAO = '0000ca11-0000-4000-8000-00000000000f'
const PONTO_BALCAO = '0000ca11-0000-4000-8000-000000000010'

/**
 * O GUICHÊ QUE VENDEU ONTEM — e a venda cancelada no balcão.
 *
 * Evento próprio pelo mesmo motivo dos dois de cima: os dois casos que ele
 * carrega envenenariam os totais do evento principal.
 *
 * Ele existe porque a linha "Sem ponto identificado" da tela de PDV passou a
 * afirmar, por escrito, que o valor dela era "exatamente a diferença" entre o
 * cabeçalho e a soma dos cartões — e não é. O cabeçalho conta o EVENTO
 * INTEIRO; cada cartão conta o CAIXA ABERTO (ou só hoje, quando não há caixa
 * aberto). Venda de guichê num turno já fechado, ou de outro dia, está no
 * cabeçalho e em cartão nenhum, e não é venda órfã.
 *
 * Medido na tela com a frase no ar: cabeçalho R$ 2.465,00, cartões
 * R$ 1.415,00, diferença REAL R$ 1.050,00 — e a linha imprimindo R$ 250,00.
 * R$ 800,00 de erro numa frase escrita pra o produtor conferir a conta.
 */
const EVENTO_GUICHE = '0000ca11-0000-4000-8000-000000000011'
const PONTO_GUICHE = '0000ca11-0000-4000-8000-000000000012'
/** vendido HOJE no guichê: é o único que o cartão do ponto mostra */
const NO_GUICHE_HOJE = 60_000
/** vendido no MESMO guichê três dias atrás: está no cabeçalho e em cartão nenhum */
const NO_GUICHE_ANTES = 80_000
/** e a venda de balcão sem guichê nenhum, com R$ 50 devolvidos */
const SEM_GUICHE_COBRADO = 30_000
const SEM_GUICHE_DEVOLVIDO = 5_000
const SEM_GUICHE = SEM_GUICHE_COBRADO - SEM_GUICHE_DEVOLVIDO
/** o total de balcão do evento: as três, pela régua da gaveta */
const NO_BALCAO_DO_GUICHE = NO_GUICHE_HOJE + NO_GUICHE_ANTES + SEM_GUICHE
/** o buraco entre o cabeçalho e a soma dos cartões: as DUAS partes */
const FORA_DOS_CARTOES = NO_BALCAO_DO_GUICHE - NO_GUICHE_HOJE

/**
 * A VENDA CANCELADA NO GUICHÊ — o estado que a fixture das sete telas não
 * tinha, e que o cancelamento de balcão produz o tempo todo.
 *
 * `SQL_CANCELA_VENDA_PDV` (`utils/caixa.ts`) grava `status = 'cancelado'` com
 * `refunded_cents = total_cents`: o operador tirou as notas da gaveta e
 * devolveu. É devolução tanto quanto o estorno parcial.
 */
const CANCELADA_NO_GUICHE = 40_000

/**
 * O BALCÃO SEM GUICHÊ — a venda que a tela de pontos de venda descartava.
 *
 *   com ponto, débito       60.000 − 0     = 60.000
 *   SEM ponto, dinheiro     30.000 − 5.000 = 25.000
 *
 * `NO_BALCAO_COM_O_DEFEITO` é o que a tela mostrava: o recorte
 * `pos_terminal_id IS NOT NULL` jogava a venda órfã fora inteira. Medido no
 * evento semeado antes do conserto — R$ 470,00 / 3 vendas no cartão "Vendido
 * na bilheteria" contra R$ 2.202,80 / 13 no `porCanal` do painel e no
 * `porPonto` do extrato, que já contavam as duas.
 */
const NO_BALCAO = 85_000
const NO_BALCAO_COM_O_DEFEITO = 60_000
const NO_BALCAO_SEM_PONTO = 25_000
const NO_BALCAO_DEVOLVIDO = 5_000
/** o que o painel soma por canal: o mesmo, mas sem descontar a devolução */
const COBRADO_NO_BALCAO = 90_000

/** o evento de verdade, que este arquivo só LÊ */
const SEMEADO = '3cd875a0-e230-448a-892b-d4cc840b1948'

/**
 * O líquido da fixture, somado na mão a partir da tabela do `utils/liquido.ts`
 * (`total − plataforma − devolvido`), pra o teste não repetir a expressão que
 * está tentando provar:
 *
 *   repassou a taxa   110.000 − 10.000 −     0 = 100.000
 *   absorveu a taxa    50.000 −  5.000 −     0 =  45.000
 *   cupom + parcial    93.500 −  8.500 − 2.000 =  83.000
 *   estorno total               (não sobrou nada a apurar) = 0
 *   expirado                    (nunca virou dinheiro)     = 0
 */
const LIQUIDO = 228_000
/** o que a conta errada devolveria: o estorno parcial apagado inteiro */
const LIQUIDO_COM_O_DEFEITO = LIQUIDO - 83_000
/** o que os compradores pagaram nos três pedidos vivos que cobraram algo */
const COBRADO = 110_000 + 50_000 + 93_500

/**
 * Pedido VIVO é o que tem líquido a apurar — inclusive o que fechou em zero.
 * São cinco: repassou, absorveu, cupom+parcial, a cortesia da casa e a venda
 * gratuita. Os dois últimos não somam dinheiro nenhum, mas CONTAM como pedido,
 * e é por essa população que o ticket médio por pedido divide.
 */
const PEDIDOS_VIVOS = 5
const PEDIDOS_FECHADOS = 4

/**
 * A RÉGUA DA DEVOLUÇÃO, somada na mão: R$ 20 do estorno parcial + R$ 220 do
 * estorno TOTAL. A pergunta "quanto foi devolvido ao comprador" não tem como
 * excluir o pedido que devolveu tudo — ele só não tem mais líquido a apurar.
 *
 * `DEVOLVIDO_NO_LIQUIDO` é a outra pergunta: quanto da devolução já está
 * descontado do líquido. Essa é só a dos vivos, e é ela que fecha
 * `cobrado − plataforma − devolvido = líquido`.
 */
const DEVOLVIDO = 2_000 + 22_000
const DEVOLVIDO_NO_LIQUIDO = 2_000

/**
 * O CAIXA DO BALCÃO — os dois pedidos do guichê, pela régua de `contarTurno`
 * (`utils/caixa.ts`): o que entrou menos o que voltou pra mão do cliente.
 *
 *   débito, taxa absorvida   50.000 − 0     = 50.000
 *   dinheiro, estorno parcial 93.500 − 2.000 = 91.500
 *
 * `NO_CAIXA_COM_O_DEFEITO` é o que a tela mostrava: `status = 'pago'` derruba
 * o pedido do estorno parcial inteiro, e sobra só a venda em débito — com o
 * turno continuando a contar os ingressos dos dois.
 */
const NO_CAIXA = 141_500
const NO_CAIXA_DINHEIRO = 91_500
const NO_CAIXA_ELETRONICO = 50_000
const NO_CAIXA_COM_O_DEFEITO = 50_000

/**
 * Cortesia é o que a CASA deu. São duas emitidas e UMA de pé: a outra foi
 * cancelada, devolveu a cota e não ocupa mais lugar. A venda que fechou em
 * ZERO (`ZZ-CT-GRATIS`) carrega a mesma marca `is_courtesy` no ingresso e NÃO
 * é cortesia de ninguém — era ela que fazia o borderô dizer um número e a tela
 * de Cortesias dizer outro.
 */
const CORTESIAS_EMITIDAS = 2
const CORTESIAS_OCUPANDO = 1

/**
 * O DIA DA JANELA — um dia fixo, longe de "hoje", pra a prova não depender da
 * hora em que a suíte roda.
 *
 * Brasil não tem horário de verão desde 2019, então a diferença é sempre de 3
 * horas: o pedido das 23h30 do dia anterior fica DENTRO da janela errada
 * (`new Date('2026-03-10')` = 21h do dia 9 na Bahia) e FORA da janela certa.
 */
const DIA_DA_JANELA = '2026-03-10'
const DIA_ANTERIOR = '2026-03-09'
/** o pedido que é do dia mesmo — o único que pode aparecer */
const NA_JANELA = 70_000
/** o das 23h30 da véspera, que as três horas a mais arrastavam pra dentro */
const NA_VESPERA = 40_000

/**
 * O comprador que leva o grupo: UM pedido de R$ 1.100 com QUATRO ingressos
 * emitidos, um deles CANCELADO depois. É a linha que prova duas coisas de uma
 * vez:
 *
 * - a soma de dinheiro não se multiplica pelo ingresso — com o pedido repetido
 *   num `JOIN tickets`, o gasto sai R$ 3.300 em vez de R$ 1.100;
 * - "quantos ingressos essa pessoa levou" se conta em `tickets`, não na
 *   quantidade do item do pedido: o item continua com 4 pra sempre e quem
 *   morre é o ingresso. É a regra que `publico.get.ts` e o `porSetor` do
 *   painel já escreveram, e que o top de relatórios não seguia.
 */
const GASTO_DO_GRUPO = 110_000
const INGRESSOS_DO_GRUPO = 3

/** o que os ITENS dos cinco pedidos vivos somam: 4 + 1 + 2 + 2 (cortesia) + 1 (grátis) */
const INGRESSOS_EMITIDOS = 10

/**
 * O cupom mora no pedido com estorno PARCIAL de propósito: é o pedido que o
 * recorte por `'pago'` derruba, então é nele que a tela de cupons e o
 * relatório param de concordar. Face 95.000 com 10.000 de abatimento fecha nos
 * mesmos 93.500 cobrados — o líquido do arquivo não muda por causa dele.
 */
const DESCONTO_DO_CUPOM = 10_000

let noAr = false
let cookie = ''
let cookieDaCasa = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../utils/db')
  return q<any>(texto, par)
}

const comSessao = (rota: string, quem = cookie) =>
  fetch(`${BASE}${rota}`, {
    headers: { 'content-type': 'application/json', cookie: quem, origin: BASE },
  })

async function json(rota: string, quem = cookie) {
  const r = await comSessao(rota, quem)
  const corpo = await r.json().catch(() => ({}))
  if (r.status !== 200) {
    throw new Error(`${rota} respondeu ${r.status}: ${corpo.statusMessage ?? corpo.message ?? ''}`)
  }
  return corpo
}

/**
 * O `R$` que o `Intl` monta vem com espaço FINO (U+00A0), não com espaço
 * normal — comparar sem normalizar falha com as duas strings IDÊNTICAS na
 * tela. Escrito com `fromCharCode` de propósito: um U+00A0 solto dentro de uma
 * regex é invisível no editor e no diff.
 */
const ESPACO_FINO = new RegExp(String.fromCharCode(160), 'g')
const semEspacoFino = (s: string) => s.replace(ESPACO_FINO, ' ')

/**
 * SÓ O QUE A TELA DESENHOU — comentário de template e payload do Nuxt fora.
 *
 * O Vue manda os comentários `<!-- -->` do `.vue` pro HTML, e o `__NUXT_DATA__`
 * carrega o payload inteiro no fim da página. Procurar texto no HTML cru
 * encontra as duas coisas: a primeira versão do caso da venda órfã ficou
 * VERDE porque o comentário do `.vue` cita a frase que o caso procura — com a
 * linha arrancada da tela, o teste continuava passando. Um teste que fica
 * verde com a trava arrancada é pior que não ter teste.
 */
const soOQueARenderizou = (html: string) =>
  semEspacoFino(html.replace(/<!--[\s\S]*?-->/g, '')
                    .replace(/<script[\s\S]*?<\/script>/g, ''))

async function entrar(email: string) {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha: 'diamond123' }),
  })
  return (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}

/**
 * O MESMO número, pelas CINCO portas por onde o produtor olha o dinheiro do
 * evento. Cada uma tem um handler diferente, e é isso que está sendo provado.
 *
 * O painel (`/dashboard`) entrou aqui depois: ele também soma dinheiro, também
 * tinha sido corrigido e não tinha nenhum teste em cima — com a régua velha de
 * volta ele divergia das outras quatro em R$ 830 e a suíte seguia verde.
 *
 * Uma diferença de construção que vale saber antes de investigar um vermelho:
 * o painel janela por `paid_at` e as outras quatro não. Pedido VIVO sem data de
 * pagamento (hoje não existe nenhum no banco) apareceria só nas outras quatro.
 */
async function asTelasDoDinheiro(eventoId: string, quem = cookie) {
  const [bordero, financeiroDoEvento, financeiroDaOrg, relatorios, dashboard] =
    await Promise.all([
      json(`/api/admin/evento/${eventoId}/bordero`, quem),
      json(`/api/admin/evento/${eventoId}/financeiro`, quem),
      json(`/api/admin/financeiro`, quem),
      json(`/api/admin/evento/${eventoId}/relatorios`, quem),
      json(`/api/admin/evento/${eventoId}/dashboard`, quem),
    ])
  const linhaDaOrg = financeiroDaOrg.eventos.find((e: any) => e.id === eventoId)
  expect(linhaDaOrg, 'o evento sumiu da lista do financeiro da organização').toBeTruthy()
  return {
    bordero: bordero.totais.liquidoCents,
    financeiroDoEvento: financeiroDoEvento.resumo.liquidoCents,
    financeiroDaOrg: linhaDaOrg.liquidoCents,
    relatorios: relatorios.resumo.liquidoCents,
    dashboard: dashboard.totais.liquidoCents,
  }
}

/**
 * AS SETE PORTAS, com o corpo inteiro de cada uma.
 *
 * `asTelasDoDinheiro` acima devolve só o líquido, porque líquido é o único
 * campo que as CINCO telas de total expõem. Esta aqui abre as sete e devolve o
 * payload cru: o extrato e a lista de vendas mostram devolução, face e cobrado
 * na cara do produtor e nunca tinham entrado em comparação nenhuma.
 *
 * A linha da organização sai já filtrada — comparar o total da org com o total
 * do evento seria comparar populações diferentes e daria vermelho no dia em
 * que a fixture ganhasse o segundo evento.
 */
async function asSeteTelas(eventoId: string, quem = cookie) {
  const [bordero, financeiroDoEvento, financeiroDaOrg, relatorios, dashboard, extrato, vendas] =
    await Promise.all([
      json(`/api/admin/evento/${eventoId}/bordero`, quem),
      json(`/api/admin/evento/${eventoId}/financeiro`, quem),
      json(`/api/admin/financeiro`, quem),
      json(`/api/admin/evento/${eventoId}/relatorios`, quem),
      json(`/api/admin/evento/${eventoId}/dashboard`, quem),
      json(`/api/admin/evento/${eventoId}/extrato`, quem),
      json(`/api/admin/evento/${eventoId}/vendas`, quem),
    ])
  const org = financeiroDaOrg.eventos.find((e: any) => e.id === eventoId)
  expect(org, 'o evento sumiu da lista do financeiro da organização').toBeTruthy()
  return { bordero, financeiroDoEvento, org, relatorios, dashboard, extrato, vendas }
}

/** insere um pedido com os valores que o checkout gravaria; devolve o id */
async function pedido(campos: {
  codigo: string
  status?: string
  canal?: string
  face: number
  /** o que o COMPRADOR pagou de taxa: igual à taxa quando repassa, 0 quando absorve */
  feeComprador: number
  /** o que a plataforma retém, sempre */
  plataforma: number
  /** o abatimento do cupom: sai do bolso do produtor, a face continua cheia */
  desconto?: number
  estornado?: number
  asaas?: string | null
  pago?: boolean
  comprador?: string | null
  cupom?: string | null
  /** forma de pagamento — o caixa separa dinheiro de cartão pra conferir a gaveta */
  forma?: string | null
  /** venda de balcão: amarra o pedido ao guichê e ao caixa aberto */
  noBalcao?: boolean
  /**
   * um guichê OUTRO, sem turno — pro caso do balcão sem caixa aberto. Passar
   * `null` explícito é venda de balcão SEM ponto nenhum, que é o caso que a
   * tela de PDV descartava.
   */
  ponto?: string | null
  /** instante do pagamento; o padrão é agora */
  pagoEm?: Date
  /** o evento; o padrão é o da fixture de dinheiro */
  evento?: string
}): Promise<string> {
  const desconto = campos.desconto ?? 0
  const [linha] = await sql(
    `INSERT INTO orders (org_id, event_id, customer_id, promo_code_id, code, status, channel,
                         face_cents, fee_cents, platform_cents, discount_cents,
                         total_cents, refunded_cents, asaas_payment_id, paid_at,
                         payment_method, pos_terminal_id, pos_shift_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id`,
    [ORG, campos.evento ?? EVENTO, campos.comprador ?? null, campos.cupom ?? null,
     campos.codigo, campos.status ?? 'pago', campos.canal ?? 'online',
     campos.face, campos.feeComprador, campos.plataforma, desconto,
     // o banco exige total = face + fee − desconto
     campos.face + campos.feeComprador - desconto,
     campos.estornado ?? 0,
     campos.asaas === undefined ? `pay_${campos.codigo}` : campos.asaas,
     campos.pago === false ? null : campos.pagoEm ?? new Date(),
     campos.forma ?? null,
     campos.ponto !== undefined ? campos.ponto : campos.noBalcao ? PONTO : null,
     campos.noBalcao ? TURNO : null])
  return linha.id
}

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).status < 500
  } catch { noAr = false }
  if (!noAr) return

  await sql(`INSERT INTO organizations (id, name, slug)
             VALUES ($1,'ZZ CONTAGEM TESTE','zz-contagem-teste')
             ON CONFLICT (id) DO NOTHING`, [ORG])

  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,'ZZ EVENTO CONTAGEM','zz-evento-contagem',
             now() - interval '10 days', now() - interval '9 days', 1000, 'ativo')
     ON CONFLICT (id) DO UPDATE SET ends_at = EXCLUDED.ends_at`, [EVENTO, ORG])

  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'Dono Contagem Teste', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [USUARIO, ORG, EMAIL])

  // O master da CASA: mesma senha, mesma organização do evento semeado, mas
  // e-mail só deste arquivo. Logar com `dono@fazendapark.com.br` amarra esta
  // grade ao freio de força bruta que `autenticacao.test.ts` dispara de
  // propósito naquele e-mail (oito falhas em 15 min = 429 pra suíte inteira).
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, e.org_id, 'Master Casa Contagem', $3, u.password_hash, 'master'
       FROM events e, users u
      WHERE e.id = $2 AND u.email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [USUARIO_CASA, SEMEADO, EMAIL_CASA])

  cookie = await entrar(EMAIL)
  cookieDaCasa = await entrar(EMAIL_CASA)

  // O evento da JANELA: mesma organização, pedidos em horas escolhidas a dedo.
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,'ZZ EVENTO JANELA','zz-evento-janela',
             now() - interval '10 days', now() - interval '9 days', 1000, 'ativo')
     ON CONFLICT (id) DO NOTHING`, [EVENTO_JANELA, ORG])

  // O evento do BALCÃO SEM GUICHÊ: duas vendas de bilheteria, uma delas sem
  // `pos_terminal_id`. Separado pelo mesmo motivo do de cima — a venda órfã
  // mudaria todos os totais do evento principal.
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,'ZZ EVENTO BALCÃO','zz-evento-balcao',
             now() - interval '10 days', now() - interval '9 days', 1000, 'ativo')
     ON CONFLICT (id) DO NOTHING`, [EVENTO_BALCAO, ORG])
  await sql(
    `INSERT INTO pos_terminals (id, org_id, event_id, name, location, kind)
     VALUES ($1,$2,$3,'ZZ GUICHÊ BALCÃO','Portão ZZB','bilheteria')
     ON CONFLICT (id) DO NOTHING`, [PONTO_BALCAO, ORG, EVENTO_BALCAO])

  // O evento do GUICHÊ QUE VENDEU ONTEM: mesmo guichê, duas datas, mais uma
  // venda órfã e uma venda CANCELADA. Separado pelo mesmo motivo dos outros
  // dois — cada um desses casos mexeria em todos os totais do evento
  // principal.
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,'ZZ EVENTO GUICHÊ','zz-evento-guiche',
             now() - interval '10 days', now() - interval '9 days', 1000, 'ativo')
     ON CONFLICT (id) DO NOTHING`, [EVENTO_GUICHE, ORG])
  await sql(
    `INSERT INTO pos_terminals (id, org_id, event_id, name, location, kind)
     VALUES ($1,$2,$3,'ZZ GUICHÊ DE ONTEM','Portão ZZG','bilheteria')
     ON CONFLICT (id) DO NOTHING`, [PONTO_GUICHE, ORG, EVENTO_GUICHE])

  await sql(`DELETE FROM entries WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM tickets WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM orders WHERE event_id = ANY($1)`,
            [[EVENTO, EVENTO_JANELA, EVENTO_BALCAO, EVENTO_GUICHE]])
  await sql(`DELETE FROM promo_codes WHERE event_id = $1`, [EVENTO])

  // O guichê e o caixa ABERTO. Precisam existir antes dos pedidos: é o turno
  // que amarra a venda de balcão ao caixa, e é esse par de telas (cartão do
  // ponto × extrato do caixa) que mais briga na noite do evento — o gerente
  // numa, o operador na outra.
  await sql(
    `INSERT INTO pos_terminals (id, org_id, event_id, name, location, kind)
     VALUES ($1,$2,$3,'ZZ GUICHÊ CONTAGEM','Portão ZZ','bilheteria')
     ON CONFLICT (id) DO NOTHING`, [PONTO, ORG, EVENTO])
  await sql(
    `INSERT INTO pos_shifts (id, org_id, event_id, terminal_id, operator_id, status,
                             opening_float_cents)
     VALUES ($1,$2,$3,$4,$5,'aberto',0)
     ON CONFLICT (id) DO NOTHING`, [TURNO, ORG, EVENTO, PONTO, USUARIO])

  // O comprador que leva o grupo: um pedido, quatro ingressos. É a linha que
  // denuncia soma multiplicada por JOIN.
  await sql(
    `INSERT INTO customers (id, org_id, name, email, phone)
     VALUES ($1,$2,'ZZ Grupo de Quatro','zz.grupo@teste.invalido','71999990000')
     ON CONFLICT (id) DO NOTHING`, [COMPRADOR, ORG])

  await sql(
    `INSERT INTO promo_codes (id, event_id, code, kind, value)
     VALUES ($1,$2,'ZZ-CT-CUPOM','fixo',$3)
     ON CONFLICT (id) DO NOTHING`, [CUPOM, EVENTO, DESCONTO_DO_CUPOM])

  // 1) online, taxa POR FORA: o comprador pagou R$ 1.100, o produtor fica com
  //    os R$ 1.000 de face. É o pedido DO GRUPO — quatro ingressos nele.
  const pedidoDoGrupo = await pedido({
    codigo: 'ZZ-CT-REPASSA', face: 100_000, feeComprador: 10_000,
    plataforma: 10_000, comprador: COMPRADOR })

  // 2) balcão, taxa ABSORVIDA, no CAIXA e em cartão: o comprador pagou R$ 500
  //    redondos e os R$ 50 de taxa saem do produtor. `face − estornado`
  //    devolveria R$ 500 aqui.
  const pedidoDoBalcao = await pedido({
    codigo: 'ZZ-CT-ABSORVE', canal: 'bilheteria', asaas: null,
    forma: 'debito', noBalcao: true,
    face: 50_000, feeComprador: 0, plataforma: 5_000 })

  // 3) O CASO QUE PARTE AS TELAS: face de R$ 950 com R$ 100 de cupom e taxa
  //    por fora — R$ 935 cobrados — e R$ 20 devolvidos depois. O webhook grava
  //    `estornado_parcial`; o pedido continua valendo R$ 830 pro produtor. Um
  //    recorte por `'pago'` apaga os R$ 830 E apaga o cupom da tela de cupons.
  //
  //    Ele mora no MESMO caixa do de cima, e em dinheiro: as notas voltaram
  //    pra mão do cliente, então a gaveta tem R$ 915 desta venda. Era o pedido
  //    que sumia inteiro do total do turno na tela de pontos de venda enquanto
  //    o extrato do mesmo caixa continuava mostrando ele.
  const pedidoComCupom = await pedido({
    codigo: 'ZZ-CT-PARCIAL', status: 'estornado_parcial',
    canal: 'bilheteria', asaas: null, forma: 'dinheiro', noBalcao: true,
    face: 95_000, feeComprador: 8_500, plataforma: 8_500,
    desconto: DESCONTO_DO_CUPOM, cupom: CUPOM,
    estornado: 2_000 })

  // 4) estorno TOTAL: o comprador recebeu tudo de volta, não sobrou nada a
  //    apurar. Tem que ficar de fora das quatro.
  await pedido({ codigo: 'ZZ-CT-TOTAL', status: 'estornado',
                 face: 20_000, feeComprador: 2_000, plataforma: 2_000,
                 estornado: 22_000 })

  // 5) pix que nunca foi pago
  await pedido({ codigo: 'ZZ-CT-EXPIRADO', status: 'expirado', pago: false,
                 face: 30_000, feeComprador: 3_000, plataforma: 3_000, asaas: null })

  // 6) A CORTESIA DA CASA: pedido nascido na rota de cortesia, zero de tudo.
  //    Duas emitidas, uma CANCELADA depois — que devolveu a cota e não ocupa
  //    mais lugar nenhum.
  const pedidoDeCortesia = await pedido({
    codigo: 'ZZ-CT-CORTESIA', canal: 'cortesia', asaas: null, forma: 'cortesia',
    face: 0, feeComprador: 0, plataforma: 0 })

  // 7) A VENDA QUE FECHOU EM ZERO (cupom de 100%, lote grátis). O ingresso dela
  //    nasce com `is_courtesy` marcado por `utils/emissao.ts` — a mesma marca
  //    da cortesia — mas ela NÃO é cortesia de ninguém: é venda, e aparece em
  //    Vendas e em Participantes. Contá-la como cortesia inflava o borderô
  //    contra a tela que existe pra controlar cortesia.
  const pedidoGratuito = await pedido({
    codigo: 'ZZ-CT-GRATIS', canal: 'online', asaas: null,
    face: 0, feeComprador: 0, plataforma: 0 })

  // ------------------------------------------------- o livro da porta ------
  // Um setor de MESA DE 4: um ingresso, quatro pessoas dentro. É o caso em
  // que contar público por ingresso emitido erra por um fator de quatro.
  await sql(
    `INSERT INTO sectors (id, event_id, name, kind, admits, sort_order)
     VALUES ($1,$2,'ZZ MESA DE 4','ingresso',4,0)
     ON CONFLICT (id) DO NOTHING`, [SETOR, EVENTO])
  await sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity)
     VALUES ($1,$2,'ZZ LOTE ÚNICO',10000,10)
     ON CONFLICT (id) DO NOTHING`, [LOTE, SETOR])
  await sql(
    `INSERT INTO tickets (id, org_id, event_id, sector_id, lot_id, order_id, code, qr_secret, status)
     VALUES ($1,$2,$3,$4,$5,$6,'ZZ-CT-TICKET-1','zz-ct-segredo-1','usado')
     ON CONFLICT (id) DO NOTHING`, [INGRESSO, ORG, EVENTO, SETOR, LOTE, pedidoDoGrupo])

  // Os outros três ingressos do MESMO pedido — e o quarto CANCELADO. Várias
  // linhas de `tickets` apontando pro mesmo pedido é o que faz um JOIN mal
  // colocado somar o pedido uma vez por ingresso; e o cancelado é o que separa
  // "quantos o item do pedido diz" (4, pra sempre) de "quantos ingressos essa
  // pessoa tem de pé" (3).
  for (const n of [2, 3, 4]) {
    await sql(
      `INSERT INTO tickets (org_id, event_id, sector_id, lot_id, order_id, code, qr_secret, status,
                            canceled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (code) DO NOTHING`,
      [ORG, EVENTO, SETOR, LOTE, pedidoDoGrupo, `ZZ-CT-TICKET-${n}`, `zz-ct-segredo-${n}`,
       n === 4 ? 'cancelado' : 'valido', n === 4 ? new Date() : null])
  }
  // Os itens do pedido, com o valor unitário fechando com o total de cada um.
  // Sem eles o evento tem ZERO ingressos vendidos e todo número "por ingresso"
  // vira 0 — o que deixa um teste de divisão por ingresso vermelho pelo motivo
  // errado (divisão por zero, não a régua trocada). Sete ingressos em três
  // pedidos, que é o caso em que "por pedido" e "por ingresso" dão números bem
  // diferentes.
  for (const [pedidoId, qtd, face, taxa, total] of [
    [pedidoDoGrupo, 4, 25_000, 2_500, 27_500],   // 4 × 27.500 = 110.000
    [pedidoDoBalcao, 1, 50_000, 0, 50_000],      // 1 × 50.000 =  50.000
    [pedidoComCupom, 2, 47_500, 4_250, 46_750],  // 2 × 46.750 =  93.500
    [pedidoDeCortesia, 2, 0, 0, 0],              // cortesia da casa: ocupa, não fatura
    [pedidoGratuito, 1, 0, 0, 0],                // venda que fechou em zero
  ] as [string, number, number, number, number][]) {
    await sql(
      `INSERT INTO order_items (order_id, lot_id, quantity,
                                unit_face_cents, unit_fee_cents, unit_total_cents)
       VALUES ($1,$2,$3,$4,$5,$6)`, [pedidoId, LOTE, qtd, face, taxa, total])
  }

  // Os ingressos de graça. Os três carregam `is_courtesy` — é a marca que
  // `utils/emissao.ts` põe em todo ingresso de pedido que fechou em zero — e
  // só DOIS são cortesia da casa. Um desses dois está cancelado. Quem contar
  // `is_courtesy` puro diz 3; quem contar como a tela de Cortesias conta diz 1.
  for (const [pedidoId, n, status] of [
    [pedidoDeCortesia, 1, 'valido'],
    [pedidoDeCortesia, 2, 'cancelado'],
    [pedidoGratuito, 3, 'valido'],
  ] as [string, number, string][]) {
    await sql(
      `INSERT INTO tickets (org_id, event_id, sector_id, lot_id, order_id, code, qr_secret,
                            status, is_courtesy, canceled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)
       ON CONFLICT (code) DO NOTHING`,
      [ORG, EVENTO, SETOR, LOTE, pedidoId, `ZZ-CT-GRATIS-${n}`, `zz-ct-gratis-${n}`,
       status, status === 'cancelado' ? new Date() : null])
  }

  // ------------------------------------------------ a janela do "Hoje" -----
  // Dois pedidos em instantes escolhidos a dedo, no fuso de QUEM OPERA: um às
  // 23h30 de um dia e outro às 00h30 do dia seguinte. `new Date('2026-03-10')`
  // é meia-noite UTC, ou seja 21h do dia 9 na Bahia — e com ela o pedido das
  // 23h30 do dia 9 entra no "Hoje" do dia 10.
  await pedido({ codigo: 'ZZ-CT-VESPERA', evento: EVENTO_JANELA, asaas: null,
                 face: 40_000, feeComprador: 0, plataforma: 0,
                 pagoEm: new Date(`${DIA_ANTERIOR}T23:30:00`) })
  await pedido({ codigo: 'ZZ-CT-NO-DIA', evento: EVENTO_JANELA, asaas: null,
                 face: 70_000, feeComprador: 0, plataforma: 0,
                 pagoEm: new Date(`${DIA_DA_JANELA}T00:30:00`) })

  // --------------------------------------- o balcão SEM guichê cadastrado ---
  // Duas vendas de bilheteria no mesmo evento: uma no guichê, uma sem ponto
  // nenhum — que é o estado de 10 dos 13 pedidos de balcão do evento semeado
  // (importação, seed, venda anterior ao cadastro do guichê). A sem ponto
  // ainda tem estorno PARCIAL, pra a venda órfã precisar passar pelas DUAS
  // réguas (pedido vivo e o que voltou pra mão do cliente) pra ser contada.
  await pedido({ codigo: 'ZZ-CT-BAL-COM', evento: EVENTO_BALCAO, canal: 'bilheteria',
                 asaas: null, forma: 'debito', ponto: PONTO_BALCAO,
                 face: 60_000, feeComprador: 0, plataforma: 6_000 })
  await pedido({ codigo: 'ZZ-CT-BAL-SEM', evento: EVENTO_BALCAO, canal: 'bilheteria',
                 asaas: null, forma: 'dinheiro', ponto: null,
                 status: 'estornado_parcial',
                 face: 30_000, feeComprador: 0, plataforma: 3_000,
                 estornado: NO_BALCAO_DEVOLVIDO })

  // ------------------------- o guichê que vendeu ONTEM, e o cancelamento ---
  // Três vendas vivas no mesmo evento e uma cancelada. O guichê NÃO tem caixa
  // aberto, então o cartão dele mostra só o dia de hoje — e é justamente por
  // isso que a venda de três dias atrás fica no cabeçalho sem aparecer em
  // cartão nenhum, sem ser venda órfã.
  await pedido({ codigo: 'ZZ-CT-GUI-HOJE', evento: EVENTO_GUICHE, canal: 'bilheteria',
                 asaas: null, forma: 'debito', ponto: PONTO_GUICHE,
                 face: NO_GUICHE_HOJE, feeComprador: 0, plataforma: 6_000 })
  await pedido({ codigo: 'ZZ-CT-GUI-ANTES', evento: EVENTO_GUICHE, canal: 'bilheteria',
                 asaas: null, forma: 'debito', ponto: PONTO_GUICHE,
                 face: NO_GUICHE_ANTES, feeComprador: 0, plataforma: 8_000,
                 pagoEm: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) })
  await pedido({ codigo: 'ZZ-CT-GUI-SEM', evento: EVENTO_GUICHE, canal: 'bilheteria',
                 asaas: null, forma: 'dinheiro', ponto: null,
                 status: 'estornado_parcial',
                 face: SEM_GUICHE_COBRADO, feeComprador: 0, plataforma: 3_000,
                 estornado: SEM_GUICHE_DEVOLVIDO })
  // A VENDA CANCELADA NO GUICHÊ, como `SQL_CANCELA_VENDA_PDV` a deixa:
  // `cancelado` com `refunded_cents = total_cents`. Ela não tem líquido a
  // apurar e não entra em nenhum total de venda — mas DEVOLVEU dinheiro, e é
  // por isso que ela está aqui.
  await pedido({ codigo: 'ZZ-CT-GUI-CANC', evento: EVENTO_GUICHE, canal: 'bilheteria',
                 asaas: null, forma: 'dinheiro', ponto: PONTO_GUICHE,
                 status: 'cancelado',
                 face: CANCELADA_NO_GUICHE, feeComprador: 0, plataforma: 4_000,
                 estornado: CANCELADA_NO_GUICHE })

  // A passagem: UMA leitura, QUATRO pessoas — como o servidor grava, copiando
  // `sectors.admits` no instante em que a catraca liberou.
  await sql(
    `INSERT INTO entries (id, org_id, event_id, ticket_id, people, gate, device_id, offline)
     VALUES ($1,$2,$3,$4,4,'Portão Norte','zz-ct-tablet',false)
     ON CONFLICT (id) DO NOTHING`, [ENTRADA, ORG, EVENTO, INGRESSO])
}, 30_000)

afterAll(async () => {
  if (!noAr) return
  await sql(`DELETE FROM entries WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM tickets WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM orders WHERE event_id = ANY($1)`,
            [[EVENTO, EVENTO_JANELA, EVENTO_BALCAO, EVENTO_GUICHE]])
  await sql(`DELETE FROM promo_codes WHERE event_id = $1`, [EVENTO])
  // o turno sai ANTES do usuário: `pos_shifts.operator_id` é ON DELETE
  // RESTRICT, e apagar o operador primeiro deixaria a fixture inteira de pé
  await sql(`DELETE FROM pos_shifts WHERE id = $1`, [TURNO])
  await sql(`DELETE FROM pos_terminals WHERE id = ANY($1)`,
            [[PONTO, PONTO_BALCAO, PONTO_GUICHE]])
  await sql(`DELETE FROM customers WHERE id = $1`, [COMPRADOR])
  await sql(`DELETE FROM lots WHERE id = $1`, [LOTE])
  await sql(`DELETE FROM sectors WHERE id = $1`, [SETOR])
  await sql(`DELETE FROM users WHERE id = ANY($1)`, [[USUARIO, USUARIO_CASA]])
  await sql(`DELETE FROM events WHERE id = ANY($1)`,
            [[EVENTO, EVENTO_JANELA, EVENTO_BALCAO, EVENTO_GUICHE]])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

// O título deste bloco dizia "as cinco telas" e o arquivo passou a abrir
// sete. Quem conta cinco aqui dentro é `asTelasDoDinheiro`, e conta cinco
// porque LÍQUIDO é o único campo que só cinco expõem — o extrato e a lista de
// vendas não apuram o que sobra pro produtor. A grade das sete está no bloco
// seguinte, campo a campo.
describe('as telas do dinheiro contam igual', () => {
  it('borderô, financeiro do evento, financeiro da org, relatórios e painel dão o MESMO número', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()

    const n = await asTelasDoDinheiro(EVENTO)

    // Primeiro a igualdade: é ela que impede a tela de discordar de si mesma,
    // mesmo que um dia o valor certo mude.
    expect(new Set(Object.values(n)).size,
      `as cinco rotas discordaram: ${JSON.stringify(n)}`).toBe(1)

    // E depois o valor, somado na mão lá em cima. Sem isto as cinco poderiam
    // concordar num número errado — que é o que acontecia quando todas
    // escreviam `face − estornado`.
    expect(n, 'as cinco concordaram, mas no número errado').toEqual({
      bordero: LIQUIDO,
      financeiroDoEvento: LIQUIDO,
      financeiroDaOrg: LIQUIDO,
      relatorios: LIQUIDO,
      dashboard: LIQUIDO,
    })
  }, 30_000)

  it('o estorno parcial não apaga o pedido inteiro de nenhuma das cinco', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const n = await asTelasDoDinheiro(EVENTO)
    for (const [rota, valor] of Object.entries(n)) {
      expect(valor,
        `${rota} recortou por status = 'pago': uma devolução de R$ 20 apagou ` +
        `os R$ 830 do pedido inteiro`).not.toBe(LIQUIDO_COM_O_DEFEITO)
    }
  }, 30_000)

  it('o "ticket médio" de cada tela continua sendo o que o rótulo dela promete', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const [rel, dash] = await Promise.all([
      json(`/api/admin/evento/${EVENTO}/relatorios`),
      json(`/api/admin/evento/${EVENTO}/dashboard`),
    ])

    // Armadilha de nome, não de número: `ticketMedioCents` queria dizer coisas
    // diferentes nas DUAS rotas — por PEDIDO em relatórios ("Ticket médio ·
    // por pedido" na tela) e por INGRESSO no painel ("Ticket médio por
    // ingresso"). Os dois rótulos estão certos; medido no evento semeado,
    // R$ 88,00 num e R$ 43,47 no outro com o mesmo nome de campo.
    //
    // Este caso prende cada um na sua conta. Trocar a régua de um lado sem
    // trocar o rótulo do .vue junto faz a tela mentir em silêncio — que é
    // exatamente o defeito desta trilha, só que na legenda em vez do total.
    expect(rel.resumo.ticketMedioPorPedidoCents,
      'relatórios deixou de dividir por PEDIDO, e o rótulo da tela diz "por pedido"')
      .toBe(Math.round(COBRADO / PEDIDOS_VIVOS))
    expect(dash.totais.ticketMedioPorIngressoCents,
      'o painel deixou de dividir por INGRESSO, e o rótulo da tela diz "por ingresso"')
      .toBe(Math.round(COBRADO / INGRESSOS_EMITIDOS))

    // E o número por ingresso de relatórios é o MESMO do painel: quando duas
    // telas respondem a mesma pergunta, elas respondem igual.
    expect(rel.resumo.ticketMedioPorIngressoCents,
      'o "por ingresso" de relatórios discorda do "ticket médio por ingresso" do painel')
      .toBe(dash.totais.ticketMedioPorIngressoCents)

    expect(rel.resumo.ticketMedioPorPedidoCents,
      'a fixture ficou fraca: com 1 ingresso por pedido as duas contas ' +
      'coincidem e este caso não prova nada')
      .not.toBe(dash.totais.ticketMedioPorIngressoCents)
  }, 20_000)

  it('o campo do ticket médio DIZ qual régua usou', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const [rel, dash] = await Promise.all([
      json(`/api/admin/evento/${EVENTO}/relatorios`),
      json(`/api/admin/evento/${EVENTO}/dashboard`),
    ])

    // O painel tinha um `ticketMedioCents` por INGRESSO e relatórios tinha um
    // `ticketMedioCents` por PEDIDO. Mesmo nome, contas opostas — armadilha
    // armada pro primeiro relatório que lesse as duas rotas. Quem sobrou tem
    // a régua no nome, e o nome ambíguo NÃO pode voltar ao painel.
    expect(dash.totais.ticketMedioCents,
      'o nome ambíguo voltou ao painel: `ticketMedioCents` quer dizer por ' +
      'ingresso aqui e por pedido em relatórios')
      .toBeUndefined()

    expect({
      porIngresso: dash.totais.ticketMedioPorIngressoCents,
      porPedido: dash.totais.ticketMedioPorPedidoCents,
    }, 'o painel trocou a régua de um dos dois campos')
      .toEqual({
        porIngresso: Math.round(COBRADO / INGRESSOS_EMITIDOS),
        porPedido: Math.round(COBRADO / PEDIDOS_VIVOS),
      })

    // AS DUAS ROTAS CHAMAM A MESMA PERGUNTA PELO MESMO NOME.
    //
    // Enquanto relatórios devolvia `ticketMedioCents` e o painel devolvia
    // `ticketMedioPorPedidoCents`, quem escrevesse um relatório lendo as duas
    // precisava saber de cor qual campo era qual. Agora as duas expõem os
    // mesmos dois nomes com a régua dentro do nome.
    expect({
      porPedido: rel.resumo.ticketMedioPorPedidoCents,
      porIngresso: rel.resumo.ticketMedioPorIngressoCents,
    }, 'relatórios não devolve os dois campos com a régua no nome, como o painel')
      .toEqual({
        porPedido: dash.totais.ticketMedioPorPedidoCents,
        porIngresso: dash.totais.ticketMedioPorIngressoCents,
      })

    // O NOME ANTIGO SÓ PODE EXISTIR COMO APELIDO.
    //
    // `ticketMedioCents` e `porIngressoCents` continuam no payload de
    // relatórios porque a tela (`relatorios/index.vue`) ainda lê esses dois —
    // arrancá-los sem trocar lá deixaria os dois KPIs em R$ 0,00, sem exceção
    // e sem console. O que este caso trava é que eles NUNCA carreguem uma
    // conta própria: no dia em que um deles apontar pra outra régua, esta
    // linha fica vermelha antes de a tela mentir.
    for (const [apelido, canonico] of [
      ['ticketMedioCents', 'ticketMedioPorPedidoCents'],
      ['porIngressoCents', 'ticketMedioPorIngressoCents'],
    ] as const) {
      if (rel.resumo[apelido] === undefined) continue // a tela já migrou: ótimo
      expect(rel.resumo[apelido],
        `o apelido ${apelido} deixou de ser apelido e virou uma segunda conta — ` +
        `ele tem que ser o MESMO número de ${canonico}`)
        .toBe(rel.resumo[canonico])
    }
  }, 20_000)

  it('relatórios mostra a devolução em vez de esconder o pedido', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const r = await json(`/api/admin/evento/${EVENTO}/relatorios`)
    expect({
      pedidos: r.resumo.pedidos,
      fechados: r.resumo.pedidosFechados,
      comEstorno: r.resumo.pedidosComEstorno,
      // a devolução INTEIRA do evento — é a pergunta que o rótulo faz
      estornado: r.resumo.estornadoCents,
      // e a parte dela que já saiu do líquido, com nome próprio
      estornadoNoLiquido: r.resumo.estornadoNoLiquidoCents,
      cobrado: r.resumo.cobradoCents,
    }, 'o pedido com estorno parcial sumiu da contagem ou o estorno não aparece')
      .toEqual({
        pedidos: PEDIDOS_VIVOS, fechados: PEDIDOS_FECHADOS, comEstorno: 1,
        estornado: DEVOLVIDO, estornadoNoLiquido: DEVOLVIDO_NO_LIQUIDO, cobrado: COBRADO,
      })

    // Ticket médio divide pela MESMA população que somou. Somar cinco pedidos
    // e dividir por quatro é o jeito silencioso de a média inflar.
    expect(r.resumo.ticketMedioPorPedidoCents,
      'o ticket médio dividiu por uma população diferente da que somou')
      .toBe(Math.round(COBRADO / PEDIDOS_VIVOS))
  }, 20_000)

  it('a curva por dia soma o mesmo líquido do total', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const r = await json(`/api/admin/evento/${EVENTO}/relatorios`)
    const soma = r.porDia.reduce((s: number, d: any) => s + d.liquidoCents, 0)
    // Total que não é a soma das linhas é o jeito clássico de a tela do
    // dinheiro discordar de si mesma na mesma tela.
    expect(soma, 'a soma dos dias não fecha com o total da tela').toBe(LIQUIDO)
  }, 20_000)

  it('a lista de eventos e a de organizações contam pela mesma régua', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const [eventos, orgs] = await Promise.all([
      json('/api/admin/eventos'),
      json('/api/admin/organizacoes'),
    ])
    const linha = eventos.find((e: any) => e.id === EVENTO)
    expect(linha, 'o evento sumiu da listagem').toBeTruthy()
    // A listagem é a primeira tela que o produtor abre. Ela dizer um número e
    // o painel do evento dizer outro é o mesmo defeito, só que na porta de
    // entrada.
    expect(linha.liquidoCents, 'a listagem de eventos discorda do painel do evento').toBe(LIQUIDO)
    expect(linha.cobradoCents, 'a listagem perdeu o pedido com estorno parcial').toBe(COBRADO)

    // A organização soma TODOS os eventos dela (esta fixture tem dois: o do
    // dinheiro e o da janela de data), então o número esperado sai do banco
    // pela mesma régua escrita à mão — e não de um literal, que passaria a
    // mentir no dia em que a fixture ganhasse mais um evento.
    const [naOrg] = await sql(
      `SELECT COALESCE(SUM(total_cents - platform_cents - refunded_cents)
                FILTER (WHERE status IN ('pago','estornado_parcial')),0)::bigint AS liquido,
              COALESCE(SUM(total_cents)
                FILTER (WHERE status IN ('pago','estornado_parcial')),0)::bigint AS cobrado
         FROM orders WHERE org_id = $1`, [ORG])

    const org = orgs.find((o: any) => o.id === ORG)
    expect(org, 'a organização sumiu da listagem').toBeTruthy()
    expect(org.liquidoCents, 'a tela de organizações discorda do financeiro')
      .toBe(Number(naOrg.liquido))
    expect(org.faturadoCents, 'o faturado da organização perdeu o estorno parcial')
      .toBe(Number(naOrg.cobrado))
    // e o evento do dinheiro continua dentro dessa soma
    expect(org.liquidoCents, 'a organização deixou de somar o evento do dinheiro')
      .toBeGreaterThanOrEqual(LIQUIDO)
  }, 20_000)

  it('o gasto do comprador não se multiplica pelo número de ingressos', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const [rel, pub] = await Promise.all([
      json(`/api/admin/evento/${EVENTO}/relatorios`),
      json(`/api/admin/evento/${EVENTO}/publico`),
    ])
    const daTelaDePublico = pub.topCompradores.find((t: any) => t.email === 'zz.grupo@teste.invalido')
    const deRelatorios = rel.topCompradores.find((t: any) => t.email === 'zz.grupo@teste.invalido')
    expect(daTelaDePublico, 'o comprador do grupo sumiu da aba Público').toBeTruthy()
    expect(deRelatorios, 'o comprador do grupo sumiu do top de relatórios').toBeTruthy()

    // UM pedido de R$ 1.100 com QUATRO ingressos. Com `JOIN tickets` na mesma
    // consulta o pedido aparece uma vez por ingresso e `sum(total_cents)`
    // devolve R$ 4.400 — quatro vezes o que a pessoa gastou. Não estoura, não
    // loga: só mostra um cliente rico que não existe.
    expect({ gasto: daTelaDePublico.gastoCents, ingressos: daTelaDePublico.ingressos },
      'a aba Público somou o mesmo pedido uma vez por ingresso')
      .toEqual({ gasto: GASTO_DO_GRUPO, ingressos: INGRESSOS_DO_GRUPO })

    // E as duas telas que mostram "quem mais comprou" mostram o mesmo. Uma
    // dizendo R$ 883,88 e a outra R$ 220,97 pra mesma pessoa foi o estado
    // anterior, medido no evento semeado.
    expect(deRelatorios.gastoCents,
      'relatórios e a aba Público discordam do gasto da MESMA pessoa')
      .toBe(daTelaDePublico.gastoCents)
    expect(deRelatorios.ingressos,
      'relatórios e a aba Público discordam de quantos ingressos a pessoa levou')
      .toBe(daTelaDePublico.ingressos)
  }, 20_000)

  it('o cupom custou o mesmo na tela de cupons e no relatório', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const [cupons, rel] = await Promise.all([
      json(`/api/admin/evento/${EVENTO}/cupons`),
      json(`/api/admin/evento/${EVENTO}/relatorios`),
    ])
    const naTelaDeCupons = cupons.cupons.find((c: any) => c.codigo === 'ZZ-CT-CUPOM')
    const noRelatorio = rel.porCupom.find((c: any) => c.codigo === 'ZZ-CT-CUPOM')
    expect(naTelaDeCupons, 'o cupom sumiu da tela de cupons').toBeTruthy()
    expect(noRelatorio, 'o cupom sumiu do relatório').toBeTruthy()

    // O cupom foi usado no pedido com estorno PARCIAL. Recorte por `'pago'` na
    // tela de cupons some com o abatimento inteiro e o relatório continua
    // mostrando — duas respostas pra "quanto este código custou".
    expect(naTelaDeCupons.descontoDadoCents,
      'a tela de cupons perdeu o abatimento do pedido com estorno parcial')
      .toBe(DESCONTO_DO_CUPOM)
    expect(noRelatorio.descontoCents,
      'a tela de cupons e o relatório discordam do que o MESMO código custou')
      .toBe(naTelaDeCupons.descontoDadoCents)
  }, 20_000)
})

describe('não é só o líquido: CADA campo comparável bate entre as SETE telas', () => {
  /**
   * A GRADE DAS SETE PORTAS — uma consulta, um campo de cada vez.
   *
   * O título deste arquivo prometia "cada campo comparável entre as telas" e
   * comparava CINCO. `/extrato` e `/vendas` mostram devolução, face e cobrado
   * pro mesmo produtor, na mesma noite, e nunca tinham entrado em comparação
   * nenhuma — foi por essa porta que a devolução de `/relatorios` ficou
   * discordando das outras seis sem nada ficar vermelho.
   *
   * A régua de cada linha abaixo:
   *
   * - **devolução** (`estornadoCents`) — as SETE respondem, e é "quanto voltou
   *   pro comprador", com o estorno TOTAL dentro.
   * - **líquido** — as cinco que apuram o que sobra pro produtor.
   * - **face / taxa / desconto / cobrado** — a população é o pedido VIVO.
   * - **contagem** — `pedidos` é a população que somou; `pedidosFechados` é a
   *   outra pergunta e tem nome próprio.
   *
   * ## A EXCEÇÃO DO `/extrato`, escrita e provada
   *
   * O extrato NÃO entra na igualdade de face/taxa/cobrado, e isso é decisão,
   * não desleixo: ele é extrato de MOVIMENTO e a população dele é todo pedido
   * que mexeu dinheiro — `pago`, `estornado`, `estornado_parcial`,
   * `chargeback`, `disputa`. O pedido devolvido por inteiro precisa aparecer
   * numa tela que existe pra explicar linha a linha por que o dia caiu;
   * escondê-lo ali seria o defeito oposto.
   *
   * Por isso o caso não ignora a diferença: ele a AFIRMA. A face do extrato
   * tem que ser maior exatamente pela face dos pedidos que mexeram dinheiro e
   * não estão vivos, lida do banco. Assim o dia em que o extrato começar a
   * derrubar o estorno total — ou a somar um pedido a mais — esta linha fica
   * vermelha do mesmo jeito.
   */
  it('as SETE telas do dinheiro dizem o MESMO em cada campo comparável', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()

    const t = await asSeteTelas(EVENTO)

    // ---------------------------------------------------------------------
    // 1. A DEVOLUÇÃO — o campo que as SETE mostram, e onde a sétima mentia.
    const devolucao = {
      bordero: t.bordero.totais.estornadoCents,
      painel: t.dashboard.totais.estornadoCents,
      financeiroDoEvento: t.financeiroDoEvento.resumo.estornadoCents,
      extrato: t.extrato.totais.estornadoCents,
      vendas: t.vendas.totais.estornadoCents,
      financeiroDaOrg: t.org.estornadoCents,
      relatorios: t.relatorios.resumo.estornadoCents,
    }
    expect(new Set(Object.values(devolucao)).size,
      `as sete telas discordaram da devolução: ${JSON.stringify(devolucao)}`).toBe(1)
    expect(devolucao.relatorios,
      'as sete concordaram, mas no número errado — a devolução é tudo que ' +
      'voltou pro comprador, inclusive o pedido estornado por inteiro')
      .toBe(DEVOLVIDO)

    // ---------------------------------------------------------------------
    // 2. O LÍQUIDO — as cinco que apuram o que sobra pro produtor.
    const liquido = {
      bordero: t.bordero.totais.liquidoCents,
      painel: t.dashboard.totais.liquidoCents,
      financeiroDoEvento: t.financeiroDoEvento.resumo.liquidoCents,
      financeiroDaOrg: t.org.liquidoCents,
      relatorios: t.relatorios.resumo.liquidoCents,
    }
    expect(new Set(Object.values(liquido)).size,
      `as cinco telas de líquido discordaram: ${JSON.stringify(liquido)}`).toBe(1)
    expect(liquido.bordero, 'o líquido das cinco não é o somado à mão').toBe(LIQUIDO)

    // ---------------------------------------------------------------------
    // 3. FACE e TAXA — a população é o pedido VIVO, nas CINCO que somam.
    //
    //    O FINANCEIRO DO EVENTO ENTROU AQUI NA TERCEIRA PASSAGEM, e foi por
    //    esta fresta que o defeito atravessou a segunda: a grade tinha
    //    acabado de trazer o financeiro da ORGANIZAÇÃO pra comparação e
    //    deixou de fora justamente o `brutoCents`/`taxasCents` da tela
    //    IRMÃ — o mesmo `FILTER (WHERE status = 'pago')`, no arquivo do lado.
    //    Medido na fixture com a grade inteira verde: bruto R$ 1.800,00 no
    //    financeiro do evento contra R$ 2.750,00 nas outras quatro, com o
    //    líquido igual em todas.
    //
    //    E foi dado por morto porque a medição de conferência rodou no evento
    //    SEMEADO, onde não existe estorno parcial nenhum: ali `'pago'` e
    //    `PEDIDO_VIVO()` respondem o mesmo número e a tela passa verde com a
    //    conta errada. É por isso que o alvo desta grade é a fixture.
    const face = {
      bordero: t.bordero.totais.faceCents,
      painel: t.dashboard.totais.faceCents,
      financeiroDoEvento: t.financeiroDoEvento.resumo.brutoCents,
      financeiroDaOrg: t.org.faceCents,
      relatorios: t.relatorios.resumo.faceCents,
    }
    expect(new Set(Object.values(face)).size,
      `as telas discordaram da face: ${JSON.stringify(face)}`).toBe(1)

    const taxa = {
      bordero: t.bordero.totais.taxaCents,
      painel: t.dashboard.totais.taxaCents,
      financeiroDoEvento: t.financeiroDoEvento.resumo.taxasCents,
      financeiroDaOrg: t.org.taxaCents,
      relatorios: t.relatorios.resumo.taxaCents,
    }
    expect(new Set(Object.values(taxa)).size,
      `as telas discordaram da taxa: ${JSON.stringify(taxa)}`).toBe(1)

    // FACE MENOR QUE O PRÓPRIO LÍQUIDO é aritmeticamente impossível, e era
    // exatamente o que as duas telas de financeiro mostravam — cada uma na
    // sua vez. É o sintoma que qualquer um reconhece sem saber de SQL, então
    // ele fica travado por tela, com nome, e não só na igualdade acima.
    for (const [tela, faceDaTela, liquidoDaTela] of [
      ['financeiro da organização', t.org.faceCents, t.org.liquidoCents],
      ['financeiro do evento',
       t.financeiroDoEvento.resumo.brutoCents, t.financeiroDoEvento.resumo.liquidoCents],
    ] as [string, number, number][]) {
      expect(faceDaTela,
        `o ${tela} mostra uma face MENOR que o próprio líquido — o recorte ` +
        'por status = \'pago\' voltou')
        .toBeGreaterThanOrEqual(liquidoDaTela)
    }

    // ---------------------------------------------------------------------
    // 4. DESCONTO e COBRADO.
    const desconto = {
      bordero: t.bordero.totais.descontoCents,
      painel: t.dashboard.totais.descontoCents,
      financeiroDoEvento: t.financeiroDoEvento.resumo.descontosCents,
      relatorios: t.relatorios.resumo.descontoCents,
    }
    expect(new Set(Object.values(desconto)).size,
      `as telas discordaram do desconto: ${JSON.stringify(desconto)}`).toBe(1)
    expect(desconto.relatorios, 'o desconto do cupom sumiu de alguma tela')
      .toBe(DESCONTO_DO_CUPOM)

    const cobrado = {
      painel: t.dashboard.totais.cobradoCents,
      relatorios: t.relatorios.resumo.cobradoCents,
      // o borderô não tem o campo: tem a quebra por forma, e as partes somam
      // o todo das outras duas
      borderoPorForma: t.bordero.formas.reduce((s: number, f: any) => s + f.totalCents, 0),
    }
    expect(new Set(Object.values(cobrado)).size,
      `as telas discordaram do cobrado: ${JSON.stringify(cobrado)}`).toBe(1)
    expect(cobrado.relatorios, 'o cobrado das telas não é o somado à mão').toBe(COBRADO)

    // ---------------------------------------------------------------------
    // 5. CONTAGEM — duas perguntas, cada uma com o seu nome, e as duas iguais
    //    em toda tela que as responde.
    const pedidosVivos = {
      painel: t.dashboard.totais.pedidos,
      relatorios: t.relatorios.resumo.pedidos,
      financeiroDoEvento: t.financeiroDoEvento.resumo.pedidos,
      financeiroDaOrg: t.org.pedidos,
    }
    expect(new Set(Object.values(pedidosVivos)).size,
      `as telas discordaram de quantos pedidos viraram dinheiro: ${JSON.stringify(pedidosVivos)}`)
      .toBe(1)
    expect(pedidosVivos.financeiroDaOrg,
      'o financeiro da organização voltou a contar só os pedidos em \'pago\'')
      .toBe(PEDIDOS_VIVOS)

    const fechados = {
      bordero: t.bordero.totais.pedidosPagos,
      painel: t.dashboard.totais.pedidosFechados,
      financeiroDoEvento: t.financeiroDoEvento.resumo.pedidosPagos,
      financeiroDaOrg: t.org.pedidosFechados,
      relatorios: t.relatorios.resumo.pedidosFechados,
    }
    expect(new Set(Object.values(fechados)).size,
      `as telas discordaram de quantos pedidos fecharam: ${JSON.stringify(fechados)}`).toBe(1)
    expect(fechados.relatorios, 'a contagem de fechados não é a somada à mão')
      .toBe(PEDIDOS_FECHADOS)

    // A fixture só prova alguma coisa enquanto as duas perguntas tiverem
    // respostas DIFERENTES — sem pedido com estorno parcial elas coincidem.
    expect(PEDIDOS_VIVOS,
      'a fixture ficou fraca: sem estorno parcial "vivos" e "fechados" ' +
      'coincidem e o recorte por \'pago\' não teria sintoma')
      .not.toBe(PEDIDOS_FECHADOS)

    // ---------------------------------------------------------------------
    // 6. A EXCEÇÃO DO EXTRATO — afirmada, não ignorada.
    //
    // O extrato inclui de propósito todo pedido que MEXEU dinheiro, vivo ou
    // não. A diferença dele pras outras telas tem que ser exatamente a face
    // (e o cobrado) desses pedidos — nem um centavo a mais.
    const [fora] = await sql(
      `SELECT COALESCE(SUM(face_cents),0)::bigint  AS face,
              COALESCE(SUM(total_cents),0)::bigint AS cobrado,
              COALESCE(SUM(fee_cents),0)::bigint   AS taxa,
              count(*)::int                        AS pedidos
         FROM orders
        WHERE event_id = $1
          AND status IN ('estornado','chargeback','disputa')`, [EVENTO])

    expect({
      face: t.extrato.totais.faceCents - face.bordero,
      cobrado: t.extrato.totais.cobradoCents - cobrado.relatorios,
      taxa: t.extrato.totais.taxaCompradorCents - taxa.bordero,
    }, 'o extrato deixou de ser extrato de MOVIMENTO: a diferença dele pras ' +
       'outras telas não é mais a dos pedidos que mexeram dinheiro e não ' +
       'estão vivos')
      .toEqual({
        face: Number(fora.face), cobrado: Number(fora.cobrado), taxa: Number(fora.taxa),
      })

    // E a exceção só é exceção enquanto existir pedido morto que mexeu
    // dinheiro: sem ele o extrato bateria com as outras por acidente e esta
    // parte do caso não provaria nada.
    expect(Number(fora.pedidos),
      'a fixture perdeu o pedido estornado por inteiro — a exceção do extrato ' +
      'passou a ser indistinguível de igualdade')
      .toBeGreaterThan(0)
    expect(t.extrato.totais.faceCents,
      'o extrato passou a recortar pelos vivos e parou de mostrar o pedido ' +
      'devolvido por inteiro, que é a linha que explica a queda do dia')
      .toBeGreaterThan(face.bordero)
  }, 30_000)

  /**
   * DENTRO do financeiro da organização: as partes somam o todo.
   *
   * O total da linha do evento já foi travado no caso acima. Aqui é a outra
   * metade da mesma tela — o gráfico por mês e a quebra por forma de
   * pagamento — que continuava com `WHERE status = 'pago'` de verdade, não em
   * `FILTER`: a soma dessas partes dava menos que o total impresso acima delas
   * e não havia nada na tela explicando a diferença. Medido na fixture antes:
   * por forma R$ 1.900,00 contra R$ 2.835,00 de cobrado.
   *
   * O número esperado sai do BANCO com a régua escrita à mão, e não de um
   * literal — a organização da fixture tem três eventos e ganharia um quarto
   * no dia em que alguém precisasse de mais um caso.
   */
  it('o financeiro da organização: por mês e por forma somam o total da tela', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const fin = await json('/api/admin/financeiro')

    const [naOrg] = await sql(
      `SELECT COALESCE(SUM(face_cents)
                FILTER (WHERE status IN ('pago','estornado_parcial')),0)::bigint AS face,
              COALESCE(SUM(fee_cents)
                FILTER (WHERE status IN ('pago','estornado_parcial')),0)::bigint AS taxa,
              COALESCE(SUM(total_cents)
                FILTER (WHERE status IN ('pago','estornado_parcial')),0)::bigint AS cobrado,
              COALESCE(SUM(face_cents)
                FILTER (WHERE status IN ('pago','estornado_parcial')
                          AND paid_at IS NOT NULL),0)::bigint AS face_com_data
         FROM orders WHERE org_id = $1`, [ORG])

    // O total da tela é a soma das linhas por evento — e é a régua dos vivos.
    expect({ face: fin.totais.faceCents, taxa: fin.totais.taxaCents },
      'o total do financeiro da organização não é o que o banco confirma pela ' +
      'régua do pedido vivo')
      .toEqual({ face: Number(naOrg.face), taxa: Number(naOrg.taxa) })

    // A curva por mês é a decomposição dessa face. Ela exige `paid_at`, então
    // o alvo é a face dos vivos COM data de pagamento.
    const porMes = fin.porMes.reduce((s: number, m: any) => s + m.faceCents, 0)
    expect(porMes,
      'a curva por mês voltou a recortar por status = \'pago\': o mês do ' +
      'estorno parcial perdeu a venda inteira e a barra encolheu sozinha')
      .toBe(Number(naOrg.face_com_data))

    // E a quebra por forma de pagamento soma o cobrado dos vivos.
    const porForma = fin.porForma.reduce((s: number, f: any) => s + f.cobradoCents, 0)
    expect(porForma,
      'a quebra por forma de pagamento não fecha com o cobrado da organização')
      .toBe(Number(naOrg.cobrado))

    // A fixture só prova alguma coisa enquanto o recorte por 'pago' der um
    // número DIFERENTE — senão o defeito não teria sintoma aqui.
    const [soPagos] = await sql(
      `SELECT COALESCE(SUM(total_cents) FILTER (WHERE status = 'pago'),0)::bigint AS cobrado
         FROM orders WHERE org_id = $1`, [ORG])
    expect(porForma,
      'a fixture ficou fraca: sem pedido com estorno parcial na organização, ' +
      'a régua errada dava no mesmo')
      .not.toBe(Number(soPagos.cobrado))
  }, 30_000)

  /**
   * O líquido já estava travado e as telas continuavam brigando no resto —
   * face, taxa, desconto, devolução, contagem de pedido. Todas essas somas
   * tinham a própria régua, e o padrão do defeito era sempre o mesmo:
   * `FILTER (WHERE status = 'pago')` numa soma de dinheiro, que derruba o
   * pedido com estorno parcial antes de qualquer conta chegar nele.
   *
   * Este caso exige igualdade campo a campo e, no fim, confere contra a régua
   * de `utils/liquido.ts` lida do BANCO — não contra um literal, que envelhece.
   */
  it('borderô, relatórios e painel dizem o MESMO em cada campo', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const [bordero, rel, dash] = await Promise.all([
      json(`/api/admin/evento/${EVENTO}/bordero`),
      json(`/api/admin/evento/${EVENTO}/relatorios`),
      json(`/api/admin/evento/${EVENTO}/dashboard`),
    ])

    for (const campo of ['faceCents', 'taxaCents', 'descontoCents', 'liquidoCents'] as const) {
      const trio = {
        bordero: bordero.totais[campo], relatorios: rel.resumo[campo], painel: dash.totais[campo],
      }
      expect(new Set(Object.values(trio)).size,
        `as três telas discordaram em ${campo}: ${JSON.stringify(trio)}`).toBe(1)
    }

    // O cobrado: o borderô não tem o campo, tem a quebra por forma de
    // pagamento — e as partes precisam somar o todo das outras duas telas.
    const porForma = bordero.formas.reduce((s: number, f: any) => s + f.totalCents, 0)
    expect({ porForma, relatorios: rel.resumo.cobradoCents, painel: dash.totais.cobradoCents },
      'a soma por forma de pagamento do borderô não fecha com o cobrado das outras telas')
      .toEqual({ porForma: COBRADO, relatorios: COBRADO, painel: COBRADO })

    // E dentro da própria tela: a quebra por canal tem que somar o total dela.
    const porCanal = bordero.canais.reduce((s: number, c: any) => s + c.faceCents, 0)
    expect(porCanal, 'a face por canal não soma a face total do borderô')
      .toBe(bordero.totais.faceCents)

    // Contagem de pedido é outra pergunta, mas também tem que ser a MESMA
    // resposta nas duas telas que a respondem.
    expect({
      pedidos: dash.totais.pedidos,
      fechados: dash.totais.pedidosFechados,
      comEstorno: dash.totais.pedidosComEstorno,
      ingressos: dash.totais.ingressos,
    }, 'o painel conta pedido/ingresso diferente de relatórios')
      .toEqual({
        pedidos: rel.resumo.pedidos,
        fechados: rel.resumo.pedidosFechados,
        comEstorno: rel.resumo.pedidosComEstorno,
        ingressos: rel.resumo.ingressos,
      })

    // A conta do líquido fecha DENTRO do borderô, com os campos que ele mesmo
    // mostra: cobrado (face + taxa − desconto, garantido pelo CHECK
    // `total_fecha`) − plataforma − devolvido dos vivos. Se qualquer um dos
    // recortes divergir, esta linha não fecha.
    const t = bordero.totais
    expect(t.faceCents + t.taxaCents - t.descontoCents - t.plataformaCents
           - t.estornadoNoLiquidoCents,
      'a conta do líquido não fecha com os próprios números do borderô')
      .toBe(t.liquidoCents)

    // E o número sai do BANCO pela régua escrita à mão, não de um literal.
    const [linha] = await sql(
      `SELECT COALESCE(SUM(face_cents) FILTER (WHERE status IN ('pago','estornado_parcial')),0)::bigint AS face,
              COALESCE(SUM(fee_cents) FILTER (WHERE status IN ('pago','estornado_parcial')),0)::bigint AS taxa,
              COALESCE(SUM(discount_cents) FILTER (WHERE status IN ('pago','estornado_parcial')),0)::bigint AS desconto,
              COALESCE(SUM(total_cents - platform_cents - refunded_cents)
                       FILTER (WHERE status IN ('pago','estornado_parcial')),0)::bigint AS liquido
         FROM orders WHERE event_id = $1`, [EVENTO])
    expect({
      face: t.faceCents, taxa: t.taxaCents, desconto: t.descontoCents, liquido: t.liquidoCents,
    }, 'as três telas concordaram num número que o banco não confirma')
      .toEqual({
        face: Number(linha.face), taxa: Number(linha.taxa),
        desconto: Number(linha.desconto), liquido: Number(linha.liquido),
      })
  }, 30_000)

  it('o estorno TOTAL aparece como devolução, e não só o parcial', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const [bordero, rel, dash] = await Promise.all([
      json(`/api/admin/evento/${EVENTO}/bordero`),
      json(`/api/admin/evento/${EVENTO}/relatorios`),
      json(`/api/admin/evento/${EVENTO}/dashboard`),
    ])

    // A pergunta é "quanto foi devolvido ao comprador neste evento". A
    // resposta honesta inclui o pedido devolvido POR INTEIRO — ele só não tem
    // mais líquido a apurar, não é que a devolução não aconteceu. Recortando
    // pelos vivos, o evento devolveu R$ 240,00 e a tela dizia R$ 20,00.
    //
    // Relatórios entrou aqui na terceira passagem: as outras seis telas já
    // respondiam R$ 240,00 e ela respondia R$ 20,00 — a sétima porta, com o
    // mesmo rótulo e outro número.
    expect({
      bordero: bordero.totais.estornadoCents,
      painel: dash.totais.estornadoCents,
      relatorios: rel.resumo.estornadoCents,
    }, 'a devolução parou de contar o estorno total — R$ 220,00 sumiram da tela')
      .toEqual({ bordero: DEVOLVIDO, painel: DEVOLVIDO, relatorios: DEVOLVIDO })

    // E a OUTRA pergunta — quanto da devolução já está descontado do líquido —
    // continua respondida, com nome próprio, pela régua dos vivos. É ela que
    // fecha a conta do líquido, e as três telas que a respondem respondem igual.
    expect({
      bordero: bordero.totais.estornadoNoLiquidoCents,
      painel: dash.totais.estornadoNoLiquidoCents,
      relatorios: rel.resumo.estornadoNoLiquidoCents,
    }, 'os dois lados da devolução se misturaram de novo')
      .toEqual({
        bordero: DEVOLVIDO_NO_LIQUIDO, painel: DEVOLVIDO_NO_LIQUIDO,
        relatorios: DEVOLVIDO_NO_LIQUIDO,
      })

    // E o valor exato que o defeito produzia, com o nome do que ele fazia.
    expect(rel.resumo.estornadoCents,
      'relatórios voltou a recortar a devolução por PEDIDO_VIVO: o estorno ' +
      'total sumiu e a sétima tela discorda das outras seis')
      .not.toBe(DEVOLVIDO_NO_LIQUIDO)

    // A curva por dia é a decomposição do LÍQUIDO, então a devolução dela é a
    // dos vivos — e o nome do campo diz isso. Somar a devolução total numa
    // curva de líquido faria a soma dos dias parar de fechar com o total.
    const naCurva = rel.porDia.reduce((s: number, d: any) => s + d.estornadoNoLiquidoCents, 0)
    expect(naCurva, 'a curva por dia trocou a régua da devolução')
      .toBe(DEVOLVIDO_NO_LIQUIDO)

    // A fixture só prova alguma coisa se os dois números forem diferentes.
    expect(DEVOLVIDO, 'a fixture ficou fraca: sem estorno total os dois números coincidem')
      .not.toBe(DEVOLVIDO_NO_LIQUIDO)

    const [linha] = await sql(
      `SELECT COALESCE(SUM(refunded_cents),0)::bigint AS tudo
         FROM orders WHERE event_id = $1`, [EVENTO])
    expect(bordero.totais.estornadoCents,
      'a devolução da tela não é a que o banco registra')
      .toBe(Number(linha.tudo))
  }, 30_000)

  it('cortesia é o que a CASA deu — venda gratuita e cortesia cancelada ficam fora', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const [bordero, cortesias, dash] = await Promise.all([
      json(`/api/admin/evento/${EVENTO}/bordero`),
      json(`/api/admin/evento/${EVENTO}/cortesias`),
      json(`/api/admin/evento/${EVENTO}/dashboard`),
    ])

    // Medido no evento semeado antes do conserto: borderô 3, tela de Cortesias
    // 2. Duas telas, dois números, mesma pergunta — e a diferença era uma
    // cortesia CANCELADA, que já devolveu a cota e não ocupa lugar nenhum.
    expect(bordero.totais.cortesias,
      'o borderô voltou a contar cortesia cancelada ou venda gratuita')
      .toBe(CORTESIAS_OCUPANDO)
    expect(bordero.totais.cortesias,
      'o borderô e a tela de Cortesias discordam de quantas cortesias ocupam lugar')
      .toBe(cortesias.cota.eventoUsadas)
    expect(cortesias.resumo.ocupando).toBe(CORTESIAS_OCUPANDO)

    // Três ingressos carregam `is_courtesy` na fixture; só dois são cortesia
    // da casa e só um está de pé. Contar a marca crua dá 3 — é o número que o
    // borderô mostrava.
    const [marca] = await sql(
      `SELECT count(*)::int AS n FROM tickets WHERE event_id = $1 AND is_courtesy`, [EVENTO])
    expect(Number(marca.n),
      'a fixture perdeu a venda gratuita ou a cortesia cancelada, e o caso não prova mais nada')
      .toBe(3)
    expect(bordero.totais.cortesias,
      'o borderô voltou a contar `is_courtesy` cru')
      .not.toBe(Number(marca.n))

    // A venda que fechou em zero não é cortesia de ninguém — e o painel também
    // não pode chamá-la assim. Lá a unidade é o item do pedido (é a
    // decomposição de "ingressos emitidos"), então ele conta as duas emitidas.
    expect(dash.totais.cortesiasEmitidas,
      'o painel chamou a venda gratuita de cortesia')
      .toBe(CORTESIAS_EMITIDAS)
    expect(dash.totais.pagos + dash.totais.cortesiasEmitidas,
      'a decomposição do painel parou de somar os ingressos emitidos')
      .toBe(dash.totais.ingressos)

    // E o nome do campo carrega a régua, senão volta a armadilha do
    // `ticketMedioCents`: `cortesias` no painel valia "emitidas" e `cortesias`
    // no borderô vale "de pé". Mesmo nome, números diferentes de propósito —
    // no evento semeado, 3 contra 2. Quem escrever um relatório lendo as duas
    // rotas soma os dois campos sem desconfiar.
    expect(dash.totais.cortesias,
      'o nome ambíguo voltou ao painel: `cortesias` quer dizer emitidas aqui ' +
      'e de pé no borderô')
      .toBeUndefined()
    expect(bordero.totais.cortesias,
      'o borderô e o painel discordam com o mesmo nome de campo')
      .not.toBe(dash.totais.cortesiasEmitidas)

    // A linha do lote conta a mesma coisa que o total da tela.
    const linha = bordero.lotes.find((l: any) => l.loteId === LOTE)
    expect(linha.cortesias, 'a coluna de cortesia do lote discorda do total do borderô')
      .toBe(CORTESIAS_OCUPANDO)
    // E as duas colunas PARTICIONAM os ingressos de pé do lote: nada some
    // entre "vendidos" e "cortesias" — nem a venda que fechou em zero.
    const [dePe] = await sql(
      `SELECT count(*)::int AS n FROM tickets
        WHERE lot_id = $1 AND status <> 'cancelado'`, [LOTE])
    expect(linha.vendidos + linha.cortesias,
      'ingresso de pé sumiu entre as colunas de vendidos e cortesias do lote')
      .toBe(Number(dePe.n))
  }, 30_000)
})

describe('o balcão: o cartão do ponto e o extrato do caixa contam igual', () => {
  /**
   * Duas telas abertas lado a lado na noite do evento — o gerente na lista de
   * pontos de venda, o operador no extrato do caixa. Elas somavam o dinheiro
   * do MESMO turno por réguas diferentes: a lista recortava por
   * `status = 'pago'` e somava o total cheio, o extrato (`contarTurno`, em
   * `utils/caixa.ts`) usa pedido vivo e desconta o que voltou.
   *
   * Resultado medido na fixture: a lista dizia R$ 500,00 e o caixa dizia
   * R$ 1.415,00 — e a contagem de ingressos do turno continuava contando os
   * dois pedidos, então nem dava pra achar a venda que faltava.
   */
  it('o total do turno na lista de PDV é o mesmo do extrato do caixa', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const [pdv, caixa] = await Promise.all([
      json(`/api/admin/evento/${EVENTO}/pdv`),
      json(`/api/admin/evento/${EVENTO}/pdv/turno?turno=${TURNO}`),
    ])
    const ponto = pdv.pontos.find((p: any) => p.id === PONTO)
    expect(ponto, 'o guichê da fixture sumiu da lista de pontos de venda').toBeTruthy()
    expect(ponto.turno, 'o caixa aberto sumiu do cartão do ponto').toBeTruthy()

    const noExtrato = caixa.contagem.dinheiroCents + caixa.contagem.eletronicoCents
    expect({ naLista: ponto.turno.totalCents, noExtrato },
      'a lista de PDV e o extrato do caixa discordam do MESMO turno')
      .toEqual({ naLista: NO_CAIXA, noExtrato: NO_CAIXA })

    expect(ponto.turno.pedidos,
      'a lista de PDV e o extrato do caixa discordam de quantos pedidos passaram')
      .toBe(caixa.contagem.pedidos)

    // O valor exato que o defeito produzia, com o nome do que ele fazia.
    expect(ponto.turno.totalCents,
      'a lista voltou a recortar por status = \'pago\': a venda com estorno ' +
      'parcial sumiu inteira do turno')
      .not.toBe(NO_CAIXA_COM_O_DEFEITO)

    // A gaveta: dinheiro separado de cartão, como o operador conta na mão.
    expect({
      dinheiro: pdv.resumo.dinheiroCents,
      total: pdv.resumo.brutoCents,
      devolvido: pdv.resumo.estornadoCents,
    }, 'o resumo do balcão do evento discorda da régua da gaveta')
      .toEqual({ dinheiro: NO_CAIXA_DINHEIRO, total: NO_CAIXA, devolvido: DEVOLVIDO_NO_LIQUIDO })
    expect(caixa.contagem.dinheiroCents,
      'o extrato do caixa e a lista de PDV discordam do dinheiro na gaveta')
      .toBe(NO_CAIXA_DINHEIRO)
    expect(caixa.contagem.eletronicoCents).toBe(NO_CAIXA_ELETRONICO)

    // O que a tela de "hoje" do ponto mostra é a mesma régua — as vendas da
    // fixture são todas de agora.
    expect(ponto.hoje.totalCents,
      'o "hoje" do ponto usa uma régua diferente do turno aberto')
      .toBe(NO_CAIXA)
  }, 30_000)

  /**
   * AS LINHAS DO EXTRATO DO CAIXA SOMAM O TOTAL IMPRESSO ACIMA DELAS.
   *
   * O total do turno já batia com a lista de PDV (caso acima) — o que não
   * batia era a tela com ELA MESMA. `contarTurno` conta por pedido VIVO e a
   * LISTA de vendas logo abaixo recortava por `status = 'pago'`: a venda com
   * estorno parcial sumia da lista inteira e continuava dentro do total.
   *
   * Medido na fixture antes: contagem de R$ 1.415,00 em 2 pedidos, UMA linha
   * de R$ 500,00 na tela. O operador confere a gaveta somando o que vê, não
   * fecha com o número impresso logo acima, e não tem como descobrir qual
   * venda falta — a que falta é justamente a que não está lá.
   *
   * Trazer a linha de volta sem mais nada trocaria um buraco de R$ 935 por um
   * de R$ 20, porque a linha vale o que foi vendido e o total conta o que
   * ficou na gaveta. Por isso a linha carrega `naGavetaCents`
   * (`total − estornado`): é a parcela com que ela entra em `contarTurno`, e é
   * a soma DELA que fecha.
   */
  it('a lista de vendas do caixa soma exatamente o total do turno', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const caixa = await json(`/api/admin/evento/${EVENTO}/pdv/turno?turno=${TURNO}`)
    const total = caixa.contagem.dinheiroCents + caixa.contagem.eletronicoCents

    // 1. a venda com estorno parcial está NA LISTA
    const codigos = caixa.vendas.map((v: any) => v.codigo)
    expect(codigos,
      'a lista de vendas voltou a recortar por status = \'pago\': a venda com ' +
      'estorno parcial sumiu da tela e continua dentro do total')
      .toContain('ZZ-CT-PARCIAL')
    expect(caixa.vendas.length,
      'a lista mostra menos vendas do que o turno conta')
      .toBe(caixa.contagem.pedidos)

    // 2. e a soma das linhas é EXATAMENTE o total impresso acima delas
    const somaDasLinhas = caixa.vendas.reduce((s: number, v: any) => s + v.naGavetaCents, 0)
    expect(somaDasLinhas,
      `as linhas da tela somam ${somaDasLinhas} e o total impresso diz ${total} — ` +
      'o operador confere a gaveta somando linhas que não fecham')
      .toBe(total)
    expect(total, 'o total do turno deixou de ser o somado à mão').toBe(NO_CAIXA)

    // 3. a linha devolvida NOMEIA o que voltou, em vez de esconder na
    //    subtração: valor vendido e valor que ficou na gaveta, lado a lado
    const parcial = caixa.vendas.find((v: any) => v.codigo === 'ZZ-CT-PARCIAL')
    expect({
      situacao: parcial.situacao,
      total: parcial.totalCents,
      estornado: parcial.estornadoCents,
      naGaveta: parcial.naGavetaCents,
    }, 'a venda com devolução parcial não diz quanto voltou pra mão do cliente')
      .toEqual({
        situacao: 'estornado_parcial', total: 93_500,
        estornado: DEVOLVIDO_NO_LIQUIDO, naGaveta: NO_CAIXA_DINHEIRO,
      })

    // 4. e a fixture só prova alguma coisa enquanto os dois valores da linha
    //    forem diferentes — sem devolução, somar `totalCents` daria no mesmo
    expect(parcial.totalCents,
      'a fixture ficou fraca: sem devolução na venda, somar o total cheio ' +
      'fecharia com a contagem e o caso não provaria nada')
      .not.toBe(parcial.naGavetaCents)

    // 5. o valor exato que o defeito produzia, com o nome do que ele fazia
    expect(somaDasLinhas,
      'a lista voltou a mostrar só a venda em \'pago\'')
      .not.toBe(NO_CAIXA_COM_O_DEFEITO)
  }, 30_000)

  /**
   * A VENDA DE BALCÃO SEM GUICHÊ CADASTRADO CONTA — e tem nome.
   *
   * O cartão "Vendido na bilheteria" recortava por `pos_terminal_id IS NOT
   * NULL`, que é o `JOIN` que come linha sem par escrito dentro de um `WHERE`.
   * Medido no evento semeado: 10 dos 13 pedidos de bilheteria não têm ponto
   * registrado (importação, seed, venda anterior ao cadastro do guichê), então
   * a tela do balcão dizia R$ 470,00 / 3 vendas enquanto o `porCanal` do
   * painel e o `porPonto` do extrato diziam R$ 2.202,80 / 13 pelo MESMO
   * evento. Três telas, duas respostas — e a errada era a que leva o nome do
   * balcão.
   *
   * Não estoura, não loga, não some da outra tela: o produtor só descobre
   * conferindo a gaveta com R$ 1.732,80 a mais do que o sistema diz.
   */
  it('a venda de balcão sem guichê cadastrado não some do total da bilheteria', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const [pdv, dash] = await Promise.all([
      json(`/api/admin/evento/${EVENTO_BALCAO}/pdv`),
      json(`/api/admin/evento/${EVENTO_BALCAO}/dashboard`),
    ])
    const canal = dash.porCanal.find((c: any) => c.canal === 'bilheteria')
    expect(canal, 'o canal de bilheteria sumiu do painel').toBeTruthy()

    // Primeiro a igualdade entre as telas, que é o que não pode regredir nem
    // quando o valor certo mudar: o painel soma o cobrado cheio e a tela do
    // balcão soma o que sobrou na gaveta, então a ponte é a devolução.
    expect({
      pedidos: pdv.resumo.pedidos,
      cobrado: pdv.resumo.brutoCents + pdv.resumo.estornadoCents,
    }, 'a tela do balcão e o painel discordam de quanto a bilheteria vendeu')
      .toEqual({ pedidos: canal.n, cobrado: canal.cobradoCents })

    // E depois os valores, somados na mão lá em cima.
    expect({
      total: pdv.resumo.brutoCents,
      devolvido: pdv.resumo.estornadoCents,
      cobradoNoPainel: canal.cobradoCents,
    }, 'o balcão parou de bater com a conta feita à mão')
      .toEqual({
        total: NO_BALCAO, devolvido: NO_BALCAO_DEVOLVIDO,
        cobradoNoPainel: COBRADO_NO_BALCAO,
      })

    // O valor exato que o defeito produzia, com o nome do que ele fazia.
    expect(pdv.resumo.brutoCents,
      'a tela do balcão voltou a exigir `pos_terminal_id IS NOT NULL`: a venda ' +
      'sem guichê cadastrado sumiu do total')
      .not.toBe(NO_BALCAO_COM_O_DEFEITO)

    // Entrar no total não basta: a parte que não dá pra atribuir a nenhum
    // cartão da lista precisa ser NOMEADA, senão o total da tela e a soma dos
    // pontos discordam e ninguém sabe onde foi parar a diferença. É a mesma
    // linha "Sem ponto identificado" que o extrato já mostra.
    expect({ cents: pdv.resumo.semPontoCents, pedidos: pdv.resumo.pedidosSemPonto },
      'a venda órfã entrou no total mas não aparece com nome próprio')
      .toEqual({ cents: NO_BALCAO_SEM_PONTO, pedidos: 1 })

    // A fixture só prova alguma coisa se existir venda órfã nela.
    expect(NO_BALCAO_SEM_PONTO,
      'a fixture ficou fraca: sem venda órfã as duas réguas coincidem')
      .toBeGreaterThan(0)

    // E o cartão do ponto continua mostrando só o que é DELE — o órfão não
    // pode ser jogado no guichê pra o total fechar.
    const ponto = pdv.pontos.find((p: any) => p.id === PONTO_BALCAO)
    expect(ponto, 'o guichê do evento de balcão sumiu da lista').toBeTruthy()
    expect(ponto.hoje.totalCents,
      'a venda sem ponto foi atribuída ao guichê pra o total fechar')
      .toBe(NO_BALCAO - NO_BALCAO_SEM_PONTO)
  }, 30_000)

  /**
   * ESTAR NO PAYLOAD NÃO É ESTAR NA TELA.
   *
   * A rota passou a devolver `semPontoCents` / `pedidosSemPonto` e a tela de
   * pontos de venda simplesmente não pintava a linha: o cabeçalho dizia
   * R$ 2.202,80, os cartões dos guichês somavam R$ 470,00, e a diferença de
   * R$ 1.732,80 não aparecia em lugar nenhum. O teste do payload ficava verde
   * e o produtor continuava vendo um total que não conseguia rastrear.
   *
   * É a classe de bug que este projeto mais leva: não estoura, não loga, não
   * deixa teste vermelho — só aparece olhando. Por isso este caso pede o HTML
   * que o servidor renderiza e procura a linha nele.
   *
   * O valor é montado com aritmética inteira, igual ao `reais` de
   * `composables/formato.ts`, e não com `toLocaleString`: o `Intl` separa o
   * `R$` com espaço FINO (U+00A0) e a comparação falha com as duas strings
   * idênticas na tela.
   */
  it('a venda sem guichê aparece NA TELA de pontos de venda, não só no payload', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const r = await comSessao(`/admin/evento/${EVENTO_BALCAO}/pdv`)
    expect(r.status, 'a tela de pontos de venda não abriu').toBe(200)
    const html = soOQueARenderizou(await r.text())

    expect(html,
      'a tela de pontos de venda não nomeia a venda de balcão sem guichê: o ' +
      'total do cabeçalho não fecha com a soma dos cartões e nada explica por quê')
      .toContain('Sem ponto identificado')

    const emReais = (c: number) =>
      `R$ ${Math.floor(c / 100).toLocaleString('pt-BR')},${String(c % 100).padStart(2, '0')}`

    expect(html,
      `a linha existe mas não mostra o valor: ${emReais(NO_BALCAO_SEM_PONTO)} é a ` +
      'diferença entre o total da tela e a soma dos cartões')
      .toContain(emReais(NO_BALCAO_SEM_PONTO))

    // A fixture só prova alguma coisa se o valor da linha for diferente do
    // total — senão bastaria a tela repetir o cabeçalho pra ficar verde.
    expect(NO_BALCAO_SEM_PONTO,
      'a fixture ficou fraca: com a venda órfã valendo o total inteiro, ' +
      'qualquer número na tela passaria')
      .not.toBe(NO_BALCAO)

    // E a tela NÃO pode inventar a linha onde ela não existe: no evento em que
    // toda venda de balcão tem guichê, nada de "sem ponto". Sem esta metade, a
    // linha poderia ser fixa na tela e o caso acima ficaria verde à toa.
    const pdvSemOrfao = await json(`/api/admin/evento/${EVENTO}/pdv`)
    expect(pdvSemOrfao.resumo.semPontoCents,
      'a fixture do evento principal ganhou uma venda órfã e esta metade do ' +
      'caso parou de provar o contrário')
      .toBe(0)
    const semOrfao = await comSessao(`/admin/evento/${EVENTO}/pdv`)
    expect(soOQueARenderizou(await semOrfao.text()),
      'a linha "sem ponto" aparece num evento que não tem venda órfã nenhuma')
      .not.toContain('Sem ponto identificado')
  }, 30_000)

  /**
   * A TELA NÃO PODE PROMETER UMA CONTA QUE ELA NÃO FAZ.
   *
   * A linha "Sem ponto identificado" nasceu certa e veio com uma frase errada
   * embaixo: "entra no total lá em cima e não entra em nenhum cartão acima: é
   * EXATAMENTE a diferença entre os dois". Não é — e o erro não é de arredondar:
   *
   *   cabeçalho  = todo pedido vivo de balcão do EVENTO INTEIRO;
   *   cartão     = o total do CAIXA ABERTO, ou só o de HOJE quando não há um.
   *
   * São populações diferentes. Venda de guichê num turno já fechado, ou de
   * outro dia, está no cabeçalho e em cartão nenhum — e não é venda órfã.
   * Medido nesta fixture com a frase no ar: cabeçalho R$ 1.650,00, cartões
   * R$ 600,00, diferença REAL R$ 1.050,00, e a linha imprimindo R$ 250,00.
   *
   * Frase errada numa tela de dinheiro é pior que nenhuma frase: o produtor
   * confere a conta, ela não fecha, e agora ele desconfia do total também.
   *
   * O caso pede o HTML renderizado, pelo mesmo motivo do de cima: estar no
   * payload não é estar na tela, e aqui o defeito era SÓ da tela.
   */
  it('a tela de PDV mostra a diferença que ela realmente tem, não só a venda órfã', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const pdv = await json(`/api/admin/evento/${EVENTO_GUICHE}/pdv`)

    // A régua da tela, montada do jeito que a tela monta: cada cartão mostra o
    // caixa aberto quando há um, e só o de hoje quando não há.
    const somaDosCartoes = pdv.pontos.reduce(
      (s: number, p: any) => s + Number(p.turno ? p.turno.totalCents : p.hoje.totalCents), 0)
    const foraDosCartoes = pdv.resumo.brutoCents - somaDosCartoes

    expect({
      bruto: pdv.resumo.brutoCents,
      cartoes: somaDosCartoes,
      semPonto: pdv.resumo.semPontoCents,
    }, 'a fixture do guichê de ontem mudou de forma')
      .toEqual({
        bruto: NO_BALCAO_DO_GUICHE,
        cartoes: NO_GUICHE_HOJE,
        semPonto: SEM_GUICHE,
      })

    // A FIXTURE SÓ PROVA ALGUMA COISA enquanto a venda órfã NÃO for o buraco
    // inteiro: é exatamente por isso que existe a venda de três dias atrás.
    expect(foraDosCartoes,
      'a fixture ficou fraca: sem venda de guichê fora do caixa aberto, a ' +
      'frase errada daria no mesmo e este caso passaria verde à toa')
      .toBeGreaterThan(pdv.resumo.semPontoCents)
    expect(foraDosCartoes, 'o buraco da tela não é o somado à mão').toBe(FORA_DOS_CARTOES)

    const r = await comSessao(`/admin/evento/${EVENTO_GUICHE}/pdv`)
    expect(r.status, 'a tela de pontos de venda não abriu').toBe(200)
    const html = soOQueARenderizou(await r.text())

    // Aritmética inteira, igual ao `reais` de `composables/formato.ts` — o
    // `Intl` separa o `R$` com espaço FINO e a comparação falharia com as duas
    // strings idênticas na tela.
    const emReais = (c: number) =>
      `R$ ${Math.floor(c / 100).toLocaleString('pt-BR')},${String(c % 100).padStart(2, '0')}`

    // 1. O BURACO INTEIRO, com o valor que a tela consegue provar somando o
    //    que ela mesma está mostrando.
    expect(html,
      `a tela não mostra a diferença real de ${emReais(foraDosCartoes)} entre o ` +
      'cabeçalho e a soma dos cartões')
      .toContain(emReais(foraDosCartoes))

    // 2. AS DUAS PARTES, cada uma com o seu nome. Sem a segunda, a tela volta
    //    a dizer que a venda órfã é o buraco todo.
    expect(html, 'a venda de balcão sem guichê perdeu o nome próprio')
      .toContain('Sem ponto identificado')
    expect(html,
      `a venda de guichê fora do caixa aberto (${emReais(NO_GUICHE_ANTES)}) não ` +
      'aparece: a tela voltou a atribuir o buraco inteiro à venda órfã')
      .toContain(emReais(NO_GUICHE_ANTES))

    // 3. E A FRASE NÃO PODE VOLTAR. Ela é o defeito em si: o número está certo
    //    e o que está escrito ao lado dele é falso.
    expect(html,
      'a frase "é exatamente a diferença entre os dois" voltou pra baixo da ' +
      'venda órfã, e ela é falsa sempre que um guichê vendeu fora do caixa aberto')
      .not.toContain('é exatamente a diferença entre os dois')
  }, 30_000)

  /**
   * A VENDA CANCELADA NO GUICHÊ — a devolução que seis telas contam e o
   * extrato não.
   *
   * O caso das SETE telas lá em cima prova a igualdade da devolução com a
   * fixture que ele tem: estorno parcial e estorno total. Falta o terceiro
   * jeito de devolver dinheiro neste sistema, e é o mais comum no balcão —
   * `SQL_CANCELA_VENDA_PDV` grava `status = 'cancelado'` com
   * `refunded_cents = total_cents` quando o operador desfaz a venda e tira as
   * notas da gaveta.
   *
   * Medido nesta fixture: borderô, painel, financeiro do evento, financeiro da
   * organização e a lista de vendas dizem R$ 450,00 de devolvido; o extrato
   * diz R$ 50,00. R$ 400,00 de diferença — o dinheiro que saiu da gaveta.
   *
   * A causa é uma linha só, e NÃO É DESTA TRILHA:
   * `server/api/admin/evento/[id]/extrato.get.ts:57` lista
   * `('pago','estornado','estornado_parcial','chargeback','disputa')` e deixa
   * `cancelado` de fora, contrariando a própria regra escrita duas linhas
   * acima ("todo estado em que o dinheiro CHEGOU a entrar") — no balcão ele
   * chegou a entrar e depois saiu.
   *
   * Este caso PRENDE o defeito em vez de escondê-lo:
   *
   * - exige que as SEIS telas que respondem certo continuem concordando —
   *   qualquer uma que regrida fica vermelha aqui;
   * - exige que a falta do extrato seja EXATAMENTE a devolução dos pedidos nos
   *   status que ele não lista, lida do banco. No dia em que o extrato passar
   *   a listar `cancelado`, esta diferença vira zero e o caso fica vermelho
   *   avisando que a exceção acabou — aí ela sai daqui e o extrato entra na
   *   igualdade das sete.
   */
  it('a venda cancelada no guichê é devolução nas seis — e o extrato ainda não conta', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const t = await asSeteTelas(EVENTO_GUICHE)

    const asSeis = {
      bordero: t.bordero.totais.estornadoCents,
      painel: t.dashboard.totais.estornadoCents,
      financeiroDoEvento: t.financeiroDoEvento.resumo.estornadoCents,
      financeiroDaOrg: t.org.estornadoCents,
      vendas: t.vendas.totais.estornadoCents,
      relatorios: t.relatorios.resumo.estornadoCents,
    }
    expect(new Set(Object.values(asSeis)).size,
      `as seis telas discordaram da devolução: ${JSON.stringify(asSeis)}`).toBe(1)
    expect(asSeis.relatorios,
      'a devolução das seis não é a somada à mão — o cancelamento de balcão ' +
      'devolveu dinheiro tanto quanto o estorno')
      .toBe(SEM_GUICHE_DEVOLVIDO + CANCELADA_NO_GUICHE)

    // A fixture só prova alguma coisa se a venda cancelada valer alguma coisa.
    expect(CANCELADA_NO_GUICHE,
      'a fixture perdeu a venda cancelada e este caso virou uma cópia do de cima')
      .toBeGreaterThan(0)

    // A FALTA DO EXTRATO, com número: é a devolução dos pedidos em status que
    // ele não lista. Sai do banco, não de um literal.
    const [foraDoExtrato] = await sql(
      `SELECT COALESCE(SUM(refunded_cents),0)::bigint AS devolvido
         FROM orders
        WHERE event_id = $1
          AND status NOT IN ('pago','estornado','estornado_parcial','chargeback','disputa')`,
      [EVENTO_GUICHE])

    expect(asSeis.relatorios - t.extrato.totais.estornadoCents,
      'a diferença entre o extrato e as outras seis deixou de ser a devolução ' +
      'dos status que o extrato não lista — ou o extrato foi consertado (e aí ' +
      'este caso sai daqui e o extrato entra na igualdade das sete), ou nasceu ' +
      'uma terceira régua de devolução')
      .toBe(Number(foraDoExtrato.devolvido))
  }, 30_000)
})

describe('o funil do painel não deixa pedido nenhum fora da conta', () => {
  /**
   * A rosca "Finalizados × abandonados" dividia por
   * `finalizados + abandonados + abertos` — três baldes que cobriam seis dos
   * ONZE status que o `CHECK` da tabela permite. O pedido estornado POR
   * INTEIRO não cabia em nenhum: sumia do desenho E do denominador, e as
   * porcentagens saíam de uma população menor que a do evento.
   *
   * Medido nesta fixture antes do conserto: a rosca somava 6 e `/relatorios`
   * dizia 7 criados, com a suíte inteira verde. O próprio comentário da
   * consulta já dizia que isso não podia acontecer — só que tinha sido
   * consertado apenas pro estorno PARCIAL.
   */
  it('as partes do funil somam os pedidos criados, e batem com relatórios', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const [dash, rel] = await Promise.all([
      json(`/api/admin/evento/${EVENTO}/dashboard`),
      json(`/api/admin/evento/${EVENTO}/relatorios`),
    ])
    const f = dash.funil

    // O total sai do BANCO, não de um literal que envelhece na primeira venda
    // nova da fixture.
    const [linha] = await sql(
      `SELECT count(*)::int AS n FROM orders WHERE event_id = $1`, [EVENTO])
    expect(f.criados, 'o painel conta um número de pedidos criados que o banco não confirma')
      .toBe(Number(linha.n))
    expect(rel.funil.criados, 'o painel e relatórios discordam de quantos pedidos nasceram')
      .toBe(f.criados)

    // A INVARIANTE: todo pedido cai em exatamente um balde. `outros` existe
    // justamente pra o dia em que alguém acrescentar um status ao `CHECK` sem
    // lembrar desta tela.
    const baldes = ['finalizados', 'devolvidos', 'abandonados', 'abertos', 'contestados', 'outros']
    const soma = baldes.reduce((s, k) => s + f[k], 0)
    expect(soma,
      `um pedido sumiu entre os baldes do funil: ${JSON.stringify(f)}`)
      .toBe(f.criados)
    for (const k of baldes) {
      expect(f[k], `o balde ${k} sumiu do funil`).toBeTypeOf('number')
      expect(f[k], `o balde ${k} ficou negativo — a soma das partes passou do todo`)
        .toBeGreaterThanOrEqual(0)
    }

    // O pedido devolvido por inteiro tem balde PRÓPRIO, e não é "abandonado":
    // ele virou dinheiro, entregou ingresso e depois voltou atrás.
    expect(f.devolvidos, 'o estorno total voltou a não ter lugar no funil').toBe(1)

    // A fixture só prova alguma coisa enquanto os três baldes antigos NÃO
    // cobrirem tudo — senão o defeito não teria sintoma aqui.
    expect(f.finalizados + f.abandonados + f.abertos,
      'a fixture ficou fraca: sem pedido fora dos três baldes antigos, o ' +
      'denominador errado da rosca dava no mesmo')
      .not.toBe(f.criados)
  }, 20_000)
})

describe('o botão "Hoje" não traz a noite de ontem', () => {
  /**
   * `new Date('2026-03-10')` é MEIA-NOITE UTC — 21h do dia 9 na Bahia. O front
   * mandava a data certa (medido na aba de rede) e a rota abria a janela três
   * horas cedo demais: a venda das 23h30 de ontem entrava no "Hoje".
   *
   * Medido no evento semeado às 02h47 de 21/09 antes do conserto: o painel
   * dizia R$ 11.228,00 de hoje contra R$ 6.732,00 de verdade — 64 pedidos da
   * noite anterior — e a própria curva mostrava DOIS dias dentro de um filtro
   * de um dia só.
   */
  it('o pedido das 23h30 da véspera fica de fora', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const r = await json(
      `/api/admin/evento/${EVENTO_JANELA}/dashboard?de=${DIA_DA_JANELA}&ate=${DIA_DA_JANELA}`)

    expect(r.totais.cobradoCents,
      `a janela do dia ${DIA_DA_JANELA} engoliu a venda das 23h30 do dia anterior`)
      .toBe(NA_JANELA)
    expect(r.totais.cobradoCents,
      'a janela começou à meia-noite UTC de novo: três horas de ontem entraram em hoje')
      .not.toBe(NA_JANELA + NA_VESPERA)
    expect(r.totais.pedidos, 'a janela de um dia pegou mais de um pedido').toBe(1)

    // O sintoma que aparecia na TELA: a curva de um filtro de um dia só
    // mostrava duas colunas.
    expect(r.ritmo.length, 'a curva de "um dia" voltou a desenhar dois dias').toBe(1)

    // E a janela que a rota diz ter usado começa à meia-noite LOCAL.
    expect(new Date(r.periodo.de).getTime(),
      'o começo do período não é a meia-noite de quem opera')
      .toBe(new Date(`${DIA_DA_JANELA}T00:00:00.000`).getTime())

    // A véspera existe mesmo — sem isso o caso ficaria verde com o evento vazio.
    const semJanela = await json(`/api/admin/evento/${EVENTO_JANELA}/dashboard`)
    expect(semJanela.totais.cobradoCents,
      'a fixture da janela perdeu um dos dois pedidos e o caso não prova nada')
      .toBe(NA_JANELA + NA_VESPERA)
  }, 30_000)

  it('data impossível na URL não derruba a tela', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    // Link colado errado, filtro salvo de outra tela: a régua cai no padrão
    // em vez de mandar `Invalid Date` pro banco e devolver 500 pra quem só
    // digitou errado.
    const r = await json(`/api/admin/evento/${EVENTO_JANELA}/dashboard?de=ontem&ate=ontem`)
    expect(r.totais.cobradoCents, 'a data inválida comeu as vendas do evento')
      .toBe(NA_JANELA + NA_VESPERA)
  }, 20_000)
})

describe('público é quem entrou, não ingresso emitido', () => {
  it('uma mesa de 4 é um ingresso e quatro pessoas', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const [relatorios, dashboard, publico] = await Promise.all([
      json(`/api/admin/evento/${EVENTO}/relatorios`),
      json(`/api/admin/evento/${EVENTO}/dashboard`),
      json(`/api/admin/evento/${EVENTO}/publico`),
    ])

    // Um ingresso emitido, uma leitura na catraca, QUATRO pessoas dentro.
    // Contar ingresso (ou contar leitura) lotava o parque com o painel
    // marcando um quarto do que tinha lá dentro.
    for (const [tela, bloco] of [
      ['relatorios', relatorios.publico],
      ['dashboard', dashboard.publico],
      ['publico', publico.presenca],
    ] as const) {
      expect({ pessoas: bloco.pessoas, passagens: bloco.passagens },
        `${tela} contou leitura/ingresso em vez de pessoa`)
        .toEqual({ pessoas: 4, passagens: 1 })
    }
  }, 20_000)
})

describe('o evento de verdade — as sete telas continuam batendo', () => {
  /**
   * A fixture é desenhada pra ter os casos que o seed não produz. Este caso é
   * o contrário: o evento REAL, com 358 pedidos e a mistura de taxa repassada
   * e absorvida no mesmo canal, lido pelas sete portas.
   *
   * Ele não repete a grade campo a campo do caso da fixture — repete o que
   * pode ser afirmado sem depender de qual pedido existe hoje: as réguas
   * batem entre si e batem com o banco.
   */
  it('borderô, financeiro do evento, financeiro da org, relatórios e painel não divergem', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect(cookieDaCasa, 'login do master da casa falhou').toBeTruthy()

    const n = await asTelasDoDinheiro(SEMEADO, cookieDaCasa)
    expect(new Set(Object.values(n)).size,
      `as cinco rotas discordaram no evento semeado: ${JSON.stringify(n)}`).toBe(1)

    // O número esperado vem do BANCO, com a régua escrita à mão — e não de um
    // literal que envelhece na primeira venda nova. Se alguém trocar a conta
    // de uma das rotas, este caso cai junto com o de cima.
    const [linha] = await sql(
      `SELECT COALESCE(SUM(total_cents - platform_cents - refunded_cents)
                FILTER (WHERE status IN ('pago','estornado_parcial')), 0)::bigint AS liquido
         FROM orders WHERE event_id = $1`, [SEMEADO])
    expect(n.relatorios, 'as quatro telas concordaram num número que o banco não confirma')
      .toBe(Number(linha.liquido))
  }, 30_000)
})
