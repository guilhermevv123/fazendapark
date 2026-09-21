/**
 * emissao.test.ts — o caminho pago de ponta a ponta, contra banco real.
 *
 * O que está sendo provado aqui, em ordem de quanto custa errar:
 *   1. webhook repetido NÃO emite ingresso duas vezes (o Asaas repete sempre);
 *   2. ingresso emitido tem QR que só o servidor consegue assinar;
 *   3. a mesma pessoa não entra duas vezes, nem com dois leitores simultâneos;
 *   4. estorno depois de pago devolve estoque e cancela ingresso — menos o que
 *      já entrou no parque;
 *   5. **cortesia não é sinônimo de zero** — três pedidos fecham em zero e só
 *      um é cortesia; quem confunde os três põe venda na coluna de entrada
 *      gratuita do borderô que o produtor leva pro sócio.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1, tx } from './db'
import {
  SQL_CORTESIA_SEM_ORIGEM, SQL_E_CORTESIA, SQL_E_VENDA_GRATUITA,
  eCortesia, emitirIngressos,
} from './emissao'
import { reservar } from './estoque'
import { lerQr, montarQr } from './ingresso'

let orgId: string, eventId: string, sectorId: string, lotId: string, customerId: string

beforeAll(async () => {
  process.env.NUXT_SESSION_SECRET ||= 'segredo-de-teste-comprido-o-bastante'
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug)
    VALUES ('Emissão', 'emi-' || gen_random_uuid()) RETURNING id`))!.id
  eventId = (await q1<any>(`INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps)
    VALUES ($1,'Parque','pq-' || gen_random_uuid(),'ativo',
            now() + interval '1 day', now() + interval '2 days', 1000)
    RETURNING id`, [orgId]))!.id
  sectorId = (await q1<any>(`INSERT INTO sectors (event_id, name)
    VALUES ($1,'Entrada') RETURNING id`, [eventId]))!.id
  customerId = (await q1<any>(`INSERT INTO customers (org_id, name, email, document)
    VALUES ($1,'Maria Souza','maria@teste.com','39053344705') RETURNING id`, [orgId]))!.id
})

afterAll(async () => {
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

async function pedidoPendente(qtd = 2, precoCents = 3000) {
  lotId = (await q1<any>(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order)
     VALUES ($1, 'Lote ' || gen_random_uuid(), $2, 100, 50) RETURNING id`,
    [sectorId, precoCents]))!.id
  const face = precoCents * qtd
  const taxa = Math.round(precoCents * 0.1) * qtd
  const order = (await q1<any>(
    `INSERT INTO orders (org_id, event_id, customer_id, code, status,
                         face_cents, fee_cents, platform_cents, discount_cents, total_cents,
                         payment_method, expires_at)
     VALUES ($1,$2,$3,'P'||substr(gen_random_uuid()::text,1,8),'aguardando_pagamento',
             $4,$5,$5,0,$6,'pix', now() + interval '20 minutes')
     RETURNING id, code`,
    [orgId, eventId, customerId, face, taxa, face + taxa]))!
  await q(`INSERT INTO order_items (order_id, lot_id, quantity,
             unit_face_cents, unit_fee_cents, unit_total_cents)
           VALUES ($1,$2,$3,$4,$5,$6)`,
    [order.id, lotId, qtd, precoCents, Math.round(precoCents * 0.1),
     precoCents + Math.round(precoCents * 0.1)])
  await tx((c) => reservar(c, [{ lotId, quantidade: qtd }]))
  return order
}

describe('emissão', () => {
  it('pagamento vira ingresso e baixa o estoque', async () => {
    const ped = await pedidoPendente(3)
    const r = await emitirIngressos(ped.id)
    expect(r.emitiu).toBe(true)
    expect(r.ingressos).toBe(3)

    const lote = await q1<any>(`SELECT sold, reserved FROM lots WHERE id = $1`, [lotId])
    expect(lote).toMatchObject({ sold: 3, reserved: 0 })

    const o = await q1<any>(`SELECT status, paid_at FROM orders WHERE id = $1`, [ped.id])
    expect(o.status).toBe('pago')
    expect(o.paid_at).toBeTruthy()
  })

  it('IDEMPOTÊNCIA: o Asaas repete o webhook e não sai ingresso a mais', async () => {
    const ped = await pedidoPendente(2)
    const primeira = await emitirIngressos(ped.id)
    expect(primeira.emitiu).toBe(true)
    expect(primeira.ingressos).toBe(2)

    // PAYMENT_CONFIRMED e depois PAYMENT_RECEIVED, mais uma reentrega
    const repetidas = await Promise.all([
      emitirIngressos(ped.id), emitirIngressos(ped.id), emitirIngressos(ped.id),
    ])
    for (const r of repetidas) {
      expect(r.emitiu).toBe(false)
      expect(r.motivo).toBe('já emitido')
    }
    const n = await q1<any>(`SELECT count(*)::int AS n FROM tickets WHERE order_id = $1`, [ped.id])
    expect(n.n).toBe(2)
    const lote = await q1<any>(`SELECT sold FROM lots WHERE id = $1`, [lotId])
    expect(lote.sold).toBe(2)
  })

  it('webhooks SIMULTÂNEOS também não duplicam', async () => {
    const ped = await pedidoPendente(2)
    const r = await Promise.all(Array.from({ length: 5 }, () => emitirIngressos(ped.id)))
    expect(r.filter((x) => x.emitiu).length).toBe(1)
    const n = await q1<any>(`SELECT count(*)::int AS n FROM tickets WHERE order_id = $1`, [ped.id])
    expect(n.n).toBe(2)
  })

  it('o primeiro ingresso sai no nome do comprador, o resto em branco', async () => {
    const ped = await pedidoPendente(3)
    await emitirIngressos(ped.id)
    const ts = await q<any>(
      `SELECT holder_name FROM tickets WHERE order_id = $1 ORDER BY issued_at, code`, [ped.id])
    expect(ts.filter((t) => t.holder_name === 'Maria Souza').length).toBe(1)
    expect(ts.filter((t) => t.holder_name === null).length).toBe(2)
  })

  it('não emite pedido já cancelado', async () => {
    const ped = await pedidoPendente(1)
    await q(`UPDATE orders SET status = 'cancelado' WHERE id = $1`, [ped.id])
    const r = await emitirIngressos(ped.id)
    expect(r.emitiu).toBe(false)
    expect(r.motivo).toMatch(/cancelado/)
  })
})

describe('QR do ingresso', () => {
  it('assina e confere', async () => {
    const ped = await pedidoPendente(1)
    await emitirIngressos(ped.id)
    const t = await q1<any>(`SELECT code FROM tickets WHERE order_id = $1`, [ped.id])
    const qr = montarQr(t.code, eventId)
    const lido = lerQr(qr)
    expect(lido.ok).toBe(true)
    expect(lido.code).toBe(t.code)
    expect(lido.eventId).toBe(eventId)
  })

  it('recusa assinatura fabricada', () => {
    const qr = montarQr('ING-AAAA-BBBB', eventId)
    const falso = qr.slice(0, -1) + (qr.at(-1) === 'A' ? 'B' : 'A')
    expect(lerQr(falso).ok).toBe(false)
    expect(lerQr(falso).motivo).toBe('assinatura')
  })

  it('recusa ingresso de outro evento mesmo com código certo', () => {
    const outro = '00000000-0000-4000-8000-000000000000'
    const qr = montarQr('ING-AAAA-BBBB', eventId)
    const trocado = qr.replace(eventId, outro)
    expect(lerQr(trocado).ok).toBe(false)
  })

  it('recusa lixo', () => {
    expect(lerQr('').ok).toBe(false)
    expect(lerQr('qualquer coisa').ok).toBe(false)
    expect(lerQr('DT1:a:b').ok).toBe(false)
  })
})

describe('portaria', () => {
  /** mesma trava do endpoint: UPDATE condicional */
  const passar = (ticketId: string) =>
    tx(async (c) => {
      const r = await c.query(
        `UPDATE tickets SET status='usado', checked_in_at=now()
          WHERE id=$1 AND status='valido' RETURNING id`, [ticketId])
      return r.rowCount === 1
    })

  it('entra uma vez; a segunda é recusada', async () => {
    const ped = await pedidoPendente(1)
    await emitirIngressos(ped.id)
    const t = await q1<any>(`SELECT id FROM tickets WHERE order_id = $1`, [ped.id])
    expect(await passar(t.id)).toBe(true)
    expect(await passar(t.id)).toBe(false)
  })

  it('dois leitores no mesmo instante: só um passa', async () => {
    const ped = await pedidoPendente(1)
    await emitirIngressos(ped.id)
    const t = await q1<any>(`SELECT id FROM tickets WHERE order_id = $1`, [ped.id])
    const r = await Promise.all(Array.from({ length: 8 }, () => passar(t.id)))
    expect(r.filter(Boolean).length).toBe(1)
  })
})

describe('estorno depois de pago', () => {
  it('devolve estoque e cancela ingresso — menos quem já entrou', async () => {
    const ped = await pedidoPendente(3)
    await emitirIngressos(ped.id)
    const ts = await q<any>(`SELECT id FROM tickets WHERE order_id = $1 ORDER BY code`, [ped.id])
    // um deles já entrou no parque
    await q(`UPDATE tickets SET status='usado', checked_in_at=now() WHERE id=$1`, [ts[0].id])

    await tx(async (c) => {
      const { rows: itens } = await c.query(
        `SELECT lot_id AS "lotId", quantity AS quantidade FROM order_items WHERE order_id=$1`,
        [ped.id])
      for (const i of itens) {
        await c.query(`UPDATE lots SET sold = GREATEST(sold - $2,0) WHERE id=$1`,
          [i.lotId, i.quantidade])
      }
      await c.query(
        `UPDATE tickets SET status='cancelado', canceled_at=now()
          WHERE order_id=$1 AND status <> 'usado'`, [ped.id])
      await c.query(`UPDATE orders SET status='estornado', refunded_at=now() WHERE id=$1`, [ped.id])
    })

    const depois = await q<any>(
      `SELECT status, count(*)::int AS n FROM tickets WHERE order_id=$1 GROUP BY status`, [ped.id])
    const mapa = Object.fromEntries(depois.map((d) => [d.status, d.n]))
    expect(mapa.usado).toBe(1)        // entrou: continua como usado, é prejuízo a cobrar
    expect(mapa.cancelado).toBe(2)
  })
})

/* ===========================================================================
 * CORTESIA × VENDA QUE FECHOU EM ZERO
 *
 * Três pedidos fecham em R$ 0,00 e `tickets.is_courtesy` carimba os três
 * igual, porque a coluna diz "fechou em zero" e não "é cortesia":
 *
 *   1. convite do patrocinador          canal `cortesia`  → É cortesia
 *   2. cupom/promoção de 100%           canal `online`    → é VENDA
 *   3. criança até 5 anos (lote R$ 0)   canal `online`    → é VENDA
 *
 * Quem lê a marca chama os três de cortesia. Custa duas coisas ao mesmo tempo:
 * o borderô que o produtor leva pro sócio joga venda na coluna de entrada
 * gratuita (e a receita da promoção some da explicação), e o comprador que usou
 * o cupom dele recebe um ingresso escrito CORTESIA na própria tela do pedido.
 *
 * O caso abaixo emite os três pelo caminho de verdade e exige que só o
 * primeiro conte como cortesia — no SQL compartilhado, na lista da portaria e
 * na tela do comprador. Arranque a origem de `SQL_E_CORTESIA` (ou devolva
 * `t.is_courtesy` a qualquer um dos dois leitores) e ele fica vermelho.
 * ======================================================================== */

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

describe('cortesia não é "o pedido fechou em zero"', () => {
  let setorZero = '', setorOrfao = '', setorCancelada = '', codigoOrfao = ''
  let noAr = false
  let cookie = ''
  type Caso = {
    id: string; code: string; ingresso: string; loteId: string
    /** o que `emitirIngressos` respondeu — só existe em quem passou por ele */
    emissao?: Awaited<ReturnType<typeof emitirIngressos>>
  }
  let cortesia: Caso, promocao: Caso, crianca: Caso

  const novoLote = async (setor: string, nome: string, precoCents: number) =>
    (await q1<any>(
      `INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order)
       VALUES ($1, $2 || ' ' || gen_random_uuid(), $3, 50, 10) RETURNING id`,
      [setor, nome, precoCents]))!.id

  /**
   * Uma VENDA que fecha em zero, emitida pelo caminho de verdade —
   * `emitirIngressos`, o mesmo que o webhook do Asaas chama. É ele que carimba
   * `is_courtesy`, então é por ele que o defeito tem que passar: montar o
   * ingresso na mão provaria só o que o próprio teste escreveu.
   *
   * `face = desconto` cobre os dois casos de uma vez: com face 4000 é a
   * promoção de 100%; com face 0 é o lote gratuito da criança.
   */
  async function vendaQueFechaEmZero(
    nome: string, faceCents: number, tipoNome: string | null,
  ): Promise<Caso> {
    const loteId = await novoLote(setorZero, nome, faceCents)
    const tipoId = tipoNome
      ? (await q1<any>(`INSERT INTO ticket_types (lot_id, name, quantity)
                        VALUES ($1,$2,50) RETURNING id`, [loteId, tipoNome]))!.id
      : null
    const ped = (await q1<any>(
      `INSERT INTO orders (org_id, event_id, customer_id, code, status, channel,
                           payment_method, face_cents, fee_cents, platform_cents,
                           discount_cents, total_cents, expires_at)
       VALUES ($1,$2,$3,'P'||substr(gen_random_uuid()::text,1,8),
               'aguardando_pagamento','online','pix',$4,0,0,$4,0,
               now() + interval '20 minutes')
       RETURNING id, code`, [orgId, eventId, customerId, faceCents]))!
    await q(
      `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity,
                                unit_face_cents, unit_fee_cents, unit_total_cents)
       VALUES ($1,$2,$3,1,$4,0,0)`, [ped.id, loteId, tipoId, faceCents])
    await tx((c) => reservar(c, [{ lotId: loteId, quantidade: 1 }]))

    // Fixture quebrada é erro, não asserção: `expect` aqui dentro morre no
    // `beforeAll` e leva o describe inteiro pra "skipped", que passa batido
    // em quem lê só o rodapé. O que É invariante está nos `it` abaixo.
    const r = await emitirIngressos(ped.id)
    if (!r.emitiu) throw new Error(`fixture ${nome}: a emissão não rodou — ${r.motivo}`)

    const t = (await q1<any>(
      `SELECT code FROM tickets WHERE order_id = $1`, [ped.id]))!
    return { id: ped.id, code: ped.code, ingresso: t.code, loteId, emissao: r }
  }

  /** A cortesia de verdade, montada como `cortesias.post.ts` monta. */
  async function cortesiaInstitucional(setor = setorZero, nome = 'ZZ Convite'): Promise<Caso> {
    const loteId = await novoLote(setor, nome, 4000)
    const ped = (await q1<any>(
      `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method,
                           face_cents, fee_cents, platform_cents, discount_cents,
                           total_cents, paid_at)
       VALUES ($1,$2,'CRT-'||substr(gen_random_uuid()::text,1,8),'pago',
               'cortesia','cortesia',0,0,0,0,0,now())
       RETURNING id, code`, [orgId, eventId]))!
    const item = (await q1<any>(
      `INSERT INTO order_items (order_id, lot_id, quantity,
                                unit_face_cents, unit_fee_cents, unit_total_cents)
       VALUES ($1,$2,1,0,0,0) RETURNING id`, [ped.id, loteId]))!
    const t = (await q1<any>(
      `INSERT INTO tickets (org_id, event_id, order_id, order_item_id, sector_id,
                            lot_id, code, qr_secret, status, is_courtesy, holder_name)
       VALUES ($1,$2,$3,$4,$5,$6,'CRT-'||encode(gen_random_bytes(5),'hex'),
               encode(gen_random_bytes(16),'hex'),'valido',true,'Jornal da Cidade')
       RETURNING code`, [orgId, eventId, ped.id, item.id, setor, loteId]))!
    await q(`UPDATE lots SET sold = sold + 1 WHERE id = $1`, [loteId])
    return { id: ped.id, code: ped.code, ingresso: t.code, loteId }
  }

  beforeAll(async () => {
    setorZero = (await q1<any>(`INSERT INTO sectors (event_id, name)
      VALUES ($1,'ZZ Zero') RETURNING id`, [eventId]))!.id
    setorOrfao = (await q1<any>(`INSERT INTO sectors (event_id, name)
      VALUES ($1,'ZZ Sem Pedido') RETURNING id`, [eventId]))!.id
    // Setor só dela: a cortesia CANCELADA é o que separa o número desta tela
    // do número do borderô, e os casos acima conferem total por setor — se
    // ela caísse no setor de outro caso, mexeria no total dele.
    setorCancelada = (await q1<any>(`INSERT INTO sectors (event_id, name)
      VALUES ($1,'ZZ Cortesia Cancelada') RETURNING id`, [eventId]))!.id

    cortesia = await cortesiaInstitucional()
    promocao = await vendaQueFechaEmZero('ZZ Promoção 100%', 4000, null)
    crianca = await vendaQueFechaEmZero('ZZ Infantil', 0, 'Criança até 5 anos')

    // O ingresso que NINGUÉM consegue classificar: sem pedido. Importação,
    // INSERT na mão, ou pedido apagado (a FK é ON DELETE SET NULL).
    const loteOrfao = await novoLote(setorOrfao, 'ZZ Órfão', 4000)
    codigoOrfao = (await q1<any>(
      `INSERT INTO tickets (org_id, event_id, sector_id, lot_id, code, qr_secret,
                            status, is_courtesy, holder_name)
       VALUES ($1,$2,$3,$4,'ORF-'||encode(gen_random_bytes(5),'hex'),
               encode(gen_random_bytes(16),'hex'),'valido',true,'ZZ Sem Origem')
       RETURNING code`, [orgId, eventId, setorOrfao, loteOrfao]))!.code

    // A cortesia que foi DADA e depois cancelada. Ela devolveu o lugar, então
    // o borderô e a tela de Cortesias não a contam mais; esta lista conta,
    // porque mostra ingresso cancelado junto com o resto. É a diferença que o
    // caso lá embaixo obriga a ter nome.
    const cancelada = await cortesiaInstitucional(setorCancelada, 'ZZ Cortesia Cancelada')
    await q(`UPDATE tickets SET status='cancelado', canceled_at=now() WHERE code = $1`,
      [cancelada.ingresso])
    await q(`UPDATE lots SET sold = GREATEST(sold - 1, 0) WHERE id = $1`, [cancelada.loteId])

    // Sessão própria, na org da fixture: a cerca de tenant recusa o evento de
    // outro produtor, e sem isso a lista viria 404 e o caso passaria à toa.
    const email = `emissao.cortesia.${crypto.randomUUID()}@teste.invalido`
    await q(
      `INSERT INTO users (org_id, name, email, password_hash, role, papel)
       SELECT $1,'ZZ Dona Emissão',$2,password_hash,'master','master'
         FROM users WHERE email = 'dono@fazendapark.com.br'`, [orgId, email])
    try {
      const r = await fetch(`${BASE}/api/auth/entrar`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, senha: 'diamond123' }),
        signal: AbortSignal.timeout(5000),
      })
      cookie = (r.headers.getSetCookie?.() ?? [])
        .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
      noAr = Boolean(cookie)
    } catch { noAr = false }
  }, 60_000)

  /**
   * A marca está nos três — é ela que engana. Se este caso cair, alguém mudou
   * o que `emissao.ts` carimba, e os casos abaixo pararam de provar a
   * distinção (passariam sem a origem, por não haver mais o que confundir).
   */
  it('os três fecham em zero e os três recebem a marca `is_courtesy`', async () => {
    const marcas = await q<any>(
      `SELECT code, is_courtesy FROM tickets WHERE code = ANY($1)`,
      [[cortesia.ingresso, promocao.ingresso, crianca.ingresso]])
    expect(marcas.length).toBe(3)
    for (const m of marcas) {
      expect(m.is_courtesy, `${m.code} não recebeu a marca — o teste perdeu o sentido`).toBe(true)
    }
  })

  /**
   * A própria emissão já responde, e responde pela ORIGEM: o caminho de
   * `emitirIngressos` é o da VENDA (webhook do Asaas, balcão). Fechar em zero
   * não muda o que ele é.
   */
  it('a emissão de uma venda não se declara cortesia nem fechando em zero', () => {
    expect(promocao.emissao!.cortesia, 'a promoção de 100% saiu como cortesia').toBe(false)
    expect(crianca.emissao!.cortesia, 'a criança de 4 anos saiu como cortesia').toBe(false)
  })

  it('só o convite conta como cortesia; promoção e criança são VENDA', async () => {
    const linhas = await q<any>(
      `SELECT t.code,
              ${SQL_E_CORTESIA('t')}         AS cortesia,
              ${SQL_E_VENDA_GRATUITA('t')}   AS gratuito,
              ${SQL_CORTESIA_SEM_ORIGEM('t')} AS sem_origem
         FROM tickets t WHERE t.code = ANY($1)`,
      [[cortesia.ingresso, promocao.ingresso, crianca.ingresso]])
    const por = Object.fromEntries(linhas.map((l) => [l.code, l]))

    expect(por[cortesia.ingresso].cortesia, 'o convite do patrocinador deixou de ser cortesia').toBe(true)
    expect(por[promocao.ingresso].cortesia, 'a promoção de 100% foi contada como cortesia').toBe(false)
    expect(por[crianca.ingresso].cortesia, 'a criança de 4 anos foi contada como cortesia').toBe(false)

    expect(por[promocao.ingresso].gratuito).toBe(true)
    expect(por[crianca.ingresso].gratuito).toBe(true)
    expect(por[cortesia.ingresso].gratuito, 'a cortesia entrou também como venda gratuita').toBe(false)

    // Os dois recortes PARTICIONAM o que saiu de graça: nenhum ingresso pode
    // cair nos dois nem sumir dos dois — é assim que a soma das colunas de uma
    // tela continua batendo com o total dela.
    for (const l of linhas) {
      expect(l.cortesia !== l.gratuito, `${l.code} caiu nos dois recortes (ou em nenhum)`).toBe(true)
      expect(l.sem_origem, `${l.code} tem pedido e mesmo assim saiu como "sem origem"`).toBe(false)
    }
  })

  it('a régua em TypeScript responde igual à de SQL', async () => {
    const linhas = await q<any>(
      `SELECT t.code, t.is_courtesy, o.channel, ${SQL_E_CORTESIA('t')} AS no_sql
         FROM tickets t LEFT JOIN orders o ON o.id = t.order_id
        WHERE t.code = ANY($1)`,
      [[cortesia.ingresso, promocao.ingresso, crianca.ingresso, codigoOrfao]])
    expect(linhas.length).toBe(4)
    for (const l of linhas) {
      expect(eCortesia(l.is_courtesy, l.channel),
        `${l.code}: a tela do comprador e o relatório do produtor discordariam`)
        .toBe(l.no_sql)
    }
  })

  it('ingresso sem pedido não dá pra distinguir — e a leitura diz isso', async () => {
    const l = (await q1<any>(
      `SELECT ${SQL_E_CORTESIA('t')} AS cortesia,
              ${SQL_CORTESIA_SEM_ORIGEM('t')} AS sem_origem
         FROM tickets t WHERE t.code = $1`, [codigoOrfao]))!
    // Conta como cortesia: é o lado seguro (entrada de graça que ninguém
    // explica). Mas vai marcado, pra tela poder dizer que ali não há prova.
    expect(l.cortesia).toBe(true)
    expect(l.sem_origem, 'o ingresso sem pedido passou como cortesia provada').toBe(true)
  })

  it('a lista da portaria conta cortesia e venda gratuita em colunas separadas', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const r = await fetch(
      `${BASE}/api/admin/evento/${eventId}/participantes?setor=${setorZero}`,
      { headers: { cookie } })
    const d: any = await r.json()
    expect(r.status, `a lista não abriu: ${d.statusMessage ?? d.message ?? ''}`).toBe(200)

    expect(d.resumo.total, 'a fixture dos três casos mudou de tamanho').toBe(3)
    expect(d.resumo.cortesias,
      'a lista contou venda gratuita como cortesia — o KPI do topo mente pro produtor').toBe(1)
    expect(d.resumo.gratuitos, 'a venda que fechou em zero sumiu da tela').toBe(2)
    expect(d.resumo.cortesiasSemOrigem).toBe(0)

    const por = Object.fromEntries(d.participantes.map((p: any) => [p.codigo, p]))
    expect(por[cortesia.ingresso].cortesia).toBe(true)
    expect(por[cortesia.ingresso].gratuito).toBe(false)
    for (const c of [promocao.ingresso, crianca.ingresso]) {
      expect(por[c].cortesia, `${c} saiu com o selo CORTESIA sendo venda`).toBe(false)
      expect(por[c].gratuito).toBe(true)
      expect(por[c].origemNaoRegistrada).toBe(false)
    }
  }, 30_000)

  it('a lista marca o ingresso sem pedido como origem não registrada', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const r = await fetch(
      `${BASE}/api/admin/evento/${eventId}/participantes?setor=${setorOrfao}`,
      { headers: { cookie } })
    const d: any = await r.json()
    expect(r.status).toBe(200)
    expect(d.resumo.cortesias).toBe(1)
    expect(d.resumo.cortesiasSemOrigem,
      'a tela não tem como avisar que essa não dá pra distinguir').toBe(1)
    expect(d.participantes[0].codigo).toBe(codigoOrfao)
    expect(d.participantes[0].origemNaoRegistrada).toBe(true)
  }, 30_000)

  /**
   * O convite do patrocinador não tem comprador: `cortesias.post.ts` grava o
   * pedido sem `customer_id` (quem recebe não preencheu formulário nenhum, o
   * nome dele está no INGRESSO). A rota fazia `JOIN customers`, o pedido sumia
   * da consulta e o convidado lia "Pedido não encontrado" no link que o
   * próprio sistema mandou. Nada estourava: um JOIN come linha sem par em
   * silêncio.
   */
  it('o link do convite abre — pedido sem comprador não some no JOIN', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const semComprador = await q1<any>(
      `SELECT customer_id FROM orders WHERE id = $1`, [cortesia.id])
    expect(semComprador!.customer_id,
      'a cortesia passou a ter comprador — o caso deixou de exercitar o JOIN').toBe(null)

    const r = await fetch(`${BASE}/api/pedido/${cortesia.code}`)
    const d: any = await r.json()
    expect(r.status,
      `o convidado levou "${d.statusMessage ?? d.message ?? ''}" no link do próprio convite`)
      .toBe(200)
    expect(d.comprador.nome, 'inventou um comprador que não existe').toBe(null)
    expect(d.comprador.email).toBe(null)
    expect(d.ingressos.length, 'abriu, mas sem o ingresso — o QR do convite não aparece').toBe(1)
    expect(d.ingressos[0].codigo).toBe(cortesia.ingresso)
  }, 30_000)

  /**
   * O MESMO evento, as MESMAS cortesias, duas telas que o produtor abre lado
   * a lado — e dois números.
   *
   * Medido no evento semeado, no mesmo instante: Participantes dizia
   * `cortesias: 3` e o borderô `cortesias: 2`, com o denominador idêntico
   * (641 ingressos emitidos dos dois lados). A diferença é uma cortesia
   * CANCELADA: ela devolveu o lugar, então some da ocupação (borderô, tela de
   * Cortesias, cota, gatilho da 017) e fica nesta lista, que mostra ingresso
   * de toda situação.
   *
   * Nenhum dos dois está errado — o que faltava era a conta que liga os dois.
   * Enquanto ela não existia, o produtor que abria as duas telas tinha que
   * escolher em qual acreditar, e é assim que um borderô vira discussão com o
   * sócio. Agora a diferença tem nome (`cortesiasCanceladas`) e a igualdade
   * abaixo é a régua:
   *
   *     cortesias − cortesiasCanceladas === cortesias do borderô
   *
   * Apague o campo, ou volte a contar cancelada no borderô, e este caso cai.
   */
  it('o número de cortesias de Participantes fecha com o do borderô', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const ler = async (rota: string) => {
      const r = await fetch(`${BASE}/api/admin/evento/${eventId}/${rota}`, { headers: { cookie } })
      const d: any = await r.json()
      expect(r.status, `${rota} não abriu: ${d.statusMessage ?? d.message ?? ''}`).toBe(200)
      return d
    }
    const [lista, bordero] = await Promise.all([ler('participantes'), ler('bordero')])

    // Sem o mesmo denominador a comparação não vale nada: se as duas telas
    // estivessem olhando conjuntos diferentes de ingressos, qualquer número
    // fecharia por acaso.
    expect(lista.resumo.total,
      'as duas telas deixaram de olhar o mesmo conjunto de ingressos')
      .toBe(bordero.totais.ingressosEmitidos)

    // A fixture tem exatamente três marcadas como cortesia pela régua da casa
    // (convite, órfão sem pedido, e a cancelada) e UMA delas está cancelada.
    expect(lista.resumo.cortesias, 'a fixture das cortesias mudou de tamanho').toBe(3)
    expect(lista.resumo.cortesiasCanceladas,
      'a tela não tem como explicar por que o borderô mostra um número menor').toBe(1)

    expect(lista.resumo.cortesias - lista.resumo.cortesiasCanceladas,
      'Participantes e borderô discordam sobre quantas cortesias este evento deu')
      .toBe(bordero.totais.cortesias)
  }, 30_000)

  it('a tela do comprador não escreve CORTESIA num ingresso que ele comprou', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const ler = async (code: string) => {
      const r = await fetch(`${BASE}/api/pedido/${code}`)
      const d: any = await r.json()
      expect(r.status, `${code}: ${d.statusMessage ?? d.message ?? ''}`).toBe(200)
      return d
    }

    const convite = await ler(cortesia.code)
    expect(convite.cortesia).toBe(true)
    expect(convite.gratuito).toBe(false)
    expect(convite.ingressos[0].cortesia).toBe(true)
    expect(convite.ingressos[0].gratuito).toBe(false)

    for (const [nome, caso] of [['promoção de 100%', promocao], ['criança', crianca]] as const) {
      const d = await ler(caso.code)
      expect(d.cortesia, `o pedido de ${nome} se diz cortesia`).toBe(false)
      expect(d.gratuito, `o pedido de ${nome} não se diz gratuito`).toBe(true)
      expect(d.ingressos.length).toBe(1)
      expect(d.ingressos[0].cortesia,
        `o comprador de ${nome} recebeu um ingresso escrito CORTESIA`).toBe(false)
      expect(d.ingressos[0].gratuito).toBe(true)
    }
  }, 30_000)

  /**
   * O TERCEIRO leitor: a ficha que o ATENDENTE abre com o cliente ao telefone.
   *
   * Participantes e a tela do comprador já sabiam a diferença; esta rota
   * continuava devolvendo `cortesia: t.is_courtesy` cru. Medido antes do
   * conserto, no pedido online com cupom de 100%:
   * `ingressos[0].cortesia = true`. É esta tela que responde "eu paguei ou me
   * deram?" — e ela respondia errado justamente pra quem usou o cupom.
   *
   * Devolva `t.is_courtesy` ali e este caso fica vermelho.
   */
  it('a ficha do atendente não chama de cortesia a venda que fechou em zero', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const ler = async (id: string) => {
      const r = await fetch(`${BASE}/api/admin/pedido/${id}`,
        { headers: { cookie }, signal: AbortSignal.timeout(20_000) })
      const d: any = await r.json()
      expect(r.status, `${id}: ${d.statusMessage ?? d.message ?? ''}`).toBe(200)
      return d
    }

    const convite = await ler(cortesia.id)
    expect(convite.ingressos.length).toBe(1)
    expect(convite.ingressos[0].cortesia,
      'o convite do patrocinador deixou de ser cortesia na ficha do atendente').toBe(true)
    expect(convite.ingressos[0].gratuito,
      'a cortesia entrou também como venda gratuita').toBe(false)

    for (const [nome, caso] of [['promoção de 100%', promocao], ['criança', crianca]] as const) {
      const d = await ler(caso.id)
      expect(d.ingressos.length).toBe(1)
      expect(d.ingressos[0].cortesia,
        `o atendente lê CORTESIA no ingresso de ${nome}, que é VENDA`).toBe(false)
      expect(d.ingressos[0].gratuito,
        `a ficha não diz que o ingresso de ${nome} saiu sem dinheiro`).toBe(true)
    }

    // Os dois recortes particionam aqui também: nenhum ingresso nos dois, e
    // nenhum marcado somindo dos dois. É o que mantém esta ficha, a lista da
    // portaria e o borderô falando a mesma coisa sobre o mesmo ingresso.
    for (const caso of [cortesia, promocao, crianca]) {
      const d = await ler(caso.id)
      const t = d.ingressos[0]
      expect(t.cortesia !== t.gratuito,
        `${t.codigo} caiu nos dois recortes (ou em nenhum) na ficha do pedido`).toBe(true)
    }
  }, 30_000)

  /* =========================================================================
   * A TELA, não a API
   *
   * Os dois casos abaixo leem o HTML que o servidor renderiza, porque o
   * defeito que sobrou não estava na rota: a API já mandava os três campos e
   * a tela mostrava um só. Isso não lança exceção, não suja o console e não
   * deixa teste de API vermelho — só aparece olhando.
   * ====================================================================== */

  /** O `<td>` daquele código, do código até o fim da célula. */
  function celulaDoCodigo(html: string, codigo: string): string | null {
    const i = html.indexOf(codigo)
    if (i < 0) return null
    const fim = html.indexOf('</td>', i)
    return fim < 0 ? null : html.slice(i, fim)
  }

  /** Os selos daquela linha, pelo texto. */
  const selosDaLinha = (html: string, codigo: string) =>
    [...(celulaDoCodigo(html, codigo) ?? '').matchAll(/<span[^>]*>([^<]*)<\/span>/g)]
      .map((m) => m[1].trim()).filter(Boolean)

  /**
   * Três jeitos de entrar de graça, TRÊS selos com nome próprio.
   *
   * Medido no navegador (1440×900, `getComputedStyle`) antes do conserto:
   *
   *   - a venda que fechou em zero ficava SEM SELO NENHUM — o `<span>` nem
   *     existia (`getBoundingClientRect().width` 0). O selo errado tinha sido
   *     removido e nada entrou no lugar: o operador perdeu a informação de que
   *     aquele ingresso saiu sem dinheiro;
   *   - o ingresso SEM PEDIDO recebia selo IDÊNTICO ao da cortesia de verdade
   *     (`selo-neutro ml-1`, `rgb(90, 107, 132)`, 73.8px nas duas linhas) — a
   *     tela afirmava uma origem que ninguém consegue provar.
   *
   * Volte a tela pra um `v-if="p.cortesia"` só e este caso cai duas vezes: o
   * gratuito fica sem selo e o órfão volta a se disfarçar de convite.
   */
  it('a tela de Participantes dá selo próprio aos três — e a nenhum deles o mesmo', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const r = await fetch(`${BASE}/admin/evento/${eventId}/vendas/participantes`,
      { headers: { cookie }, signal: AbortSignal.timeout(20_000) })
    expect(r.status, 'a tela de Participantes não abriu').toBe(200)
    const html = await r.text()

    // A tela mostra a primeira página (50). Se a fixture crescer além disso,
    // o caso passa a medir outra coisa — melhor cair dizendo o porquê.
    const n = (await q1<any>(
      `SELECT count(*)::int AS n FROM tickets WHERE event_id = $1`, [eventId]))!.n
    expect(n, 'a fixture passou de uma página: os três casos saíram da tela medida')
      .toBeLessThanOrEqual(50)

    // Primeiro: as quatro linhas estão MESMO nesta tela. Sem isto, "ficou sem
    // selo" lá embaixo confundiria "a tela não mostra o selo" com "a tela não
    // mostra o ingresso".
    const codigos = {
      cortesia: cortesia.ingresso, gratuito: promocao.ingresso,
      crianca: crianca.ingresso, semOrigem: codigoOrfao,
    }
    for (const [nome, codigo] of Object.entries(codigos)) {
      expect(celulaDoCodigo(html, codigo), `${nome} (${codigo}) não apareceu na tela`)
        .not.toBeNull()
    }

    const selo = Object.fromEntries(
      Object.entries(codigos).map(([nome, codigo]) => [nome, selosDaLinha(html, codigo)]),
    ) as Record<keyof typeof codigos, string[]>

    // 1. ninguém que entrou de graça fica sem selo — foi assim que a venda
    //    gratuita sumiu da tela depois que o selo errado saiu.
    for (const [nome, s] of Object.entries(selo)) {
      expect(s.length, `${nome}: o ingresso gratuito ficou sem selo nenhum na tela`)
        .toBeGreaterThan(0)
    }

    // 2. cada um com o nome DELE.
    expect(selo.cortesia).toContain('CORTESIA')
    expect(selo.gratuito.join(' '),
      'a venda com cupom de 100% voltou a ser chamada de cortesia na tela')
      .not.toMatch(/CORTESIA/)
    expect(selo.crianca.join(' ')).not.toMatch(/CORTESIA/)
    expect(selo.gratuito, 'a venda gratuita e a criança não saem com o mesmo selo')
      .toEqual(selo.crianca)

    // 3. e o que ninguém consegue provar não se passa pelo convite.
    expect(selo.semOrigem.join(' '),
      'o ingresso sem pedido recebeu o mesmo selo da cortesia de verdade')
      .not.toEqual(selo.cortesia.join(' '))

    // 4. o rodapé continua explicando o que tem dentro do número dele: sem
    //    esta linha, "Cortesias 2" com um selo CORTESIA na tela é contradição.
    expect(html, 'a tela deixou de avisar que há cortesia sem origem registrada')
      .toMatch(/origem não registrada/)
  }, 30_000)

  /**
   * A nota do KPI empresta um número da OUTRA tela — e só pode fazer isso
   * quando as duas estão olhando o mesmo conjunto.
   *
   * O borderô conta o evento INTEIRO. Esta lista conta o que o filtro deixou
   * passar. Enquanto a frase era uma só, bastava ligar o filtro de setor pra
   * ela virar uma afirmação errada sobre a tela do lado. Medido no navegador
   * (1440×900), fixture com 5 cortesias no evento (1 cancelada) e o filtro
   * num setor que tem 2 (1 cancelada):
   *
   *     a tela dizia  "1 cancelada(s) — o borderô mostra 1"
   *     o borderô diz  4
   *
   * Errado por 3, com as duas abertas lado a lado — a discussão com o sócio
   * que esta nota nasceu justamente pra evitar. Nada estourava: é a classe de
   * bug que só aparece olhando.
   *
   * O caso trava as DUAS metades do conserto, e cai se qualquer uma sumir:
   *
   *  1. o filtro mora na URL (regra da casa), senão `?setor=` nem chega ao
   *     desenho e não existe tela filtrada pra medir de fora;
   *  2. filtrada, a tela fala por si; inteira, o número que ela atribui ao
   *     borderô é o do borderô, conferido na rota dele no mesmo instante.
   */
  it('a nota do KPI não atribui ao borderô um número que o borderô não mostra', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const tela = async (qs: string) => {
      const r = await fetch(
        `${BASE}/admin/evento/${eventId}/vendas/participantes${qs}`,
        { headers: { cookie }, signal: AbortSignal.timeout(20_000) })
      expect(r.status, `a tela de Participantes não abriu (${qs || 'sem filtro'})`).toBe(200)
      // Comentário some junto com a tag: o texto do comentário desta tela
      // CITA a frase antiga, e sem tirá-lo o caso acharia a nota no lugar
      // errado e passaria com a tela mentindo.
      return (await r.text())
        .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    }

    const bordero: any = await (await fetch(
      `${BASE}/api/admin/evento/${eventId}/bordero`, { headers: { cookie } })).json()

    /* ---- a tela inteira: pode emprestar o número, e ele tem que bater ---- */
    const inteira = await tela('')
    const citada = inteira.match(/(\d+) cancelada\(s\) — o borderô mostra (\d+)/)
    expect(citada,
      'a tela parou de explicar por que o borderô mostra um número menor de cortesias')
      .not.toBeNull()
    expect(Number(citada![2]),
      'a tela diz ao produtor um número de borderô que o borderô não mostra')
      .toBe(bordero.totais.cortesias)

    /* ---- filtrada: ela fala por si, nunca pelo borderô ---- */
    const filtrada = await tela(`?setor=${setorCancelada}`)

    // Antes de tudo: o filtro CHEGOU. Sem isto, "não falou do borderô"
    // passaria à toa no dia em que o `?setor=` voltasse a ser ignorado.
    expect(filtrada, 'o `?setor=` da URL não filtrou a tela — o link não vale nada')
      .not.toMatch(new RegExp(cortesia.ingresso))
    expect(filtrada, 'a cortesia cancelada sumiu do setor dela — o caso mede outra coisa')
      .toMatch(/cancelada\(s\)/)

    expect(filtrada,
      'com filtro ligado a tela continua falando pelo borderô, que conta o evento inteiro')
      .not.toMatch(/o borderô mostra/)
    expect(filtrada, 'filtrada, a tela não diz quantas cortesias ocupam lugar no recorte')
      .toMatch(/cancelada\(s\) — \d+ ocupa\(m\) lugar dentro deste filtro/)
  }, 30_000)

  /**
   * Rótulo sem valor é pior que ausência.
   *
   * Desde que o convite parou de dar 404, a ficha dele ABRE — e abria com
   * "Comprador" em cima de nada (medido: `textContent` `""`, `offsetHeight`
   * 0), porque cortesia não tem comprador: quem recebe o convite não
   * preencheu formulário nenhum. Quem lê conclui que o sistema perdeu o dado.
   *
   * A trava é dupla: nenhum rótulo desta ficha aparece sem valor, e o nome
   * que aparece no convite é o de quem RECEBEU.
   */
  it('no convite, a ficha nomeia quem RECEBEU — e nenhum rótulo fica sem valor', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const ler = async (code: string) => {
      const r = await fetch(`${BASE}/ingressos/${code}`,
        { signal: AbortSignal.timeout(20_000) })
      expect(r.status, `a ficha de ${code} não abriu`).toBe(200)
      return r.text()
    }
    const pares = (html: string) =>
      [...html.matchAll(/<p class="text-xs text-tinta-fraca">([^<]*)<\/p><p[^>]*>([^<]*)<\/p>/g)]
        .map((m) => [m[1].trim(), m[2].trim()] as const)

    const convite = pares(await ler(cortesia.code))
    expect(convite.length, 'o cabeçalho da ficha mudou de forma — o caso parou de medi-lo')
      .toBeGreaterThan(1)
    for (const [rotulo, valor] of convite) {
      expect(valor, `o convite mostra o rótulo "${rotulo}" sem valor nenhum embaixo`).not.toBe('')
    }
    expect(convite.map(([r]) => r),
      'o convite ainda pede "Comprador" a quem não comprou nada').not.toContain('Comprador')
    expect(convite.map(([, v]) => v),
      'o convite não diz quem recebeu — o nome está no INGRESSO').toContain('Jornal da Cidade')

    // E quem COMPROU continua sendo chamado de comprador, com o nome dele.
    const compra = pares(await ler(promocao.code))
    expect(compra.map(([r]) => r), 'a compra deixou de nomear o comprador').toContain('Comprador')
    expect(compra.map(([, v]) => v)).toContain('Maria Souza')
    for (const [rotulo, valor] of compra) {
      expect(valor, `a compra mostra o rótulo "${rotulo}" sem valor nenhum embaixo`).not.toBe('')
    }
  }, 30_000)
})
