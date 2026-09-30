/**
 * reagendamento.test.ts — a troca de dia pelo próprio cliente (036), direto na camada do
 * servidor (sem HTTP: só o banco da suíte).
 *
 * O que cada caso trava:
 *   · as opções: outro dia do MESMO parque, publicado, no futuro, mesmo tipo, que não custe
 *     mais do que foi pago — rascunho, dia mais caro, meia e promocional (pra quem tem inteira), o próprio
 *     dia, lote esgotado e evento de outro parque ficam de fora;
 *   · ingresso de outra conta não aparece (nem existe, pra quem pergunta);
 *   · a troca: pedido novo R$ 0,00 no dia novo, na mesma conta, ligado ao ingresso antigo; o
 *     antigo vira cancelado (o QR morre); estoque sai de um lote e volta pro outro; rastro;
 *   · a mesma troca de novo é recusada; destino fora das regras é recusado;
 *   · duas confirmações ao mesmo tempo: só UMA troca acontece;
 *   · dia que já começou não reagenda.
 *
 * Fixture própria (organização ZZ), apagada no fim.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

;(globalThis as any).defineEventHandler ??= (h: any) => h

const { db, q, q1 } = await import('./db')
const {
  ingressoDaContaParaReagendar, motivoSemReagendamento, opcoesDeReagendamento,
  reagendarIngressoDoCliente, RecusaDoReagendamento,
} = await import('./reagendamento')

const MARCA = `zzreag${Date.now().toString(36)}`
let orgId = '', outraOrg = '', conta = '', outraConta = ''
const ev: Record<string, string> = {}
const lote: Record<string, string> = {}
const tipo: Record<string, string> = {}

async function evento(nome: string, dias: number, status = 'ativo', org = orgId) {
  return (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval, now() + ($5 || ' days')::interval + interval '8 hours', 0, 'repassar')
     RETURNING id`, [org, `ZZ ${nome}`, `${MARCA}-${nome}`, status, String(dias)]))!.id
}
async function loteCom(eventoId: string, nome: string, preco: number, qtd = 100) {
  const setor = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1, 'Geral') RETURNING id`, [eventoId]))!.id
  const l = (await q1<any>(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
     VALUES ($1,$2,$3,$4,6,'{online}') RETURNING id`, [setor, nome, preco, qtd]))!.id
  const inteira = (await q1<any>(
    `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps) VALUES ($1,'Inteira',$2,0) RETURNING id`, [l, qtd]))!.id
  // meia de verdade exige documento (é isso que o banco chama de 'meia'); o assistente marca sozinho
  const meia = (await q1<any>(
    `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps, requires_document)
     VALUES ($1,'Meia-entrada',$2,5000,true) RETURNING id`, [l, qtd]))!.id
  // promocional sem documento: o banco chama de 'inteira' com desconto — não pode virar destino da inteira
  const crianca = (await q1<any>(
    `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps) VALUES ($1,'Criança',$2,5000) RETURNING id`, [l, qtd]))!.id
  return { l, inteira, meia, crianca }
}
async function contaNova(org: string, sufixo: string) {
  return (await q1<any>(
    `INSERT INTO customer_accounts (org_id, name, email, document, phone, password_hash)
     VALUES ($1,'Cliente Teste',$2,$3,'73998260963','x') RETURNING id`,
    [org, `${MARCA}.${sufixo}@exemplo.com`, String(Math.floor(1e10 + Math.random() * 8e10))]))!.id
}
/** Um ingresso pago de R$ 30,00 (inteira) no dia A, na conta dada. */
async function ingressoPago(contaId: string, eventoId = ev.a!, loteId = lote.a!, tipoId = tipo.aInteira!, pago = 3000) {
  const pedido = (await q1<any>(
    `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                         discount_cents, total_cents, paid_at, customer_account_id)
     VALUES ($1,$2,$3,'pago','online',$4,0,0,0,$4,now(),$5) RETURNING id`,
    [orgId, eventoId, `PED-${Math.random().toString(36).slice(2, 10).toUpperCase()}`, pago, contaId]))!.id
  const item = (await q1<any>(
    `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents)
     VALUES ($1,$2,$3,1,$4,0,$4) RETURNING id`, [pedido, loteId, tipoId, pago]))!.id
  await q(`UPDATE lots SET sold = sold + 1 WHERE id = $1`, [loteId])
  await q(`UPDATE ticket_types SET sold = sold + 1 WHERE id = $1`, [tipoId])
  const setor = (await q1<any>(`SELECT sector_id FROM lots WHERE id = $1`, [loteId]))!.sector_id
  return (await q1<any>(
    `INSERT INTO tickets (org_id, event_id, order_id, order_item_id, sector_id, lot_id, ticket_type_id, code, qr_secret, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'x','valido') RETURNING id`,
    [orgId, eventoId, pedido, item, setor, loteId, tipoId,
     `ZZR-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`]))!.id
}
const sold = async (tabela: 'lots' | 'ticket_types', id: string) =>
  Number((await q1<any>(`SELECT sold FROM ${tabela} WHERE id = $1`, [id]))!.sold)

beforeAll(async () => {
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug) VALUES ('ZZ Reagendar', $1) RETURNING id`, [`${MARCA}-org`]))!.id
  outraOrg = (await q1<any>(`INSERT INTO organizations (name, slug) VALUES ('ZZ Outro Parque', $1) RETURNING id`, [`${MARCA}-org2`]))!.id
  conta = await contaNova(orgId, 'dona')
  outraConta = await contaNova(orgId, 'outra')

  ev.a = await evento('dia-a', 5)
  ev.b = await evento('dia-b', 6)
  ev.caro = await evento('dia-caro', 7)
  ev.rascunho = await evento('dia-rascunho', 8, 'rascunho')
  ev.esgotado = await evento('dia-esgotado', 9)
  ev.outroParque = await evento('outro-parque', 6, 'ativo', outraOrg)
  ev.passou = await evento('dia-passou', -1)

  let x = await loteCom(ev.a, 'A', 3000); lote.a = x.l; tipo.aInteira = x.inteira; tipo.aMeia = x.meia
  x = await loteCom(ev.b, 'B', 3000); lote.b = x.l; tipo.bInteira = x.inteira; tipo.bMeia = x.meia; tipo.bCrianca = x.crianca
  x = await loteCom(ev.caro, 'Caro', 5000); lote.caro = x.l; tipo.caroInteira = x.inteira
  x = await loteCom(ev.rascunho, 'Rascunho', 1000); tipo.rascunhoInteira = x.inteira
  x = await loteCom(ev.esgotado, 'Esgotado', 1000, 1)
  await q(`UPDATE lots SET sold = 1 WHERE id = $1`, [x.l])
  x = await loteCom(ev.outroParque, 'Outro', 1000); tipo.outroInteira = x.inteira
  x = await loteCom(ev.passou, 'Passou', 3000); lote.passou = x.l; tipo.passouInteira = x.inteira
})

afterAll(async () => {
  const pedidos = `SELECT id FROM orders WHERE org_id = ANY($1::uuid[])`
  const orgs = [orgId, outraOrg]
  await q(`DELETE FROM email_queue WHERE order_id IN (${pedidos})`, [orgs]).catch(() => {})
  await q(`UPDATE orders SET rescheduled_from_ticket_id = NULL WHERE org_id = ANY($1::uuid[])`, [orgs])
  await q(`DELETE FROM tickets WHERE order_id IN (${pedidos})`, [orgs])
  await q(`DELETE FROM order_items WHERE order_id IN (${pedidos})`, [orgs])
  await q(`DELETE FROM orders WHERE org_id = ANY($1::uuid[])`, [orgs])
  await q(`DELETE FROM customer_accounts WHERE org_id = ANY($1::uuid[])`, [orgs])
  await q(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [orgs]).catch(() => {})
  await db().end()
})

describe('reagendamento · opções', () => {
  it('só outro dia do mesmo parque, publicado, futuro, mesmo tipo e sem custar mais', async () => {
    const id = await ingressoPago(conta)
    const i = (await ingressoDaContaParaReagendar(conta, id))!
    expect(motivoSemReagendamento(i)).toBeNull()
    const opcoes = await opcoesDeReagendamento(i)
    const eventos = new Set(opcoes.map((o) => o.eventoId))
    expect([...eventos]).toEqual([ev.b])            // só o dia B
    expect(opcoes.map((o) => o.tipoId)).toEqual([tipo.bInteira]) // inteira → só inteira
    expect(opcoes[0]!.totalCents).toBe(3000)
    for (const fora of [ev.a, ev.caro, ev.rascunho, ev.esgotado, ev.outroParque, ev.passou]) {
      expect(eventos.has(fora!), `evento ${fora} não devia aparecer`).toBe(false)
    }
  })

  it('ingresso de outra conta não existe pra quem pergunta', async () => {
    const id = await ingressoPago(conta)
    expect(await ingressoDaContaParaReagendar(outraConta, id)).toBeNull()
    await expect(reagendarIngressoDoCliente(outraConta, id, { loteId: lote.b!, tipoId: tipo.bInteira! }))
      .rejects.toMatchObject({ status: 404 })
  })

  it('dia que já começou não reagenda', async () => {
    const id = await ingressoPago(conta, ev.passou, lote.passou, tipo.passouInteira)
    const i = (await ingressoDaContaParaReagendar(conta, id))!
    expect(motivoSemReagendamento(i)).toMatch(/já começou/)
  })
})

describe('reagendamento · a troca', () => {
  it('pedido novo zerado no dia novo; o antigo morre; estoque troca de lote; rastro', async () => {
    const id = await ingressoPago(conta)
    const antes = { a: await sold('lots', lote.a!), b: await sold('lots', lote.b!),
      ta: await sold('ticket_types', tipo.aInteira!), tb: await sold('ticket_types', tipo.bInteira!) }

    const r = await reagendarIngressoDoCliente(conta, id, { loteId: lote.b!, tipoId: tipo.bInteira! })

    const novo = (await q1<any>(
      `SELECT o.event_id, o.status, o.total_cents, o.customer_account_id, o.rescheduled_from_ticket_id,
              t.status AS t_status, t.event_id AS t_evento, t.lot_id
         FROM orders o JOIN tickets t ON t.order_id = o.id WHERE o.code = $1`, [r.pedido]))!
    expect(novo).toMatchObject({
      event_id: ev.b, status: 'pago', customer_account_id: conta, rescheduled_from_ticket_id: id,
      t_status: 'valido', t_evento: ev.b, lot_id: lote.b,
    })
    expect(Number(novo.total_cents)).toBe(0)

    const velho = (await q1<any>(`SELECT status, canceled_at FROM tickets WHERE id = $1`, [id]))!
    expect(velho.status).toBe('cancelado')
    expect(velho.canceled_at).not.toBeNull()

    expect(await sold('lots', lote.a!)).toBe(antes.a - 1)
    expect(await sold('lots', lote.b!)).toBe(antes.b + 1)
    expect(await sold('ticket_types', tipo.aInteira!)).toBe(antes.ta - 1)
    expect(await sold('ticket_types', tipo.bInteira!)).toBe(antes.tb + 1)
    expect(Number((await q1<any>(`SELECT reserved FROM lots WHERE id = $1`, [lote.b]))!.reserved)).toBe(0)

    const rastro = await q<any>(
      `SELECT action FROM audit_log WHERE entity = 'ingresso' AND entity_id IN ($1, $2) ORDER BY action`,
      [id, r.ingresso])
    expect(rastro.map((x) => x.action)).toEqual(['emitido_por_reagendamento', 'reagendado_pelo_cliente'])

    // a mesma troca de novo: o ingresso já morreu
    await expect(reagendarIngressoDoCliente(conta, id, { loteId: lote.b!, tipoId: tipo.bInteira! }))
      .rejects.toMatchObject({ status: 409 })
  })

  it('destino fora das regras (mais caro, outro tipo) é recusado', async () => {
    const id = await ingressoPago(conta)
    for (const destino of [
      { loteId: lote.caro!, tipoId: tipo.caroInteira! },
      { loteId: lote.b!, tipoId: tipo.bMeia! },
      { loteId: lote.b!, tipoId: tipo.bCrianca! },
    ]) {
      const e = await reagendarIngressoDoCliente(conta, id, destino).catch((x) => x)
      expect(e).toBeInstanceOf(RecusaDoReagendamento)
      expect(e.status).toBe(409)
    }
    expect((await q1<any>(`SELECT status FROM tickets WHERE id = $1`, [id]))!.status).toBe('valido')
  })

  it('meia vai pra meia levando o motivo; a cota de meia do lote novo vale', async () => {
    // ingresso de meia com motivo (o gatilho da 015 exige em pedido online)
    const pedido = (await q1<any>(
      `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                           discount_cents, total_cents, paid_at, customer_account_id)
       VALUES ($1,$2,$3,'pago','online',1500,0,0,0,1500,now(),$4) RETURNING id`,
      [orgId, ev.a, `PED-M${Date.now().toString(36).toUpperCase()}`, conta]))!.id
    const item = (await q1<any>(
      `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity, unit_face_cents, unit_fee_cents,
                                unit_total_cents, half_reason, half_document)
       VALUES ($1,$2,$3,1,1500,0,1500,'estudante','123') RETURNING id`, [pedido, lote.a, tipo.aMeia]))!.id
    await q(`UPDATE lots SET sold = sold + 1 WHERE id = $1`, [lote.a])
    await q(`UPDATE ticket_types SET sold = sold + 1 WHERE id = $1`, [tipo.aMeia])
    const setor = (await q1<any>(`SELECT sector_id FROM lots WHERE id = $1`, [lote.a]))!.sector_id
    const id = (await q1<any>(
      `INSERT INTO tickets (org_id, event_id, order_id, order_item_id, sector_id, lot_id, ticket_type_id, code,
                            qr_secret, status, half_reason, half_document)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'x','valido','estudante','123') RETURNING id`,
      [orgId, ev.a, pedido, item, setor, lote.a, tipo.aMeia, `ZZM-${Date.now().toString(36).toUpperCase()}`]))!.id

    const i = (await ingressoDaContaParaReagendar(conta, id))!
    const opcoes = await opcoesDeReagendamento(i)
    expect(opcoes.map((o) => o.tipoId)).toEqual([tipo.bMeia]) // meia → só meia

    const r = await reagendarIngressoDoCliente(conta, id, { loteId: lote.b!, tipoId: tipo.bMeia! })
    const novo = (await q1<any>(`SELECT half_reason, half_document FROM tickets WHERE id = $1`, [r.ingresso]))!
    expect(novo).toMatchObject({ half_reason: 'estudante', half_document: '123' })

    // cota de meia do lote B zerada: a próxima troca de meia pra lá é recusada, e nada muda
    await q(`UPDATE lots SET half_quota_bps = 0 WHERE id = $1`, [lote.b])
    const outro = await (async () => {
      const p2 = (await q1<any>(
        `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                             discount_cents, total_cents, paid_at, customer_account_id)
         VALUES ($1,$2,$3,'pago','online',1500,0,0,0,1500,now(),$4) RETURNING id`,
        [orgId, ev.a, `PED-N${Date.now().toString(36).toUpperCase()}`, conta]))!.id
      const it2 = (await q1<any>(
        `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity, unit_face_cents, unit_fee_cents,
                                  unit_total_cents, half_reason) VALUES ($1,$2,$3,1,1500,0,1500,'estudante') RETURNING id`,
        [p2, lote.a, tipo.aMeia]))!.id
      return (await q1<any>(
        `INSERT INTO tickets (org_id, event_id, order_id, order_item_id, sector_id, lot_id, ticket_type_id, code,
                              qr_secret, status, half_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'x','valido','estudante') RETURNING id`,
        [orgId, ev.a, p2, it2, setor, lote.a, tipo.aMeia, `ZZN-${Date.now().toString(36).toUpperCase()}`]))!.id
    })()
    const e = await reagendarIngressoDoCliente(conta, outro, { loteId: lote.b!, tipoId: tipo.bMeia! }).catch((x) => x)
    expect(e).toBeInstanceOf(RecusaDoReagendamento)
    expect(e.message).toMatch(/meia-entrada/i)
    expect((await q1<any>(`SELECT status FROM tickets WHERE id = $1`, [outro]))!.status).toBe('valido')
    await q(`UPDATE lots SET half_quota_bps = 4000 WHERE id = $1`, [lote.b])
  })

  it('duas confirmações ao mesmo tempo: só UMA troca acontece', async () => {
    const id = await ingressoPago(conta)
    const destino = { loteId: lote.b!, tipoId: tipo.bInteira! }
    const r = await Promise.allSettled([
      reagendarIngressoDoCliente(conta, id, destino),
      reagendarIngressoDoCliente(conta, id, destino),
    ])
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    const novos = await q<any>(`SELECT id FROM orders WHERE rescheduled_from_ticket_id = $1`, [id])
    expect(novos).toHaveLength(1)
  })
})
