/**
 * caminho.test.ts — o login do cliente não pode travar em "Origem não autorizada" por estar num
 * endereço NOSSO (05/10), e continua travando quem vem de outro site.
 *
 *   · em produção, o endereço oficial e o gêmeo com/sem `www.` passam; outro site não;
 *   · `Origin: null` não decide sozinho: vale o `Sec-Fetch-Site`;
 *   · página aberta no gêmeo ou no host do EasyPanel vai pro oficial (301, mesmo caminho); `/api/*`,
 *     POST e host desconhecido ficam onde estão; fora de produção, nada muda de lugar.
 */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { createEvent } from 'h3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

;(globalThis as any).defineEventHandler ??= (h: any) => h

const { mutacaoDeOutroSite } = await import('./caminho')
const { default: enderecoOficial } = await import('../middleware/00.endereco-oficial')

function evento(metodo: string, url: string, cabecalhos: Record<string, string>) {
  const req = new IncomingMessage(new Socket())
  req.method = metodo
  req.url = url
  req.headers = Object.fromEntries(Object.entries(cabecalhos).map(([k, v]) => [k.toLowerCase(), v]))
  const res = new ServerResponse(req)
  return { ev: createEvent(req, res), res }
}

const antes = { env: process.env.NODE_ENV, base: process.env.PUBLIC_BASE_URL }
beforeEach(() => {
  process.env.NODE_ENV = 'production'
  process.env.PUBLIC_BASE_URL = 'https://www.conquistapark.com.br'
})
afterEach(() => {
  process.env.NODE_ENV = antes.env
  if (antes.base === undefined) delete process.env.PUBLIC_BASE_URL
  else process.env.PUBLIC_BASE_URL = antes.base
})

describe('origem da mutação', () => {
  const host = { host: 'www.conquistapark.com.br' }
  it('o endereço oficial e o gêmeo sem www passam', () => {
    expect(mutacaoDeOutroSite(evento('POST', '/api/conta/entrar', { ...host, origin: 'https://www.conquistapark.com.br' }).ev)).toBe(false)
    expect(mutacaoDeOutroSite(evento('POST', '/api/conta/entrar', { ...host, origin: 'https://conquistapark.com.br' }).ev)).toBe(false)
  })

  it('outro site, e um parecido, não passam', () => {
    expect(mutacaoDeOutroSite(evento('POST', '/api/conta/entrar', { ...host, origin: 'https://golpe.example' }).ev)).toBe(true)
    expect(mutacaoDeOutroSite(evento('POST', '/api/conta/entrar', { ...host, origin: 'https://conquistapark.com.br.golpe.example' }).ev)).toBe(true)
    expect(mutacaoDeOutroSite(evento('POST', '/api/conta/entrar', { ...host, origin: 'http://www.conquistapark.com.br' }).ev)).toBe(true)
  })

  it('Origin: null decide pelo Sec-Fetch-Site', () => {
    expect(mutacaoDeOutroSite(evento('POST', '/api/conta/entrar', { ...host, origin: 'null', 'sec-fetch-site': 'same-origin' }).ev)).toBe(false)
    expect(mutacaoDeOutroSite(evento('POST', '/api/conta/entrar', { ...host, origin: 'null', 'sec-fetch-site': 'cross-site' }).ev)).toBe(true)
  })
})

describe('página fora do endereço oficial vai pro oficial', () => {
  const rodar = (metodo: string, url: string, h: string) => {
    const { ev, res } = evento(metodo, url, { host: h })
    ;(enderecoOficial as any)(ev)
    return { status: res.statusCode, destino: res.getHeader('location') }
  }

  it('gêmeo sem www e host do EasyPanel: 301 pro oficial, mesmo caminho', () => {
    expect(rodar('GET', '/e/sabado?x=1', 'conquistapark.com.br'))
      .toEqual({ status: 301, destino: 'https://www.conquistapark.com.br/e/sabado?x=1' })
    expect(rodar('GET', '/conta', 'demaisprojetos-fazendapark.nyrnfd.easypanel.host'))
      .toEqual({ status: 301, destino: 'https://www.conquistapark.com.br/conta' })
  })

  it('o oficial, /api, POST e host desconhecido ficam onde estão', () => {
    expect(rodar('GET', '/conta', 'www.conquistapark.com.br').destino).toBeUndefined()
    expect(rodar('GET', '/api/saude', 'demaisprojetos-fazendapark.nyrnfd.easypanel.host').destino).toBeUndefined()
    expect(rodar('POST', '/conta', 'conquistapark.com.br').destino).toBeUndefined()
    expect(rodar('GET', '/conta', '127.0.0.1:80').destino).toBeUndefined()
    expect(rodar('GET', '/conta', 'golpe.example').destino).toBeUndefined()
  })

  it('fora de produção não redireciona nada', () => {
    process.env.NODE_ENV = 'development'
    expect(rodar('GET', '/conta', 'conquistapark.com.br').destino).toBeUndefined()
  })
})
