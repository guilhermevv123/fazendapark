/**
 * O preço da meia-entrada é a METADE DO QUE O COMPRADOR PAGA na inteira.
 *
 * O defeito que este arquivo trava: taxa repassada de 10%, lote com face
 * R$ 27,27 (a inteira sai R$ 30,00 redondo). A meia descontava 50% da FACE
 * (13,64 de desconto → face 13,63) e recalculava a taxa (1,36): R$ 14,99. O
 * comprador via "meia R$ 14,99" do lado de "inteira R$ 30,00" — nenhuma
 * exceção, nenhum console, nenhum teste vermelho, só dois arredondamentos
 * empilhados.
 *
 * A régua agora é `faceDoTipo` (server/utils/dinheiro.ts): no repasse, o alvo é
 * o TOTAL da inteira com o desconto, e a face sai de `faceParaTotal`. Quando o
 * alvo é inalcançável (a taxa arredondada pula um centavo), a meia fica no
 * máximo UM centavo abaixo — nunca acima.
 *
 * Duas metades:
 *   1. unidade — a conta pura, com preços reais e uma varredura;
 *   2. HTTP — a vitrine (`/api/e/<slug>`) e o checkout cobram o MESMO total pra
 *      meia. Se um lado usar outra conta, a tela avisa "o preço mudou".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../scripts/test-setup'
import { q } from './db'
import { arredonda, faceDoTipo, faceParaTotal, precificar, taxaPlataforma, type ModoTaxa } from './dinheiro'

const TAXA = 1000 // 10%, o padrão da casa
const MEIA = 5000

/** Total que o comprador paga por um tipo, pela régua única. */
const totalDoTipo = (faceLote: number, bps: number, fee: number, modo: ModoTaxa) =>
  precificar(faceDoTipo(faceLote, bps, fee, modo), fee, modo).totalCents

/** Metade exata do total da inteira, arredondada (meio pra cima). */
const alvo = (faceLote: number, bps: number, fee: number, modo: ModoTaxa) =>
  arredonda(precificar(faceLote, fee, modo).totalCents * (10_000 - bps), 10_000)

/* ====================================================================== */
/* 1. unidade                                                             */
/* ====================================================================== */
describe('faceDoTipo — a meia é metade do que se PAGA', () => {
  it('inteira R$ 30,00 (face 27,27, repassar) → meia R$ 15,00, face 13,64', () => {
    expect(precificar(2727, TAXA, 'repassar').totalCents).toBe(3000)
    const face = faceDoTipo(2727, MEIA, TAXA, 'repassar')
    expect(face, 'face da meia').toBe(1364)
    const p = precificar(face, TAXA, 'repassar')
    expect(p.feeCents).toBe(136)
    expect(p.totalCents, 'a meia saiu R$ 14,99 — desconto na face e taxa recalculada').toBe(1500)
  })

  // Preços pensados pelo TOTAL que o comprador vê (o jeito que o produtor
  // configura: "quero que saia 30 redondo").
  const pelosTotais: Array<[string, number]> = [
    ['R$ 30,00', 3000], ['R$ 49,90', 4990], ['R$ 1,00', 100], ['R$ 110,00', 11000],
  ]
  for (const [rotulo, total] of pelosTotais) {
    it(`repassar — inteira ${rotulo}: meia = metade exata`, () => {
      const { faceCents: faceLote, exato } = faceParaTotal(total, TAXA, 'repassar')
      expect(exato, `${rotulo} deveria ser alcançável com taxa de 10%`).toBe(true)
      expect(totalDoTipo(faceLote, MEIA, TAXA, 'repassar')).toBe(arredonda(total, 2))
    })
  }

  // Preços pensados pela FACE (o jeito que o formulário do lote grava).
  const pelasFaces: Array<[string, number, number]> = [
    // rótulo, face do lote, total esperado da meia
    ['face R$ 27,00 (inteira 29,70)', 2700, 1485],
    ['face R$ 49,90 (inteira 54,89)', 4990, 2745], // 54,89/2 = 27,445 → 27,45
    ['face R$ 1,00 (inteira 1,10)', 100, 55],
    ['face R$ 27,27 (inteira 30,00)', 2727, 1500],
  ]
  for (const [rotulo, faceLote, esperado] of pelasFaces) {
    it(`repassar — ${rotulo}: meia R$ ${(esperado / 100).toFixed(2)}`, () => {
      expect(alvo(faceLote, MEIA, TAXA, 'repassar')).toBe(esperado)
      expect(totalDoTipo(faceLote, MEIA, TAXA, 'repassar')).toBe(esperado)
    })
  }

  it('absorver — comprador paga a face, meia é metade da face', () => {
    for (const [face, meia] of [[3000, 1500], [2700, 1350], [4990, 2495], [100, 50], [333, 166]]) {
      expect(faceDoTipo(face, MEIA, TAXA, 'absorver')).toBe(meia)
      expect(totalDoTipo(face, MEIA, TAXA, 'absorver')).toBe(meia)
    }
  })

  it('bordas: sem desconto é a face do lote, 100% é gratuito, lote gratuito fica 0', () => {
    for (const modo of ['repassar', 'absorver'] as const) {
      expect(faceDoTipo(2727, 0, TAXA, modo)).toBe(2727)
      expect(faceDoTipo(2727, 10_000, TAXA, modo)).toBe(0)
      expect(faceDoTipo(0, MEIA, TAXA, modo)).toBe(0)
    }
    expect(() => faceDoTipo(27.27, MEIA, TAXA, 'repassar')).toThrow(/inteiro/)
  })

  it('varredura: nunca acima do alvo, no máximo 1 centavo abaixo, e exato sempre que dá', () => {
    const achados: string[] = []
    for (const fee of [0, 500, 1000, 1234]) {
      for (const bps of [5000, 2500, 3333, 7000]) {
        for (let faceLote = 1; faceLote <= 20_000; faceLote += 7) {
          for (const modo of ['repassar', 'absorver'] as const) {
            const a = modo === 'repassar'
              ? alvo(faceLote, bps, fee, modo)
              // absorver: total = face; o desconto é sobre a face (`faceComDesconto`)
              : faceLote - arredonda(faceLote * bps, 10_000)
            const face = faceDoTipo(faceLote, bps, fee, modo)
            const t = precificar(face, fee, modo).totalCents
            if (t > a || a - t > 1) {
              achados.push(`${modo} fee=${fee} bps=${bps} lote=${faceLote}: alvo ${a}, cobrou ${t}`)
            }
            // abaixo do alvo só quando o alvo é impossível: a face seguinte passaria
            if (modo === 'repassar' && t < a && face + 1 + taxaPlataforma(face + 1, fee) <= a) {
              achados.push(`${modo} fee=${fee} bps=${bps} lote=${faceLote}: ficou abaixo podendo bater ${a}`)
            }
          }
        }
      }
    }
    expect(achados.slice(0, 10), `${achados.length} preço(s) fora da régua`).toEqual([])
  })
})

/* ====================================================================== */
/* 2. HTTP — vitrine e checkout cobram o mesmo total pela meia             */
/* ====================================================================== */
const SLUG = 'zz-meia-preco'
const ORG = '0000ab50-0000-4000-8000-000000000001'
const EVENTO = '0000ab50-0000-4000-8000-000000000002'
const SETOR = '0000ab50-0000-4000-8000-000000000003'
const LOTE = '0000ab50-0000-4000-8000-000000000004'
const T_INTEIRA = '0000ab50-0000-4000-8000-000000000005'
const T_MEIA = '0000ab50-0000-4000-8000-000000000006'

let sonda: Sonda = { noAr: false, porque: 'sonda não rodou' }

function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

async function limparPedidos() {
  await q(`DELETE FROM tickets WHERE org_id = $1`, [ORG])
  await q(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [ORG])
  await q(`DELETE FROM orders WHERE org_id = $1`, [ORG])
  await q(`UPDATE lots SET sold = 0, reserved = 0 WHERE id = $1`, [LOTE])
  await q(`UPDATE ticket_types SET sold = 0 WHERE lot_id = $1`, [LOTE])
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('meia-preco', sonda)
  if (!sonda.noAr) return

  await q(`INSERT INTO organizations (id, name, slug)
           VALUES ($1,'ZZ MEIA PRECO','zz-meia-preco-org') ON CONFLICT (id) DO NOTHING`, [ORG])
  await q(
    `INSERT INTO events (id, org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online)
     VALUES ($1,$2,'ZZ MEIA PRECO',$3,'ativo',
             now() + interval '10 days', now() + interval '11 days', $4, 'repassar')
     ON CONFLICT (id) DO UPDATE SET status = 'ativo', fee_bps = EXCLUDED.fee_bps,
       fee_mode_online = 'repassar', starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at`,
    [EVENTO, ORG, SLUG, TAXA])
  await q(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZ PISTA') ON CONFLICT (id) DO NOTHING`,
    [SETOR, EVENTO])
  // face 27,27 → inteira R$ 30,00 com 10% repassado: o caso do defeito
  await q(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity, max_per_order, channels, visible)
     VALUES ($1,$2,'ZZ LOTE 30 REDONDO',2727,50,10,'{online}',true)
     ON CONFLICT (id) DO UPDATE SET price_cents = 2727, quantity = 50, sold = 0, reserved = 0`,
    [LOTE, SETOR])
  const tipo = (id: string, nome: string, desconto: number, doc: boolean) =>
    q(`INSERT INTO ticket_types (id, lot_id, name, quantity, discount_bps, requires_document)
       VALUES ($1,$2,$3,50,$4,$5)
       ON CONFLICT (id) DO UPDATE SET sold = 0, discount_bps = EXCLUDED.discount_bps,
         requires_document = EXCLUDED.requires_document`,
      [id, LOTE, nome, desconto, doc])
  await tipo(T_INTEIRA, 'ZZ Inteira', 0, false)
  await tipo(T_MEIA, 'ZZ Meia-entrada', MEIA, true)
  await limparPedidos()
}, 60_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await limparPedidos()
  await q(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

/** Acha a variação do tipo na resposta da vitrine, onde quer que ela esteja. */
function variacao(vitrine: any, tipoId: string): any {
  for (const s of vitrine.setores ?? []) {
    for (const l of s.lotes ?? []) {
      for (const v of l.variacoes ?? []) if (v.tipoId === tipoId) return v
    }
  }
  return null
}

async function comprar(tipoId: string, meia: boolean) {
  const r = await fetch(`${BASE_DE_TESTE}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventSlug: SLUG,
      itens: [{
        lotId: LOTE, ticketTypeId: tipoId, quantidade: 2,
        ...(meia ? { meia: { motivo: 'estudante', documento: '2026778899' } } : {}),
      }],
      comprador: {
        nome: 'Comprador Meia Preco',
        email: `mp.${Date.now()}.${Math.random().toString(36).slice(2)}@exemplo.com`,
        documento: cpf(), telefone: '73998260963',
      },
      forma: 'pix',
    }),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any }
}

describe('vitrine e checkout — o mesmo total pela meia', () => {
  it('vitrine mostra inteira R$ 30,00 e meia R$ 15,00, e o "a partir de" é R$ 15,00', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE_DE_TESTE}/api/e/${SLUG}`)
    expect(r.status).toBe(200)
    const v = await r.json()
    const inteira = variacao(v, T_INTEIRA)
    const meia = variacao(v, T_MEIA)
    expect(inteira?.totalCents).toBe(3000)
    expect(meia?.totalCents, 'vitrine: meia não é a metade da inteira').toBe(1500)
    expect(meia?.faceCents).toBe(1364)
    expect(v.evento?.aPartirDeCents ?? v.aPartirDeCents, '"a partir de" divergente da variação').toBe(1500)
  }, 30_000)

  it('checkout cobra pela meia exatamente o que a vitrine mostrou', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    await limparPedidos()
    const v = await (await fetch(`${BASE_DE_TESTE}/api/e/${SLUG}`)).json()
    const naVitrine = variacao(v, T_MEIA).totalCents

    const c = await comprar(T_MEIA, true)
    expect(c.status, `checkout recusou a meia: ${c.corpo?.statusMessage ?? ''}`).toBe(200)
    expect(c.corpo.totalCents, 'checkout cobrou diferente da vitrine').toBe(naVitrine * 2)
    expect(c.corpo.totalCents).toBe(3000)
    expect(c.corpo.faceCents).toBe(1364 * 2)
    expect(c.corpo.feeCents).toBe(136 * 2)

    const ped = await q<any>(`SELECT total_cents FROM orders WHERE id = $1`, [c.corpo.pedidoId])
    expect(Number(ped[0].total_cents), 'pedido gravado com outro total').toBe(3000)
  }, 30_000)

  it('inteira segue R$ 30,00 no checkout (a correção não mexeu no preço cheio)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    await limparPedidos()
    const c = await comprar(T_INTEIRA, false)
    expect(c.status, `checkout recusou a inteira: ${c.corpo?.statusMessage ?? ''}`).toBe(200)
    expect(c.corpo.totalCents).toBe(6000)
  }, 30_000)
})
