/**
 * Teste da CORTESIA — o lugar por onde o evento sangra sem aparecer.
 *
 * Cortesia ocupa lugar e não fatura. Antes da 017 ela não tinha teto nenhum
 * (o estoque do lote é o teto da CASA, não o da gratuidade), o motivo era
 * opcional e "a pedido de quem" não existia como campo. Um evento de 5.000
 * lugares podia sair inteiro de graça sem estourar nenhuma conferência.
 *
 * Cinco coisas aqui podem custar caro, e cada uma tem caso:
 *
 *  1. **Emissão sem motivo e sem quem pediu.** Seis meses depois ninguém
 *     consegue explicar as 400 entradas gratuitas.
 *  2. **Cota furada.** Cada cortesia acima do teto é uma pessoa a mais no
 *     portão que não pagou — e um lugar a menos pra vender.
 *  3. **Duas emissões ao mesmo tempo.** Não dá pra provar isso com dois
 *     `fetch`: eles não chegam juntos no servidor de dev, o primeiro já
 *     gravou quando o segundo lê, e o caso fica VERDE com a trava arrancada.
 *     Aqui a ordem é forçada à mão: uma conexão do pool segura a linha do
 *     evento e a rota real, pela HTTP, precisa ficar pendurada nela.
 *  4. **A cota que nasce abaixo do que já foi dado.** O produtor não pode
 *     dizer "só 10" depois de ter dado 12 — as 12 não somem da portaria.
 *  5. **O borderô.** Cortesia conta em coluna própria e NÃO entra na receita.
 *     O caso mede o borderô antes e depois de emitir e exige que o
 *     faturamento não se mexa.
 *
 * Fixture própria, apagada no fim. O evento semeado não é tocado.
 * Sem servidor de dev no ar, PULA em vez de falhar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

const ORG = '0000e017-0000-4000-8000-000000000001'
const USUARIO = '0000e017-0000-4000-8000-000000000002'
const EVENTO = '0000e017-0000-4000-8000-000000000003'
const SETOR = '0000e017-0000-4000-8000-000000000004'
const LOTE = '0000e017-0000-4000-8000-000000000005'
const LOTE_B = '0000e017-0000-4000-8000-000000000006'
const PEDIDO_PAGO = '0000e017-0000-4000-8000-000000000007'
const ITEM_PAGO = '0000e017-0000-4000-8000-000000000008'
/** lote de R$ 0: a venda gratuita, que NÃO é cortesia */
const LOTE_GRATIS = '0000e017-0000-4000-8000-000000000009'
const USUARIO_OPERACAO = '0000e017-0000-4000-8000-00000000000a'
const EMAIL = 'dono.cortesia@teste.invalido'
const EMAIL_OPERACAO = 'operacao.cortesia@teste.invalido'
const SLUG = 'zz-evento-cortesia'
/** CPF válido de teste — o checkout confere o dígito */
const CPF = '52998224725'

let noAr = false
let cookie = ''
let cookieOperacao = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../utils/db')
  return q<any>(texto, par)
}

const comSessao = (rota: string, init: RequestInit = {}) =>
  fetch(`${BASE}${rota}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, origin: BASE, ...(init.headers ?? {}) },
  })

type Resposta = { status: number; corpo: any; mensagem: string }

/** o mesmo POST, dito por QUEM — a cota e a emissão não são do mesmo papel */
async function chamarComo(quem: string, corpo: any): Promise<Resposta> {
  const r = await comSessao(`/api/admin/evento/${EVENTO}/cortesias`, {
    method: 'POST', body: JSON.stringify(corpo), headers: { cookie: quem },
  })
  const c: any = await r.json().catch(() => ({}))
  return { status: r.status, corpo: c, mensagem: c.statusMessage ?? c.message ?? '' }
}

const chamar = (corpo: any) => chamarComo(cookie, corpo)

/** uma compra de verdade na vitrine pública, sem sessão nenhuma */
async function comprar(loteId: string, quantidade = 1) {
  const r = await fetch(`${BASE}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventSlug: SLUG,
      itens: [{ lotId: loteId, quantidade }],
      comprador: {
        nome: 'ZZ Comprador Gratis', email: 'zz.gratis@teste.invalido', documento: CPF,
      },
    }),
  })
  const c: any = await r.json().catch(() => ({}))
  return { status: r.status, corpo: c, mensagem: c.statusMessage ?? c.message ?? '' }
}

/** emite `quantos` cortesias, com motivo e quem pediu preenchidos */
function emitir(quantos: number, extra: Record<string, any> = {}) {
  const pessoas = Array.from({ length: quantos }, (_, i) => ({
    nome: `ZZ Convidado ${i + 1}`, email: null, documento: null,
  }))
  return chamar({
    loteId: LOTE, motivo: 'Imprensa local', responsavel: 'Diretor de Marketing',
    pessoas, ...extra,
  })
}

const definirCota = (cotaEvento: number | null, lotes: any[] = []) =>
  chamar({ acao: 'cota', cotaEvento, lotes })

async function painel() {
  const r = await comSessao(`/api/admin/evento/${EVENTO}/cortesias`)
  return await r.json() as any
}

async function bordero() {
  const r = await comSessao(`/api/admin/evento/${EVENTO}/bordero`)
  return await r.json() as any
}

/** quantas cortesias ocupam lugar agora — a mesma conta que a rota faz */
async function cortesiasVivas(loteId?: string): Promise<number> {
  const r = await sql(
    `SELECT count(*)::int AS n FROM tickets
      WHERE event_id = $1 AND is_courtesy AND status <> 'cancelado'
        AND ($2::uuid IS NULL OR lot_id = $2)`, [EVENTO, loteId ?? null])
  return r[0].n
}

/**
 * Zera as cortesias da fixture e recompõe `lots.sold` a partir dos ingressos
 * que sobraram. O pedido pago da fixture (o que o borderô mede) fica de pé.
 */
async function limparCortesias() {
  await sql(`DELETE FROM tickets WHERE event_id = $1 AND is_courtesy`, [EVENTO])
  await sql(`DELETE FROM orders WHERE event_id = $1 AND channel = 'cortesia'`, [EVENTO])
  // a venda gratuita da vitrine também some: ela marca `is_courtesy` (os
  // ingressos já saíram na linha de cima) e o pedido dela ficaria órfão
  await sql(
    `DELETE FROM orders WHERE event_id = $1 AND total_cents = 0 AND channel <> 'cortesia'`,
    [EVENTO])
  await sql(
    `UPDATE lots l SET sold = (SELECT count(*) FROM tickets t
                                WHERE t.lot_id = l.id AND t.status <> 'cancelado')
       FROM sectors s WHERE s.id = l.sector_id AND s.event_id = $1`, [EVENTO])
  await sql(`UPDATE events SET courtesy_quota = NULL WHERE id = $1`, [EVENTO])
  await sql(
    `UPDATE lots l SET courtesy_quota = NULL
       FROM sectors s WHERE s.id = l.sector_id AND s.event_id = $1`, [EVENTO])
}

/** INSERT de cortesia direto no banco — o caminho que NÃO passa pela rota */
function inserirCortesiaCrua(cliente?: any, loteId = LOTE) {
  const executor = cliente
    ? (t: string, p: any[]) => cliente.query(t, p)
    : (t: string, p: any[]) => sql(t, p)
  return executor(
    `INSERT INTO tickets (org_id, event_id, sector_id, lot_id, code, qr_secret,
                          status, is_courtesy, holder_name)
     VALUES ($1,$2,$3,$4,'ZZC-' || encode(gen_random_bytes(5),'hex'),
             encode(gen_random_bytes(16),'hex'), 'valido', true, 'ZZ Crua')`,
    [ORG, EVENTO, SETOR, loteId])
}

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).status < 500
  } catch { noAr = false }
  if (!noAr) return

  await sql(`INSERT INTO organizations (id, name, slug)
             VALUES ($1,'ZZ CORTESIA TESTE','zz-cortesia-teste')
             ON CONFLICT (id) DO NOTHING`, [ORG])

  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,'ZZ EVENTO CORTESIA','zz-evento-cortesia',
             now() + interval '10 days', now() + interval '11 days', 1000, 'ativo')
     ON CONFLICT (id) DO UPDATE SET status = 'ativo', courtesy_quota = NULL`, [EVENTO, ORG])

  await sql(
    `INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZ SETOR')
     ON CONFLICT (id) DO NOTHING`, [SETOR, EVENTO])

  for (const [id, nome] of [[LOTE, 'ZZ LOTE A'], [LOTE_B, 'ZZ LOTE B']] as const) {
    await sql(
      `INSERT INTO lots (id, sector_id, name, price_cents, quantity, channels)
       VALUES ($1,$2,$3,10000,50,'{online}')
       ON CONFLICT (id) DO UPDATE SET quantity = 50, courtesy_quota = NULL`, [id, SETOR, nome])
  }
  // Lote de R$ 0: a VENDA gratuita. `utils/emissao.ts` marca `is_courtesy`
  // nela (todo pedido que fecha em zero), e é essa marca que já confundiu a
  // cota de cortesia com a entrada de graça do patrocinador.
  await sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity, channels)
     VALUES ($1,$2,'ZZ LOTE GRATIS',0,50,'{online}')
     ON CONFLICT (id) DO UPDATE SET quantity = 50, price_cents = 0, courtesy_quota = NULL`,
    [LOTE_GRATIS, SETOR])

  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'Dona Cortesia Teste', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [USUARIO, ORG, EMAIL])

  // Quem emite cortesia no dia a dia: papel `operacao`, a mesma área `evento`
  // da rota. É ele que não pode levantar o próprio teto.
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role, papel)
     SELECT $1, $2, 'ZZ Operação Cortesia', $3, password_hash, 'operacional', 'operacao'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO UPDATE SET papel = 'operacao', role = 'operacional'`,
    [USUARIO_OPERACAO, ORG, EMAIL_OPERACAO])

  const entrar = async (email: string) => {
    const r = await fetch(`${BASE}/api/auth/entrar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, senha: 'diamond123' }),
    })
    return (r.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
  }
  cookie = await entrar(EMAIL)
  cookieOperacao = await entrar(EMAIL_OPERACAO)

  // Uma venda de verdade, pra o borderô ter receita pra comparar: R$ 100 de
  // face com taxa de 10% repassada ao comprador.
  await sql(`DELETE FROM tickets WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
  await sql(
    `INSERT INTO orders (id, org_id, event_id, code, status, channel, payment_method,
                         face_cents, fee_cents, platform_cents, discount_cents,
                         total_cents, asaas_payment_id, paid_at)
     VALUES ($1,$2,$3,'ZZ-CRT-PAGO','pago','online','pix',
             10000,1000,1000,0,11000,'pay_zz_cortesia',now())`,
    [PEDIDO_PAGO, ORG, EVENTO])
  await sql(
    `INSERT INTO order_items (id, order_id, lot_id, quantity,
                              unit_face_cents, unit_fee_cents, unit_total_cents)
     VALUES ($1,$2,$3,1,10000,1000,11000)`, [ITEM_PAGO, PEDIDO_PAGO, LOTE])
  await sql(
    `INSERT INTO tickets (org_id, event_id, order_id, order_item_id, sector_id, lot_id,
                          code, qr_secret, status, holder_name)
     VALUES ($1,$2,$3,$4,$5,$6,'ZZ-PAGO-1',encode(gen_random_bytes(16),'hex'),
             'valido','ZZ Comprador')`,
    [ORG, EVENTO, PEDIDO_PAGO, ITEM_PAGO, SETOR, LOTE])
  await sql(`UPDATE lots SET sold = 1 WHERE id = $1`, [LOTE])
}, 30_000)

afterAll(async () => {
  if (!noAr) return
  // organizations → events → tickets/orders cascateia tudo da fixture
  await sql(`DELETE FROM tickets WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('cortesia — motivo e quem pediu', () => {
  it('não emite sem motivo', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()
    await limparCortesias()

    const r = await chamar({
      loteId: LOTE, responsavel: 'Diretor', pessoas: [{ nome: 'ZZ Sem Motivo' }],
    })
    expect(r.status, `emitiu cortesia sem dizer por quê — ${r.mensagem}`).toBe(400)
    // a recusa é pra quem está no guichê, não pro console do programador
    expect(r.mensagem.toLowerCase(), 'recusou em linguagem de zod').toContain('motivo')
    expect(await cortesiasVivas(), 'recusou na resposta e emitiu assim mesmo').toBe(0)
  }, 20_000)

  it('não emite sem dizer quem pediu', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()

    const r = await chamar({
      loteId: LOTE, motivo: 'Imprensa', pessoas: [{ nome: 'ZZ Sem Responsavel' }],
    })
    expect(r.status, `emitiu cortesia sem dizer a pedido de quem — ${r.mensagem}`).toBe(400)
    expect(r.mensagem.toLowerCase()).toContain('quem pediu')
    expect(await cortesiasVivas()).toBe(0)
  }, 20_000)

  it('motivo em branco não conta como motivo', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()

    // Campo obrigatório que aceita espaço é campo opcional com nome pior.
    const r = await chamar({
      loteId: LOTE, motivo: '   ', responsavel: 'Diretor',
      pessoas: [{ nome: 'ZZ Motivo Branco' }],
    })
    expect(r.status, `aceitou três espaços como motivo — ${r.mensagem}`).toBe(400)
    expect(await cortesiasVivas()).toBe(0)
  }, 20_000)

  it('a emissão deixa o rastro inteiro: por quê, a pedido de quem, autorizada por quem, pra quem', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()

    const r = await chamar({
      loteId: LOTE, motivo: 'Patrocinador master', responsavel: 'Sócio Fundador',
      pessoas: [{ nome: 'ZZ Convidada Um', email: 'zz.um@teste.invalido', documento: '' }],
    })
    expect(r.status, `não emitiu — ${r.mensagem}`).toBe(200)

    const p = await painel()
    const linha = p.ingressos.find((i: any) => i.nome === 'ZZ Convidada Um')
    expect(linha, 'a cortesia emitida não aparece na tela de cortesias').toBeTruthy()
    expect(linha.motivo, 'o motivo digitado não chegou no rastro').toBe('Patrocinador master')
    expect(linha.pedidaPor, 'quem PEDIU a cortesia não foi registrado').toBe('Sócio Fundador')
    // quem autorizou vem da SESSÃO, nunca do corpo do pedido
    expect(linha.autorizadaPorEmail, 'quem autorizou não foi carimbado').toBe(EMAIL)
    expect(linha.autorizadaEm, 'a emissão não tem data').toBeTruthy()

    // e o rastro está no banco, não só na resposta da tela
    const g = await sql(
      `SELECT reason, requested_by, authorized_email, quantity, unit_face_cents
         FROM courtesy_grants WHERE event_id = $1`, [EVENTO])
    expect(g.length, 'a emissão não gravou linha de rastro').toBe(1)
    expect(g[0].requested_by).toBe('Sócio Fundador')
    expect(g[0].authorized_email).toBe(EMAIL)
    // a face fica CONGELADA: o que a cortesia custou é o preço da hora em que
    // ela foi dada, não o do lote de hoje
    expect(Number(g[0].unit_face_cents), 'a face da emissão não foi congelada').toBe(10000)
  }, 20_000)

  it('quem autorizou é quem está logado, e não o que vier no corpo', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()

    const r = await chamar({
      loteId: LOTE, motivo: 'Teste de autoria', responsavel: 'Diretor',
      // tentativa de se passar por outra pessoa pelo corpo da requisição
      authorized_email: 'outro@teste.invalido', autorizadaPor: 'Outro Qualquer',
      pessoas: [{ nome: 'ZZ Autoria' }],
    })
    expect(r.status).toBe(200)

    const g = await sql(`SELECT authorized_email FROM courtesy_grants WHERE event_id = $1`, [EVENTO])
    expect(g[0].authorized_email, 'dava pra assinar a cortesia como outra pessoa').toBe(EMAIL)
  }, 20_000)
})

describe('cortesia — a cota', () => {
  it('sem cota definida, o teto continua sendo só o estoque', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()

    const r = await emitir(3)
    expect(r.status, `travou sem cota nenhuma definida — ${r.mensagem}`).toBe(200)
    expect(await cortesiasVivas()).toBe(3)

    const p = await painel()
    expect(p.cota.eventoCota, 'inventou cota onde não existe').toBe(null)
    expect(p.cota.eventoRestam).toBe(null)
  }, 20_000)

  it('a cota do evento recusa a emissão que passa do teto', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()
    expect((await definirCota(3)).status).toBe(200)

    expect((await emitir(2)).status).toBe(200)

    // 2 + 2 = 4 num teto de 3. A emissão é inteira ou nada: emitir 1 das 2
    // deixaria o operador achando que deu certo.
    const r = await emitir(2)
    expect(r.status, `furou a cota do evento: emitiu 4 num teto de 3 — ${r.mensagem}`).toBe(409)
    expect(r.mensagem.toLowerCase(), 'recusou sem dizer que foi a cota').toContain('cota')
    expect(await cortesiasVivas(), 'recusou na resposta e emitiu assim mesmo').toBe(2)

    // o que ainda cabe, cabe
    expect((await emitir(1)).status, 'recusou a cortesia que ainda cabia na cota').toBe(200)
    expect(await cortesiasVivas()).toBe(3)

    // e agora nem mais uma
    const cheio = await emitir(1)
    expect(cheio.status, `emitiu a 4ª cortesia num teto de 3 — ${cheio.mensagem}`).toBe(409)
    expect(await cortesiasVivas()).toBe(3)
  }, 30_000)

  it('a cota do lote segura mesmo com a do evento sobrando', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()
    expect((await definirCota(10, [{ id: LOTE, cota: 1 }])).status).toBe(200)

    expect((await emitir(1)).status).toBe(200)

    const r = await emitir(1)
    expect(r.status, `furou a cota do lote — ${r.mensagem}`).toBe(409)
    expect(r.mensagem, 'recusou sem dizer QUAL prateleira travou').toContain('ZZ LOTE A')
    expect(await cortesiasVivas(LOTE)).toBe(1)

    // o outro lote não tem cota própria e a do evento ainda sobra
    const outro = await emitir(1, { loteId: LOTE_B })
    expect(outro.status, `a cota de um lote travou o outro — ${outro.mensagem}`).toBe(200)
    expect(await cortesiasVivas()).toBe(2)
  }, 30_000)

  it('cancelar a cortesia devolve a cota junto com o lugar', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()
    expect((await definirCota(1)).status).toBe(200)
    expect((await emitir(1)).status).toBe(200)

    expect((await emitir(1)).status, 'a cota já estava cheia e ele emitiu').toBe(409)

    const alvo = (await painel()).ingressos[0]
    const del = await comSessao(`/api/admin/evento/${EVENTO}/cortesias`, {
      method: 'DELETE', body: JSON.stringify({ id: alvo.id }),
    })
    expect(del.status, 'não cancelou a cortesia').toBe(200)

    const r = await emitir(1)
    expect(r.status, `cancelou a cortesia e a cota continuou gasta — ${r.mensagem}`).toBe(200)
    expect(await cortesiasVivas()).toBe(1)
  }, 30_000)

  it('a cota não pode nascer abaixo do que já foi dado', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()
    expect((await emitir(3)).status).toBe(200)

    // Dizer "só 2" depois de ter dado 3 não desconvida ninguém: as 3 pessoas
    // aparecem no portão do mesmo jeito.
    const r = await definirCota(2)
    expect(r.status, `aceitou um teto de 2 com 3 cortesias já emitidas — ${r.mensagem}`).toBe(409)
    expect(r.mensagem, 'recusou sem dizer quantas já existem').toContain('3')

    const p = await painel()
    expect(p.cota.eventoCota, 'recusou na resposta e gravou a cota assim mesmo').toBe(null)

    // o teto igual ao que já existe é legítimo: fecha a torneira daqui pra frente
    expect((await definirCota(3)).status, 'recusou o teto igual ao já emitido').toBe(200)
    expect((await emitir(1)).status).toBe(409)
  }, 30_000)

  it('a cota do lote também não nasce abaixo do que aquele lote já deu', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()
    expect((await emitir(2)).status).toBe(200)

    const r = await definirCota(null, [{ id: LOTE, cota: 1 }])
    expect(r.status, `aceitou teto de 1 num lote que já deu 2 — ${r.mensagem}`).toBe(409)
    expect(r.mensagem).toContain('ZZ LOTE A')

    const p = await painel()
    expect(p.lotes.find((l: any) => l.id === LOTE).cota,
      'recusou na resposta e gravou a cota do lote assim mesmo').toBe(null)
  }, 20_000)

  it('cota zero é um teto de verdade, e não "sem cota"', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()
    expect((await definirCota(0)).status).toBe(200)

    const p = await painel()
    expect(p.cota.eventoCota, 'zero virou "sem teto" no caminho').toBe(0)

    const r = await emitir(1)
    expect(r.status, `o evento diz que não dá cortesia e ele deu — ${r.mensagem}`).toBe(409)
    expect(await cortesiasVivas()).toBe(0)
  }, 20_000)

  it('a tela mostra o teto, o gasto e o que sobra', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()
    await definirCota(5, [{ id: LOTE, cota: 4 }])
    await emitir(2)

    const p = await painel()
    expect(p.cota.eventoCota).toBe(5)
    expect(p.cota.eventoUsadas).toBe(2)
    expect(p.cota.eventoRestam, 'o que sobra na tela não bate com teto menos gasto').toBe(3)

    const l = p.lotes.find((x: any) => x.id === LOTE)
    expect(l.cota).toBe(4)
    expect(l.cortesias).toBe(2)
    expect(l.cotaRestam).toBe(2)
  }, 30_000)
})

describe('venda gratuita NÃO é cortesia', () => {
  /**
   * `tickets.is_courtesy` mente sobre o que é cortesia.
   *
   * `utils/emissao.ts` carimba a coluna em TODO ingresso de pedido que fechou
   * em zero — lote de R$ 0, evento gratuito, cupom de 100%. Isso é venda, com
   * comprador, CPF e pedido no canal `online`.
   *
   * Contar a cota por essa marca custava caro dos dois lados, e os dois estão
   * medidos abaixo: o comprador levava HTTP 500 no checkout PÚBLICO, e a
   * venda gratuita comia em silêncio a vaga guardada pra imprensa.
   */
  it('o checkout público de um ingresso gratuito não morre na cota de cortesia', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()
    // "aqui não se dá cortesia" — o teto mais fechado que existe
    expect((await definirCota(0)).status).toBe(200)

    const compra = await comprar(LOTE_GRATIS)
    expect(compra.status,
      `a cota de cortesia derrubou uma VENDA: o comprador de um ingresso gratuito levou ${compra.status} — ${compra.mensagem}`)
      .toBe(200)
    expect(compra.corpo.status, 'a venda gratuita não fechou').toBe('pago')

    // o ingresso existe, e existe COM a marca — é ela que enganava a cota
    const t = await sql(
      `SELECT t.is_courtesy, o.channel FROM tickets t JOIN orders o ON o.id = t.order_id
        WHERE t.event_id = $1 AND o.total_cents = 0 AND o.channel <> 'cortesia'`, [EVENTO])
    expect(t.length, 'a venda gratuita não emitiu ingresso').toBe(1)
    expect(t[0].is_courtesy, 'o teste perdeu o sentido: a venda gratuita não marca is_courtesy').toBe(true)

    // e mesmo assim ela não conta como cortesia em lugar nenhum
    const p = await painel()
    expect(p.cota.eventoUsadas, 'a venda gratuita gastou a cota de cortesia').toBe(0)
    expect(p.ingressos.length, 'a venda gratuita apareceu na tela de cortesias como entrada de graça').toBe(0)
    expect(p.resumo.semRastro, 'a faixa de "rastro faltando" acusou uma venda de hoje').toBe(0)
  }, 30_000)

  it('venda gratuita não come a cota guardada pra imprensa', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()
    expect((await definirCota(1)).status).toBe(200)

    expect((await comprar(LOTE_GRATIS)).status).toBe(200)

    // a única cortesia da cota continua inteira depois da venda
    const r = await emitir(1)
    expect(r.status,
      `a venda gratuita comeu a cortesia guardada pra imprensa — ${r.mensagem}`).toBe(200)
    // e o teto continua valendo pro que É cortesia
    expect((await emitir(1)).status, 'passou da cota depois de a venda ter sido descontada').toBe(409)
  }, 30_000)

  it('a venda gratuita não cancela pela porta da cortesia', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()
    expect((await comprar(LOTE_GRATIS)).status).toBe(200)

    const alvo = await sql(
      `SELECT t.id FROM tickets t JOIN orders o ON o.id = t.order_id
        WHERE t.event_id = $1 AND o.channel <> 'cortesia'
          AND o.total_cents = 0`, [EVENTO])
    expect(alvo.length).toBe(1)

    const del = await comSessao(`/api/admin/evento/${EVENTO}/cortesias`, {
      method: 'DELETE', body: JSON.stringify({ id: alvo[0].id }),
    })
    const corpo: any = await del.json().catch(() => ({}))
    expect(del.status,
      'cancelou o ingresso de um comprador pela rota de cortesia, devolvendo estoque por fora do pedido')
      .toBe(422)
    expect(String(corpo.statusMessage ?? corpo.message ?? '').toLowerCase()).toContain('pedido')

    const depois = await sql(`SELECT status FROM tickets WHERE id = $1`, [alvo[0].id])
    expect(depois[0].status, 'recusou na resposta e cancelou assim mesmo').toBe('valido')
  }, 30_000)
})

describe('a cota não é levantada por quem passa por baixo dela', () => {
  /**
   * Emitir cortesia e mudar o teto entram pela MESMA rota, e por isso caíam na
   * mesma área `evento` de `utils/papeis.ts` — que `operacao` tem. Medido no
   * sistema no ar: duas chamadas e o teto virava 9999.
   *
   * Teto que o próprio interessado levanta não é teto. Emitir dentro da cota
   * continua sendo de quem atende; o teto é de quem responde pelo parque.
   */
  it('quem emite cortesia não muda o próprio teto', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect(cookieOperacao, 'login de operação falhou — o teste ficaria verde à toa').toBeTruthy()
    await limparCortesias()
    expect((await definirCota(1)).status).toBe(200)

    // ele EMITE, que é o trabalho dele
    const emitiu = await chamarComo(cookieOperacao, {
      loteId: LOTE, motivo: 'Imprensa local', responsavel: 'Diretor',
      pessoas: [{ nome: 'ZZ Operacao Um' }],
    })
    expect(emitiu.status, `tirou de operação o que é trabalho dela — ${emitiu.mensagem}`).toBe(200)

    // e agora tenta abrir a torneira
    const subiu = await chamarComo(cookieOperacao, { acao: 'cota', cotaEvento: 9999, lotes: [] })
    expect(subiu.status,
      'quem é segurado pela cota levantou a própria cota').toBe(403)
    expect(subiu.mensagem.toLowerCase(), 'recusou sem dizer que é questão de acesso').toContain('master')

    const q = await sql(`SELECT courtesy_quota FROM events WHERE id = $1`, [EVENTO])
    expect(q[0].courtesy_quota, 'recusou na resposta e gravou a cota assim mesmo').toBe(1)

    // o teto continua valendo: a 2ª cortesia não sai
    const segunda = await chamarComo(cookieOperacao, {
      loteId: LOTE, motivo: 'Imprensa local', responsavel: 'Diretor',
      pessoas: [{ nome: 'ZZ Operacao Dois' }],
    })
    expect(segunda.status, `emitiu por cima do teto que ele não conseguiu levantar — ${segunda.mensagem}`).toBe(409)

    // e o master continua podendo mudar
    expect((await definirCota(2)).status, 'trancou o master junto').toBe(200)
  }, 30_000)
})

describe('cortesia — a rede do banco', () => {
  /**
   * O gatilho da 017 não substitui a trava da rota (ele não enxerga transação
   * não confirmada, então não resolve corrida). Ele fecha o outro buraco: o
   * caminho que não passa pela rota — script de importação, rota nova, INSERT
   * na mão às 23h.
   */
  it('o banco recusa cortesia acima da cota mesmo sem passar pela rota', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()
    await sql(`UPDATE events SET courtesy_quota = 1 WHERE id = $1`, [EVENTO])

    await inserirCortesiaCrua()
    await expect(inserirCortesiaCrua(),
      'um INSERT direto furou a cota sem nenhuma reclamação do banco')
      .rejects.toThrow(/[Cc]ota de cortesia/)

    expect(await cortesiasVivas()).toBe(1)
  }, 20_000)

  it('sem cota definida o gatilho não atrapalha ninguém', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()
    await inserirCortesiaCrua()
    await inserirCortesiaCrua()
    expect(await cortesiasVivas()).toBe(2)
  }, 20_000)
})

describe('CONCORRÊNCIA — a cota é lida depois da trava', () => {
  /**
   * Por que não dá pra testar isto com dois `fetch`.
   *
   * Dois pedidos disparados com `Promise.all` não chegam juntos no servidor de
   * dev: o primeiro já gravou quando o segundo lê, e o caso fica VERDE com a
   * trava arrancada — a garantia que o teste não tem é pior do que teste
   * nenhum.
   *
   * Aqui a ordem é forçada na mão. Uma conexão do pool segura a linha do
   * evento (a MESMA que `cortesias.post.ts` trava) e gasta a cota inteira
   * dentro da transação dela. A rota de verdade é chamada pela HTTP no meio
   * disso e precisa fazer DUAS coisas:
   *
   *   1. ficar pendurada — se ela responder antes do COMMIT, não há trava;
   *   2. enxergar a cortesia do outro quando andar — se ela tiver contado a
   *      cota ANTES de pegar a trava, ela emite em cima de um número velho e
   *      a 2ª cortesia entra num teto de 1.
   *
   * Uma asserção pra cada; qualquer uma das duas falhas deixa o caso vermelho.
   */
  it('o segundo pedido espera a trava e enxerga a cota que o primeiro gastou', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()
    await sql(`UPDATE events SET courtesy_quota = 1 WHERE id = $1`, [EVENTO])

    const { db } = await import('../../../../utils/db')
    const c1 = await db().connect()

    try {
      await c1.query('BEGIN')
      // a linha do evento é a que serializa a cota — a rota trava esta mesma
      await c1.query(`SELECT id FROM events WHERE id = $1 FOR UPDATE`, [EVENTO])

      let respondeu = false
      const pendente = emitir(1)
        .then((r) => { respondeu = true; return r })
        // Sem este catch, uma falha de asserção antes do COMMIT viraria uma
        // rejeição solta que derruba o processo do vitest em vez de mostrar
        // o caso vermelho.
        .catch((e): Resposta => {
          respondeu = true
          return { status: 0, corpo: {}, mensagem: String(e) }
        })

      // tempo de sobra pra rota responder, se ela fosse responder
      await new Promise((r) => setTimeout(r, 500))
      expect(respondeu,
        'a rota decidiu a cota sem esperar a trava do evento — duas emissões simultâneas furam o teto').toBe(false)

      // c1 gasta a cota inteira e confirma
      await inserirCortesiaCrua(c1)
      await c1.query('COMMIT')

      const r = await pendente
      expect(r.status,
        `andou depois da trava mas decidiu com a contagem velha: emitiu a 2ª cortesia num teto de 1 — ${r.mensagem}`)
        .toBe(409)
      expect(r.mensagem.toLowerCase()).toContain('cota')
    } finally {
      // ROLLBACK antes de devolver ao pool, SEMPRE: `release()` não desfaz
      // transação aberta, e o `FOR UPDATE` preso na conexão devolvida travaria
      // o caso seguinte até estourar o timeout — uma falha viraria duas, e a
      // segunda apontaria pro lugar errado.
      await c1.query('ROLLBACK').catch(() => {})
      c1.release()
    }

    expect(await cortesiasVivas(), 'saiu mais cortesia do que a cota permitia').toBe(1)
  }, 30_000)
})

describe('cortesia — o borderô continua fechando', () => {
  /**
   * Cortesia ocupa lugar e não fatura. O borderô conta as duas coisas em
   * colunas diferentes, e é isso que não pode mudar: emitir cortesia não move
   * um centavo de receita, e some da ocupação se ninguém contar.
   */
  it('emitir cortesia não mexe na receita e aparece na coluna dela', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparCortesias()

    const antes = await bordero()
    expect(antes.totais.faceCents, 'a fixture perdeu a venda que serve de régua').toBe(10_000)

    expect((await emitir(2)).status).toBe(200)
    const depois = await bordero()

    expect(depois.totais.faceCents,
      'a cortesia entrou no faturamento do borderô').toBe(antes.totais.faceCents)
    expect(depois.totais.liquidoCents,
      'a cortesia mexeu no líquido do produtor').toBe(antes.totais.liquidoCents)
    expect(depois.totais.taxaCents).toBe(antes.totais.taxaCents)

    // e do outro lado: ela TEM que aparecer como ocupação, senão o produtor
    // acha que ainda tem os lugares que já deu
    expect(depois.totais.cortesias,
      'a cortesia não foi contada como ingresso emitido').toBe(antes.totais.cortesias + 2)

    const linha = depois.lotes.find((l: any) => l.loteId === LOTE)
    expect(linha.cortesias, 'a coluna de cortesia do lote não se mexeu').toBe(2)
    expect(linha.faceCents, 'a cortesia somou face no lote').toBe(10_000)

    const canal = depois.canais.find((c: any) => c.canal === 'cortesia')
    expect(canal, 'o canal cortesia sumiu do borderô').toBeTruthy()
    expect(canal.faceCents, 'o canal cortesia faturou alguma coisa').toBe(0)
    expect(canal.ingressos).toBe(2)
  }, 30_000)
})
