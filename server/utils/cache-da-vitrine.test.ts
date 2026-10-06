import { afterEach, describe, expect, it } from 'vitest'
import { comCacheDaVitrine, esquecerCacheDaVitrine, prazoDoCacheDaVitrine } from './cache-da-vitrine'

const antes = { ms: process.env.VITRINE_CACHE_MS, env: process.env.NODE_ENV }
afterEach(() => {
  esquecerCacheDaVitrine()
  if (antes.ms === undefined) delete process.env.VITRINE_CACHE_MS; else process.env.VITRINE_CACHE_MS = antes.ms
  process.env.NODE_ENV = antes.env
})

describe('cache curto da vitrine', () => {
  it('fora de produção não guarda nada (os testes compram e leem a vitrine em seguida)', async () => {
    delete process.env.VITRINE_CACHE_MS
    process.env.NODE_ENV = 'test'
    expect(prazoDoCacheDaVitrine()).toBe(0)
    let n = 0
    await comCacheDaVitrine('x', async () => ++n)
    await comCacheDaVitrine('x', async () => ++n)
    expect(n).toBe(2)
  })

  it('ligado: a 2ª visita sai da memória, e visitas simultâneas esperam a MESMA consulta', async () => {
    process.env.VITRINE_CACHE_MS = '60000'
    let n = 0
    const lenta = async () => { await new Promise((r) => setTimeout(r, 20)); return ++n }
    const [a, b] = await Promise.all([comCacheDaVitrine('y', lenta), comCacheDaVitrine('y', lenta)])
    expect([a, b, n]).toEqual([1, 1, 1])
    expect(await comCacheDaVitrine('y', lenta)).toBe(1)
    expect(await comCacheDaVitrine('outra', lenta)).toBe(2)
  })

  it('erro não fica guardado: a próxima visita tenta de novo', async () => {
    process.env.VITRINE_CACHE_MS = '60000'
    await expect(comCacheDaVitrine('z', async () => { throw new Error('banco fora') })).rejects.toThrow('banco fora')
    expect(await comCacheDaVitrine('z', async () => 'ok')).toBe('ok')
  })

  it('produção sem ajuste: 10 s; VITRINE_CACHE_MS=0 desliga', () => {
    delete process.env.VITRINE_CACHE_MS
    process.env.NODE_ENV = 'production'
    expect(prazoDoCacheDaVitrine()).toBe(10_000)
    process.env.VITRINE_CACHE_MS = '0'
    expect(prazoDoCacheDaVitrine()).toBe(0)
  })
})
