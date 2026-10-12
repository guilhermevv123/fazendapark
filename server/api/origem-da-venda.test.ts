/**
 * De onde veio a venda (052), por HTTP — dono, 11/10: "a gente está com o tráfego pago ativo e eu não
 * consigo saber de onde está vindo a pessoa ... na aba relatório preciso saber também".
 *
 *  1. a visita sobe com a origem, uma vez por aba; de outro site, não grava;
 *  2. o checkout grava a origem no pedido (reclassificada no servidor) e origem torta não recusa a
 *     compra;
 *  3. o relatório do evento separa tráfego pago, robô e direto, por campanha, com visitas e conversão.
 *
 * Fixtura desta corrida, apagada no fim. Sem servidor de teste no ar, PULA.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor, uuidDaCorrida, type Sonda } from '../../scripts/test-setup'
import { diaDeUsoDe } from '../utils/dias-de-uso'

const BASE = BASE_DE_TESTE
const id = (n: number) => uuidDaCorrida('api/origem-da-venda', n)
const ORG = id(1)
const EVENTO = id(2)
const SETOR = id(3)
const LOTE = id(4)
const TIPO = id(5)
const M = MARCA_MAIUSCULA.toLowerCase()
const SLUG = `zz-origem-${M}`
const EMAIL = `master.origem.${M}@origem.invalido`
const VISITANTE = `zzorigem${M}`.replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 40)
const AMANHA = new Date(new Date(`${diaDeUsoDe(new Date(), 'America/Bahia')}T12:00:00Z`).getTime() + 86_400_000)
  .toISOString().slice(0, 10)

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

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
const visita = (corpo: any, origemHeader = BASE) => fetch(`${BASE}/api/origem/visita`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: origemHeader }, body: JSON.stringify(corpo) })
async function comprar(origem: any) {
  const r = await fetch(`${BASE}/api/checkout`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventSlug: SLUG, itens: [{ lotId: LOTE, ticketTypeId: TIPO, quantidade: 2 }], forma: 'pix', origem,
      comprador: { nome: 'Comprador da Origem', email: `origem.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@exemplo.com`,
                   documento: cpf(), telefone: '73998260963' } }),
  })
  const corpo = await r.json().catch(() => ({})) as any
  return { status: r.status, corpo }
}
const anuncio = { fonte: 'meta', meio: 'paid_social', campanha: `zz-campanha-${M}`, conteudo: 'video-1', clique: 'fbclid',
                  entrada: '/', em: new Date().toISOString(), tipo: 'direto' /* mentira do navegador: o servidor reclassifica */ }

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/origem-da-venda.test.ts', sonda)
  if (!sonda.noAr) return
  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`, [ORG, `ZZ ORIGEM ${M}`, `zz-origem-org-${M}`])
  await sql(`INSERT INTO events (id, org_id, name, slug, status, starts_at, ends_at, timezone, fee_bps, fee_mode_online, created_at)
             VALUES ($1,$2,'ZZ ORIGEM',$3,'ativo',$4::timestamptz,$5::timestamptz,'America/Bahia',0,'repassar', now() - interval '1 hour')`,
    [EVENTO, ORG, SLUG, `${AMANHA}T12:00:00Z`, `${AMANHA}T20:00:00Z`])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'Geral')`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity, max_per_order, channels)
             VALUES ($1,$2,'1º lote',2000,500,20,'{online}')`, [LOTE, SETOR])
  await sql(`INSERT INTO ticket_types (id, lot_id, name, quantity, price_cents) VALUES ($1,$2,'ZZ ENTRADA',500,2000)`, [TIPO, LOTE])
  await sql(`INSERT INTO users (org_id, name, email, password_hash, role, papel)
             SELECT $1, 'Master da Origem', $2, password_hash, 'master', 'master' FROM users WHERE email = 'dono@fazendapark.com.br'`,
    [ORG, EMAIL])
  const r = await fetch(`${BASE}/api/auth/entrar`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }) })
  cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]!).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 30_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await sql(`DELETE FROM site_visits WHERE visitante LIKE $1`, [`${VISITANTE.slice(0, 12)}%`]).catch(() => {})
  await sql(`DELETE FROM orders WHERE event_id = $1`, [EVENTO]).catch(() => {})
  await sql(`DELETE FROM users WHERE org_id = $1`, [ORG]).catch(() => {})
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG]).catch(() => {})
})

describe('de onde veio a venda (052)', () => {
  it('a visita sobe com a origem, uma vez por aba; vinda de outro site não grava', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    for (const [aba, origem] of [['aba-paga-1', anuncio], ['aba-paga-2', anuncio], ['aba-robo-1',
      { fonte: 'whatsapp', meio: 'robo', campanha: 'sofia' }], ['aba-direta-1', null]] as const) {
      const r = await visita({ visitante: `${VISITANTE}${aba.slice(-1)}`, aba: `${aba}-${M}`, caminho: '/', origem })
      expect(r.status).toBe(204)
    }
    // recarregar a mesma aba não conta de novo
    await visita({ visitante: `${VISITANTE}1`, aba: `aba-paga-1-${M}`, caminho: `/e/${SLUG}`, origem: anuncio })
    expect((await visita({ visitante: `${VISITANTE}9`, aba: `aba-fora-${M}`, caminho: '/', origem: anuncio },
      'https://golpe.example')).status).toBe(204)
    const v = await sql(`SELECT tipo, campanha FROM site_visits WHERE visitante LIKE $1 ORDER BY tipo`, [`${VISITANTE.slice(0, 12)}%`])
    expect(v.map((x: any) => x.tipo)).toEqual(['direto', 'pago', 'pago', 'robo'])
  })

  it('o checkout grava a origem no pedido; origem torta não recusa a compra', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const pago = await comprar({ ultimo: anuncio, primeiro: { fonte: 'instagram', meio: 'bio', em: new Date().toISOString() } })
    expect(pago.status, JSON.stringify(pago.corpo)).toBe(200)
    const robo = await comprar({ ultimo: { fonte: 'whatsapp', meio: 'robo', campanha: 'sofia', em: new Date().toISOString() } })
    expect(robo.status).toBe(200)
    const torta = await comprar({ ultimo: { clique: 'inventado' } })
    expect(torta.status, 'origem torta derrubou a compra').toBe(200)
    // anúncio rodando SEM UTM: só o fbclid chega (dono 11/10: conta como tráfego pago no relatório)
    const semUtm = await comprar({ ultimo: { clique: 'fbclid', referencia: 'l.instagram.com', em: new Date().toISOString() } })
    expect(semUtm.status).toBe(200)
    const pedidos = await sql(`SELECT origem FROM orders WHERE event_id = $1 ORDER BY created_at`, [EVENTO])
    expect(pedidos[0].origem.ultimo).toMatchObject({ tipo: 'pago', campanha: `zz-campanha-${M}`, clique: 'fbclid' })
    expect(pedidos[0].origem.primeiro).toMatchObject({ tipo: 'organico', fonte: 'instagram' })
    expect(pedidos[1].origem.ultimo.tipo).toBe('robo')
    expect(pedidos[2].origem).toBeNull()
    expect(pedidos[3].origem.ultimo.tipo).toBe('meta_sem_utm')
    // pagos pelo caminho de verdade (o relatório conta pedido vivo e os ingressos emitidos)
    const { emitirIngressos } = await import('../utils/emissao')
    for (const p of await sql(`SELECT id FROM orders WHERE event_id = $1`, [EVENTO])) {
      expect((await emitirIngressos(p.id)).emitiu).toBe(true)
    }
  })

  it('a aba Relatórios separa pago (com e sem UTM), robô e direto, por campanha, com visitas e conversão', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE}/api/admin/evento/${EVENTO}/relatorios`, { headers: { cookie } })
    expect(r.status).toBe(200)
    const { origens } = await r.json() as any
    const tipo = (t: string) => origens.porTipo.find((x: any) => x.tipo === t)
    // o anúncio com UTM + o Facebook/Instagram sem UTM somam em tráfego pago; não há grupo à parte
    expect(tipo('pago')).toMatchObject({ pagos: 2, ingressos: 4, receitaCents: 8000 })
    expect(tipo('meta_sem_utm')).toBeUndefined()
    expect(origens.porCampanha.find((c: any) => c.rotulo.includes('sem UTM'))).toMatchObject({ tipo: 'pago', pagos: 1 })
    expect(tipo('pago').visitantes).toBeGreaterThanOrEqual(2)
    expect(tipo('robo')).toMatchObject({ pagos: 1, ingressos: 2, receitaCents: 4000 })
    expect(tipo('direto')).toMatchObject({ pagos: 1 })
    const campanha = origens.porCampanha.find((c: any) => c.campanha === `zz-campanha-${M}`)
    expect(campanha).toMatchObject({ tipo: 'pago', fonte: 'meta', meio: 'paid_social', conteudo: 'video-1', pagos: 1 })
    expect(campanha.conversaoPct).toBeGreaterThan(0)
  })
})
