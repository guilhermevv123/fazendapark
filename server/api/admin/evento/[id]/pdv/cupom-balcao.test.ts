/**
 * Cupom no BALCÃO pela régua do site (ADM-15, 27/09).
 *
 * A rota do guichê lia o cupom num SELECT solto (`uses < max_uses`) fora da transação e somava
 * `uses + 1` depois: dois caixas passavam juntos num cupom de 1 uso; "1 por pessoa" e o teto de
 * desconto eram ignorados; e como o placar `uses` também é gasto por carrinho online que expirou,
 * o balcão recusava cupom que o site aceitava. Agora é `resgatarCupom`/`aplicarCupom`
 * (`utils/cupom.ts`), dentro da transação da venda, depois de `reservar()`.
 *
 * A tela do balcão não tem campo de cupom — o risco é de chamada direta, e é assim que o teste
 * chama. Sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../../../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/evento/pdv/cupom-balcao', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const SETOR = id(4)
const LOTE = id(5)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.cupom-balcao.${MARCA}@teste.invalido`
const PRECO = 10_000
const CPF_1 = '52998224725'
const CPF_2 = '11144477735'
const CPF_3 = '39053344705'

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''
let turnoId = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../../utils/db')
  return q<any>(texto, par)
}

async function chamar(rota: string, corpo?: any) {
  const r = await fetch(`${BASE}/api/admin/evento/${EVENTO}${rota}`, {
    method: corpo === undefined ? 'GET' : 'POST',
    headers: { cookie, origin: BASE, 'content-type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({} as any)) }
}

const vender = (cupom: string | null, cpf: string | null) => chamar('/pdv/venda', {
  turnoId, forma: 'debito', itens: [{ lotId: LOTE, quantidade: 1 }],
  ...(cupom ? { cupom } : {}),
  ...(cpf ? { comprador: { nome: 'Cliente Cupom', documento: cpf } } : {}),
})

async function cupom(codigo: string, campos: Record<string, any>) {
  await sql(
    `INSERT INTO promo_codes (event_id, code, kind, value, max_uses, max_per_customer, max_discount_cents, uses)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [EVENTO, codigo, campos.kind ?? 'percentual', campos.value ?? 1000, campos.maxUses ?? null,
     campos.porPessoa ?? 1, campos.teto ?? null, campos.uses ?? 0])
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/evento/[id]/pdv/cupom-balcao.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZK CUPOM BALCAO ${MARCA_MAIUSCULA}`, `zzk-cupom-${MARCA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, fee_mode_pos, status)
     VALUES ($1,$2,$3,$4, now() + interval '5 days', now() + interval '6 days', 1000, 'absorver', 'ativo')`,
    [EVENTO, ORG, `ZZK CUPOM BALCAO ${MARCA_MAIUSCULA}`, `zzk-cupom-ev-${MARCA}`])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZK SETOR')`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity, channels, visible)
             VALUES ($1,$2,'ZZK LOTE',$3,100,'{online,bilheteria}',true)`, [LOTE, SETOR, PRECO])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZK Dono', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'`, [USUARIO, ORG, EMAIL])

  // um uso de verdade de cada; o 'PLACAR' tem o contador `uses` estourado por carrinho expirado
  await cupom('UMVEZ', { maxUses: 1 })
  await cupom('PORPESSOA', { porPessoa: 1 })
  await cupom('TETO', { value: 5000, teto: 1000 })
  await cupom('PLACAR', { maxUses: 3, uses: 3 })

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
  const ponto = await chamar('/pdv', { nome: `ZZK GUICHE ${MARCA_MAIUSCULA}`, formas: ['dinheiro', 'debito'] })
  if (ponto.status !== 200) throw new Error(`ponto: ${JSON.stringify(ponto.corpo)}`)
  const caixa = await chamar('/pdv/turno', { pontoId: ponto.corpo.id, fundoCents: 0 })
  if (caixa.status !== 200) throw new Error(`caixa: ${JSON.stringify(caixa.corpo)}`)
  turnoId = caixa.corpo.turnoId
}, 240_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

const pedidosCom = async (codigo: string) => Number((await sql(
  `SELECT count(*)::int AS n FROM orders o JOIN promo_codes pc ON pc.id = o.promo_code_id
    WHERE pc.event_id = $1 AND pc.code = $2`, [EVENTO, codigo]))[0].n)

describe('cupom no balcão: a régua do site', () => {
  it('entrou e abriu o caixa (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie).toBeTruthy()
    expect(turnoId).toBeTruthy()
  })

  it('cupom de 1 uso em dois caixas ao mesmo tempo: só uma venda leva', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const rs = await Promise.all([vender('UMVEZ', CPF_1), vender('UMVEZ', CPF_2)])
    const aceitas = rs.filter((r) => r.status === 200)
    expect(aceitas.length, `as duas passaram: ${JSON.stringify(rs.map((r) => r.status))}`).toBe(1)
    const recusada = rs.find((r) => r.status !== 200)!
    expect(recusada.status).toBe(409)
    expect(recusada.corpo.data?.motivo).toBe('esgotado')
    expect(await pedidosCom('UMVEZ')).toBe(1)
  }, 120_000)

  it('"1 por pessoa" vale no guichê, mesmo sem e-mail (o CPF vai no ingresso)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const primeira = await vender('PORPESSOA', CPF_3)
    expect(primeira.status, JSON.stringify(primeira.corpo)).toBe(200)
    const segunda = await vender('PORPESSOA', CPF_3)
    expect(segunda.status, 'o mesmo CPF usou de novo o cupom "1 por pessoa"').toBe(409)
    expect(segunda.corpo.data?.motivo).toBe('uma_vez_por_pessoa')
    // outra pessoa continua podendo
    expect((await vender('PORPESSOA', CPF_1)).status).toBe(200)
  }, 120_000)

  it('o teto de desconto segura o percentual', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await vender('TETO', CPF_2)
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(r.corpo.descontoCents, '50% de R$ 100 passou do teto de R$ 10').toBe(1_000)
    expect(r.corpo.totalCents).toBe(PRECO - 1_000)
  }, 120_000)

  it('o placar `uses` estourado por carrinho expirado não recusa: vale a contagem dos pedidos', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await vender('PLACAR', CPF_1)
    expect(r.status, `recusou cupom que o site aceitaria: ${JSON.stringify(r.corpo)}`).toBe(200)
  }, 120_000)

  it('cupom sem CPF no balcão: 422 com o porquê', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await vender('TETO', null)
    expect(r.status).toBe(422)
    expect(r.corpo.data?.motivo).toBe('sem_cpf')
  }, 120_000)
})
