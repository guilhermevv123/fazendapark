/**
 * reconciliacao-periodo.test.ts — proposta 10 na rota da Reconciliação.
 *
 * `?periodo=` fala o vocabulário do painel, resolvido no calendário do PARQUE; "Tudo" é recusado
 * com frase (o extrato do gateway precisa de janela com começo); De depois de Até também. Olhar
 * não grava conferência (sem o par registrar=1 + cabeçalho da tela, nada entra no livro).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'
import { comSessao, entrar } from '../../../scripts/teste-sessao'
import { db } from '../../utils/db'
import { hojeNoFuso, somarDiasNoCalendario } from '../../../app/composables/painelPeriodo'

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let http: ReturnType<typeof comSessao>

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/reconciliacao-periodo.test.ts', sonda)
  if (!sonda.noAr) return
  http = comSessao(await entrar('master'))
}, 60_000)
afterAll(async () => { await db().end() })

const abrir = async (qs: string) => {
  const r = await http(`/api/admin/reconciliacao${qs}`)
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any }
}

describe('Reconciliação — o atalho de período', () => {
  it('?periodo=hoje e ?periodo=7d viram datas do parque', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const hoje = hojeNoFuso('America/Bahia')
    const h = await abrir('?periodo=hoje')
    expect(h.status, JSON.stringify(h.corpo)).toBe(200)
    expect(h.corpo.periodo).toMatchObject({ de: hoje, ate: hoje, dias: 1, atalho: 'hoje' })
    const s = await abrir('?periodo=7d')
    expect(s.corpo.periodo).toMatchObject({ de: somarDiasNoCalendario(hoje, -6), ate: hoje, dias: 7 })
  })

  it('sem nada: este mês (o padrão de sempre)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const hoje = hojeNoFuso('America/Bahia')
    const r = await abrir('')
    expect(r.corpo.periodo).toMatchObject({ de: `${hoje.slice(0, 8)}01`, ate: hoje })
  })

  it('"Tudo" e atalho desconhecido são recusados com frase; De depois de Até também', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    for (const qs of ['?periodo=tudo', '?periodo=semana-que-vem']) {
      const r = await abrir(qs)
      expect(r.status, qs).toBe(400)
      expect(r.corpo.statusMessage).toContain('Período desconhecido')
    }
    const trocado = await abrir('?de=2026-09-10&ate=2026-09-01')
    expect(trocado.status).toBe(400)
    expect(trocado.corpo.statusMessage).toMatch(/data inicial é depois/i)
  })
})
