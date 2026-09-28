/**
 * Auditoria com AUTOR nas rotas do evento (ADM-26, 27/09).
 *
 * Mudança de preço, estoque e taxa, lote apagado e pedido de saque gravavam `audit_log` com um
 * INSERT solto, sem `user_id` (dois deles nem `org_id`): "quem baixou o preço?" ficava sem
 * resposta. O mesmo INSERT solto estava na venda de balcão, no abrir/fechar caixa, nas sessões,
 * nas transferências e no mapa de assentos. Agora todas passam por `registrarAuditoria`, que
 * carimba usuário, organização, e-mail e IP.
 *
 * Aqui: mudar o preço de um lote, apagar outro, abrir caixa, vender e fechar — e cada linha da
 * auditoria diz quem foi. Sem servidor, PULA (`ctx.skip()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../../../../scripts/test-setup'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/admin/evento/auditoria-autor', n)
const ORG = id(1)
const USUARIO = id(2)
const EVENTO = id(3)
const SETOR = id(4)
const LOTE = id(5)
const LOTE_SOBRA = id(6)
const MARCA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL = `dono.auditoria.${MARCA}@teste.invalido`

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''
let turnoId = ''
let pedidoId = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../utils/db')
  return q<any>(texto, par)
}

async function chamar(rota: string, metodo = 'GET', corpo?: any) {
  const r = await fetch(`${BASE}/api/admin/evento/${EVENTO}${rota}`, {
    method: metodo, headers: { cookie, origin: BASE, 'content-type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  })
  const texto = await r.text()
  let j: any = {}
  try { j = JSON.parse(texto) } catch { /* vazio */ }
  return { status: r.status, corpo: j, texto }
}

const linhas = (entidade: string, alvo: string, acao: string) => sql(
  `SELECT org_id, user_id, actor_email, before, after FROM audit_log
    WHERE entity = $1 AND entity_id = $2 AND action = $3 ORDER BY id DESC`, [entidade, alvo, acao])

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/admin/evento/[id]/auditoria-autor.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [ORG, `ZZA AUDITORIA ${MARCA_MAIUSCULA}`, `zza-aud-${MARCA}`])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, fee_mode_pos, status)
     VALUES ($1,$2,$3,$4, now() + interval '5 days', now() + interval '6 days', 1000, 'absorver', 'ativo')`,
    [EVENTO, ORG, `ZZA AUDITORIA ${MARCA_MAIUSCULA}`, `zza-aud-ev-${MARCA}`])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZA SETOR')`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity, channels, visible)
             VALUES ($1,$2,'ZZA LOTE',1000,100,'{online,bilheteria}',true),
                    ($3,$2,'ZZA SOBRA',500,10,'{online}',true)`, [LOTE, SETOR, LOTE_SOBRA])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'ZZA Dono', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'`, [USUARIO, ORG, EMAIL])
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 240_000)

afterAll(async () => {
  if (!sonda.noAr) return
  // as linhas de auditoria ficam: `audit_log` é só-leitura (db/019) e não tem chave pra organização
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

function temAutor(l: any) {
  expect(l, 'a ação não deixou linha na auditoria').toBeTruthy()
  expect(l.user_id, 'auditoria sem autor: quem fez?').toBe(USUARIO)
  expect(l.org_id).toBe(ORG)
  expect(l.actor_email).toBe(EMAIL)
}

describe('toda linha da auditoria do evento diz quem fez', () => {
  it('entrou (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie).toBeTruthy()
  })

  it('mudar o preço do lote: quem, de quanto, pra quanto', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar('/ingressos', 'PATCH', { o: 'lote', id: LOTE, campos: { faceCents: 1500 } })
    expect(r.status, r.texto).toBe(200)
    const [l] = await linhas('lote', LOTE, 'editado')
    temAutor(l)
    expect(l.before.faceCents).toBe(1000)
    expect(l.after.faceCents).toBe(1500)
  }, 120_000)

  it('apagar um lote sem venda', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar('/ingressos', 'DELETE', { o: 'lote', id: LOTE_SOBRA })
    expect(r.status, r.texto).toBe(200)
    temAutor((await linhas('lot', LOTE_SOBRA, 'apagado'))[0])
  }, 120_000)

  it('abrir caixa, vender no balcão e fechar', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ponto = await chamar('/pdv', 'POST', { nome: `ZZA GUICHE ${MARCA_MAIUSCULA}`, formas: ['dinheiro', 'debito'] })
    expect(ponto.status, ponto.texto).toBe(200)
    const caixa = await chamar('/pdv/turno', 'POST', { pontoId: ponto.corpo.id, fundoCents: 0 })
    expect(caixa.status, caixa.texto).toBe(200)
    turnoId = caixa.corpo.turnoId
    temAutor((await linhas('turno', turnoId, 'aberto'))[0])

    const venda = await chamar('/pdv/venda', 'POST', { turnoId, forma: 'debito', itens: [{ lotId: LOTE, quantidade: 1 }] })
    expect(venda.status, venda.texto).toBe(200)
    pedidoId = venda.corpo.pedidoId
    temAutor((await linhas('order', pedidoId, 'venda_balcao'))[0])

    const fechou = await chamar('/pdv/turno', 'PATCH', { turnoId, contadoCents: 0 })
    expect(fechou.status, fechou.texto).toBe(200)
    temAutor((await linhas('turno', turnoId, 'fechado'))[0])
  }, 120_000)
})
