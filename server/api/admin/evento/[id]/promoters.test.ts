/**
 * A tabela de promoters é a que o produtor usa pra PAGAR o divulgador — e contava outra conta
 * (ADM-01, 27/09).
 *
 * `LEFT JOIN order_items` repetia o pedido uma vez por linha de item: um pedido de inteira + meia
 * somava a face duas vezes, contava dois pedidos e dobrava a comissão. E `status = 'pago'`
 * derrubava o pedido com estorno parcial inteiro. A régua certa já existia em Relatórios ›
 * "por promoter" (`LATERAL` + `PEDIDO_VIVO`): as duas portas agora dizem o MESMO número, e este
 * arquivo exige isso campo a campo.
 *
 * E o botão Apagar (ADM-38): a tela contava só pedido pago e oferecia "Apagar" pra quem tinha
 * carrinho expirado; a rota conta TODO pedido atribuído e respondia 409. A mesma régua nos dois.
 *
 * Vai às rotas com sessão de verdade; sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/evento/promoters', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const SETOR = id(4)
const LOTE = id(5)
const PROMOTER_A = id(6)
const PROMOTER_B = id(7)
const PROMOTER_C = id(8)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.promoters.${MARCA}@teste.invalido`

/**
 * O que o promoter A trouxe, somado na mão:
 *
 *   pedido 1  pago               inteira 60,00 + meia 40,00 (DUAS linhas)  face 100,00
 *   pedido 2  estornado_parcial  2 × 25,00 (uma linha), R$ 10 devolvidos  face  50,00
 *   pedido 3  expirado           nunca virou dinheiro                     (fora)
 *
 * Face 150,00, 2 pedidos, 4 ingressos, comissão 10% = 15,00. A conta velha dizia face 200,00
 * (o pedido 1 repetido pelo JOIN, o 2 derrubado pelo 'pago'), 2 "pedidos" e comissão 20,00.
 */
const FACE_A = 15_000
const PEDIDOS_A = 2
const INGRESSOS_A = 4
const COMISSAO_A = 1_500

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../utils/db')
  return q<any>(texto, par)
}

async function get(rota: string) {
  const r = await fetch(`${BASE}${rota}`, { headers: { cookie, origin: BASE } })
  expect(r.status, `${rota} respondeu ${r.status}`).toBe(200)
  return r.json()
}

async function pedido(sufixo: string, promoter: string, status: string, face: number,
                      estornado: number, itens: { unit: number; qtd: number }[]) {
  const [o] = await sql(
    `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method, promoter_id,
                         face_cents, fee_cents, platform_cents, discount_cents,
                         total_cents, refunded_cents, asaas_payment_id, paid_at)
     VALUES ($1,$2,$3,$4,'online','pix',$5,$6,0,0,0,$6,$7,NULL,
             CASE WHEN $4 IN ('pago','estornado_parcial') THEN now() - interval '1 day' END)
     RETURNING id`,
    [ORG, EVENTO, `ZZP-${MARCA_MAIUSCULA}-${sufixo}`, status, promoter, face, estornado])
  for (const it of itens) {
    await sql(
      `INSERT INTO order_items (order_id, lot_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents)
       VALUES ($1,$2,$3,$4,0,$4)`, [o.id, LOTE, it.qtd, it.unit])
  }
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/evento/[id]/promoters.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZP PROMOTERS ${MARCA_MAIUSCULA}`, `zzp-promoters-${MARCA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,$3,$4, now() + interval '5 days', now() + interval '6 days', 1000, 'ativo')`,
    [EVENTO, ORG, `ZZP PROMOTERS ${MARCA_MAIUSCULA}`, `zzp-promoters-ev-${MARCA}`])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZP SETOR')`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity)
             VALUES ($1,$2,'ZZP LOTE', 6000, 100)`, [LOTE, SETOR])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZP Dono Promoters', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'`, [USUARIO, ORG, EMAIL])
  await sql(
    `INSERT INTO promoters (id, event_id, name, code, commission_bps) VALUES
       ($1,$4,'ZZP Ana',   $5, 1000),
       ($2,$4,'ZZP Bruno', $6,  500),
       ($3,$4,'ZZP Caio',  $7,  500)`,
    [PROMOTER_A, PROMOTER_B, PROMOTER_C, EVENTO,
     `zzpa${MARCA}`, `zzpb${MARCA}`, `zzpc${MARCA}`])

  await pedido('A1', PROMOTER_A, 'pago', 10_000, 0, [{ unit: 6_000, qtd: 1 }, { unit: 4_000, qtd: 1 }])
  await pedido('A2', PROMOTER_A, 'estornado_parcial', 5_000, 1_000, [{ unit: 2_500, qtd: 2 }])
  await pedido('A3', PROMOTER_A, 'expirado', 3_000, 0, [{ unit: 3_000, qtd: 1 }])
  // o B só tem um carrinho que não pagou: não vendeu nada, e mesmo assim não se apaga
  await pedido('B1', PROMOTER_B, 'expirado', 6_000, 0, [{ unit: 6_000, qtd: 1 }])

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 240_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM orders WHERE org_id = $1`, [ORG])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('promoters: a tabela que paga o divulgador', () => {
  it('entrou (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()
  })

  it('pedido de duas linhas conta UMA vez; estorno parcial fica; expirado não entra (ADM-01)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { promoters } = await get(`/api/admin/evento/${EVENTO}/promoters`)
    const a = promoters.find((p: any) => p.id === PROMOTER_A)
    expect(a.faturadoCents, 'face repetida pelo JOIN com os itens, ou estorno parcial derrubado').toBe(FACE_A)
    expect(a.pedidos).toBe(PEDIDOS_A)
    expect(a.ingressos).toBe(INGRESSOS_A)
    expect(a.comissaoCents).toBe(COMISSAO_A)
    expect(a.estornadoCents).toBe(1_000)
  }, 120_000)

  it('a MESMA conta de Relatórios › por promoter, campo a campo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const [tela, rel] = await Promise.all([
      get(`/api/admin/evento/${EVENTO}/promoters`),
      get(`/api/admin/evento/${EVENTO}/relatorios`),
    ])
    const a = tela.promoters.find((p: any) => p.id === PROMOTER_A)
    const r = rel.porPromoter.find((p: any) => p.id === PROMOTER_A)
    expect(r, 'o promoter sumiu de Relatórios').toBeTruthy()
    expect(a.faturadoCents).toBe(r.faceCents)
    expect(a.comissaoCents).toBe(r.comissaoCents)
    expect(a.pedidos).toBe(r.pedidos)
    expect(a.ingressos).toBe(r.ingressos)
    expect(a.estornadoCents).toBe(r.estornadoCents)
    // o rodapé da tela é a soma das linhas: com o A certo, o total também fecha
    const total = tela.promoters.reduce((s: number, p: any) => s + p.comissaoCents, 0)
    expect(total).toBe(rel.porPromoter.reduce((s: number, p: any) => s + p.comissaoCents, 0))
  }, 120_000)

  it('Apagar: a tela e a rota usam a mesma régua (ADM-38)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { promoters } = await get(`/api/admin/evento/${EVENTO}/promoters`)
    const b = promoters.find((p: any) => p.id === PROMOTER_B)
    const c = promoters.find((p: any) => p.id === PROMOTER_C)
    expect(b.pedidos, 'o B não vendeu nada').toBe(0)
    expect(b.podeApagar, 'a tela oferece Apagar pra quem a rota recusa').toBe(false)
    expect(b.pedidosAtribuidos).toBe(1)
    expect(c.podeApagar).toBe(true)

    const apagarB = await fetch(`${BASE}/api/admin/evento/${EVENTO}/promoters`, {
      method: 'DELETE', headers: { cookie, origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ id: PROMOTER_B }),
    })
    expect(apagarB.status).toBe(409)
    const apagarC = await fetch(`${BASE}/api/admin/evento/${EVENTO}/promoters`, {
      method: 'DELETE', headers: { cookie, origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ id: PROMOTER_C }),
    })
    expect(apagarC.status).toBe(200)
  }, 120_000)
})
