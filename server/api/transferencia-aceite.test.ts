/**
 * B33 · o aceite da transferência: CPF conferido, e sem formulário pra ingresso morto.
 *
 *  · o CPF de quem aceita era gravado como veio em `holder_document` — "abc😀"
 *    virava o documento que a portaria confere;
 *  · o link de um ingresso que já entrou (ou foi cancelado) oferecia o
 *    formulário de aceite, e o POST recusava depois de a pessoa preencher.
 *
 * `cpfDoAceite` é pura; o resto vai pela HTTP, com fixture própria (tickets e
 * transferências inseridos direto), apagada no fim. Sem servidor, PULA.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1 } from '../utils/db'
import { anunciarPulo, seForaDoArPula, sondarServidor, type Sonda } from '../../scripts/test-setup'

;(globalThis as any).defineEventHandler ??= (h: any) => h
const { cpfDoAceite } = await import('./transferencia/[code].post')

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let orgId: string, eventId: string, setorId: string, loteId: string

async function transferencia(statusDoIngresso: string) {
  const t = (await q1<any>(
    `INSERT INTO tickets (org_id, event_id, sector_id, lot_id, code, qr_secret, status,
                          holder_name, holder_email, holder_document)
     VALUES ($1,$2,$3,$4,'ZZA-' || upper(substr(md5(random()::text),1,8)),'teste',$5,
             'Dono','dono.aceite@teste.invalido','52998224725') RETURNING id`,
    [orgId, eventId, setorId, loteId, statusDoIngresso]))!
  const token = `tr_zz_aceite_${randomUUID()}`
  await q(`INSERT INTO ticket_transfers (org_id, event_id, ticket_id, de_nome, de_email, de_documento,
                                          para_nome, para_email, code, expires_at)
           VALUES ($1,$2,$3,'Dono','dono.aceite@teste.invalido','52998224725',
                   'Recebe','recebe.aceite@teste.invalido',$4, now() + interval '2 days')`,
    [orgId, eventId, t.id, token])
  return { token, ingressoId: t.id as string }
}
const documentoDo = async (id: string) =>
  (await q1<any>(`SELECT holder_document FROM tickets WHERE id = $1`, [id]))!.holder_document

beforeAll(async () => {
  orgId = (await q1<any>(`INSERT INTO organizations (name, slug)
    VALUES ('ZZ Aceite', 'zz-aceite-' || gen_random_uuid()) RETURNING id`))!.id
  eventId = (await q1<any>(`INSERT INTO events (org_id, name, slug, status, starts_at, ends_at)
    VALUES ($1,'ZZ Aceite','zz-aceite-' || gen_random_uuid(),'ativo',
            now() + interval '10 days', now() + interval '11 days') RETURNING id`, [orgId]))!.id
  setorId = (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1,'Pista') RETURNING id`, [eventId]))!.id
  loteId = (await q1<any>(`INSERT INTO lots (sector_id, name, price_cents, quantity) VALUES ($1,'Lote',5000,10)
    RETURNING id`, [setorId]))!.id
  sonda = await sondarServidor('/api/eventos-publicos')
  anunciarPulo('server/api/transferencia-aceite.test.ts', sonda)
})

afterAll(async () => {
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

describe('B33 · cpfDoAceite (puro)', () => {
  it('vazio é "não informou"; máscara é aceita; o que sobra tem que ser CPF que confere', () => {
    expect(cpfDoAceite('')).toEqual({ ok: true, cpf: null })
    expect(cpfDoAceite(null)).toEqual({ ok: true, cpf: null })
    expect(cpfDoAceite('529.982.247-25')).toEqual({ ok: true, cpf: '52998224725' })
    expect(cpfDoAceite(' 52998224725 ')).toEqual({ ok: true, cpf: '52998224725' })
  })
  it('letra, emoji ou CPF que não confere: recusa com frase', () => {
    expect(cpfDoAceite('abc😀')).toMatchObject({ ok: false, recado: 'Digite só os números do CPF.' })
    expect(cpfDoAceite('529982247-2x')).toMatchObject({ ok: false })
    expect(cpfDoAceite('12345678900')).toMatchObject({ ok: false, recado: 'CPF inválido. Confira os 11 números.' })
    expect(cpfDoAceite('11111111111')).toMatchObject({ ok: false })
  })
})

describe('B33 · pela HTTP', () => {
  it('CPF com emoji é recusado e o ingresso não muda de dono', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { token, ingressoId } = await transferencia('valido')
    const r = await fetch(`${BASE}/api/transferencia/${token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nome: 'Recebe Silva', documento: 'abc😀' }),
    })
    expect(r.status).toBe(400)
    const corpo = await r.json()
    expect(corpo.data).toMatchObject({ campo: 'documento' })
    expect(await documentoDo(ingressoId), 'o documento torto foi gravado no ingresso').toBe('52998224725')
    const [tr] = await q<any>(`SELECT status FROM ticket_transfers WHERE code = $1`, [token])
    expect(tr.status).toBe('aguardando')
  })

  it('CPF com máscara é aceito e gravado só com os números', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { token, ingressoId } = await transferencia('valido')
    const r = await fetch(`${BASE}/api/transferencia/${token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nome: 'Recebe Silva', documento: '111.444.777-35' }),
    })
    expect(r.status, await r.clone().text()).toBe(200)
    expect(await documentoDo(ingressoId)).toBe('11144477735')
  })

  it('ingresso já usado: a página não oferece o aceite e diz por quê', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { token } = await transferencia('usado')
    const v = await fetch(`${BASE}/api/transferencia/${token}`).then((x) => x.json())
    expect(v.podeAceitar, 'o formulário de aceite apareceu pra um ingresso que já entrou').toBe(false)
    expect(v.motivo).toMatch(/já foi usado/)
    expect(v.statusTexto).toBe('Ingresso já utilizado')
  })

  it('ingresso cancelado: idem', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { token } = await transferencia('cancelado')
    const v = await fetch(`${BASE}/api/transferencia/${token}`).then((x) => x.json())
    expect(v.podeAceitar).toBe(false)
    expect(v.motivo).toMatch(/cancelado/)
  })
})

describe('B24 · a página da transferência escreve a data no fuso do EVENTO', () => {
  it('a rota devolve o fuso do evento (não o do servidor, não o do navegador)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    await q(`UPDATE events SET timezone = 'America/Manaus' WHERE id = $1`, [eventId])
    try {
      const { token } = await transferencia('valido')
      const v = await fetch(`${BASE}/api/transferencia/${token}`).then((x) => x.json())
      expect(v.evento.fuso).toBe('America/Manaus')
    } finally {
      await q(`UPDATE events SET timezone = 'America/Bahia' WHERE id = $1`, [eventId])
    }
  })
})
