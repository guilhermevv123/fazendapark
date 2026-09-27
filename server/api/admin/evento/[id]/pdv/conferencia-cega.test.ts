/**
 * Conferência de caixa CEGA — de verdade, não só na tela (ADM-07, 27/09).
 *
 * A tela prometia esconder o esperado até a contagem, mas a rota do turno devolvia
 * `esperadoCents` e as quatro parcelas (fundo, vendas em dinheiro, suprimentos, sangrias) com
 * o caixa aberto, e a recusa de uma sangria grande escrevia "A gaveta deste caixa deve ter
 * R$ X". Quem conta lia o alvo e digitava o alvo — a diferença de caixa sumia.
 *
 * Aqui: caixa aberto com R$ 100 de fundo e uma venda de R$ 30 em dinheiro (esperado R$ 130).
 * A Operação (quem conta) não recebe o número por caminho nenhum; o master recebe; depois de
 * fechado, todo mundo vê. Sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../../../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/evento/pdv/conferencia-cega', n)
const ORG = id(1)
const MASTER = id(2)
const OPERACAO = id(3)
const EVENTO = id(4)
const SETOR = id(5)
const LOTE = id(6)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL_MASTER = `dono.conferencia-cega.${MARCA}@teste.invalido`
const EMAIL_OPERACAO = `operacao.conferencia-cega.${MARCA}@teste.invalido`

const FUNDO = 10_000
const VENDA = 3_000
const ESPERADO = FUNDO + VENDA

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let master = ''
let operacao = ''
let turnoId = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../../utils/db')
  return q<any>(texto, par)
}

async function entrar(email: string) {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha: 'diamond123' }),
  })
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}

async function chamar(quem: string, rota: string, metodo = 'GET', corpo?: any) {
  const r = await fetch(`${BASE}/api/admin/evento/${EVENTO}${rota}`, {
    method: metodo,
    headers: { cookie: quem, origin: BASE, 'content-type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  })
  const texto = await r.text()
  let corpoJson: any = {}
  try { corpoJson = JSON.parse(texto) } catch { /* corpo vazio */ }
  return { status: r.status, corpo: corpoJson, texto }
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/evento/[id]/pdv/conferencia-cega.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZC CEGA ${MARCA_MAIUSCULA}`, `zzc-cega-${MARCA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, fee_mode_pos, status)
     VALUES ($1,$2,$3,$4, now() + interval '5 days', now() + interval '6 days', 1000, 'absorver', 'ativo')`,
    [EVENTO, ORG, `ZZC CEGA ${MARCA_MAIUSCULA}`, `zzc-cega-ev-${MARCA}`])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZC SETOR')`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity, channels, visible)
             VALUES ($1,$2,'ZZC LOTE',$3,100,'{online,bilheteria}',true)`, [LOTE, SETOR, VENDA])
  for (const [uid, email, papel, role] of [
    [MASTER, EMAIL_MASTER, 'master', 'master'], [OPERACAO, EMAIL_OPERACAO, 'operacao', 'operacional'],
  ]) {
    await sql(
      `INSERT INTO users (id, org_id, name, email, password_hash, role, papel)
       SELECT $1, $2, 'ZZC Conferência', $3, password_hash, $5, $4
         FROM users WHERE email = 'dono@fazendapark.com.br' LIMIT 1`, [uid, ORG, email, papel, role])
  }
  master = await entrar(EMAIL_MASTER)
  operacao = await entrar(EMAIL_OPERACAO)

  const ponto = await chamar(master, '/pdv', 'POST', { nome: `ZZC GUICHE ${MARCA_MAIUSCULA}`, formas: ['dinheiro', 'debito'] })
  if (ponto.status !== 200) throw new Error(`ponto: ${ponto.texto}`)
  const caixa = await chamar(master, '/pdv/turno', 'POST', { pontoId: ponto.corpo.id, fundoCents: FUNDO })
  if (caixa.status !== 200) throw new Error(`caixa: ${caixa.texto}`)
  turnoId = caixa.corpo.turnoId
  const venda = await chamar(operacao, '/pdv/venda', 'POST', {
    turnoId, forma: 'dinheiro', itens: [{ lotId: LOTE, quantidade: 1 }], recebidoCents: VENDA,
  })
  if (venda.status !== 200) throw new Error(`venda: ${venda.texto}`)
}, 240_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('conferência cega do caixa', () => {
  it('as duas sessões existem (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(master).toBeTruthy()
    expect(operacao).toBeTruthy()
    expect(turnoId).toBeTruthy()
  })

  it('caixa aberto: quem conta não recebe o esperado nem as parcelas', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar(operacao, `/pdv/turno?turno=${turnoId}`)
    expect(r.status).toBe(200)
    const c = r.corpo.contagem
    expect(c.cega).toBe(true)
    expect(c.esperadoCents, 'a rota entrega o alvo da conferência cega').toBeNull()
    expect(c.dinheiroCents).toBeNull()
    expect(c.aberturaCents).toBeNull()
    expect(c.porForma.some((f: any) => f.forma === 'dinheiro'), 'o dinheiro veio pela lista por forma').toBe(false)
    // nem em lugar nenhum da resposta: o número inteiro do esperado não aparece
    expect(r.texto.includes(String(ESPERADO)), 'o esperado vazou em algum campo').toBe(false)
    expect(c.pedidos).toBe(1)
  }, 120_000)

  it('o master continua vendo o dinheiro da gaveta', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar(master, `/pdv/turno?turno=${turnoId}`)
    expect(r.corpo.contagem.cega).toBe(false)
    expect(r.corpo.contagem.esperadoCents).toBe(ESPERADO)
  }, 120_000)

  it('sangria acima do saldo: recusa sem dizer quanto a gaveta deve ter', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar(operacao, '/pdv/gaveta', 'POST', {
      turnoId, tipo: 'sangria', valorCents: 999_900, motivo: 'teste',
    })
    expect(r.status).toBe(409)
    expect(r.texto.includes('130,00'), `a recusa entregou o esperado: ${r.corpo.statusMessage}`).toBe(false)
    expect(r.corpo.data?.saldoCents).toBeUndefined()
    expect(String(r.corpo.statusMessage)).toContain('maior que o dinheiro')
  }, 120_000)

  it('depois de fechado, o esperado aparece pra todo mundo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const f = await chamar(operacao, '/pdv/turno', 'PATCH', { turnoId, contadoCents: 12_000 })
    expect(f.status, f.texto).toBe(200)
    const r = await chamar(operacao, `/pdv/turno?turno=${turnoId}`)
    expect(r.corpo.contagem.cega).toBe(false)
    expect(r.corpo.turno.esperadoNoFechamentoCents).toBe(ESPERADO)
    expect(r.corpo.turno.contadoCents).toBe(12_000)
  }, 120_000)
})
