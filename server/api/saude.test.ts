/**
 * GET /api/saude — o que um monitor externo lê a cada minuto.
 *
 *  · 200 quando dá pra vender e entregar, 503 quando não — com o porquê;
 *  · os sinais que o dono só descobria pelo telefone: reserva vencida presa
 *    (a varredura de expirados parou — PROD-07), pago sem ingresso, evento à
 *    venda sem como cobrar (PROD-06);
 *  · em produção o diagnóstico só sai com `x-monitor-token`;
 *  · valor de variável NUNCA sai — nem pela HTTP do servidor de verdade.
 *
 * A medição roda no processo do teste (banco de teste); a rota inteira também
 * (com os globais do h3 emprestados), e uma ida pela HTTP confere o servidor
 * de dev — essa PULA sem servidor no ar.
 */
import { readFileSync } from 'node:fs'
import { createError, getRequestHeader, setResponseHeader, setResponseStatus } from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1 } from '../utils/db'
import { anunciarPulo, seForaDoArPula, sondarServidor, type Sonda } from '../../scripts/test-setup'

;(globalThis as any).defineEventHandler ??= (h: any) => h
;(globalThis as any).createError ??= createError
;(globalThis as any).setResponseHeader ??= setResponseHeader
;(globalThis as any).setResponseStatus ??= setResponseStatus
;(globalThis as any).getRequestHeader ??= getRequestHeader
const rota = await import('./saude.get')
const { medir, monitorAutorizado } = rota

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let orgId: string, eventId: string, slug: string

const ENV = { NODE_ENV: process.env.NODE_ENV, PAGAMENTO_SIMULADO: process.env.PAGAMENTO_SIMULADO,
  MONITOR_TOKEN: process.env.MONITOR_TOKEN, ASAAS_WEBHOOK_TOKEN: process.env.ASAAS_WEBHOOK_TOKEN }
afterEach(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await q(`DELETE FROM orders WHERE org_id = $1`, [orgId])
  await q(`UPDATE organizations SET asaas_api_key = NULL WHERE id = $1`, [orgId])
})

beforeAll(async () => {
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug)
    VALUES ('ZZ Saúde', 'zz-saude-' || gen_random_uuid()) RETURNING id`))!.id
  slug = `zz-saude-${Date.now()}`
  eventId = (await q1<any>(`INSERT INTO events (org_id, name, slug, status, starts_at, ends_at)
    VALUES ($1,'ZZ Saúde',$2,'ativo', now() + interval '10 days', now() + interval '11 days') RETURNING id`,
    [orgId, slug]))!.id
  sonda = await sondarServidor('/api/saude')
  anunciarPulo('server/api/saude.test.ts', sonda)
})

afterAll(async () => {
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

async function pedido(o: { status: string; expiraHaMin?: number; pagoHaMin?: number }) {
  await q(
    `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                         discount_cents, total_cents, expires_at, paid_at)
     VALUES ($1,$2,'PED-ZZSA-' || upper(substr(md5(random()::text),1,4)),$3,'online',100,0,0,0,100,
             CASE WHEN $4::int IS NULL THEN now() + interval '20 minutes'
                  ELSE now() - make_interval(mins => $4::int) END,
             CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(mins => $5::int) END)`,
    [orgId, eventId, o.status, o.expiraHaMin ?? null, o.pagoHaMin ?? null])
}

describe('/api/saude · os sinais que o dono só descobria pelo telefone', () => {
  it('reserva vencida há 15 min ainda presa: 503 — a varredura de expirados parou', async () => {
    await pedido({ status: 'aguardando_pagamento', expiraHaMin: 15 })
    const { status, corpo } = await medir()
    expect(corpo.pedidos.reservasVencidasAindaPresas).toBeGreaterThanOrEqual(1)
    expect(status).toBe(503)
    expect(corpo.ok).toBe(false)
    expect(corpo.problemas.find((p: any) => p.item === 'liberar-expirados')).toMatchObject({ critico: true })
  })

  it('pago há 15 min sem nenhum ingresso: 503 — o dinheiro entrou e a emissão não', async () => {
    await pedido({ status: 'pago', pagoHaMin: 15 })
    const { status, corpo } = await medir()
    expect(corpo.pedidos.pagosSemIngresso).toBeGreaterThanOrEqual(1)
    expect(status).toBe(503)
    expect(corpo.problemas.find((p: any) => p.item === 'emissão')).toMatchObject({ critico: true })
  })

  it('PROD-06 · evento à venda sem como cobrar aparece pelo slug e o motivo — a chave nunca', async () => {
    process.env.PAGAMENTO_SIMULADO = '0'
    let { corpo } = await medir()
    expect(corpo.vendaOnline.eventosSemPagamento).toContainEqual({ slug, motivo: 'sem_chave' })

    process.env.NODE_ENV = 'production'
    process.env.ASAAS_WEBHOOK_TOKEN = 'token-de-teste-do-webhook'
    await q(`UPDATE organizations SET asaas_api_key = '$aact_hmlg_000ZZchaveDeTesteQueNaoPodeVazar'
              WHERE id = $1`, [orgId])
    ;({ corpo } = await medir())
    expect(corpo.vendaOnline.eventosSemPagamento).toContainEqual({ slug, motivo: 'chave_de_teste' })
    expect(JSON.stringify(corpo)).not.toContain('aact')
  })
})

describe('/api/saude · e-mail que desistiu só é alarme quando ainda há ingresso pra entregar', () => {
  /**
   * Um pedido com o e-mail de confirmação em `falhou` (teto de tentativas), sem saída nem
   * pendência — é o "perdido" que derruba a fila. `ingresso` diz como fica o único ingresso.
   */
  async function falhouDeVez(status: string, ingresso: 'valido' | 'cancelado' | 'transferido') {
    const setor = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1,'ZZ') RETURNING id`, [eventId]))!.id
    const lote = (await q1<any>(`INSERT INTO lots (sector_id, name, price_cents, quantity)
      VALUES ($1,'ZZ',100,10) RETURNING id`, [setor]))!.id
    const pedidoId = (await q1<any>(
      `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                           discount_cents, total_cents, paid_at)
       VALUES ($1,$2,'PED-ZZSE-' || upper(substr(md5(random()::text),1,4)),$3,'online',100,0,0,0,100, now())
       RETURNING id`, [orgId, eventId, status]))!.id
    const t = (await q1<any>(
      `INSERT INTO tickets (org_id, event_id, sector_id, lot_id, order_id, code, qr_secret, status)
       VALUES ($1,$2,$3,$4,$5,'ZZSE-' || upper(substr(md5(random()::text),1,8)),'teste',$6) RETURNING id`,
      [orgId, eventId, setor, lote, pedidoId, ingresso === 'cancelado' ? 'cancelado' : 'valido']))!.id
    if (ingresso === 'transferido') {
      await q(`INSERT INTO ticket_transfers (org_id, event_id, ticket_id, para_nome, para_email, code, status)
               VALUES ($1,$2,$3,'Recebe','recebe.saude@teste.invalido','tr_zz_saude_' || gen_random_uuid(),
                       'concluido')`, [orgId, eventId, t])
    }
    await q(`INSERT INTO email_sends (org_id, event_id, order_id, kind, to_email, status, attempts, last_error)
             VALUES ($1,$2,$3,'confirmacao_pedido','zz.saude@teste.invalido','falhou',5,'zz')`,
      [orgId, eventId, pedidoId])
  }
  const perdidos = async () => Number((await medir()).corpo.filaDeEnvio.pedidosSemEmailDeVez)

  afterEach(async () => {
    await q(`DELETE FROM email_sends WHERE org_id = $1`, [orgId])
    await q(`DELETE FROM ticket_transfers WHERE org_id = $1`, [orgId])
    await q(`DELETE FROM tickets WHERE org_id = $1`, [orgId])
  })

  it('estornado, em disputa ou todo transferido NÃO contam; pago com ingresso pra entregar conta', async () => {
    // travas: `WHERE PEDIDO_VIVO('o.')` e o EXISTS do ingresso entregável (não cancelado, sem
    // transferência concluída) no `por_pedido` de saude.get.ts. Sem elas, o PRIMEIRO estorno
    // antes de o e-mail sair deixava a saúde em 503 pra sempre (a contagem não tem janela e o
    // pedido estornado não tem reenvio) — medido no servidor da bateria: 21 "perdidos" assim.
    // A contagem é do servidor inteiro (todas as organizações): o teste mede a DIFERENÇA.
    const antes = await perdidos()
    await falhouDeVez('estornado', 'cancelado')    // o estorno cancelou o ingresso
    await falhouDeVez('disputa', 'valido')         // a entrega recusa pedido fora de PEDIDO_VIVO
    await falhouDeVez('pago', 'transferido')       // B02: o ingresso é de outra pessoa agora
    expect(await perdidos(), 'e-mail que falhou de propósito virou alarme').toBe(antes)
    await falhouDeVez('pago', 'valido')
    expect(await perdidos(), 'quem pagou e ficou sem o e-mail sumiu do alarme').toBe(antes + 1)
    await falhouDeVez('estornado_parcial', 'valido')
    expect(await perdidos(), 'estorno parcial ainda tem ingresso pra entregar').toBe(antes + 2)
  })
})

describe('/api/saude · em produção o diagnóstico é do monitor', () => {
  const TOKEN = 'monitor-ZZ-0123456789-0123456789-0123456789'
  it('monitorAutorizado: fora de produção sempre; em produção só com o token certo (32+)', () => {
    expect(monitorAutorizado(null, { NODE_ENV: 'development' })).toBe(true)
    expect(monitorAutorizado(TOKEN, { NODE_ENV: 'production' })).toBe(false)
    expect(monitorAutorizado('curto', { NODE_ENV: 'production', MONITOR_TOKEN: 'curto' })).toBe(false)
    expect(monitorAutorizado('outro', { NODE_ENV: 'production', MONITOR_TOKEN: TOKEN })).toBe(false)
    expect(monitorAutorizado(TOKEN, { NODE_ENV: 'production', MONITOR_TOKEN: TOKEN })).toBe(true)
  })

  it('a rota: sem o cabeçalho sai só ok e status; com ele, o diagnóstico', async () => {
    process.env.NODE_ENV = 'production'
    process.env.MONITOR_TOKEN = TOKEN
    await pedido({ status: 'aguardando_pagamento', expiraHaMin: 15 })
    const chamar = async (token?: string) => {
      const res: any = { statusCode: 200, setHeader() {}, getHeader() {} }
      const ev: any = { method: 'GET', path: '/api/saude', context: {},
        node: { req: { method: 'GET', headers: token ? { 'x-monitor-token': token } : {} }, res } }
      const corpo = await (rota.default as any)(ev)
      return { status: res.statusCode, corpo }
    }
    // a resposta fica 5 s em memória: as duas leituras são da mesma medição
    const anonimo = await chamar()
    expect(anonimo.status).toBe(503)
    expect(Object.keys(anonimo.corpo).sort()).toEqual(['detalhes', 'ok', 'verificadoEm'])
    const monitor = await chamar(TOKEN)
    expect(monitor.status).toBe(503)
    expect(monitor.corpo.pedidos.reservasVencidasAindaPresas).toBeGreaterThanOrEqual(1)
  })
})

describe('/api/saude · pela HTTP, no servidor de dev', () => {
  it('responde o formato e nenhum valor das variáveis do ambiente aparece', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE}/api/saude`)
    expect([200, 503]).toContain(r.status)
    const texto = await r.text()
    const corpo = JSON.parse(texto)
    for (const k of ['ok', 'banco', 'webhook', 'filaDeEnvio', 'pedidos', 'vendaOnline', 'config', 'problemas']) {
      expect(corpo, k).toHaveProperty(k)
    }
    expect(Object.values(corpo.config).every((v) => v === 'SIM' || v === 'NÃO')).toBe(true)

    // todo valor de variável dos arquivos de ambiente desta máquina: nenhum sai
    const valores: string[] = []
    for (const arq of ['.env', process.env.ENV_TESTE_ARQUIVO ?? '.env.e2e-f1']) {
      let txt = ''
      try { txt = readFileSync(new URL(`../../${arq}`, import.meta.url), 'utf8') } catch { continue }
      for (const linha of txt.split('\n')) {
        const m = /^[A-Z_][A-Z0-9_]*=(.+)$/.exec(linha.trim())
        if (!m) continue
        valores.push(m[1])
        valores.push(...m[1].split(/[:@/?=,]/).filter((x) => x.length >= 12))
      }
    }
    for (const v of valores.filter((x) => x.length >= 8 && !/^https?$/.test(x))) {
      expect(texto, 'a saúde vazou o valor de uma variável do ambiente').not.toContain(v)
    }
  })
})
