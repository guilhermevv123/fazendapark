/**
 * Prazo da venda online por dia (dono, 09/10), por HTTP — a vitrine, a home e o checkout.
 *
 * "Se o primeiro ingresso é sexta-feira, quinta-feira tem que acabar ... se o próximo evento começa
 * quarta, só pode comprar até terça, quando der meia-noite ... depois é na portaria, presencial."
 * O que este arquivo prova:
 *  1. o tipo de ONTEM e o de HOJE saem da página do evento; o de AMANHÃ continua; tipo SEM dia segue
 *     o 1º dia do evento (que já começou: sai também); a página diz quais dias são "só na portaria";
 *  2. o checkout recusa o tipo de hoje com a frase do dia (mesmo montando a compra na mão) e vende o
 *     de amanhã;
 *  3. a home anuncia o "a partir de" só com o que ainda vende; evento com todos os dias começados
 *     aparece "encerrado" e a página dele diz "venda pelo site encerrada".
 *
 * Fixtura desta corrida, apagada no fim. Sem servidor de teste no ar, PULA.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor, uuidDaCorrida, type Sonda } from '../../scripts/test-setup'
import { diaDeUsoDe, rotuloDoDiaDeUso } from '../utils/dias-de-uso'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/prazo-venda-online', n)
const ORG = id(1)
const EVENTO = id(2)
const SETOR = id(3)
const LOTE = id(4)
const T_ONTEM = id(5)
const T_HOJE = id(6)
const T_AMANHA = id(7)
const LOTE_LIVRE = id(8)
const T_LIVRE = id(9)
const EVENTO_FIM = id(10)
const SETOR_FIM = id(11)
const LOTE_FIM = id(12)
const T_FIM = id(13)
const M = MARCA_MAIUSCULA.toLowerCase()
const SLUG = `zz-prazo-${M}`
const SLUG_FIM = `zz-prazo-fim-${M}`

const FUSO = 'America/Bahia'
const HOJE = diaDeUsoDe(new Date(), FUSO)
const soma = (dia: string, n: number) => new Date(new Date(`${dia}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10)
const ONTEM = soma(HOJE, -1)
const AMANHA = soma(HOJE, 1)

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../utils/db')
  return q<any>(texto, par)
}
function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}
async function comprar(tipo: string, lote = LOTE) {
  const r = await fetch(`${BASE}/api/checkout`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventSlug: SLUG, itens: [{ lotId: lote, ticketTypeId: tipo, quantidade: 1 }], forma: 'pix',
      comprador: { nome: 'Comprador do Prazo', email: `prazo.${Date.now()}@exemplo.com`, documento: cpf(), telefone: '73998260963' } }),
  })
  const corpo = await r.json().catch(() => ({})) as any
  return { status: r.status, corpo, recado: corpo.statusMessage ?? corpo.message ?? '' }
}
const getJson = async (rota: string) => (await fetch(`${BASE}${rota}`)).json() as Promise<any>

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/prazo-venda-online.test.ts', sonda)
  if (!sonda.noAr) return
  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`, [ORG, `ZZ PRAZO ${M}`, `zz-prazo-org-${M}`])
  // começou ONTEM, termina daqui a 3 dias: a porta do EVENTO está aberta
  const evento = (eid: string, slug: string, inicio: string, fim: string) => sql(
    `INSERT INTO events (id, org_id, name, slug, status, starts_at, ends_at, timezone, fee_bps, fee_mode_online)
     VALUES ($1,$2,$3,$4,'ativo',$5::timestamptz,$6::timestamptz,'America/Bahia',0,'repassar')`,
    [eid, ORG, `ZZ PRAZO ${slug}`, slug, inicio, fim])
  await evento(EVENTO, SLUG, `${ONTEM}T12:00:00Z`, `${soma(HOJE, 3)}T20:00:00Z`)
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'Geral')`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity, max_per_order, channels, sort_order)
             VALUES ($1,$2,'1º lote',2000,500,20,'{online}',1), ($3,$2,'Avulso',1500,500,20,'{online}',2)`, [LOTE, SETOR, LOTE_LIVRE])
  const tipo = (tid: string, lote: string, nome: string, dias: string[] | null, preco: number) => sql(
    `INSERT INTO ticket_types (id, lot_id, name, quantity, valid_dates, price_cents) VALUES ($1,$2,$3,500,$4::date[],$5)`,
    [tid, lote, nome, dias, preco])
  await tipo(T_ONTEM, LOTE, 'ZZ ENTRADA ONTEM', [ONTEM], 1000)
  await tipo(T_HOJE, LOTE, 'ZZ ENTRADA HOJE', [HOJE], 2000)
  await tipo(T_AMANHA, LOTE, 'ZZ ENTRADA AMANHA', [AMANHA], 3000)
  await tipo(T_LIVRE, LOTE_LIVRE, 'ZZ ENTRADA QUALQUER DIA', null, 500)

  // o outro: começou ontem, só tem tipo de HOJE — nada mais vende pelo site
  await evento(EVENTO_FIM, SLUG_FIM, `${ONTEM}T12:00:00Z`, `${soma(HOJE, 2)}T20:00:00Z`)
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'Geral')`, [SETOR_FIM, EVENTO_FIM])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity, max_per_order, channels)
             VALUES ($1,$2,'1º lote',2000,500,20,'{online}')`, [LOTE_FIM, SETOR_FIM])
  await tipo(T_FIM, LOTE_FIM, 'ZZ SO HOJE', [HOJE], 2000)
}, 30_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM orders WHERE event_id IN ($1,$2)`, [EVENTO, EVENTO_FIM]).catch(() => {})
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG]).catch(() => {})
})

describe('prazo da venda online por dia (09/10)', () => {
  it('a página do evento só oferece o dia que ainda não começou, e diz o que é só na portaria', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await getJson(`/api/e/${SLUG}`)
    const nomes = r.setores.flatMap((s: any) => s.lotes.flatMap((l: any) => l.variacoes.map((v: any) => v.nome)))
    expect(nomes).toEqual(['ZZ ENTRADA AMANHA'])
    expect(r.setores[0].lotes.map((l: any) => l.id), 'lote sem variação viva sobrou (viraria venda sem tipo)')
      .toEqual([LOTE])
    expect(r.evento.soNaPortaria).toContain(rotuloDoDiaDeUso(HOJE))
    expect(r.evento.soNaPortaria).toContain(rotuloDoDiaDeUso(ONTEM))
    expect(r.evento.aPartirDeCents).toBe(3000)
  })

  it('o checkout recusa o dia que já começou (montado na mão) e vende o de amanhã', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const hoje = await comprar(T_HOJE)
    expect(hoje.status).toBe(409)
    expect(hoje.corpo.data?.tipo).toBe('venda_online_encerrada')
    expect(hoje.recado).toContain(rotuloDoDiaDeUso(HOJE))
    expect(hoje.recado).toContain('portaria')
    const livre = await comprar(T_LIVRE, LOTE_LIVRE)
    expect(livre.status, 'tipo sem dia num evento que já começou vendeu').toBe(409)
    const amanha = await comprar(T_AMANHA)
    expect(amanha.status, amanha.recado).toBe(200)
  })

  it('a home: preço só do que vende; evento com todos os dias começados aparece encerrado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await getJson('/api/eventos-publicos')
    const meu = r.eventos.find((e: any) => e.slug === SLUG)
    expect(meu).toMatchObject({ aPartirDeCents: 3000 })
    const fim = r.eventos.find((e: any) => e.slug === SLUG_FIM)
    expect(fim?.situacao).toBe('encerrado')
    const pagina = await getJson(`/api/e/${SLUG_FIM}`)
    expect(pagina.setores).toEqual([])
    expect(pagina.evento.soNaPortaria).toBe(rotuloDoDiaDeUso(HOJE))
  })
})
