/**
 * O dia em que o evento não acontece — e o dinheiro tendo que voltar.
 *
 * Três coisas aqui não podem ficar verdes por acidente, porque as três são
 * dinheiro saindo da conta:
 *
 * 1. **A varredura pega quem tem o que receber, e só.** `PEDIDO_VIVO()` no
 *    recorte, nunca `status = 'pago'`: pedido com estorno parcial ainda tem
 *    comprador esperando o resto. Cortesia e pedido expirado não entram.
 * 2. **Estornar duas vezes o mesmo pedido não devolve em dobro.** O caso real
 *    não é o clique duplo: é o nosso estorno voltando como `PAYMENT_REFUNDED`
 *    no webhook do Asaas e gravando o MESMO dinheiro pela segunda porta.
 * 3. **A janela do arrependimento (CDC art. 49) recusa de verdade.** Recusar
 *    na tela e aceitar na rota é o buraco chegando pronto.
 *
 * Fixture própria, ids fixos, apagada no fim. Nenhum dado do evento semeado é
 * tocado. Os pedidos usam cobrança com prefixo `sim_`, então nenhuma linha
 * daqui conversa com o Asaas de verdade nem em sonho.
 *
 * O trabalhador de fundo é desligado NESTE processo (`DT_ESTORNO_WORKER=off`,
 * antes do import) pra fila andar só quando o teste mandar. O servidor de dev
 * tem o dele; por isso as afirmações são sobre o ESTADO FINAL — que não muda
 * se o outro trabalhador chegar primeiro — e as linhas delicadas nascem com
 * `available_at` no futuro, onde só uma reserva por id alcança.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

const ORG     = '0000c020-0000-4000-8000-000000000001'
const USUARIO = '0000c020-0000-4000-8000-000000000002'
const EVENTO  = '0000c020-0000-4000-8000-000000000003'
const SETOR   = '0000c020-0000-4000-8000-000000000004'
const LOTE    = '0000c020-0000-4000-8000-000000000005'
const SESSAO  = '0000c020-0000-4000-8000-000000000006'
const EMAIL   = 'dono.cancelamento@teste.invalido'

/** ids de pedido, pra poder falar de cada um pelo nome */
const P_ONLINE   = '0000c020-0000-4000-8000-0000000000a1' // compra de hoje, pela internet
const P_DINHEIRO = '0000c020-0000-4000-8000-0000000000a2' // guichê em espécie, sem gateway
const P_PARCIAL  = '0000c020-0000-4000-8000-0000000000a3' // já teve R$ 20 estornados
const P_EXPIRADO = '0000c020-0000-4000-8000-0000000000a4' // nunca virou dinheiro
const P_CORTESIA = '0000c020-0000-4000-8000-0000000000a5' // não tem o que devolver
const P_USADO    = '0000c020-0000-4000-8000-0000000000a6' // a pessoa já entrou
const P_VELHO    = '0000c020-0000-4000-8000-0000000000a7' // comprado há 10 dias
const P_BALCAO   = '0000c020-0000-4000-8000-0000000000a8' // comprado na bilheteria

type Cancelamento = typeof import('./cancelamento')
type Banco = typeof import('./db')

let C: Cancelamento
let banco: Banco
let noAr = false
let cookie = ''

const q = <T = any>(t: string, p: any[] = []) => banco.q<T>(t, p)
const q1 = <T = any>(t: string, p: any[] = []) => banco.q1<T>(t, p)

const comSessao = (rota: string, init: RequestInit = {}) =>
  fetch(`${BASE}${rota}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, origin: BASE, ...(init.headers ?? {}) },
  })

async function chamar(rota: string, corpo: any) {
  const r = await comSessao(rota, { method: 'POST', body: JSON.stringify(corpo) })
  const c = await r.json().catch(() => ({}))
  return { status: r.status, corpo: c, mensagem: c.statusMessage ?? c.message ?? '' }
}

const cancelar = (corpo: any) => chamar(`/api/admin/evento/${EVENTO}/cancelar`, corpo)
const remarcar = (corpo: any) => chamar(`/api/admin/evento/${EVENTO}/remarcar`, corpo)

/* ------------------------------------------------------------- a fixture */

interface Pedido {
  id: string
  codigo: string
  canal?: string
  status?: string
  face: number
  fee?: number
  plataforma?: number
  estornado?: number
  /** null = venda que nunca passou pela plataforma (espécie, pix do produtor) */
  asaas?: string | null
  diasAtras?: number
  /** quantos ingressos emitir, e se algum já entrou */
  ingressos?: number
  ingressoUsado?: boolean
  formaPagamento?: string | null
}

async function semear(p: Pedido) {
  const fee = p.fee ?? 0
  const total = p.face + fee
  await q(
    `INSERT INTO orders (id, org_id, event_id, code, status, channel, payment_method,
                         face_cents, fee_cents, platform_cents, discount_cents,
                         total_cents, refunded_cents, asaas_payment_id, paid_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,
             now() - make_interval(days => $14), now() - make_interval(days => $14))`,
    [p.id, ORG, EVENTO, p.codigo, p.status ?? 'pago', p.canal ?? 'online',
     p.formaPagamento ?? null, p.face, fee, p.plataforma ?? 0, total,
     p.estornado ?? 0,
     p.asaas === undefined ? `sim_${p.codigo}` : p.asaas, p.diasAtras ?? 0])

  const quantos = p.ingressos ?? 1
  await q(
    `INSERT INTO order_items (order_id, lot_id, quantity,
                              unit_face_cents, unit_fee_cents, unit_total_cents)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [p.id, LOTE, quantos, p.face, fee, total])

  for (let i = 0; i < quantos; i++) {
    await q(
      `INSERT INTO tickets (org_id, event_id, order_id, sector_id, lot_id,
                            code, qr_secret, status, checked_in_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ORG, EVENTO, p.id, SETOR, LOTE, `${p.codigo}-T${i}`, `s-${p.codigo}-${i}`,
       p.ingressoUsado ? 'usado' : 'valido', p.ingressoUsado ? new Date() : null])
  }
}

/** apaga tudo que a fixture cria, na ordem que o banco aceita */
async function limpar() {
  await q(`DELETE FROM refund_jobs WHERE event_id = $1`, [EVENTO])
  await q(`DELETE FROM event_postpone_choices
            WHERE order_id IN (SELECT id FROM orders WHERE event_id = $1)`, [EVENTO])
  await q(`DELETE FROM event_cancellations WHERE event_id = $1`, [EVENTO])
  await q(`DELETE FROM tickets WHERE event_id = $1`, [EVENTO])
  await q(`DELETE FROM order_items
            WHERE order_id IN (SELECT id FROM orders WHERE event_id = $1)`, [EVENTO])
  await q(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
}

/** o evento volta pro estado inicial: 30 dias à frente, vendendo */
async function reporEvento() {
  await q(
    `UPDATE events SET status = 'ativo', canceled_at = NULL, cancel_reason = NULL,
            postponed_from = NULL, choice_deadline = NULL,
            starts_at = now() + interval '30 days', ends_at = now() + interval '31 days'
      WHERE id = $1`, [EVENTO])
  await q(
    `UPDATE event_sessions SET starts_at = now() + interval '30 days',
            ends_at = now() + interval '31 days' WHERE id = $1`, [SESSAO])
  await q(`UPDATE lots SET sold = 10, reserved = 0 WHERE id = $1`, [LOTE])
}

const pedidoNoBanco = (id: string) =>
  q1<any>(`SELECT status, total_cents, refunded_cents FROM orders WHERE id = $1`, [id])

const filaDoPedido = (id: string) =>
  q1<any>(`SELECT * FROM refund_jobs WHERE order_id = $1`, [id])

beforeAll(async () => {
  // Antes de QUALQUER import do módulo: o trabalhador de fundo não sobe neste
  // processo, senão ele drena a fila no meio das afirmações.
  process.env.DT_ESTORNO_WORKER = 'off'
  banco = await import('./db')
  C = await import('./cancelamento')

  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).status < 500
  } catch { noAr = false }

  await q(`INSERT INTO organizations (id, name, slug)
           VALUES ($1,'ZZ CANCELAMENTO TESTE','zz-cancelamento-teste')
           ON CONFLICT (id) DO NOTHING`, [ORG])
  await q(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,'ZZ EVENTO CANCELAMENTO','zz-evento-cancelamento',
             now() + interval '30 days', now() + interval '31 days', 1000, 'ativo')
     ON CONFLICT (id) DO NOTHING`, [EVENTO, ORG])
  await q(
    `INSERT INTO event_sessions (id, event_id, starts_at, ends_at, title)
     VALUES ($1,$2, now() + interval '30 days', now() + interval '31 days', 'ZZ SESSAO')
     ON CONFLICT (id) DO NOTHING`, [SESSAO, EVENTO])
  await q(
    `INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZ SETOR')
     ON CONFLICT (id) DO NOTHING`, [SETOR, EVENTO])
  await q(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity, sold)
     VALUES ($1,$2,'ZZ LOTE',10000,1000,10)
     ON CONFLICT (id) DO NOTHING`, [LOTE, SETOR])
  await q(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'Dono Cancelamento Teste', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [USUARIO, ORG, EMAIL])

  if (noAr) {
    const r = await fetch(`${BASE}/api/auth/entrar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
    })
    cookie = (r.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
  }
}, 40_000)

afterAll(async () => {
  C?.usarEstornador(null)
  await limpar().catch(() => {})
  await q(`DELETE FROM event_sessions WHERE id = $1`, [SESSAO]).catch(() => {})
  await q(`DELETE FROM lots WHERE id = $1`, [LOTE]).catch(() => {})
  await q(`DELETE FROM sectors WHERE id = $1`, [SETOR]).catch(() => {})
  await q(`DELETE FROM events WHERE id = $1`, [EVENTO]).catch(() => {})
  await q(`DELETE FROM users WHERE id = $1`, [USUARIO]).catch(() => {})
  await q(`DELETE FROM organizations WHERE id = $1`, [ORG]).catch(() => {})
})

/* ============================================================ a janela CDC */

describe('desistir da compra — CDC art. 49', () => {
  const daquiADias = (n: number) => new Date(Date.now() + n * 86_400_000)
  const haDias = (n: number) => new Date(Date.now() - n * 86_400_000)

  const base = {
    canal: 'online', status: 'pago', aDevolverCents: 11_000,
    compradoEm: haDias(1), eventoComecaEm: daquiADias(30),
  }

  it('compra de ontem, evento daqui a 30 dias: pode', () => {
    const v = C.avaliarArrependimento(base)
    expect(v.disponivel, v.motivo).toBe(true)
    expect(v.motivo, 'aceitou sem dizer por quê').toContain('7 dias')
  })

  it('passou dos 7 dias da compra: não pode, e a frase diz a data', () => {
    const v = C.avaliarArrependimento({ ...base, compradoEm: haDias(10) })
    expect(v.disponivel).toBe(false)
    expect(v.motivo).toContain('prazo de arrependimento')
    // a data do fim do prazo precisa aparecer: "não pode" sem "até quando
    // podia" é o tipo de resposta que vira reclamação no Procon.
    expect(v.motivo).toContain(v.prazoAte!.toLocaleDateString('pt-BR'))
  })

  it('evento daqui a 3 dias: não pode, mesmo a compra sendo de ontem', () => {
    const v = C.avaliarArrependimento({ ...base, eventoComecaEm: daquiADias(3) })
    expect(v.disponivel).toBe(false)
    expect(v.motivo).toContain('7 dias antes')
  })

  it('compra no guichê não é compra a distância', () => {
    const v = C.avaliarArrependimento({ ...base, canal: 'bilheteria' })
    expect(v.disponivel).toBe(false)
    expect(v.motivo).toContain('internet')
  })

  it('cortesia não tem o que devolver', () => {
    const v = C.avaliarArrependimento({ ...base, aDevolverCents: 0 })
    expect(v.disponivel).toBe(false)
  })

  it('pedido com estorno parcial ainda pode desistir do resto', () => {
    const v = C.avaliarArrependimento({ ...base, status: 'estornado_parcial' })
    expect(v.disponivel,
      'pedido com estorno parcial ficou de fora do arrependimento').toBe(true)
  })
})

/* ================================================== cancelar o evento todo */

describe('cancelar o evento', () => {
  beforeAll(async () => {
    if (!noAr) return
    await limpar()
    await reporEvento()
    await semear({ id: P_ONLINE, codigo: 'ZZC-ONLINE', face: 10_000, fee: 1_000, plataforma: 1_000 })
    await semear({ id: P_DINHEIRO, codigo: 'ZZC-DINHEIRO', canal: 'bilheteria',
                   formaPagamento: 'dinheiro', face: 5_000, plataforma: 0, asaas: null })
    await semear({ id: P_PARCIAL, codigo: 'ZZC-PARCIAL', status: 'estornado_parcial',
                   face: 85_000, fee: 8_500, plataforma: 8_500, estornado: 2_000 })
    await semear({ id: P_EXPIRADO, codigo: 'ZZC-EXPIRADO', status: 'expirado',
                   face: 50_000, fee: 5_000, plataforma: 5_000 })
    await semear({ id: P_CORTESIA, codigo: 'ZZC-CORTESIA', canal: 'cortesia',
                   face: 0, plataforma: 0, asaas: null })
    await semear({ id: P_USADO, codigo: 'ZZC-USADO', face: 10_000, fee: 1_000,
                   plataforma: 1_000, ingressoUsado: true })
  }, 30_000)

  it('varre todo pedido vivo e ninguém mais', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()

    const r = await cancelar({ escopo: 'evento', motivo: 'Chuva forte, parque fechado' })
    expect(r.status, `não cancelou: ${r.mensagem}`).toBe(200)

    const fila = await q<any>(
      `SELECT order_id, amount_cents, reason, status FROM refund_jobs WHERE event_id = $1`,
      [EVENTO])
    const porPedido = new Map(fila.map((l) => [l.order_id, l]))

    // quem TEM o que receber
    expect(porPedido.get(P_ONLINE)?.amount_cents, 'a compra online ficou de fora').toBe(11_000)
    expect(porPedido.get(P_DINHEIRO)?.amount_cents, 'a venda do guichê ficou de fora').toBe(5_000)
    expect(porPedido.get(P_USADO)?.amount_cents).toBe(11_000)

    // ← o recorte antigo seria `status = 'pago'`, e ele derrubaria ESTE pedido
    //   inteiro: um estorno de R$ 20 apagaria os R$ 915 que faltam devolver.
    expect(porPedido.get(P_PARCIAL)?.amount_cents,
      'o pedido com estorno parcial sumiu da fila, ou entrou pelo valor cheio').toBe(91_500)

    // quem NÃO tem
    expect(porPedido.has(P_EXPIRADO),
      'pedido expirado entrou na fila de devolução — nunca entrou dinheiro nenhum').toBe(false)
    expect(porPedido.has(P_CORTESIA),
      'cortesia entrou na fila de devolução').toBe(false)

    expect(fila.length).toBe(4)
    expect(fila.every((l) => l.reason === 'evento_cancelado')).toBe(true)
  }, 30_000)

  it('o evento fica cancelado e o motivo fica gravado', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const ev = await q1<any>(
      `SELECT status, canceled_at, cancel_reason FROM events WHERE id = $1`, [EVENTO])
    expect(ev.status).toBe('cancelado')
    expect(ev.canceled_at).toBeTruthy()
    expect(ev.cancel_reason).toContain('Chuva forte')

    const ato = await q1<any>(
      `SELECT kind, orders_swept, refund_cents, tickets_killed
         FROM event_cancellations WHERE event_id = $1 ORDER BY at DESC LIMIT 1`, [EVENTO])
    expect(ato.kind).toBe('cancelado')
    expect(ato.orders_swept).toBe(4)
    expect(Number(ato.refund_cents)).toBe(11_000 + 5_000 + 91_500 + 11_000)
  }, 20_000)

  it('todo ingresso válido morre; o que já entrou fica como está', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const t = await q1<any>(
      `SELECT count(*) FILTER (WHERE status = 'valido')::int AS validos,
              count(*) FILTER (WHERE status = 'cancelado')::int AS cancelados,
              count(*) FILTER (WHERE status = 'usado')::int AS usados
         FROM tickets WHERE event_id = $1`, [EVENTO])

    // O leitor da portaria olha o INGRESSO, não o evento: ingresso vivo num
    // evento cancelado continua abrindo a catraca.
    expect(t.validos, 'sobrou ingresso válido num evento cancelado').toBe(0)
    // quem já entrou usou o parque — virar 'cancelado' apagaria a entrada do
    // relatório e o prejuízo a cobrar sumiria junto.
    expect(t.usados, 'cancelou o ingresso de quem já tinha entrado').toBe(1)
    expect(t.cancelados).toBe(5)
  }, 20_000)

  /**
   * A trava do "duas vezes". Aqui ela é o `UNIQUE (order_id)` da fila somado
   * ao `ON CONFLICT DO NOTHING` da varredura: o segundo disparo não cria a
   * segunda linha, e sem segunda linha não existe segunda devolução.
   */
  it('cancelar de novo não enfileira o mesmo pedido outra vez', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const antes = await q1<any>(
      `SELECT count(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS soma
         FROM refund_jobs WHERE event_id = $1`, [EVENTO])

    const r = await cancelar({ escopo: 'evento', motivo: 'Chuva forte, parque fechado' })
    expect(r.status, `o segundo disparo derrubou a rota: ${r.mensagem}`).toBe(200)
    expect(r.corpo.jaEstava, 'não percebeu que o evento já estava cancelado').toBe(true)

    const depois = await q1<any>(
      `SELECT count(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS soma
         FROM refund_jobs WHERE event_id = $1`, [EVENTO])

    expect(depois.n, 'o segundo cancelamento duplicou a fila — cada pedido seria devolvido duas vezes')
      .toBe(antes.n)
    expect(Number(depois.soma)).toBe(Number(antes.soma))
  }, 30_000)

  it('pagamento que cai DEPOIS do cancelamento ainda é varrido pelo segundo disparo', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    // É por isso que a rota aceita o segundo disparo em vez de responder 409:
    // o pix que o comprador pagou no minuto do cancelamento precisa de alguém
    // pra devolver, e esse alguém é o mesmo botão.
    const atrasado = '0000c020-0000-4000-8000-0000000000b1'
    await semear({ id: atrasado, codigo: 'ZZC-ATRASADO', face: 7_000, fee: 700, plataforma: 700 })

    const r = await cancelar({ escopo: 'evento', motivo: 'Chuva forte, parque fechado' })
    expect(r.status).toBe(200)

    const linha = await filaDoPedido(atrasado)
    expect(linha, 'o pagamento que caiu depois do cancelamento ficou sem devolução').toBeTruthy()
    expect(Number(linha.amount_cents)).toBe(7_700)
  }, 30_000)

  /**
   * "Pedidos pagos" NÃO é "quantas compras recebem dinheiro de volta".
   *
   * `configuracoes.get.ts` calcula `pedidosPagos` como `count(*) WHERE status =
   * 'pago'` — e está certo pro que ele foi feito: travar campo depois da
   * primeira venda. A fila varre outra coisa: `PEDIDO_VIVO()` com
   * `total_cents > refunded_cents`. As duas listas se cruzam mas não são a
   * mesma, e nos dois sentidos:
   *
   *  • cortesia é pedido PAGO de R$ 0 — conta na tela, não tem o que devolver;
   *  • estorno parcial NÃO é 'pago' — não conta na tela, e é justamente quem
   *    ainda tem dinheiro a receber.
   *
   * Medido no evento semeado hoje: 145 pela régua da tela, 144 pela da fila.
   * Os números podem até COINCIDIR por acaso (uma cortesia a mais anulando um
   * parcial a menos), e foi por isso que a caixa de ciência do cancelamento
   * passou despercebida prometendo devolução "para {{ pedidosPagos }} compras".
   * Este caso olha as duas listas, não o tamanho delas.
   */
  it('"pedidos pagos" e "compras que recebem dinheiro" são listas diferentes', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const soNaTela = await q<any>(
      `SELECT id FROM orders
        WHERE event_id = $1 AND status = 'pago' AND total_cents <= refunded_cents`, [EVENTO])
    expect(soNaTela.length,
      'a fixture perdeu a cortesia — sem ela este caso não prova nada').toBeGreaterThan(0)

    const soNaFila = await q<any>(
      `SELECT id FROM orders
        WHERE event_id = $1 AND status = 'estornado_parcial'
          AND total_cents > refunded_cents`, [EVENTO])
    expect(soNaFila.length,
      'a fixture perdeu o estorno parcial — sem ele este caso não prova nada').toBeGreaterThan(0)
  }, 20_000)
})

/* ============================================================== a fila */

describe('a fila de estorno', () => {
  const PEDIDO = '0000c020-0000-4000-8000-0000000000c1'
  const SEM_GATEWAY = '0000c020-0000-4000-8000-0000000000c2'

  beforeAll(async () => {
    await limpar()
    await reporEvento()
    await semear({ id: PEDIDO, codigo: 'ZZF-PAGO', status: 'estornado_parcial',
                   face: 85_000, fee: 8_500, plataforma: 8_500, estornado: 2_000 })
    await semear({ id: SEM_GATEWAY, codigo: 'ZZF-ESPECIE', canal: 'bilheteria',
                   formaPagamento: 'dinheiro', face: 5_000, plataforma: 0, asaas: null })
    // a fila é montada pela MESMA instrução que a rota usa
    await q(C.SQL_ENFILEIRA_ESTORNO_DO_EVENTO, [EVENTO, null, 'evento_cancelado', null])
  }, 30_000)

  it('devolve o que FALTAVA, não o total', async () => {
    const linha = await filaDoPedido(PEDIDO)
    // 93.500 de total, 2.000 já devolvidos: mandar o total de volta seria
    // devolver R$ 20 a mais do que o comprador pagou.
    expect(Number(linha.amount_cents),
      'a fila ia devolver mais do que entrou').toBe(91_500)
  })

  it('drenar a fila devolve uma vez e fecha o pedido', async () => {
    await C.processarFilaDeEstorno(20, 'teste')

    const linha = await filaDoPedido(PEDIDO)
    expect(linha.status).toBe('estornado')
    expect(Number(linha.refunded_cents)).toBe(91_500)
    expect(linha.done_at).toBeTruthy()

    const o = await pedidoNoBanco(PEDIDO)
    expect(o.status).toBe('estornado')
    expect(Number(o.refunded_cents),
      'o pedido não ficou com o total devolvido').toBe(Number(o.total_cents))
  }, 30_000)

  /**
   * ESTA é a trava que o item pede: estornar duas vezes não pode devolver em
   * dobro.
   *
   * O caso real não é o clique duplo — é o nosso próprio estorno voltando como
   * `PAYMENT_REFUNDED` no webhook do Asaas e gravando o mesmo dinheiro pela
   * segunda porta. `refunded_cents` é SOMADO (a fila devolve o que faltava,
   * não o total), então a única coisa entre o sistema e a dobra é o
   * `WHERE status IN ('pago','estornado_parcial')` de
   * `SQL_MARCA_PEDIDO_ESTORNADO`. Arranque essa condição e este caso fica
   * vermelho na linha de baixo.
   */
  it('reprocessar a mesma linha não devolve em dobro', async () => {
    const antes = await pedidoNoBanco(PEDIDO)
    expect(antes.status, 'o caso anterior não deixou o pedido estornado').toBe('estornado')

    // a linha volta pra fila como se o processo tivesse morrido antes de
    // fechar — é exatamente o que o resgate de 5 minutos faz em produção
    await q(`UPDATE refund_jobs SET status = 'na_fila', done_at = NULL WHERE order_id = $1`,
      [PEDIDO])
    await C.processarFilaDeEstorno(20, 'teste')

    const depois = await pedidoNoBanco(PEDIDO)
    expect(Number(depois.refunded_cents),
      'devolveu o mesmo dinheiro duas vezes — o pedido está com mais estornado do que entrou')
      .toBe(Number(depois.total_cents))
  }, 30_000)

  it('venda que não passou pela plataforma sai da fila com nome próprio', async () => {
    const linha = await filaDoPedido(SEM_GATEWAY)
    // Dinheiro contado na gaveta do produtor: a plataforma não tem de onde
    // tirar pra mandar de novo. Sumir da lista seria pior — o comprador cobra.
    expect(linha.status).toBe('na_mao')

    const o = await pedidoNoBanco(SEM_GATEWAY)
    expect(o.status).toBe('estornado')
    expect(Number(o.refunded_cents)).toBe(5_000)
  }, 20_000)

  it('a fila vazia não inventa trabalho', async () => {
    expect(await C.processarUmEstorno('teste')).toBeNull()
  })

  /**
   * A reserva é UM comando. Ler com SELECT e marcar depois deixa os dois
   * trabalhadores lerem a MESMA linha antes de qualquer um marcar — e aí o
   * comprador recebe duas vezes.
   *
   * Dois `Promise.all` com dois fetch não provariam isto (eles não chegam
   * juntos no servidor). Aqui a ordem é forçada à mão, em duas conexões,
   * rodando exatamente a instrução que o trabalhador roda.
   */
  it('dois trabalhadores não pegam a mesma linha', async () => {
    const alvo = '0000c020-0000-4000-8000-0000000000c3'
    await semear({ id: alvo, codigo: 'ZZF-CORRIDA', face: 3_000, fee: 300, plataforma: 300 })
    // nasce com espera no futuro: assim só a reserva POR ID alcança esta linha
    // e o trabalhador de fundo do servidor de dev não entra no meio
    const criado = await q1<any>(
      `INSERT INTO refund_jobs (org_id, event_id, order_id, reason, amount_cents,
                                asaas_payment_id, available_at)
       VALUES ($1,$2,$3,'evento_cancelado',3300,'sim_ZZF-CORRIDA', now() + interval '1 hour')
       RETURNING id`, [ORG, EVENTO, alvo])

    const c1 = await banco.db().connect()
    const c2 = await banco.db().connect()
    try {
      await c1.query('BEGIN')
      await c2.query('BEGIN')

      const a = await c1.query(C.SQL_RESERVA_ESTORNO, ['trabalhador-a', criado.id])
      expect(a.rowCount, 'o primeiro trabalhador não conseguiu reservar').toBe(1)
      expect(a.rows[0].status).toBe('estornando')

      // B roda a MESMA instrução enquanto A ainda não confirmou: o SKIP LOCKED
      // faz ele pular a linha travada em vez de esperar por ela.
      const b = await c2.query(C.SQL_RESERVA_ESTORNO, ['trabalhador-b', criado.id])
      expect(b.rowCount,
        'os dois trabalhadores pegaram a mesma linha — o comprador receberia duas vezes').toBe(0)

      await c1.query('COMMIT')
    } finally {
      // ROLLBACK antes de devolver ao pool, SEMPRE: `release()` não desfaz
      // transação aberta, e uma falha no meio deixaria o próximo caso travado
      // até o timeout, apontando pro lugar errado.
      await c1.query('ROLLBACK').catch(() => {})
      await c2.query('ROLLBACK').catch(() => {})
      c1.release()
      c2.release()
    }

    const linha = await filaDoPedido(alvo)
    expect(linha.attempts, 'a tentativa foi contada duas vezes').toBe(1)
    expect(linha.claimed_by).toBe('trabalhador-a')
  }, 30_000)

  it('gateway fora do ar volta pra fila com espera, e desiste no fim', async () => {
    const alvo = '0000c020-0000-4000-8000-0000000000c4'
    await semear({ id: alvo, codigo: 'ZZF-FALHA', face: 4_000, fee: 400, plataforma: 400 })
    const criado = await q1<any>(
      `INSERT INTO refund_jobs (org_id, event_id, order_id, reason, amount_cents,
                                asaas_payment_id, max_attempts, available_at)
       VALUES ($1,$2,$3,'evento_cancelado',4400,'sim_ZZF-FALHA',2, now() + interval '1 hour')
       RETURNING id`, [ORG, EVENTO, alvo])

    C.usarEstornador(async () => { throw new Error('ECONNREFUSED 127.0.0.1:443') })
    try {
      const primeira = await C.processarUmEstorno('teste', criado.id)
      expect(primeira!.ok).toBe(false)
      expect(primeira!.status, 'desistiu na primeira falha de rede').toBe('na_fila')
      // A mensagem é lida por quem atende o cliente, não por quem lê log.
      // `toLocaleString` separa o R$ com espaço FINO (U+00A0): comparar sem
      // normalizar falha com as duas strings idênticas na tela.
      expect(primeira!.erro!.replace(/ /g, ' ')).toContain('R$ 44,00')

      const meio = await filaDoPedido(alvo)
      expect(new Date(meio.available_at).getTime(),
        'voltou pra fila sem espera nenhuma — giraria em brasa contra o gateway fora')
        .toBeGreaterThan(Date.now())

      // empurra a espera pra longe de novo: a linha volta a ser alcançável só
      // por id, e o trabalhador de fundo do servidor de dev (que usa o
      // estornador de verdade) não rouba a segunda tentativa.
      await q(`UPDATE refund_jobs SET available_at = now() + interval '1 hour' WHERE id = $1`,
        [criado.id])

      const segunda = await C.processarUmEstorno('teste', criado.id)
      expect(segunda!.status, 'insistiu para sempre no mesmo erro').toBe('falhou')
    } finally {
      C.usarEstornador(null)
    }

    const o = await pedidoNoBanco(alvo)
    expect(o.status,
      'marcou o pedido como estornado sem o dinheiro ter saído').toBe('pago')
    expect(Number(o.refunded_cents)).toBe(0)
  }, 30_000)

  /**
   * O valor da linha é uma FOTO do dia do cancelamento, e a fila anda depois.
   *
   * O terceiro andar da idempotência (`WHERE status IN ('pago',
   * 'estornado_parcial')`) só segura o caso em que o webhook fecha o pedido
   * inteiro antes da fila — aí o pedido sai de 'pago' e a soma não acontece.
   * Ele NÃO segura o estorno PARCIAL que cai no meio: o pedido continua em
   * `PEDIDO_VIVO()`, a condição casa, e a linha soma por cima a foto velha.
   *
   * Um evento de parque leva minutos pra drenar (15 s por varredura, milhares
   * de pedidos). Um estorno parcial que o comprador tinha pedido antes e que
   * liquida nesse meio tempo é suficiente: a plataforma pede ao banco mais do
   * que ainda deve e `refunded_cents` passa de `total_cents` — não existe
   * CHECK que impeça, e a partir daí o líquido do produtor fica negativo
   * sozinho (`SQL_LIQUIDO` é `total − platform − refunded`).
   */
  it('estorno parcial que cai depois da fila montada não faz devolver mais do que falta', async () => {
    const alvo = '0000c020-0000-4000-8000-0000000000c5'
    await semear({ id: alvo, codigo: 'ZZF-MEIO', face: 100_000, fee: 0, plataforma: 0 })
    // a fila nasce com o total, como no minuto do cancelamento
    const criado = await q1<any>(
      `INSERT INTO refund_jobs (org_id, event_id, order_id, reason, amount_cents,
                                asaas_payment_id, available_at)
       VALUES ($1,$2,$3,'evento_cancelado',100000,'sim_ZZF-MEIO', now() + interval '1 hour')
       RETURNING id`, [ORG, EVENTO, alvo])

    // ... e SÓ DEPOIS o webhook do Asaas registra um estorno parcial de R$ 200
    await q(`UPDATE orders SET status = 'estornado_parcial', refunded_cents = 20000
              WHERE id = $1`, [alvo])

    let pedidoAoBanco = -1
    C.usarEstornador(async (p) => { pedidoAoBanco = p.valorCents; return { id: 'sim_meio' } })
    try {
      await C.processarUmEstorno('teste', criado.id)
    } finally {
      C.usarEstornador(null)
    }

    const o = await pedidoNoBanco(alvo)
    expect(Number(o.refunded_cents),
      'o pedido ficou com mais devolvido do que entrou — o líquido do produtor vira negativo')
      .toBeLessThanOrEqual(Number(o.total_cents))
    expect(pedidoAoBanco,
      'pediu ao banco o valor da foto antiga, não o que ainda faltava devolver')
      .toBe(80_000)
  }, 30_000)
})

/* ====================================================== desistir da compra */

describe('a desistência pela rota', () => {
  const RECENTE = '0000c020-0000-4000-8000-0000000000d1'
  const VELHO = P_VELHO
  const BALCAO = P_BALCAO

  beforeAll(async () => {
    if (!noAr) return
    await limpar()
    await reporEvento()
    await semear({ id: RECENTE, codigo: 'ZZD-RECENTE', face: 10_000, fee: 1_000,
                   plataforma: 1_000, ingressos: 2 })
    await semear({ id: VELHO, codigo: 'ZZD-VELHO', face: 10_000, fee: 1_000,
                   plataforma: 1_000, diasAtras: 10 })
    await semear({ id: BALCAO, codigo: 'ZZD-BALCAO', canal: 'bilheteria',
                   face: 10_000, plataforma: 1_000 })
  }, 30_000)

  it('compra de hoje pela internet: devolve, mata o ingresso e solta o lugar', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const antes = await q1<any>(`SELECT sold FROM lots WHERE id = $1`, [LOTE])

    const r = await cancelar({ escopo: 'pedido', pedidoId: RECENTE, motivo: 'desisti' })
    expect(r.status, `recusou uma desistência dentro do prazo: ${r.mensagem}`).toBe(200)
    expect(r.corpo.valorCents).toBe(11_000)

    const linha = await filaDoPedido(RECENTE)
    expect(linha.reason).toBe('arrependimento')

    const t = await q1<any>(
      `SELECT count(*) FILTER (WHERE status = 'valido')::int AS validos
         FROM tickets WHERE order_id = $1`, [RECENTE])
    expect(t.validos, 'o ingresso continuou valendo depois da desistência').toBe(0)

    // O evento continua de pé: os dois lugares voltam pra prateleira e podem
    // ser vendidos de novo. (No cancelamento do evento inteiro isso NÃO
    // acontece — lá ninguém vai vender mais nada.)
    const depois = await q1<any>(`SELECT sold FROM lots WHERE id = $1`, [LOTE])
    expect(depois.sold,
      'o lugar não voltou pra prateleira num evento que vai acontecer').toBe(antes.sold - 2)
  }, 30_000)

  it('a segunda desistência da mesma compra é recusada', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const r = await cancelar({ escopo: 'pedido', pedidoId: RECENTE, motivo: 'desisti de novo' })
    expect(r.status, 'aceitou devolver a mesma compra duas vezes').toBe(409)
  }, 20_000)

  /**
   * A janela precisa recusar NA ROTA, não só na tela. Arranque a chamada a
   * `avaliarArrependimento` do handler e este caso fica vermelho nas duas
   * linhas de baixo: a compra de 10 dias atrás passa e vira dinheiro saindo.
   */
  it('compra de 10 dias atrás: recusa, e nada se mexe', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const r = await cancelar({ escopo: 'pedido', pedidoId: VELHO, motivo: 'desisti' })
    expect(r.status, `deixou desistir fora do prazo de 7 dias — ${r.mensagem}`).toBe(409)
    expect(r.mensagem).toContain('prazo de arrependimento')

    expect(await filaDoPedido(VELHO),
      'recusou na resposta e enfileirou a devolução assim mesmo').toBeNull()
    const t = await q1<any>(
      `SELECT count(*) FILTER (WHERE status = 'valido')::int AS validos
         FROM tickets WHERE order_id = $1`, [VELHO])
    expect(t.validos, 'recusou e matou o ingresso do comprador do mesmo jeito').toBe(1)
  }, 20_000)

  it('compra no guichê não tem arrependimento de 7 dias', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const r = await cancelar({ escopo: 'pedido', pedidoId: BALCAO, motivo: 'desisti' })
    expect(r.status).toBe(409)
    expect(r.mensagem).toContain('internet')
  }, 20_000)

  it('evento em cima da hora fecha a janela', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const perto = '0000c020-0000-4000-8000-0000000000d4'
    await semear({ id: perto, codigo: 'ZZD-PERTO', face: 10_000, fee: 1_000, plataforma: 1_000 })
    await q(`UPDATE events SET starts_at = now() + interval '3 days',
                                ends_at = now() + interval '4 days' WHERE id = $1`, [EVENTO])
    try {
      const r = await cancelar({ escopo: 'pedido', pedidoId: perto, motivo: 'desisti' })
      expect(r.status, `devolveu ingresso com o evento em 3 dias — ${r.mensagem}`).toBe(409)
      expect(r.mensagem).toContain('7 dias antes')
    } finally {
      await reporEvento()
    }
  }, 30_000)

  /**
   * Evento cancelado não tem "desistência": tem devolução de todo mundo.
   *
   * A rota LÊ `e.status AS evento_status` no mesmo SELECT e não olha pra ele
   * em lugar nenhum — campo previsto num lado e nunca usado no outro. Quem
   * segura o caso comum é o `ON CONFLICT` da fila, por acidente: o pedido já
   * estava enfileirado pelo cancelamento, a segunda linha não entra, e a
   * transação volta atrás.
   *
   * O pedido que NÃO estava na fila fura essa proteção por acidente — e ele
   * existe: é o pix que caiu no minuto do cancelamento e ainda não foi varrido
   * pelo segundo disparo (o caso que a própria rota documenta como motivo pra
   * aceitar o disparo repetido). Nele a desistência passa, e duas coisas saem
   * erradas em silêncio:
   *
   *  • o lugar volta pra prateleira de um evento que não vai acontecer — o
   *    cancelamento em massa deixa o estoque quieto DE PROPÓSITO, pra não
   *    apagar do relatório quanto tinha sido vendido;
   *  • a devolução entra na fila como `arrependimento` em vez de
   *    `evento_cancelado`. A coluna `reason` existe justamente porque, como diz
   *    a migração 020, "o relatório do Procon pergunta exatamente por esse
   *    recorte" — e arrependimento é direito do consumidor, não cancelamento
   *    do fornecedor. Trocar um pelo outro é assinar a resposta errada.
   */
  it('compra paga depois do cancelamento não vira "arrependimento"', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const tardio = '0000c020-0000-4000-8000-0000000000d5'
    await semear({ id: tardio, codigo: 'ZZD-TARDIO', face: 10_000, fee: 1_000, plataforma: 1_000 })
    const antes = await q1<any>(`SELECT sold FROM lots WHERE id = $1`, [LOTE])

    // o evento já caiu; este pix entrou depois e ainda não foi varrido
    await q(`UPDATE events SET status = 'cancelado', canceled_at = now(),
                               cancel_reason = 'Chuva forte' WHERE id = $1`, [EVENTO])
    try {
      const r = await cancelar({ escopo: 'pedido', pedidoId: tardio, motivo: 'desisti' })

      const linha = await filaDoPedido(tardio)
      expect(linha?.reason ?? null,
        'a devolução de um evento CANCELADO entrou na fila como arrependimento do consumidor')
        .not.toBe('arrependimento')

      const depois = await q1<any>(`SELECT sold FROM lots WHERE id = $1`, [LOTE])
      expect(Number(depois.sold),
        'devolveu o lugar à prateleira de um evento cancelado — ninguém vai vender, '
        + 'e o relatório perde quanto tinha sido vendido até a hora que ele caiu')
        .toBe(Number(antes.sold))

      expect(r.status,
        `deixou "desistir" de uma compra de evento cancelado: ${r.mensagem}`).toBe(409)
    } finally {
      await reporEvento()
    }
  }, 30_000)
})

/* ============================================================== adiar */

describe('adiar o evento', () => {
  const COMPRADOR = '0000c020-0000-4000-8000-0000000000e1'
  const DESISTENTE = '0000c020-0000-4000-8000-0000000000e2'
  const novaData = () => new Date(Date.now() + 60 * 86_400_000)

  beforeAll(async () => {
    if (!noAr) return
    await limpar()
    await reporEvento()
    await semear({ id: COMPRADOR, codigo: 'ZZA-FICA', face: 10_000, fee: 1_000, plataforma: 1_000 })
    await semear({ id: DESISTENTE, codigo: 'ZZA-SAI', face: 20_000, fee: 2_000, plataforma: 2_000 })
  }, 30_000)

  it('o ingresso continua valendo, e a sessão anda junto com o evento', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const antes = await q1<any>(
      `SELECT e.starts_at AS evento, s.starts_at AS sessao
         FROM events e JOIN event_sessions s ON s.id = $2 WHERE e.id = $1`, [EVENTO, SESSAO])

    const nova = novaData()
    const fim = new Date(nova.getTime() + 86_400_000)
    const r = await remarcar({
      escopo: 'evento', comecaEm: nova.toISOString(), terminaEm: fim.toISOString(),
      motivo: 'Chuva: passou para o mês que vem',
    })
    expect(r.status, `não adiou: ${r.mensagem}`).toBe(200)

    const ev = await q1<any>(
      `SELECT status, starts_at, postponed_from, choice_deadline FROM events WHERE id = $1`,
      [EVENTO])
    expect(ev.status).toBe('adiado')
    expect(new Date(ev.postponed_from).getTime(),
      'perdeu a data que a pessoa comprou').toBe(new Date(antes.evento).getTime())

    // Ingresso continua VÁLIDO: adiar não é cancelar e vender de novo.
    const t = await q1<any>(
      `SELECT count(*) FILTER (WHERE status = 'valido')::int AS validos
         FROM tickets WHERE event_id = $1`, [EVENTO])
    expect(t.validos, 'adiar matou os ingressos — ninguém teria o que usar na data nova').toBe(2)

    // A sessão anda pelo MESMO deslocamento. Sem isto o ingresso fica amarrado
    // a uma sessão do dia que não vai existir e o leitor recusa "fora da
    // sessão" no dia certo.
    const depois = await q1<any>(`SELECT starts_at FROM event_sessions WHERE id = $1`, [SESSAO])
    const deslocamentoEvento = new Date(ev.starts_at).getTime() - new Date(antes.evento).getTime()
    const deslocamentoSessao = new Date(depois.starts_at).getTime() - new Date(antes.sessao).getTime()
    expect(deslocamentoSessao,
      'o evento mudou de data e a sessão ficou na data velha')
      .toBe(deslocamentoEvento)

    expect(ev.choice_deadline, 'adiou sem abrir prazo de escolha pro comprador').toBeTruthy()
    expect(new Date(ev.choice_deadline).getTime(),
      'o prazo de escolha passa do início do evento').toBeLessThanOrEqual(
      new Date(ev.starts_at).getTime())
  }, 30_000)

  it('quem fica com o ingresso não gera devolução', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const r = await remarcar({ escopo: 'pedido', pedidoId: COMPRADOR, escolha: 'remarcar' })
    expect(r.status, r.mensagem).toBe(200)

    expect(await filaDoPedido(COMPRADOR),
      'quem aceitou a data nova entrou na fila de devolução').toBeNull()
    const t = await q1<any>(
      `SELECT count(*) FILTER (WHERE status = 'valido')::int AS validos
         FROM tickets WHERE order_id = $1`, [COMPRADOR])
    expect(t.validos).toBe(1)
  }, 20_000)

  it('quem não quer a data nova entra na fila e perde o ingresso', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const r = await remarcar({ escopo: 'pedido', pedidoId: DESISTENTE, escolha: 'reembolso' })
    expect(r.status, r.mensagem).toBe(200)

    const linha = await filaDoPedido(DESISTENTE)
    expect(linha.reason).toBe('evento_adiado')
    expect(Number(linha.amount_cents)).toBe(22_000)

    const t = await q1<any>(
      `SELECT count(*) FILTER (WHERE status = 'valido')::int AS validos
         FROM tickets WHERE order_id = $1`, [DESISTENTE])
    expect(t.validos).toBe(0)
  }, 20_000)

  /**
   * Quem já pediu o dinheiro de volta não pode ouvir "ingressos mantidos".
   *
   * O `ON CONFLICT DO UPDATE` da escolha aceita trocar de ideia, e isso é certo
   * ENQUANTO nada aconteceu. Só que o ramo 'reembolso' não é uma intenção: ele
   * já matou o ingresso, já devolveu o lugar pra prateleira e já botou o pedido
   * na fila de devolução. Voltar pra 'remarcar' depois disso não desfaz nada —
   * apenas troca a linha da escolha e responde "Ingressos mantidos: valem em
   * <data>. Nada foi cobrado nem devolvido."
   *
   * É a falha muda inteira: 200, sem exceção, sem log, e a pessoa vai pro
   * parque com um ingresso cancelado enquanto o dinheiro sai assim mesmo. Ou a
   * rota desfaz de verdade, ou ela recusa com a verdade — o que não pode é
   * responder que está tudo mantido.
   */
  it('depois de pedir o dinheiro de volta, a rota não promete o ingresso de volta', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const naFila = await filaDoPedido(DESISTENTE)
    expect(naFila, 'o caso anterior não deixou a devolução na fila').toBeTruthy()

    const r = await remarcar({ escopo: 'pedido', pedidoId: DESISTENTE, escolha: 'remarcar' })

    if (r.status === 200) {
      // Se aceitou, tem que ter DESFEITO: ingresso vivo de novo e fila limpa.
      const t = await q1<any>(
        `SELECT count(*) FILTER (WHERE status = 'valido')::int AS validos
           FROM tickets WHERE order_id = $1`, [DESISTENTE])
      const linha = await filaDoPedido(DESISTENTE)
      expect(
        t.validos > 0 && (linha == null || linha.status === 'cancelado'),
        `respondeu "${r.corpo.aviso}" com o ingresso cancelado e `
        + `${linha ? `a devolução ainda ${linha.status}` : 'a fila desfeita'} — `
        + 'o comprador fica sem ingresso e o dinheiro sai do mesmo jeito',
      ).toBe(true)
    } else {
      // Recusar é a outra saída honesta: a frase precisa dizer por quê.
      expect(r.status, `recusou com um código que a tela não explica: ${r.mensagem}`).toBe(409)
      expect(r.mensagem.toLowerCase(),
        'recusou sem dizer que a devolução já estava em andamento').toContain('devolução')
    }
  }, 20_000)

  it('passado o prazo, a escolha não existe mais', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await q(`UPDATE event_cancellations SET choice_deadline = now() - interval '1 day'
              WHERE event_id = $1 AND kind = 'adiado'`, [EVENTO])
    const tarde = '0000c020-0000-4000-8000-0000000000e3'
    await semear({ id: tarde, codigo: 'ZZA-TARDE', face: 10_000, fee: 1_000, plataforma: 1_000 })

    const r = await remarcar({ escopo: 'pedido', pedidoId: tarde, escolha: 'reembolso' })
    expect(r.status, `devolveu dinheiro depois do prazo da escolha — ${r.mensagem}`).toBe(409)
    expect(r.mensagem).toContain('prazo')
    expect(await filaDoPedido(tarde)).toBeNull()
  }, 30_000)

  it('evento cancelado não se remarca', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await q(`UPDATE events SET status = 'cancelado' WHERE id = $1`, [EVENTO])
    try {
      const nova = novaData()
      const r = await remarcar({
        escopo: 'evento', comecaEm: nova.toISOString(),
        terminaEm: new Date(nova.getTime() + 86_400_000).toISOString(),
        motivo: 'tentando ressuscitar',
      })
      // ressuscitar um evento cancelado devolveria validade a ingresso que já
      // está sendo estornado — dinheiro devolvido E pessoa entrando.
      expect(r.status, 'remarcou um evento cancelado').toBe(409)
    } finally {
      await reporEvento()
    }
  }, 20_000)
})
