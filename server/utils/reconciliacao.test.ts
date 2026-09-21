/**
 * Reconciliação — o extrato do gateway contra o nosso caixa.
 *
 * O que estes casos travam não é "a tela mostra uma tabela": é que ela
 * responda **a verdade** nas três situações que custam dinheiro, e que ela
 * **cale a boca** quando não conferiu. São quatro invariantes, e cada uma já
 * tem um jeito conhecido de quebrar:
 *
 *  1. **A régua dos dois lados é a mesma.** `PEDIDO_VIVO()` aqui,
 *     `traduzirStatus()` lá. Um `status = 'pago'` de um lado só faz todo
 *     pedido com estorno parcial virar "o Asaas recebeu e aqui não consta" —
 *     a tela inventa uma divergência grave por causa de uma devolução de
 *     R$ 20.
 *
 *  2. **A janela pega o pedido que NÃO foi pago.** Filtrar por `paid_at`
 *     esconde exatamente o caso que a tela existe pra achar: o webhook
 *     perdido deixa o pedido sem `paid_at` nenhum.
 *
 *  3. **Nunca acusar o que não se olhou.** Extrato parcial (sem credencial,
 *     página faltando, gateway mudo) vira "não conferido", não "grave". A
 *     tela que grita por falta de página é a tela que ninguém abre na vez em
 *     que o grito é verdadeiro.
 *
 *  4. **Resposta do gateway é achado.** "Esta cobrança não existe" (404)
 *     acusa; "não consegui perguntar" (rede, 401, 500) não acusa.
 *
 * Os casos de banco vão AO BANCO de propósito: o que precisa ficar travado é
 * a expressão SQL compartilhada, não uma cópia dela em TypeScript. Fixture
 * com ids próprios, apagada no fim — nada do evento semeado é tocado.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { db, q, q1 } from './db'
import { PEDIDO_VIVO } from './liquido'
import { traduzirStatus } from './asaas'
import {
  CATALOGO, MAX_CONSULTAS_POR_ID, SQL_AVISOS_GUARDADOS, SQL_EXTRATO_SIMULADO,
  SQL_PEDIDOS_DO_PERIODO, STATUS_VIVOS, cobrancaTemDinheiro, comparar, conferirPorId,
  diaLocal, lerCobranca, lerJanela, listarCobrancas, pedidoDaLinha, vereditoDaConferencia,
  type CobrancaDoExtrato, type PedidoNosso,
} from './reconciliacao'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

/** ids fixos: o teste apaga exatamente o que criou */
const ORG = '0000a220-0000-4000-8000-000000000001'
const VIZINHA = '0000a220-0000-4000-8000-000000000002'
const EVENTO = '0000a220-0000-4000-8000-000000000003'
const EVENTO_VIZINHO = '0000a220-0000-4000-8000-000000000004'
const USUARIO = '0000a220-0000-4000-8000-000000000005'
const EMAIL = 'dono.reconciliacao@teste.invalido'

let noAr = false
let cookie = ''

/**
 * Pula o caso quando o servidor de dev não está no ar — e pula DE VERDADE.
 *
 * Isto era `if (!noAr) return void console.warn(...)`, e o vitest conta esse
 * retorno como ✓. Medido: com `BASE_TESTE` apontando pra uma porta morta,
 * este arquivo imprimiu **53 passed em 344ms** sem bater uma vez na rota — os
 * três casos que provam que "olhar não grava conferência" entre eles. Numa
 * corrida de MUTAÇÃO é a pior resposta possível: dá a invariante por provada
 * exatamente quando ela foi arrancada, e o relatório fica idêntico ao de uma
 * corrida que provou tudo. `ctx.skip()` sai contado como PULADO, que é o que
 * se lê de longe. Mesma decisão de `api/admin/evento/[id]/pdv/venda.test.ts`.
 */
const PORQUE_PULOU = 'servidor de dev fora do ar ou respondendo 500 (porta 3100)'
function seForaDoArPula(ctx: { skip: (motivo?: string) => void }) {
  if (!noAr) ctx.skip(PORQUE_PULOU)
}

/**
 * Uma corrida deste arquivo de cada vez.
 *
 * O `beforeAll` semeia a organização ZZ e o `afterAll` a APAGA — e o DELETE
 * cai em cascata até os pedidos, o usuário e a sessão dele. Com duas corridas
 * ao mesmo tempo (o normal aqui: vários agentes rodando a suíte no mesmo
 * banco), o `afterAll` de uma derruba a fixture da outra NO MEIO das
 * asserções. Medido: numa corrida da suíte inteira este arquivo deu 8
 * vermelhos e, isolado, os mesmos 54 casos passaram três vezes seguidas — o
 * vermelho não falava do código. Vermelho que não fala do código é o que
 * ensina a ignorar vermelho.
 *
 * `pg_advisory_lock` é de SESSÃO: morre junto com a conexão, então corrida
 * interrompida não deixa trava presa. Fica com prazo e frase, em vez de
 * bloquear pra sempre. Mesma decisão de `api/admin/evento/[id]/pdv/venda.test.ts`.
 */
const TRAVA_DESTE_ARQUIVO = 902_2200
let travaDono: PoolClient | null = null

/* ------------------------------------------------------------- fixture */

interface NovoPedido {
  id?: string
  codigo: string
  org?: string
  evento?: string
  status?: string
  /** o que o comprador pagou */
  total: number
  plataforma?: number
  estornado?: number
  /** `null` = dinheiro que entrou direto no bolso do produtor */
  cobranca?: string | null
  pagoEm?: string
  criadoEm?: string
}

async function pedido(p: NovoPedido) {
  const face = p.total
  await q(
    `INSERT INTO orders (id, org_id, event_id, code, status, channel,
                         face_cents, fee_cents, platform_cents, discount_cents,
                         total_cents, refunded_cents, asaas_payment_id, paid_at, created_at)
     VALUES (COALESCE($1::uuid, gen_random_uuid()),$2,$3,$4,$5,'online',
             $6,0,$7,0,$8,$9,$10,$11::timestamptz,$12::timestamptz)`,
    [p.id ?? null, p.org ?? ORG, p.evento ?? EVENTO, p.codigo, p.status ?? 'pago',
     face, p.plataforma ?? 0, p.total, p.estornado ?? 0,
     p.cobranca === undefined ? `sim_${p.codigo}` : p.cobranca,
     p.pagoEm ?? (p.status === 'pago' || p.status === 'estornado_parcial' ? 'now()' : null),
     p.criadoEm ?? 'now()'])
}

/** grava um aviso do gateway como o webhook gravaria */
async function aviso(dados: {
  chave: string
  cobranca: string
  pedidoId?: string
  evento?: string
  status: string
  valorReais: number
  estornadoReais?: number
  processado?: boolean
  erro?: string
}) {
  await q(
    `INSERT INTO payment_events (provider, gateway_event_id, external_id, event_name,
                                 order_id, payload, processed_at, attempts, error)
     VALUES ('asaas',$1,$2,$3,$4::uuid,$5::jsonb,$6,$7,$8)
     ON CONFLICT (provider, gateway_event_id) DO NOTHING`,
    [dados.chave, dados.cobranca, dados.evento ?? 'PAYMENT_RECEIVED',
     dados.pedidoId ?? null,
     JSON.stringify({
       id: dados.chave,
       event: dados.evento ?? 'PAYMENT_RECEIVED',
       payment: {
         id: dados.cobranca,
         status: dados.status,
         value: dados.valorReais,
         refundedValue: dados.estornadoReais,
         paymentDate: '2026-09-10',
       },
     }),
     dados.processado ? new Date() : null, dados.erro ? 2 : 0, dados.erro ?? null])
}

const limparPedidos = () =>
  q(`DELETE FROM orders WHERE org_id IN ($1,$2)`, [ORG, VIZINHA])

beforeAll(async () => {
  travaDono = await db().connect()
  const prazo = Date.now() + 25_000
  while (!(await travaDono.query(
    'SELECT pg_try_advisory_lock($1) AS ok', [TRAVA_DESTE_ARQUIVO])).rows[0].ok) {
    if (Date.now() > prazo) {
      throw new Error('outra corrida deste arquivo ainda está de pé — rode de novo em instantes')
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  for (const [org, nome] of [[ORG, 'zz-reconciliacao'], [VIZINHA, 'zz-reconciliacao-vizinha']]) {
    await q(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$2)
             ON CONFLICT (id) DO NOTHING`, [org, nome])
  }
  for (const [ev, org, nome] of [
    [EVENTO, ORG, 'zz-rec-evento'], [EVENTO_VIZINHO, VIZINHA, 'zz-rec-evento-vizinho'],
  ]) {
    await q(
      `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
       VALUES ($1,$2,$3,$3, now() - interval '10 days', now() - interval '9 days', 1000, 'ativo')
       ON CONFLICT (id) DO NOTHING`, [ev, org, nome])
  }
  await q(
    `INSERT INTO users (id, org_id, name, email, password_hash, role, papel)
     SELECT $1, $2, 'Dono Reconciliacao Teste', $3, password_hash, 'master', 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [USUARIO, ORG, EMAIL])

  await limparPedidos()

  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).status < 500
  } catch { noAr = false }
  if (!noAr) return

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 40_000)

afterAll(async () => {
  try {
    // a organização leva junto eventos, pedidos e usuários (ON DELETE CASCADE);
    // os avisos são apagados na mão porque `payment_events` não tem org
    await q(`DELETE FROM payment_events WHERE gateway_event_id LIKE 'zz-rec-%'`)
    await q(`DELETE FROM reconciliation_runs WHERE org_id IN ($1,$2)`, [ORG, VIZINHA])
    await q(`DELETE FROM organizations WHERE id IN ($1,$2)`, [ORG, VIZINHA])
  } finally {
    // solta a trava mesmo se a limpeza falhar, senão a próxima corrida espera
    // os 25 segundos inteiros por causa de um erro que já passou
    if (travaDono) {
      try {
        await travaDono.query('SELECT pg_advisory_unlock($1)', [TRAVA_DESTE_ARQUIVO])
      } catch { /* conexão já morreu: a trava morreu junto */ }
      travaDono.release()
      travaDono = null
    }
  }
})

/* ==================================================== 1. a régua é uma só */

describe('a régua de "tem dinheiro" é a mesma nos dois lados', () => {
  it('o SQL do nosso lado usa PEDIDO_VIVO, não status = pago', () => {
    // `STATUS_VIVOS` é o que o lado do gateway consulta. Se ela e o
    // `PEDIDO_VIVO()` do SQL discordarem, a tela acusa divergência onde não
    // tem — cada status que sobra num lado é uma denúncia falsa.
    for (const s of STATUS_VIVOS) {
      expect(PEDIDO_VIVO(), `PEDIDO_VIVO() não conhece "${s}"`).toContain(`'${s}'`)
      expect(SQL_PEDIDOS_DO_PERIODO,
        `o recorte da reconciliação não conhece "${s}"`).toContain(`'${s}'`)
    }
    // e nada além disso: um status a mais de um lado é o mesmo defeito ao contrário
    expect((PEDIDO_VIVO().match(/'[a-z_]+'/g) ?? []).sort())
      .toEqual([...STATUS_VIVOS].map((s) => `'${s}'`).sort())
  })

  it('o status do gateway vira "tem dinheiro" pela tradução do webhook', () => {
    for (const cru of ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'PARTIALLY_REFUNDED']) {
      expect(cobrancaTemDinheiro({ statusCru: cru }), `${cru} devia contar como dinheiro`)
        .toBe(true)
      expect(STATUS_VIVOS as readonly string[]).toContain(traduzirStatus(cru))
    }
    for (const cru of ['PENDING', 'OVERDUE', 'REFUNDED', 'DELETED', 'CHARGEBACK_REQUESTED']) {
      expect(cobrancaTemDinheiro({ statusCru: cru }), `${cru} não é dinheiro na conta`)
        .toBe(false)
    }
  })

  it('cobrança APAGADA não conta, mesmo com o status ainda em PENDING', () => {
    // O Asaas manda `deleted: true` com `status` em PENDING. Lida só pelo
    // status, ela viraria "aguardando" — e um pedido pago aqui contra uma
    // cobrança apagada lá é justamente o caso grave.
    expect(cobrancaTemDinheiro({ statusCru: 'RECEIVED', apagada: true })).toBe(false)
  })
})

/* ============================================ 2. o recorte, no banco mesmo */

describe('o recorte do nosso lado', () => {
  const janela = () => {
    const j = lerJanela('2026-09-01', '2026-09-30')
    return [ORG, j.inicio, j.fim, null]
  }

  it('pedido com estorno PARCIAL entra vivo — não sumiu nem virou divergência', async () => {
    await limparPedidos()
    await pedido({ codigo: 'ZZ-REC-PARCIAL', status: 'estornado_parcial',
                   total: 85_000, estornado: 2_000, pagoEm: '2026-09-10' })

    const linhas = await q<any>(SQL_PEDIDOS_DO_PERIODO, janela())
    // ← com `status = 'pago'` no lugar do PEDIDO_VIVO(), esta linha some do
    //   nosso lado e o extrato do Asaas passa a mostrar R$ 830 "recebidos lá
    //   e não pagos aqui": divergência grave inventada por um estorno de R$ 20.
    expect(linhas.length, 'o pedido com estorno parcial sumiu do nosso lado').toBe(1)
    expect(pedidoDaLinha(linhas[0]).vivo).toBe(true)
    expect(pedidoDaLinha(linhas[0]).estornadoCents).toBe(2_000)
  })

  it('pedido que NUNCA foi pago entra na janela pela data de criação', async () => {
    await limparPedidos()
    await pedido({ codigo: 'ZZ-REC-EXPIRADO', status: 'expirado', total: 6_600,
                   pagoEm: undefined, criadoEm: '2026-09-12 14:00-03' })

    const linhas = await q<any>(SQL_PEDIDOS_DO_PERIODO, janela())
    // ← é ESTE o pedido do webhook perdido: o Asaas recebeu, a plataforma não
    //   soube, e por isso ele não tem `paid_at`. Uma janela por `paid_at`
    //   esconde exatamente o que a tela existe pra achar.
    expect(linhas.length, 'o pedido não pago ficou fora da janela').toBe(1)
    expect(pedidoDaLinha(linhas[0]).vivo).toBe(false)
  })

  it('venda sem cobrança no gateway fica fora: não há o que conferir', async () => {
    await limparPedidos()
    await pedido({ codigo: 'ZZ-REC-DINHEIRO', total: 5_000, cobranca: null,
                   pagoEm: '2026-09-10' })

    expect((await q<any>(SQL_PEDIDOS_DO_PERIODO, janela())).length,
      'dinheiro que nunca passou pelo gateway entrou na conferência').toBe(0)
  })

  it('pedido de outra organização não entra na conferência desta', async () => {
    await limparPedidos()
    await pedido({ codigo: 'ZZ-REC-VIZINHA', org: VIZINHA, evento: EVENTO_VIZINHO,
                   total: 9_900, pagoEm: '2026-09-10' })
    await pedido({ codigo: 'ZZ-REC-MINHA', total: 3_300, pagoEm: '2026-09-10' })

    const linhas = await q<any>(SQL_PEDIDOS_DO_PERIODO, janela())
    expect(linhas.map((l: any) => l.code), 'a conferência puxou pedido de outro produtor')
      .toEqual(['ZZ-REC-MINHA'])
  })

  it('o filtro de evento estreita o nosso lado de verdade', async () => {
    await limparPedidos()
    await q(`INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
             VALUES ($1,$2,'zz-rec-outro','zz-rec-outro',
                     now() - interval '10 days', now() - interval '9 days', 1000, 'ativo')
             ON CONFLICT (id) DO NOTHING`,
      ['0000a220-0000-4000-8000-000000000006', ORG])
    await pedido({ codigo: 'ZZ-REC-EV1', total: 3_300, pagoEm: '2026-09-10' })
    await pedido({ codigo: 'ZZ-REC-EV2', evento: '0000a220-0000-4000-8000-000000000006',
                   total: 7_700, pagoEm: '2026-09-10' })

    const j = lerJanela('2026-09-01', '2026-09-30')
    // ← com o filtro morto a tela diz "conferência do evento X" e mostra o
    //   caixa da organização inteira; a conta do evento fecha errada e
    //   ninguém vê, porque nada quebra
    expect((await q<any>(SQL_PEDIDOS_DO_PERIODO, [ORG, j.inicio, j.fim, EVENTO]))
      .map((l: any) => l.code)).toEqual(['ZZ-REC-EV1'])
    expect((await q<any>(SQL_PEDIDOS_DO_PERIODO, [ORG, j.inicio, j.fim, null]))
      .map((l: any) => l.code).sort()).toEqual(['ZZ-REC-EV1', 'ZZ-REC-EV2'])
  })

  it('o extrato sem credencial é cercado pela organização', async () => {
    await limparPedidos()
    await pedido({ id: '0000a220-0000-4000-8000-000000000101', codigo: 'ZZ-REC-EXT-MINHA',
                   total: 3_300, pagoEm: '2026-09-10' })
    await pedido({ id: '0000a220-0000-4000-8000-000000000102', codigo: 'ZZ-REC-EXT-VIZINHA',
                   org: VIZINHA, evento: EVENTO_VIZINHO, total: 9_900, pagoEm: '2026-09-10' })
    await aviso({ chave: 'zz-rec-ext-1', cobranca: 'sim_ZZ-REC-EXT-MINHA',
                  pedidoId: '0000a220-0000-4000-8000-000000000101',
                  status: 'RECEIVED', valorReais: 33 })
    await aviso({ chave: 'zz-rec-ext-2', cobranca: 'sim_ZZ-REC-EXT-VIZINHA',
                  pedidoId: '0000a220-0000-4000-8000-000000000102',
                  status: 'RECEIVED', valorReais: 99 })

    const j = lerJanela('2026-09-01', '2026-09-30')
    const linhas = await q<any>(SQL_EXTRATO_SIMULADO, [ORG, null, j.inicio, j.fim])
    expect(linhas.map((l: any) => l.id),
      'o extrato de um cliente mostrou cobrança de outro').toEqual(['sim_ZZ-REC-EXT-MINHA'])
  })

  it('o extrato sem credencial respeita o período escolhido na tela', async () => {
    await limparPedidos()
    await q(`DELETE FROM payment_events WHERE gateway_event_id LIKE 'zz-rec-%'`)
    // uma venda de MARÇO, com o aviso do gateway guardado
    await pedido({ id: '0000a220-0000-4000-8000-000000000111', codigo: 'ZZ-REC-MARCO',
                   total: 40_000, pagoEm: '2026-03-10', criadoEm: '2026-03-10' })
    await aviso({ chave: 'zz-rec-marco', cobranca: 'sim_ZZ-REC-MARCO',
                  pedidoId: '0000a220-0000-4000-8000-000000000111',
                  status: 'RECEIVED', valorReais: 400 })

    const j = lerJanela('2026-09-01', '2026-09-30')
    const linhas = await q<any>(SQL_EXTRATO_SIMULADO, [ORG, null, j.inicio, j.fim])
    // ← sem recorte de data o "extrato" desta fonte é o histórico INTEIRO da
    //   organização. O pedido de março volta pela chave da cobrança
    //   (SQL_PEDIDOS_POR_CHAVE) e entra em "A plataforma recebeu" e em "O
    //   gateway pagou" de um período que não é o dele: a tela promete
    //   01/09–30/09 e mostra o caixa de sempre.
    expect(linhas.map((l: any) => l.id),
      'cobrança de fora do período entrou no extrato').toEqual([])
  })
})

/* ================================================= 3. as três divergências */

/** um pedido nosso, pronto pra comparação */
const nosso = (p: Partial<PedidoNosso> & { codigo: string }): PedidoNosso => ({
  id: p.id ?? `id-${p.codigo}`,
  codigo: p.codigo,
  eventoId: p.eventoId ?? EVENTO,
  evento: p.evento ?? 'ZZ Evento',
  status: p.status ?? 'pago',
  vivo: p.vivo ?? ((p.status ?? 'pago') === 'pago' || p.status === 'estornado_parcial'),
  cobrancaId: p.cobrancaId === undefined ? `sim_${p.codigo}` : p.cobrancaId,
  totalCents: p.totalCents ?? 10_000,
  estornadoCents: p.estornadoCents ?? 0,
  pagoEm: p.pagoEm ?? null,
  criadoEm: p.criadoEm ?? null,
})

/** uma cobrança do extrato */
const cobranca = (c: {
  id: string; valorReais?: number | null; estornadoReais?: number
  status?: string; referencia?: string; apagada?: boolean
}): CobrancaDoExtrato => lerCobranca({
  id: c.id,
  value: c.valorReais === null ? undefined : c.valorReais ?? 100,
  refundedValue: c.estornadoReais,
  status: c.status ?? 'RECEIVED',
  externalReference: c.referencia,
  deleted: c.apagada,
  paymentDate: '2026-09-10',
})

describe('divergência 1: o Asaas recebeu e aqui não consta', () => {
  it('pedido expirado com cobrança recebida vira webhook perdido, com ação', () => {
    const r = comparar({
      pedidos: [nosso({ codigo: 'A', status: 'expirado', vivo: false, totalCents: 6_600 })],
      extrato: [cobranca({ id: 'sim_A', valorReais: 66 })],
      extratoCompleto: true,
    })

    expect(r.divergencias.map((d) => d.tipo)).toEqual(['webhook_perdido'])
    const d = r.divergencias[0]
    expect(d.gravidade).toBe('grave')
    expect(d.gatewayCents).toBe(6_600)
    expect(d.diferencaCents, 'a diferença precisa ser o dinheiro que só existe lá').toBe(6_600)
    // divergência sem caminho de ação é fofoca
    expect(d.acao.chave).toBe('reprocessar_evento')
    expect(d.acao.comoFazer).toContain('/api/webhooks/asaas')
    expect(r.totais.webhookPerdido).toBe(1)
  })

  it('cobrança recebida sem pedido nenhum aqui também é webhook perdido', () => {
    const r = comparar({
      pedidos: [], extrato: [cobranca({ id: 'sim_ORFA', valorReais: 120 })],
      extratoCompleto: true,
    })
    expect(r.divergencias.map((d) => d.tipo)).toEqual(['webhook_perdido'])
    expect(r.divergencias[0].pedidoId).toBe(null)
    expect(r.divergencias[0].explicacao).toMatch(/não existe pedido/i)
  })

  it('pedido PAGO com cobrança recebida não é divergência nenhuma', () => {
    const r = comparar({
      pedidos: [nosso({ codigo: 'OK', totalCents: 10_000 })],
      extrato: [cobranca({ id: 'sim_OK', valorReais: 100 })],
      extratoCompleto: true,
    })
    expect(r.divergencias).toEqual([])
    expect(r.totais.nossoCents).toBe(10_000)
    expect(r.totais.gatewayCents).toBe(10_000)
    expect(r.totais.diferencaCents).toBe(0)
  })

  it('estorno parcial batendo dos dois lados fecha sem divergência', () => {
    // O caso que o `status = 'pago'` quebrava: R$ 850 com R$ 20 devolvidos.
    const r = comparar({
      pedidos: [nosso({ codigo: 'P', status: 'estornado_parcial', vivo: true,
                        totalCents: 85_000, estornadoCents: 2_000 })],
      extrato: [cobranca({ id: 'sim_P', valorReais: 850, estornadoReais: 20,
                           status: 'PARTIALLY_REFUNDED' })],
      extratoCompleto: true,
    })
    expect(r.divergencias, JSON.stringify(r.divergencias)).toEqual([])
    expect(r.totais.nossoCents).toBe(83_000)
    expect(r.totais.gatewayCents).toBe(83_000)
  })
})

describe('divergência 2: pago aqui, sem pagamento no Asaas', () => {
  it('cobrança pendente lá com pedido pago aqui é grave', () => {
    const r = comparar({
      pedidos: [nosso({ codigo: 'B', totalCents: 4_000 })],
      extrato: [cobranca({ id: 'sim_B', valorReais: 40, status: 'PENDING' })],
      extratoCompleto: true,
    })
    expect(r.divergencias.map((d) => d.tipo)).toEqual(['sem_cobranca_no_asaas'])
    expect(r.divergencias[0].gravidade).toBe('grave')
    expect(r.divergencias[0].explicacao).toContain('PENDING')
    expect(r.divergencias[0].diferencaCents, 'o dinheiro que só existe aqui').toBe(-4_000)
    expect(r.divergencias[0].acao.chave).toBe('conferir_pedido')
  })

  it('cobrança que o gateway diz não existir é grave mesmo com extrato parcial', () => {
    const r = comparar({
      pedidos: [nosso({ codigo: 'C', totalCents: 7_000 })],
      extrato: [],
      extratoCompleto: false,
      ausentesConfirmadas: new Set(['sim_C']),
    })
    // A resposta VEIO do gateway: isso é achado, não silêncio.
    expect(r.divergencias.map((d) => d.tipo)).toEqual(['sem_cobranca_no_asaas'])
    expect(r.divergencias[0].explicacao).toMatch(/não existe/i)
  })

  it('cobrança APAGADA no Asaas com pedido pago aqui é grave', () => {
    const r = comparar({
      pedidos: [nosso({ codigo: 'D', totalCents: 5_000 })],
      extrato: [cobranca({ id: 'sim_D', valorReais: 50, status: 'RECEIVED', apagada: true })],
      extratoCompleto: true,
    })
    expect(r.divergencias.map((d) => d.tipo)).toEqual(['sem_cobranca_no_asaas'])
    expect(r.divergencias[0].explicacao).toMatch(/APAGADA/)
  })

  it('venda em dinheiro (sem cobrança nenhuma) NÃO vira divergência', () => {
    const r = comparar({
      pedidos: [nosso({ codigo: 'E', cobrancaId: null, totalCents: 5_000 })],
      extrato: [], extratoCompleto: true,
    })
    // Esse dinheiro está na gaveta do produtor. Acusar aqui seria a tela
    // chamando de sumiço o que nunca passou pela plataforma.
    expect(r.divergencias).toEqual([])
    expect(r.naoConferidos).toEqual([])
  })
})

describe('divergência 3: valor diferente', () => {
  it('estorno que o Asaas tem e o pedido não aparece com nome e ação', () => {
    const r = comparar({
      pedidos: [nosso({ codigo: 'F', totalCents: 10_000, estornadoCents: 0 })],
      extrato: [cobranca({ id: 'sim_F', valorReais: 100, estornadoReais: 30,
                           status: 'PARTIALLY_REFUNDED' })],
      extratoCompleto: true,
    })
    expect(r.divergencias.map((d) => d.tipo)).toEqual(['valor_diferente'])
    expect(r.divergencias[0].nossoCents).toBe(10_000)
    expect(r.divergencias[0].gatewayCents).toBe(7_000)
    expect(r.divergencias[0].diferencaCents).toBe(-3_000)
    expect(r.divergencias[0].explicacao).toMatch(/estorno/i)
    expect(r.divergencias[0].acao.chave).toBe('conferir_valor')
  })

  it('valor cobrado diferente também é pego', () => {
    const r = comparar({
      pedidos: [nosso({ codigo: 'G', totalCents: 10_000 })],
      extrato: [cobranca({ id: 'sim_G', valorReais: 99.9 })],
      extratoCompleto: true,
    })
    expect(r.divergencias.map((d) => d.tipo)).toEqual(['valor_diferente'])
    // reais → centavos passa por inteiro: 99.9 é 9.990, nunca 9989.999…
    expect(r.divergencias[0].gatewayCents).toBe(9_990)
    expect(r.divergencias[0].diferencaCents).toBe(-10)
  })

  it('cobrança sem valor no extrato não vira acusação de valor', () => {
    const r = comparar({
      pedidos: [nosso({ codigo: 'H', totalCents: 10_000 })],
      extrato: [cobranca({ id: 'sim_H', valorReais: null })],
      extratoCompleto: true,
    })
    // Valor ausente virando zero acusaria o pedido inteiro como diferença.
    expect(r.divergencias).toEqual([])
    expect(r.naoConferidos.map((n) => n.pedidoCodigo)).toEqual(['H'])
  })
})

/* ========================================= 4. nunca acusar o que não olhou */

describe('o que a conferência não olhou não vira acusação', () => {
  it('extrato parcial deixa o pedido em "não conferido", não em "grave"', () => {
    const r = comparar({
      pedidos: [nosso({ codigo: 'I', totalCents: 12_000 })],
      extrato: [], extratoCompleto: false,
    })
    // ← sem esta trava a tela sem credencial acusaria TODOS os pedidos do
    //   período como "pago aqui e sem cobrança lá": centenas de linhas
    //   vermelhas que não são divergência nenhuma, e a tela vira ruído.
    expect(r.divergencias, JSON.stringify(r.divergencias)).toEqual([])
    expect(r.naoConferidos.map((n) => n.pedidoCodigo)).toEqual(['I'])
    expect(r.totais.naoConferidos).toBe(1)
    expect(r.totais.conferidos).toBe(0)
  })

  it('com extrato COMPLETO o mesmo pedido é acusado', () => {
    const r = comparar({
      pedidos: [nosso({ codigo: 'I', totalCents: 12_000 })],
      extrato: [], extratoCompleto: true,
    })
    expect(r.divergencias.map((d) => d.tipo)).toEqual(['sem_cobranca_no_asaas'])
  })

  it('o teto de consultas por id aparece no motivo, não vira denúncia', () => {
    const r = comparar({
      pedidos: [nosso({ codigo: 'J', totalCents: 1_000 })],
      extrato: [], extratoCompleto: false,
      naoPerguntadas: new Set(['sim_J']),
    })
    expect(r.divergencias).toEqual([])
    expect(r.naoConferidos[0].motivo).toMatch(/teto de consultas/i)
  })

  it('cobrança que não deu pra perguntar não acusa NEM com o extrato do período completo', () => {
    // Este é o caminho que a rota percorre de verdade com credencial boa: a
    // listagem do período foi lida inteira (`extratoCompleto`), e as cobranças
    // que não apareceram nela foram perguntadas uma a uma — até o teto de
    // `MAX_CONSULTAS_POR_ID`. Quem ficou ALÉM do teto nunca foi perguntado.
    //
    // Com `naoPerguntadas` só valendo quando o extrato é parcial, esses
    // pedidos caem direto na divergência mais grave da tela ("pago aqui, sem
    // pagamento no Asaas — não transfira este valor"), sem ninguém ter
    // perguntado nada ao gateway. É a tela denunciando o que não olhou.
    const r = comparar({
      pedidos: [nosso({ codigo: 'K', totalCents: 9_000 })],
      extrato: [], extratoCompleto: true,
      naoPerguntadas: new Set(['sim_K']),
    })
    expect(r.divergencias, JSON.stringify(r.divergencias)).toEqual([])
    expect(r.naoConferidos.map((n) => n.pedidoCodigo)).toEqual(['K'])
    expect(r.naoConferidos[0].motivo).toMatch(/teto de consultas/i)
  })

  it('o tamanho do que não foi conferido sai em DINHEIRO, não só em contagem', () => {
    const r = comparar({
      pedidos: [nosso({ codigo: 'L', totalCents: 12_000 }), nosso({ codigo: 'M', totalCents: 3_000 })],
      extrato: [], extratoCompleto: false,
    })
    // Sem este número a tela mostra "Diferença −R$ 150,00" em vermelho com
    // ZERO divergência e NADA conferido: a maior acusação da tela sai
    // justamente do que ela não olhou. É ele que deixa o KPI dizer a verdade.
    expect(r.totais.naoConferidosCents).toBe(15_000)
    expect(r.totais.diferencaCents).toBe(-15_000)
  })

  it('o mesmo pedido não entra DUAS vezes em "não conferido"', () => {
    // Duas cobranças apontando para o MESMO pedido e nenhuma delas com valor
    // no extrato: a de cima pelo `asaas_payment_id` gravado no pedido, a de
    // baixo pelo `externalReference` que o próprio pedido criou. Acontece
    // quando o comprador pede um PIX novo e o gateway emite a segunda cobrança
    // com a mesma referência.
    const r = comparar({
      pedidos: [nosso({ codigo: 'DUPNC', totalCents: 9_900 })],
      extrato: [
        cobranca({ id: 'sim_DUPNC', valorReais: null }),
        cobranca({ id: 'sim_DUPNC_2', valorReais: null, referencia: 'id-DUPNC' }),
      ],
      extratoCompleto: true,
    })
    // ← sem a trava, o pedido é empilhado uma vez por cobrança: o KPI "não
    //   conferidos" conta 2 onde existe 1 pedido, `naoConferidosCents` soma
    //   R$ 198,00 de um pedido de R$ 99,00 — o tamanho do silêncio fica maior
    //   que o caixa — e `conferidos` (vivos − não conferidos) vira NEGATIVO,
    //   "-1 pedido(s) conferidos" na tela.
    expect(r.naoConferidos.map((n) => n.pedidoCodigo)).toEqual(['DUPNC'])
    expect(r.totais.naoConferidos).toBe(1)
    expect(r.totais.naoConferidosCents,
      'o dinheiro não conferido foi contado duas vezes').toBe(9_900)
    expect(r.totais.conferidos, 'contagem de conferidos ficou negativa')
      .toBeGreaterThanOrEqual(0)
  })

  it('no webhook perdido a coluna "nosso" não inventa dinheiro do pedido morto', () => {
    const r = comparar({
      pedidos: [nosso({ codigo: 'N', status: 'expirado', vivo: false, totalCents: 6_600 })],
      extrato: [cobranca({ id: 'sim_N', valorReais: 66 })],
      extratoCompleto: true,
    })
    const d = r.divergencias[0]
    // A linha tem que fechar sozinha: gateway − nosso = diferença. Com o total
    // do pedido expirado na coluna "nosso" a tela mostra 66 / 66 / 66 e quem
    // lê vê três números que não fazem a conta — e o "nosso" da linha ainda
    // discorda do KPI, que não conta pedido morto.
    expect(d.nossoCents, 'pedido expirado não é dinheiro nosso').toBe(null)
    expect((d.gatewayCents ?? 0) - (d.nossoCents ?? 0)).toBe(d.diferencaCents)
    expect(r.totais.nossoCents).toBe(0)
  })
})

/* ================================================== 5. a janela, em local */

describe('a janela é dia de calendário LOCAL', () => {
  it('o início é meia-noite daqui, não meia-noite de Londres', () => {
    const j = lerJanela('2026-09-01', '2026-09-30')
    // `new Date('2026-09-01')` nasce à meia-noite UTC — 31/08 às 21h na Bahia.
    // A conferência começaria três horas antes do que a tela promete e puxaria
    // a venda da noite anterior pra dentro do período.
    expect(j.inicio.getDate(), 'a janela começou no dia errado').toBe(1)
    expect(j.inicio.getHours(), 'a janela começou no horário errado').toBe(0)
    expect(j.inicio.getMonth()).toBe(8)
  })

  it('o fim é exclusivo: pega o último dia inteiro', () => {
    const j = lerJanela('2026-09-01', '2026-09-30')
    expect(j.fim.getDate()).toBe(1)
    expect(j.fim.getMonth(), 'o fim tem que ser 1º de outubro à meia-noite').toBe(9)
    expect(j.dias).toBe(30)
  })

  it('às 21h de Brasília "hoje" continua sendo hoje', () => {
    const j = lerJanela(undefined, undefined, new Date(2026, 8, 21, 21, 30))
    // com `toISOString().slice(0,10)` o padrão viraria 22/09 e o dia de
    // venda apareceria vazio justo no horário de pico da bilheteria
    expect(j.ate).toBe('2026-09-21')
    expect(j.de).toBe('2026-09-01')
  })

  it('período invertido é recusado com frase de gente', () => {
    expect(() => lerJanela('2026-09-30', '2026-09-01'))
      .toThrowError(/data inicial é depois/i)
  })
})

/* ====================================== 6. o transporte: erro não é achado */

describe('falar com o gateway', () => {
  it('a listagem junta as páginas e para quando não há mais', async () => {
    const paginas = [
      { hasMore: true, totalCount: 3, data: [{ id: 'p1', value: 10, status: 'RECEIVED' }] },
      { hasMore: false, totalCount: 3, data: [{ id: 'p2', value: 20, status: 'RECEIVED' }] },
    ]
    let chamadas = 0
    const r = await listarCobrancas(async () => paginas[chamadas++]!, lerJanela('2026-09-01', '2026-09-02'))
    expect(chamadas).toBe(2)
    expect(r.cobrancas.map((c) => c.id)).toEqual(['p1', 'p2'])
    expect(r.truncado).toBe(false)
  })

  it('período grande demais volta truncado, e não como conferência completa', async () => {
    const r = await listarCobrancas(
      async () => ({ hasMore: true, totalCount: 9_999,
                     data: [{ id: `x`, value: 1, status: 'RECEIVED' }] }),
      lerJanela('2026-01-01', '2026-12-31'))
    // ← a tela precisa DIZER que não leu tudo; o que sobrou não foi conferido
    expect(r.truncado, 'a conferência se disse completa sem ler o período inteiro').toBe(true)
  })

  it('404 do gateway é achado; erro de rede NÃO é', async () => {
    const { ErroDoExtrato } = await import('./reconciliacao')
    const r = await conferirPorId(async (caminho) => {
      if (caminho.includes('some')) throw new ErroDoExtrato(404, 'Asaas: HTTP 404')
      throw new Error('ECONNREFUSED 127.0.0.1:443')
    }, ['some', 'rede'])

    expect([...r.ausentes], 'a resposta "não existe" precisa virar achado').toEqual(['some'])
    // ← e a queda de rede NÃO pode virar "o Asaas não conhece esta cobrança":
    //   seria a tela acusando o produtor por causa do wi-fi do escritório
    expect([...r.naoPerguntadas]).toEqual(['rede'])
    expect(r.erro).toMatch(/ECONNREFUSED/)
  })

  it('a consulta por id para no teto, e o que sobrou sai como NÃO perguntado', async () => {
    const ids = Array.from({ length: MAX_CONSULTAS_POR_ID + 5 }, (_, i) => `c${i}`)
    let perguntas = 0
    const r = await conferirPorId(async () => {
      perguntas++
      return { id: `c${perguntas}`, value: 1, status: 'RECEIVED' }
    }, ids)
    // Sem teto, um período largo vira milhares de chamadas em sequência e a
    // tela pendura. COM teto, o que sobra precisa sair identificado — é esse
    // conjunto que impede a rota de acusar quem ela nunca perguntou.
    expect(perguntas, 'a conferência perguntou sem teto').toBe(MAX_CONSULTAS_POR_ID)
    expect(r.naoPerguntadas.size).toBe(5)
    expect([...r.naoPerguntadas]).toEqual(ids.slice(MAX_CONSULTAS_POR_ID))
    expect(r.ausentes.size, 'não perguntar não é "o gateway disse que não existe"').toBe(0)
  })
})

/* ============================================== 7. a rota, de ponta a ponta */

describe('a rota de reconciliação', () => {
  const chamar = (busca: string) =>
    fetch(`${BASE}/api/admin/reconciliacao${busca}`,
      { headers: { cookie, origin: BASE } })

  /** o mesmo GET, com o cabeçalho que só o clique na tela manda */
  const registrar = (busca: string) =>
    fetch(`${BASE}/api/admin/reconciliacao${busca}`,
      { headers: { cookie, origin: BASE, 'x-diamond-conferencia': '1' } })

  const conferenciasGravadas = async () => Number((await q1<any>(
    `SELECT count(*)::int AS n FROM reconciliation_runs WHERE org_id = $1`, [ORG]))?.n ?? 0)

  it('acha as três divergências pelo aviso guardado e grava a conferência', async (ctx) => {
    seForaDoArPula(ctx)
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()

    await limparPedidos()
    await q(`DELETE FROM payment_events WHERE gateway_event_id LIKE 'zz-rec-%'`)

    const ontem = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19).replace('T', ' ')

    // 1) webhook perdido: o gateway recebeu, o pedido segue expirado
    await pedido({ id: '0000a220-0000-4000-8000-000000000201', codigo: 'ZZ-REC-R1',
                   status: 'expirado', total: 6_600, criadoEm: ontem })
    await aviso({ chave: 'zz-rec-r1', cobranca: 'sim_ZZ-REC-R1',
                  pedidoId: '0000a220-0000-4000-8000-000000000201',
                  status: 'RECEIVED', valorReais: 66, erro: 'banco fora no meio' })

    // 2) pago aqui, cobrança pendente lá
    await pedido({ id: '0000a220-0000-4000-8000-000000000202', codigo: 'ZZ-REC-R2',
                   total: 4_000, pagoEm: ontem, criadoEm: ontem })
    await aviso({ chave: 'zz-rec-r2', cobranca: 'sim_ZZ-REC-R2',
                  pedidoId: '0000a220-0000-4000-8000-000000000202',
                  evento: 'PAYMENT_OVERDUE', status: 'PENDING', valorReais: 40 })

    // 3) valor diferente: o Asaas devolveu R$ 30 e o pedido não sabe
    await pedido({ id: '0000a220-0000-4000-8000-000000000203', codigo: 'ZZ-REC-R3',
                   total: 10_000, pagoEm: ontem, criadoEm: ontem })
    await aviso({ chave: 'zz-rec-r3', cobranca: 'sim_ZZ-REC-R3',
                  pedidoId: '0000a220-0000-4000-8000-000000000203',
                  evento: 'PAYMENT_PARTIALLY_REFUNDED', status: 'PARTIALLY_REFUNDED',
                  valorReais: 100, estornadoReais: 30 })

    const hoje = new Date()
    const dia = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const r = await chamar(
      `?de=${dia(new Date(Date.now() - 3 * 86_400_000))}&ate=${dia(hoje)}`)
    expect(r.status).toBe(200)
    const corpo = await r.json()

    const tipos = corpo.divergencias.map((d: any) => d.tipo).sort()
    expect(tipos, JSON.stringify(corpo.divergencias, null, 1))
      .toEqual(['sem_cobranca_no_asaas', 'valor_diferente', 'webhook_perdido'])

    // sem credencial, a tela DIZ que a fonte é o gateway simulado
    expect(corpo.fonte.tipo).toBe('simulado')
    expect(corpo.fonte.completa).toBe(false)
    expect(corpo.fonte.aviso, 'a tela não avisou que o extrato não é o do Asaas')
      .toMatch(/gateway simulado/i)

    // o aviso guardado vira instrução: a linha diz que o evento está preso
    const perdido = corpo.divergencias.find((d: any) => d.tipo === 'webhook_perdido')
    expect(perdido.aviso?.processado).toBe(false)
    expect(perdido.aviso?.erro).toMatch(/banco fora/)
    expect(perdido.acao.rotulo).toBeTruthy()

    // sem extrato do Asaas de verdade, o veredito não deixa a tela se dizer
    // conferida — é ele que decide a cor do número maior
    expect(corpo.veredito.conferido).toBe(false)
    expect(corpo.veredito.tom).not.toBe('ok')

    // e a conferência ficou registrada QUANDO alguém registrou: é o que
    // responde "quando bateu?". A leitura de cima não gravou nada.
    const so_olhou = await conferenciasGravadas()
    const depois = await registrar(
      `?de=${dia(new Date(Date.now() - 3 * 86_400_000))}&ate=${dia(hoje)}&registrar=1`)
    expect(depois.status).toBe(200)
    expect((await depois.json()).registro.gravado).toBe(true)
    expect(await conferenciasGravadas()).toBe(so_olhou + 1)

    const registro = await q1<any>(
      `SELECT source, webhook_missing, charge_missing, amount_mismatch, duplicate_charge,
              ran_by_email
         FROM reconciliation_runs WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1`, [ORG])
    expect(registro?.source).toBe('simulado')
    expect(registro?.ran_by_email).toBe(EMAIL)
    expect([registro?.webhook_missing, registro?.charge_missing, registro?.amount_mismatch])
      .toEqual([1, 1, 1])
    expect(registro?.duplicate_charge).toBe(0)
  }, 40_000)

  it('OLHAR não grava conferência nenhuma', async (ctx) => {
    seForaDoArPula(ctx)
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()

    const antes = await conferenciasGravadas()
    // duas leituras porque é o que UMA abertura de tela faz com `useFetch`:
    // uma no servidor e outra na hidratação. Medido: 14 linhas viraram 16.
    await chamar('?de=2026-09-01&ate=2026-09-30')
    await chamar('?de=2026-09-01&ate=2026-09-30')
    // ← com o INSERT no caminho da leitura, o cartão "última conferência em…"
    //   passa a mostrar VOCÊ de cinco segundos atrás, e o livro perde o único
    //   dado que ele tinha pra dar: quando alguém conferiu de verdade.
    expect(await conferenciasGravadas(),
      'abrir a tela gravou conferência no livro').toBe(antes)
  }, 30_000)

  it('registrar sem o cabeçalho da tela não grava, e diz por quê', async (ctx) => {
    seForaDoArPula(ctx)
    const antes = await conferenciasGravadas()
    // uma navegação vinda de outro site leva o cookie (SameSite=Lax) e NÃO
    // consegue mandar cabeçalho: não pode carimbar conferência em nome de
    // quem clicou
    const r = await chamar('?de=2026-09-01&ate=2026-09-30&registrar=1')
    expect(r.status).toBe(200)
    const corpo = await r.json()
    expect(corpo.registro.gravado).toBe(false)
    expect(corpo.registro.porque, 'falha muda: não gravou e não disse nada').toBeTruthy()
    expect(await conferenciasGravadas()).toBe(antes)
  }, 30_000)

  it('o registro explícito carimba autor, período e fonte — uma linha por clique', async (ctx) => {
    seForaDoArPula(ctx)
    const antes = await conferenciasGravadas()
    const r = await registrar('?de=2026-09-01&ate=2026-09-30&registrar=1')
    const corpo = await r.json()
    expect(corpo.registro.gravado).toBe(true)
    expect(corpo.registro.quando).toBeTruthy()
    expect(await conferenciasGravadas()).toBe(antes + 1)

    const linha = await q1<any>(
      `SELECT ran_by_email, period_start, period_end, source
         FROM reconciliation_runs WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1`, [ORG])
    expect(linha?.ran_by_email).toBe(EMAIL)
    expect(linha?.source).toBe('simulado')
    // o período guardado é o da tela, em dia de calendário
    expect(diaLocal(new Date(linha!.period_start))).toBe('2026-09-01')
    expect(diaLocal(new Date(linha!.period_end))).toBe('2026-09-30')
    // o cartão de memória volta com o dia de calendário, e não com o instante
    // UTC que faria "01/09" aparecer como 31/08
    expect(corpo.ultimaConferencia?.de).toBe('2026-09-01')
    expect(corpo.ultimaConferencia?.ate).toBe('2026-09-30')
    expect(corpo.ultimaConferencia?.por).toBe(EMAIL)
  }, 30_000)

  it('não mostra pedido de outra organização', async (ctx) => {
    seForaDoArPula(ctx)
    await limparPedidos()
    const ontem = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
    await pedido({ codigo: 'ZZ-REC-ALHEIO', org: VIZINHA, evento: EVENTO_VIZINHO,
                   total: 50_000, pagoEm: ontem, criadoEm: ontem })

    const corpo = await (await chamar('')).json()
    expect(corpo.totais.nossoCents, 'o caixa do vizinho entrou nesta conferência').toBe(0)
    expect(corpo.divergencias).toEqual([])
  }, 20_000)

  it('evento de outra organização no filtro responde 404, e não o dado', async (ctx) => {
    seForaDoArPula(ctx)
    // O middleware de organização cerca `/api/admin/evento/:id` pela URL —
    // aqui o evento vem como FILTRO, e a cerca é da rota.
    const r = await chamar(`?eventoId=${EVENTO_VIZINHO}`)
    expect(r.status).toBe(404)
  }, 20_000)

  it('período invertido devolve frase, não erro de banco', async (ctx) => {
    seForaDoArPula(ctx)
    const r = await chamar('?de=2026-09-30&ate=2026-09-01')
    expect(r.status).toBe(400)
    expect((await r.json()).statusMessage ?? '').toMatch(/data inicial é depois/i)
  }, 20_000)
})

/* ============================ 8. a mesma cobrança em mais de um pedido */

describe('duas vendas na mesma cobrança', () => {
  it('a segunda venda é NOMEADA, e não vira frase que se contradiz', () => {
    const r = comparar({
      pedidos: [
        nosso({ codigo: 'DUP-A', totalCents: 10_000 }),
        nosso({ codigo: 'DUP-B', cobrancaId: 'sim_DUP-A', totalCents: 10_000 }),
      ],
      extrato: [cobranca({ id: 'sim_DUP-A', valorReais: 100 })],
      extratoCompleto: true,
    })

    // ← com um pedido por cobrança no mapa, a segunda venda sumia do laço do
    //   gateway, caía no último ramo do nosso laço — o que existe pra cobrança
    //   SEM dinheiro — e saía como GRAVE dizendo: o Asaas diz "RECEIVED", o
    //   dinheiro não entrou. As duas metades da frase se negam.
    expect(r.divergencias.map((d) => d.tipo), JSON.stringify(r.divergencias, null, 1))
      .toEqual(['cobranca_repetida'])
    const d = r.divergencias[0]
    expect(d.gravidade).toBe('grave')
    expect(d.explicacao, 'a linha precisa nomear os DOIS pedidos').toContain('DUP-A')
    expect(d.explicacao).toContain('DUP-B')
    expect(d.acao.chave).toBe('conferir_duplicidade')
    // o dinheiro entrou uma vez e está contado duas: a linha fecha sozinha
    expect(d.gatewayCents).toBe(10_000)
    expect(d.nossoCents).toBe(20_000)
    expect(d.diferencaCents).toBe(-10_000)
    expect(r.totais.cobrancaRepetida).toBe(1)
  })

  it('nenhuma linha diz que o dinheiro não entrou numa cobrança RECEBIDA', () => {
    // A varredura é de propósito mais larga que o caso de cima: a frase
    // impossível pode nascer de qualquer ramo que misture "o gateway recebeu"
    // com "o dinheiro não entrou".
    const cenarios = [
      comparar({
        pedidos: [nosso({ codigo: 'X1' }), nosso({ codigo: 'X2', cobrancaId: 'sim_X1' })],
        extrato: [cobranca({ id: 'sim_X1', valorReais: 100 })], extratoCompleto: true,
      }),
      comparar({
        pedidos: [
          nosso({ codigo: 'Y1', status: 'expirado', vivo: false }),
          nosso({ codigo: 'Y2', cobrancaId: 'sim_Y1' }),
        ],
        extrato: [cobranca({ id: 'sim_Y1', valorReais: 100, status: 'CONFIRMED' })],
        extratoCompleto: true,
      }),
      comparar({
        pedidos: [nosso({ id: 'ped-Z', codigo: 'Z1' }), nosso({ codigo: 'Z2', cobrancaId: 'sim_Z1' })],
        extrato: [cobranca({ id: 'sim_Z1', valorReais: 100, referencia: 'ped-Z' })],
        extratoCompleto: true,
      }),
    ]
    for (const r of cenarios) {
      for (const d of r.divergencias) {
        const recebida = d.statusNoGateway === 'RECEIVED' || d.statusNoGateway === 'CONFIRMED'
        expect(recebida && /dinheiro não entrou/.test(d.explicacao),
          `linha que se contradiz: "${d.explicacao}"`).toBe(false)
      }
    }
  })

  it('o banco não deixa mais duas vendas apontarem pra mesma cobrança', async () => {
    await limparPedidos()
    await pedido({ codigo: 'ZZ-REC-UNICO-1', total: 10_000, cobranca: 'sim_ZZ_UNICO',
                   pagoEm: '2026-09-10' })
    // ← sem o índice único de db/025 a segunda venda entra, o webhook escolhe
    //   `rows[0]` no escuro e o mesmo dinheiro é somado duas vezes no borderô
    await expect(
      pedido({ codigo: 'ZZ-REC-UNICO-2', total: 10_000, cobranca: 'sim_ZZ_UNICO',
               pagoEm: '2026-09-10' }),
    ).rejects.toThrow(/orders_asaas_payment_unico|duplicate key|duplicada/i)

    // e a venda em dinheiro (sem cobrança) continua podendo repetir o NULL
    await pedido({ codigo: 'ZZ-REC-GAVETA-1', total: 5_000, cobranca: null })
    await pedido({ codigo: 'ZZ-REC-GAVETA-2', total: 5_000, cobranca: null })
    expect((await q<any>(
      `SELECT code FROM orders WHERE org_id = $1 AND asaas_payment_id IS NULL`, [ORG])).length)
      .toBe(2)
  })
})

/* ================= 9. o aviso guardado é cercado pela organização, na consulta */

describe('o aviso guardado não atravessa a cerca do produtor', () => {
  it('a consulta não devolve o aviso de outro produtor nem quando perguntam por ele', async () => {
    await limparPedidos()
    await q(`DELETE FROM payment_events WHERE gateway_event_id LIKE 'zz-rec-%'`)

    await pedido({ id: '0000a220-0000-4000-8000-000000000301', codigo: 'ZZ-REC-AV-MINHA',
                   total: 3_300, pagoEm: '2026-09-10' })
    await pedido({ id: '0000a220-0000-4000-8000-000000000302', codigo: 'ZZ-REC-AV-VIZINHA',
                   org: VIZINHA, evento: EVENTO_VIZINHO, total: 9_900, pagoEm: '2026-09-10' })
    await aviso({ chave: 'zz-rec-av-1', cobranca: 'sim_ZZ-REC-AV-MINHA',
                  pedidoId: '0000a220-0000-4000-8000-000000000301',
                  status: 'RECEIVED', valorReais: 33 })
    await aviso({ chave: 'zz-rec-av-2', cobranca: 'sim_ZZ-REC-AV-VIZINHA',
                  pedidoId: '0000a220-0000-4000-8000-000000000302',
                  status: 'RECEIVED', valorReais: 99, erro: 'erro interno do vizinho' })

    const ids = ['sim_ZZ-REC-AV-MINHA', 'sim_ZZ-REC-AV-VIZINHA']
    const linhas = await q<any>(SQL_AVISOS_GUARDADOS, [ids, ORG])
    // ← sem a cerca DENTRO da consulta, quem manda a lista de ids manda no que
    //   sai: o payload, o erro e a trilha de webhook do vizinho aparecem nesta
    //   tela. Defesa que mora no chamador não é defesa.
    expect(linhas.map((l: any) => l.external_id),
      'o aviso do vizinho entrou nesta conferência').toEqual(['sim_ZZ-REC-AV-MINHA'])

    // e a cerca vale dos dois lados: o vizinho enxerga o dele
    const doVizinho = await q<any>(SQL_AVISOS_GUARDADOS, [ids, VIZINHA])
    expect(doVizinho.map((l: any) => l.external_id)).toEqual(['sim_ZZ-REC-AV-VIZINHA'])
  })

  it('o aviso que só o order_id liga ao pedido continua aparecendo', async () => {
    await limparPedidos()
    await q(`DELETE FROM payment_events WHERE gateway_event_id LIKE 'zz-rec-%'`)
    // cobrança achada por externalReference: o id nunca foi parar no pedido
    await pedido({ id: '0000a220-0000-4000-8000-000000000311', codigo: 'ZZ-REC-AV-REF',
                   total: 3_300, cobranca: null, pagoEm: '2026-09-10' })
    await aviso({ chave: 'zz-rec-av-ref', cobranca: 'pay_so_no_evento',
                  pedidoId: '0000a220-0000-4000-8000-000000000311',
                  status: 'RECEIVED', valorReais: 33 })

    const linhas = await q<any>(SQL_AVISOS_GUARDADOS, [['pay_so_no_evento'], ORG])
    // ← uma cerca só por `asaas_payment_id` calaria justamente a linha que
    //   transforma "reprocessar o aviso" de conselho em instrução
    expect(linhas.map((l: any) => l.external_id)).toEqual(['pay_so_no_evento'])
  })
})

/* ================== 10. sem extrato de verdade a tela não se diz conferida */

describe('o veredito da conferência', () => {
  it('gateway simulado NUNCA fecha, nem com zero divergência', () => {
    const v = vereditoDaConferencia({
      fonte: 'simulado', completa: false, erro: null, naoConferidos: 0, divergencias: 0,
    })
    // ← medido na tela antes do conserto: "Divergências 0" em text-ok,
    //   rgb(18,128,92), com 213 de 213 pedidos sem conferir. O verde é uma
    //   afirmação, e a afirmação era falsa.
    expect(v.conferido, 'o gateway simulado não é o extrato do Asaas').toBe(false)
    expect(v.tom).not.toBe('ok')
    expect(v.selo).toMatch(/simulado/i)
  })

  it('pedido sem conferir derruba o "fecha" mesmo com o Asaas de verdade', () => {
    const v = vereditoDaConferencia({
      fonte: 'asaas', completa: true, erro: null, naoConferidos: 3, divergencias: 0,
    })
    expect(v.conferido).toBe(false)
    expect(v.selo).toMatch(/3 pedido/)
  })

  it('erro do gateway e falta de fonte são o tom mais forte', () => {
    expect(vereditoDaConferencia({ fonte: 'asaas', completa: false, erro: 'HTTP 401',
                                   naoConferidos: 0, divergencias: 0 }).tom).toBe('erro')
    expect(vereditoDaConferencia({ fonte: 'indisponivel', completa: false, erro: null,
                                   naoConferidos: 0, divergencias: 0 }).tom).toBe('erro')
  })

  it('só o extrato do Asaas inteiro e sem sobra autoriza dizer que fecha', () => {
    const v = vereditoDaConferencia({
      fonte: 'asaas', completa: true, erro: null, naoConferidos: 0, divergencias: 0,
    })
    expect(v.conferido).toBe(true)
    expect(v.tom).toBe('ok')
  })

  it('conferiu de verdade e achou divergência não é verde', () => {
    const v = vereditoDaConferencia({
      fonte: 'asaas', completa: true, erro: null, naoConferidos: 0, divergencias: 2,
    })
    expect(v.conferido).toBe(true)
    expect(v.tom).toBe('erro')
    expect(v.selo).toMatch(/2 divergência/)
  })
})

/* ------------------------------------------------------------ vocabulário */

describe('o catálogo das divergências', () => {
  it('toda divergência tem rótulo, explicação e caminho de ação', () => {
    for (const [tipo, c] of Object.entries(CATALOGO)) {
      expect(c.rotulo, `${tipo} sem rótulo`).toBeTruthy()
      expect(c.oQueE.length, `${tipo} sem explicação`).toBeGreaterThan(40)
      expect(c.acao.rotulo, `${tipo} sem ação`).toBeTruthy()
      expect(c.acao.comoFazer.length, `${tipo} sem instrução`).toBeGreaterThan(40)
    }
  })
})
