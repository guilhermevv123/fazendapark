/**
 * organizacao-numeros.test.ts — matriz, caso "Organização › Números › Faturado e líquido: iguais".
 *
 * O cartão da Organização, a Visão geral com "Tudo" e o Financeiro falam do MESMO dinheiro: o que
 * os compradores pagaram nos pedidos vivos (cobrado) e o que sobra pro produtor (`SQL_LIQUIDO`).
 * Três telas, uma conta — este teste pergunta às três rotas, logado como o dono do seed, e exige o
 * mesmo número.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'
import { comSessao, entrar } from '../../../scripts/teste-sessao'
import { db } from '../../utils/db'

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let http: ReturnType<typeof comSessao>

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/organizacao-numeros.test.ts', sonda)
  if (!sonda.noAr) return
  http = comSessao(await entrar('master'))
}, 60_000)
afterAll(async () => { await db().end() })

describe('Organização × Visão geral × Financeiro', () => {
  it('cobrado e líquido da vida toda são o mesmo número nas três rotas', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const [org] = await (await http('/api/admin/organizacoes')).json()
    const vg = await (await http('/api/admin/relatorios?periodo=tudo')).json()
    const fin = await (await http('/api/admin/financeiro?periodo=tudo')).json()
    expect(org.faturadoCents).toBe(vg.resumo.cobradoCents)
    expect(org.liquidoCents).toBe(vg.resumo.liquidoCents)
    expect(org.liquidoCents).toBe(fin.totais.liquidoCents)
    expect(org.faturadoCents).toBe(fin.noPeriodo.cobradoCents)
  })
})
