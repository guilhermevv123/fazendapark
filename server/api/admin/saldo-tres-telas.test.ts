/**
 * Um evento, um saldo — nas três telas que mostram dinheiro a receber.
 *
 * O defeito medido pelo QA: evento com R$ 840 pela plataforma e R$ 135 em
 * espécie no balcão.
 *
 *   antes de sacar          → financeiro do evento R$ 840, organização R$ 975
 *   R$ 500 transferidos e
 *   R$ 340 pedidos          → evento R$ 0, organização R$ 135, borderô R$ 475
 *
 * Três contas diferentes do mesmo dinheiro. A organização somava o balcão (que
 * está na gaveta do produtor) e o borderô ignorava o saque em curso. O número
 * certo é o de `saldoParaSaque` (na plataforma − transferido − em curso), e o
 * recebido direto aparece à parte, com nome, nas três.
 *
 * Vai às ROTAS, não à função: o que precisa ficar travado é cada tela chamar
 * a mesma régua, e só a rota prova isso.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/saldo-tres-telas', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.saldo-tres-telas.${MARCA}@teste.invalido`

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../utils/db')
  return q<any>(texto, par)
}

const get = async (rota: string) => {
  const r = await fetch(`${BASE}${rota}`, { headers: { cookie, origin: BASE } })
  expect(r.status, `${rota} respondeu ${r.status}`).toBe(200)
  return r.json()
}

/** o saldo que cada uma das três telas mostra para este evento */
async function saldos() {
  const fin = await get(`/api/admin/evento/${EVENTO}/financeiro`)
  const bor = await get(`/api/admin/evento/${EVENTO}/bordero`)
  const org = await get('/api/admin/financeiro')
  const linhaOrg = org.eventos.find((e: any) => e.id === EVENTO)
  return {
    evento: fin.resumo.retidoCents + fin.resumo.disponivelCents,
    eventoDisponivel: fin.resumo.disponivelCents,
    organizacao: linhaOrg.retidoCents + linhaOrg.disponivelCents,
    organizacaoDisponivel: linhaOrg.disponivelCents,
    bordero: bor.totais.aReceberCents,
    diretoEvento: fin.resumo.recebidoDiretoCents,
    diretoOrganizacao: linhaOrg.recebidoDiretoCents,
    diretoBordero: bor.totais.recebidoDiretoCents,
    emCursoBordero: bor.totais.emCursoCents,
  }
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/saldo-tres-telas.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)
             ON CONFLICT (id) DO NOTHING`,
  [ORG, `ZZQA SALDO ${MARCA_MAIUSCULA}`, `zzqa-saldo-${MARCA}`])
  // Evento vencido há tempo: passa da retenção, então "retido" é zero e o
  // saldo inteiro é disponível — é o caso medido pelo QA.
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,$3,$4, now() - interval '60 days', now() - interval '59 days', 1000, 'ativo')
     ON CONFLICT (id) DO NOTHING`,
    [EVENTO, ORG, `ZZQA EVENTO SALDO ${MARCA_MAIUSCULA}`, `zzqa-evento-saldo-${MARCA}`])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZQA Dono Saldo', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [USUARIO, ORG, EMAIL])

  // R$ 840 pela plataforma (cobrança no gateway) …
  await sql(
    `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method,
                         face_cents, fee_cents, platform_cents, discount_cents,
                         total_cents, refunded_cents, asaas_payment_id, paid_at)
     VALUES ($1,$2,$3,'pago','online','pix', 84000, 0, 0, 0, 84000, 0, $4, now() - interval '60 days')`,
    [ORG, EVENTO, `ZZQA-SALDO-${MARCA_MAIUSCULA}-1`, `pay_zzqa_saldo_${MARCA}`])
  // … e R$ 135 em espécie no balcão, que nunca passou por ela.
  await sql(
    `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method,
                         face_cents, fee_cents, platform_cents, discount_cents,
                         total_cents, refunded_cents, asaas_payment_id, paid_at)
     VALUES ($1,$2,$3,'pago','bilheteria','dinheiro', 13500, 0, 0, 0, 13500, 0, NULL, now() - interval '60 days')`,
    [ORG, EVENTO, `ZZQA-SALDO-${MARCA_MAIUSCULA}-2`])

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 40_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM payouts WHERE org_id = $1`, [ORG])
  await sql(`DELETE FROM orders WHERE org_id = $1`, [ORG])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('saldo a receber: um número só nas três telas', () => {
  it('entrou (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()
  })

  it('antes de sacar: R$ 840 nas três, R$ 135 de balcão à parte', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const s = await saldos()
    expect(s.evento).toBe(84_000)
    expect(s.organizacao, 'a organização somou o dinheiro do balcão ao saldo').toBe(84_000)
    expect(s.bordero).toBe(84_000)
    expect(s.eventoDisponivel).toBe(84_000)
    expect(s.organizacaoDisponivel).toBe(84_000)
    for (const d of [s.diretoEvento, s.diretoOrganizacao, s.diretoBordero]) {
      expect(d, 'o recebido direto sumiu de uma das telas').toBe(13_500)
    }
  }, 30_000)

  it('R$ 500 transferidos e R$ 340 pedidos: zero nas três', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    await sql(
      `INSERT INTO payouts (org_id, event_id, code, beneficiary_name, destination_kind,
                            destination, amount_cents, status)
       VALUES ($1,$2,$3,'ZZQA Beneficiario','pix','zzqa@teste.invalido', 50000, 'concluida'),
              ($1,$2,$4,'ZZQA Beneficiario','pix','zzqa@teste.invalido', 34000, 'solicitada')`,
      [ORG, EVENTO, `ZZQA-SALDO-${MARCA_MAIUSCULA}-P1`, `ZZQA-SALDO-${MARCA_MAIUSCULA}-P2`])

    const s = await saldos()
    expect(s.evento).toBe(0)
    expect(s.organizacao, 'organização ofereceu de novo os R$ 135 da gaveta').toBe(0)
    expect(s.bordero, 'borderô ignorou o saque em curso e somou o balcão').toBe(0)
    expect(s.emCursoBordero).toBe(34_000)
    for (const d of [s.diretoEvento, s.diretoOrganizacao, s.diretoBordero]) {
      expect(d).toBe(13_500)
    }
  }, 30_000)
})
