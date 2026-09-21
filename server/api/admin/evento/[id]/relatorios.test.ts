/**
 * AS CINCO TELAS DO DINHEIRO PRECISAM DIZER O MESMO NÚMERO.
 *
 * O produtor abre o borderô e vê um total; abre o financeiro do evento e vê
 * outro; abre o financeiro da organização e vê um terceiro; abre relatórios e
 * vê um quarto; abre o painel do evento e vê um quinto. Nenhuma das cinco está
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
/** o que os compradores pagaram nos três pedidos vivos */
const COBRADO = 110_000 + 50_000 + 93_500

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

/** o que os ITENS dos três pedidos vivos somam: 4 + 1 + 2 */
const INGRESSOS_EMITIDOS = 7

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
}): Promise<string> {
  const desconto = campos.desconto ?? 0
  const [linha] = await sql(
    `INSERT INTO orders (org_id, event_id, customer_id, promo_code_id, code, status, channel,
                         face_cents, fee_cents, platform_cents, discount_cents,
                         total_cents, refunded_cents, asaas_payment_id, paid_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [ORG, EVENTO, campos.comprador ?? null, campos.cupom ?? null,
     campos.codigo, campos.status ?? 'pago', campos.canal ?? 'online',
     campos.face, campos.feeComprador, campos.plataforma, desconto,
     // o banco exige total = face + fee − desconto
     campos.face + campos.feeComprador - desconto,
     campos.estornado ?? 0,
     campos.asaas === undefined ? `pay_${campos.codigo}` : campos.asaas,
     campos.pago === false ? null : new Date()])
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

  await sql(`DELETE FROM entries WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM tickets WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM promo_codes WHERE event_id = $1`, [EVENTO])

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

  // 2) balcão, taxa ABSORVIDA e em dinheiro: o comprador pagou R$ 500
  //    redondos e os R$ 50 de taxa saem do produtor. `face − estornado`
  //    devolveria R$ 500 aqui.
  const pedidoDoBalcao = await pedido({
    codigo: 'ZZ-CT-ABSORVE', canal: 'bilheteria', asaas: null,
    face: 50_000, feeComprador: 0, plataforma: 5_000 })

  // 3) O CASO QUE PARTE AS TELAS: face de R$ 950 com R$ 100 de cupom e taxa
  //    por fora — R$ 935 cobrados — e R$ 20 devolvidos depois. O webhook grava
  //    `estornado_parcial`; o pedido continua valendo R$ 830 pro produtor. Um
  //    recorte por `'pago'` apaga os R$ 830 E apaga o cupom da tela de cupons.
  const pedidoComCupom = await pedido({
    codigo: 'ZZ-CT-PARCIAL', status: 'estornado_parcial',
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
  ] as [string, number, number, number, number][]) {
    await sql(
      `INSERT INTO order_items (order_id, lot_id, quantity,
                                unit_face_cents, unit_fee_cents, unit_total_cents)
       VALUES ($1,$2,$3,$4,$5,$6)`, [pedidoId, LOTE, qtd, face, taxa, total])
  }

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
  await sql(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM promo_codes WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM customers WHERE id = $1`, [COMPRADOR])
  await sql(`DELETE FROM lots WHERE id = $1`, [LOTE])
  await sql(`DELETE FROM sectors WHERE id = $1`, [SETOR])
  await sql(`DELETE FROM users WHERE id = ANY($1)`, [[USUARIO, USUARIO_CASA]])
  await sql(`DELETE FROM events WHERE id = $1`, [EVENTO])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('as cinco telas do dinheiro contam igual', () => {
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

    // Armadilha de nome, não de número: o campo `ticketMedioCents` existe nas
    // DUAS rotas e quer dizer coisas diferentes — por PEDIDO em relatórios
    // ("Ticket médio · por pedido" na tela) e por INGRESSO no painel ("Ticket
    // médio por ingresso · Vendas por ingressos pagos"). Os dois rótulos estão
    // certos hoje; medido no evento semeado, R$ 88,00 num e R$ 43,47 no outro.
    //
    // Este caso prende cada um na sua conta. Trocar a régua de um lado sem
    // trocar o rótulo do .vue junto faz a tela mentir em silêncio — que é
    // exatamente o defeito desta trilha, só que na legenda em vez do total.
    expect(rel.resumo.ticketMedioCents,
      'relatórios deixou de dividir por PEDIDO, e o rótulo da tela diz "por pedido"')
      .toBe(Math.round(COBRADO / 3))
    expect(dash.totais.ticketMedioCents,
      'o painel deixou de dividir por INGRESSO, e o rótulo da tela diz "por ingresso"')
      .toBe(Math.round(COBRADO / INGRESSOS_EMITIDOS))

    // E o número por ingresso de relatórios é o MESMO do painel: quando duas
    // telas respondem a mesma pergunta, elas respondem igual.
    expect(rel.resumo.porIngressoCents,
      'o "por ingresso" de relatórios discorda do "ticket médio por ingresso" do painel')
      .toBe(dash.totais.ticketMedioCents)

    expect(rel.resumo.ticketMedioCents,
      'a fixture ficou fraca: com 1 ingresso por pedido as duas contas ' +
      'coincidem e este caso não prova nada')
      .not.toBe(dash.totais.ticketMedioCents)
  }, 20_000)

  it('relatórios mostra a devolução em vez de esconder o pedido', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const r = await json(`/api/admin/evento/${EVENTO}/relatorios`)
    expect({
      pedidos: r.resumo.pedidos,
      fechados: r.resumo.pedidosFechados,
      comEstorno: r.resumo.pedidosComEstorno,
      estornado: r.resumo.estornadoCents,
      cobrado: r.resumo.cobradoCents,
    }, 'o pedido com estorno parcial sumiu da contagem ou o estorno não aparece')
      .toEqual({ pedidos: 3, fechados: 2, comEstorno: 1, estornado: 2_000, cobrado: COBRADO })

    // Ticket médio divide pela MESMA população que somou. Somar três pedidos
    // e dividir por dois é o jeito silencioso de a média inflar 50%.
    expect(r.resumo.ticketMedioCents,
      'o ticket médio dividiu por uma população diferente da que somou')
      .toBe(Math.round(COBRADO / 3))
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

    const org = orgs.find((o: any) => o.id === ORG)
    expect(org, 'a organização sumiu da listagem').toBeTruthy()
    expect(org.liquidoCents, 'a tela de organizações discorda do financeiro').toBe(LIQUIDO)
    expect(org.faturadoCents, 'o faturado da organização perdeu o estorno parcial').toBe(COBRADO)
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

describe('o evento de verdade — as cinco telas continuam batendo', () => {
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
