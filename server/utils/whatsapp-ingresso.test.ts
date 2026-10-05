/**
 * whatsapp-ingresso.test.ts — o ingresso pelo WhatsApp (038).
 *
 * Banco de verdade (o gatilho mora no Postgres); a UAZAPI é injetada — nenhum teste manda
 * mensagem de verdade. Cada caso diz a trava que o deixa vermelho.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

;(globalThis as any).defineEventHandler ??= (h: any) => h

const { db, q, q1 } = await import('./db')
const { montarMensagemDoWhatsapp, processarUmWhatsapp } = await import('./whatsapp-ingresso')

const MARCA = `zzwa${Date.now().toString(36)}`
let orgId = '', eventoId = '', loteId = '', tipoId = '', setorId = ''

async function conta(fone: string) {
  return (await q1<any>(
    `INSERT INTO customer_accounts (org_id, name, email, document, phone, password_hash)
     VALUES ($1, 'Maria Souza', $2, $3, $4, 'x') RETURNING id`,
    [orgId, `${MARCA}.${Math.random().toString(36).slice(2, 8)}@teste.invalido`,
     String(Math.floor(1e10 + Math.random() * 8e10)), fone]))!.id
}

/** Pedido que nasce aguardando pagamento, ganha 1 ingresso e vira pago — como o webhook faz. */
async function pedidoPago(contaId: string | null, extra: { canal?: string; pagoEm?: string } = {}) {
  const code = `PED-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  const p = (await q1<any>(
    `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                         discount_cents, total_cents, customer_account_id)
     VALUES ($1,$2,$3,'aguardando_pagamento',$4,3000,0,0,0,3000,$5) RETURNING id`,
    [orgId, eventoId, code, extra.canal ?? 'online', contaId]))!.id
  const item = (await q1<any>(
    `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents)
     VALUES ($1,$2,$3,1,3000,0,3000) RETURNING id`, [p, loteId, tipoId]))!.id
  await q(`INSERT INTO tickets (org_id, event_id, order_id, order_item_id, sector_id, lot_id, ticket_type_id, code, qr_secret, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'x','valido')`,
    [orgId, eventoId, p, item, setorId, loteId, tipoId, `ZZW-${Math.random().toString(36).slice(2, 8).toUpperCase()}`])
  await q(`UPDATE orders SET status = 'pago', paid_at = COALESCE($2::timestamptz, now()) WHERE id = $1`, [p, extra.pagoEm ?? null])
  return { id: p, code }
}
const linhas = (orderId: string) => q<any>(`SELECT * FROM whatsapp_sends WHERE order_id = $1`, [orderId])

beforeAll(async () => {
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug) VALUES ('ZZ WhatsApp', $1) RETURNING id`, [`${MARCA}-org`]))!.id
  eventoId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online)
     VALUES ($1, 'Domingo em Família', $2, 'ativo', now() + interval '5 days', now() + interval '5 days 8 hours', 0, 'repassar')
     RETURNING id`, [orgId, `${MARCA}-dia`]))!.id
  setorId = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1, 'Parque') RETURNING id`, [eventoId]))!.id
  loteId = (await q1<any>(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order, channels)
     VALUES ($1, 'Lote 1', 3000, 100, 6, '{online}') RETURNING id`, [setorId]))!.id
  tipoId = (await q1<any>(`INSERT INTO ticket_types (lot_id, name, quantity, discount_bps) VALUES ($1,'Inteira',100,0) RETURNING id`, [loteId]))!.id
})

beforeEach(() => {
  process.env.UAZAPI_URL = 'https://uazapi.teste.invalido'
  process.env.UAZAPI_TOKEN = 'token-de-teste'
  delete process.env.WHATSAPP_SO_PARA
  process.env.PUBLIC_BASE_URL = 'https://www.conquistapark.com.br'
})

afterAll(async () => {
  const pedidos = `SELECT id FROM orders WHERE org_id = $1`
  await q(`DELETE FROM whatsapp_sends WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM email_sends WHERE order_id IN (${pedidos})`, [orgId]).catch(() => {})
  await q(`DELETE FROM tickets WHERE order_id IN (${pedidos})`, [orgId])
  await q(`DELETE FROM order_items WHERE order_id IN (${pedidos})`, [orgId])
  await q(`DELETE FROM orders WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM customer_accounts WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM ticket_types WHERE lot_id = $1`, [loteId])
  await q(`DELETE FROM lots WHERE id = $1`, [loteId])
  await q(`DELETE FROM sectors WHERE id = $1`, [setorId])
  await q(`DELETE FROM events WHERE id = $1`, [eventoId])
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId]).catch(() => {})
  await db().end()
})

/** Esvazia a fila do teste (outras linhas do banco não são deste arquivo). */
async function processarDoPedido(orderId: string, enviar: any) {
  // as outras linhas saem da frente com uma data-marca, e só ELAS voltam depois
  const MARCA_DATA = '2100-01-01T00:00:00Z'
  await q(`UPDATE whatsapp_sends SET available_at = $2
            WHERE status = 'na_fila' AND order_id <> $1`, [orderId, MARCA_DATA])
  try { return await processarUmWhatsapp(enviar) }
  finally { await q(`UPDATE whatsapp_sends SET available_at = now() WHERE available_at = $1`, [MARCA_DATA]) }
}

describe('a mensagem', () => {
  it('um ingresso: nome, evento em negrito, data, pedido e o link sozinho na linha', () => {
    const t = montarMensagemDoWhatsapp({ nome: 'Maria Souza', evento: 'Domingo em Família', inicio: '2026-10-11T12:00:00Z',
      fuso: 'America/Bahia', pedido: 'PED-AB12', quantidade: 1, link: 'https://www.conquistapark.com.br/ingressos/PED-AB12' })
    expect(t).toContain('Olá, Maria!')
    expect(t).toContain('Seu ingresso do *Domingo em Família* está confirmado.')
    expect(t).toContain('11 de outubro de 2026 às 09:00')
    expect(t).toContain('Pedido PED-AB12')
    expect(t.split('\n')).toContain('https://www.conquistapark.com.br/ingressos/PED-AB12')
  })
  it('vários ingressos falam no plural', () => {
    const t = montarMensagemDoWhatsapp({ evento: 'Sábado', pedido: 'P', quantidade: 3, link: 'https://x/ingressos/P' })
    expect(t).toContain('Seus 3 ingressos do *Sábado* estão confirmados.')
    expect(t).toContain('os QR Codes')
    expect(t.startsWith('Olá! 🎉')).toBe(true)
  })
})

describe('o gatilho (038)', () => {
  it('pedido pago com telefone na conta enfileira UMA linha, com o 55 na frente', async () => {
    // trava: o INSERT do gatilho + o "55 ||" pra número de 11 dígitos
    const p = await pedidoPago(await conta('73998605622'))
    const l = await linhas(p.id)
    expect(l).toHaveLength(1)
    expect(l[0].to_phone).toBe('5573998605622')
    expect(l[0].status).toBe('na_fila')
    // reprocessar o pago (webhook repetido) não cria segunda linha
    await q(`UPDATE orders SET status = 'pago' WHERE id = $1`, [p.id])
    expect(await linhas(p.id)).toHaveLength(1)
  })
  it('sem telefone, cortesia ou pagamento antigo: nenhuma linha', async () => {
    // trava: os três RETURN do gatilho
    expect(await linhas((await pedidoPago(null)).id)).toHaveLength(0)   // sem conta e sem cadastro
    expect(await linhas((await pedidoPago(await conta('73998605622'), { canal: 'cortesia' })).id)).toHaveLength(0)
    expect(await linhas((await pedidoPago(await conta('73998605622'), { pagoEm: '2026-01-01T12:00:00Z' })).id)).toHaveLength(0)
  })
})

describe('o envio', () => {
  it('manda pela UAZAPI com o carimbo da Sofia e grava o que saiu', async () => {
    // trava: track_source 'sofia' — sem ele a Sofia trava a conversa 6 h (fp:block)
    const p = await pedidoPago(await conta('73998605622'))
    const corpos: any[] = []
    const r = await processarDoPedido(p.id, async (c: any) => { corpos.push(c); return { id: 'MSG-1' } })
    expect(r?.status).toBe('enviado')
    expect(corpos).toHaveLength(1)
    expect(corpos[0]).toMatchObject({ number: '5573998605622', track_source: 'sofia', track_id: `ingresso:${p.code}`, linkPreview: true })
    expect(corpos[0].text).toContain(`https://www.conquistapark.com.br/ingressos/${p.code}`)
    const [l] = await linhas(p.id)
    expect(l.status).toBe('enviado')
    expect(l.message_id).toBe('MSG-1')
    expect(l.body_text).toContain('Domingo em Família')
    expect(l.sent_at).not.toBeNull()
  })
  it('modo de teste: número fora de WHATSAPP_SO_PARA não recebe nada', async () => {
    // trava: o `soPara` — teste com o sistema aberto já mandou mensagem pra desconhecido (30/08)
    process.env.WHATSAPP_SO_PARA = '5573999999999'
    const p = await pedidoPago(await conta('73998605622'))
    let chamou = false
    const r = await processarDoPedido(p.id, async () => { chamou = true; return {} })
    expect(chamou).toBe(false)
    expect(r?.status).toBe('desligado')
  })
  it('falha de rede volta pra fila com espera; erro 463 desiste na hora', async () => {
    const p = await pedidoPago(await conta('73998605622'))
    const r = await processarDoPedido(p.id, async () => { throw new Error('UAZAPI 500: fora do ar') })
    expect(r?.status).toBe('na_fila')
    const [l] = await linhas(p.id)
    expect(new Date(l.available_at).getTime()).toBeGreaterThan(Date.now() + 30_000)

    const p2 = await pedidoPago(await conta('73998605622'))
    const r2 = await processarDoPedido(p2.id, async () => { throw new Error('UAZAPI 463: cannot start new chat') })
    expect(r2?.status).toBe('falhou')
  })
  it('linha que esperou mais de 48 h vence em vez de sair atrasada', async () => {
    const p = await pedidoPago(await conta('73998605622'))
    await q(`UPDATE whatsapp_sends SET created_at = now() - interval '3 days' WHERE order_id = $1`, [p.id])
    let chamou = false
    const r = await processarDoPedido(p.id, async () => { chamou = true; return {} })
    expect(chamou).toBe(false)
    expect(r?.status).toBe('falhou')
    expect((await linhas(p.id))[0].last_error).toMatch(/venceu/)
  })
})
