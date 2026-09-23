/**
 * caminho-codificado.test.ts — o portão lê o MESMO caminho que o roteador.
 *
 * Em 22/09, `/api/%61dmin/...` passava pelos três middlewares como se não
 * fosse painel (eles liam o caminho cru) e o roteador, que decodifica, entregava
 * o handler: participantes, borderô e criação de cupom respondiam 200 sem login.
 * Sem servidor de dev no ar, PULA.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../scripts/test-setup'
import { caminhoDaRota } from '../utils/caminho'
import { q1 } from '../utils/db'

const BASE = BASE_DE_TESTE
let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let evento = ''
const cookie: Record<string, string> = {}

async function entrar(email: string) {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha: 'diamond123' }),
  })
  return (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}

const status = async (rota: string, init: RequestInit = {}) =>
  (await fetch(`${BASE}${rota}`, init)).status

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/caminho-codificado.test.ts', sonda)
  if (!sonda.noAr) return
  evento = (await q1<any>(`SELECT id FROM events ORDER BY created_at LIMIT 1`))?.id ?? ''
  cookie.master = await entrar('dono@fazendapark.com.br')
  cookie.portaria = await entrar('portaria@fazendapark.com.br')
})

describe('caminhoDaRota', () => {
  const ev = (path: string) => ({ path }) as any
  it('tira query, barras repetidas e a barra final — e mantém o decodificado que vier', () => {
    expect(caminhoDaRota(ev('/api/admin/eventos?x=1'))).toBe('/api/admin/eventos')
    expect(caminhoDaRota(ev('/api//admin///evento/'))).toBe('/api/admin/evento')
    expect(caminhoDaRota(ev('/'))).toBe('/')
  })
})

describe('URL codificada não pula o portão', () => {
  it('sem login: toda variação do painel dá 401 ou 404, nunca 200', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    for (const rota of [
      `/api/%61dmin/evento/${evento}/participantes`,
      `/api/%61dmin/evento/${evento}/bordero`,
      `/api/admin/%65vento/${evento}/vendas`,
      `/api//admin/evento/${evento}/vendas`,
      `/api/admin/evento/${evento}/vendas/`,
      `/api/%63heckin`,
    ]) {
      expect([401, 404], rota).toContain(await status(rota))
    }
    // escrita anônima era o pior caso: criava cupom de 100% em evento alheio
    expect(await status(`/api/%61dmin/evento/${evento}/cupons`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codigo: 'CAMINHOCOD', tipo: 'percentual', valor: 10000 }),
    })).toBe(401)
  })

  it('portaria continua barrada da equipe com o caminho codificado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(await status('/api/%61dmin/equipe', { headers: { cookie: cookie.portaria! } })).toBe(403)
  })

  it('o master abre a mesma rota codificada — o conserto não trancou quem pode', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(await status('/api/%61dmin/eventos', { headers: { cookie: cookie.master! } })).toBe(200)
  })
})

describe('mutação de outro site', () => {
  it('Origin estranho ou Sec-Fetch-Site cross-site dão 403 mesmo logado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const corpo = { method: 'PATCH', body: JSON.stringify({ nome: 'x' }) }
    expect(await status('/api/admin/organizacao', { ...corpo,
      headers: { cookie: cookie.master!, 'content-type': 'application/json', origin: 'https://golpe.invalido' } })).toBe(403)
    expect(await status('/api/admin/organizacao', { ...corpo,
      headers: { cookie: cookie.master!, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } })).toBe(403)
  })
})
