/**
 * sw-portaria.js — o service worker da portaria, rodado de verdade num `self` de mentira.
 *
 * O arquivo é JavaScript puro servido de /public; aqui ele é avaliado com `caches`, `fetch` e
 * `self` dublês, e cada pergunta é uma situação do portão:
 *
 *  · servidor fora (502 do proxy, deploy no meio do evento): a tela guardada abre, não a de erro;
 *  · tela de um evento nunca aberto, sem rede: a lista de eventos abre (dali se chega ao leitor);
 *  · versão nova instalada SEM rede: o cache velho NÃO é apagado (senão o tablet fica sem nada);
 *  · versão nova instalada com rede: já nasce com as telas que o tablet usava;
 *  · /api/ e o painel nunca entram no cache.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const FONTE = readFileSync(fileURLToPath(new URL('../../public/sw-portaria.js', import.meta.url)), 'utf8')
const ORIGEM = 'https://parque.test'

/** CacheStorage mínimo: chave = URL (sem query quando ignoreSearch). */
function armazem() {
  const caixas = new Map<string, Map<string, Response>>()
  const semQuery = (u: string) => u.split('?')[0]
  const urlDe = (r: any) => new URL(typeof r === 'string' ? r : r.url, ORIGEM).href
  const caixa = (m: Map<string, Response>) => ({
    match: async (r: any, o?: any) => {
      const u = urlDe(r)
      if (m.has(u)) return m.get(u)!.clone()
      if (o?.ignoreSearch) for (const [k, v] of m) if (semQuery(k) === semQuery(u)) return v.clone()
      return undefined
    },
    put: async (r: any, resp: Response) => { m.set(urlDe(r), resp.clone()) },
    keys: async () => [...m.keys()].map((url) => ({ url })),
  })
  return {
    caixas,
    api: {
      open: async (nome: string) => { if (!caixas.has(nome)) caixas.set(nome, new Map()); return caixa(caixas.get(nome)!) },
      keys: async () => [...caixas.keys()],
      delete: async (nome: string) => caixas.delete(nome),
      match: async (r: any, o?: any) => {
        for (const m of caixas.values()) { const achou = await caixa(m).match(r, o); if (achou) return achou }
        return undefined
      },
    },
  }
}

type Rede = (url: string) => Promise<Response>

function carregarWorker(versao: string, rede: Rede, a = armazem()) {
  const ouvintes: Record<string, (e: any) => void> = {}
  const self: any = {
    location: { href: `${ORIGEM}/sw-portaria.js?v=${versao}`, origin: ORIGEM },
    addEventListener: (tipo: string, fn: any) => { ouvintes[tipo] = fn },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  }
  const fetchFalso = (r: any) => rede(new URL(typeof r === 'string' ? r : r.url, ORIGEM).href)
  vm.runInNewContext(FONTE, { self, caches: a.api, fetch: fetchFalso, URL, Response, Promise, setTimeout, Set })

  const esperar = async (tipo: string) => {
    let p: Promise<any> = Promise.resolve()
    ouvintes[tipo]({ waitUntil: (x: Promise<any>) => { p = x } })
    await p
  }
  const pedir = async (url: string, navegacao = true) => {
    let resposta: Promise<Response> | undefined
    const req = { url: new URL(url, ORIGEM).href, method: 'GET', mode: navegacao ? 'navigate' : 'no-cors' }
    ouvintes.fetch({ request: req, respondWith: (p: Promise<Response>) => { resposta = p } })
    return resposta ? await resposta : 'passou-direto'
  }
  return { armazem: a, instalar: () => esperar('install'), ativar: () => esperar('activate'), pedir }
}

const html = (texto: string, status = 200) => new Response(`<html>${texto}<script src="/_nuxt/entrada.js"></script></html>`,
  { status, headers: { 'content-type': 'text/html' } })
const semRede: Rede = async () => { throw new TypeError('Failed to fetch') }

describe('service worker da portaria', () => {
  it('servidor fora (502): a tela guardada abre no lugar da página de erro', async () => {
    let fora = false
    const sw = carregarWorker('b1', async (u) => (fora ? new Response('Bad Gateway', { status: 502 }) : html(`tela ${u}`)))
    await sw.instalar(); await sw.ativar()
    const boa = await sw.pedir('/portaria/ev1')
    expect(await (boa as Response).text()).toContain('tela')
    fora = true
    const r = await sw.pedir('/portaria/ev1') as Response
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('/portaria/ev1')
  })

  it('evento nunca aberto, sem rede: abre a lista de eventos (precacheada na instalação)', async () => {
    let online = true
    const sw = carregarWorker('b1', async (u) => { if (!online) throw new TypeError('x'); return html(`tela ${u}`) })
    await sw.instalar(); await sw.ativar()
    online = false
    const r = await sw.pedir('/portaria/evento-novo') as Response
    expect(await r.text()).toContain(`${ORIGEM}/portaria`)
  })

  it('a instalação guarda os scripts que a tela cita', async () => {
    const sw = carregarWorker('b1', async (u) => (u.endsWith('.js') ? new Response('js') : html('lista')))
    await sw.instalar()
    const caixa = sw.armazem.caixas.get('dt-b1')!
    expect(caixa.has(`${ORIGEM}/_nuxt/entrada.js`)).toBe(true)
    expect(caixa.has(`${ORIGEM}/portaria`)).toBe(true)
  })

  it('versão nova instalada SEM rede: o cache velho fica (o tablet não pode ficar sem nada)', async () => {
    const a = armazem()
    const v1 = carregarWorker('b1', async (u) => html(`v1 ${u}`), a)
    await v1.instalar(); await v1.ativar()
    await v1.pedir('/portaria/ev1')

    const v2 = carregarWorker('b2', semRede, a)
    await v2.instalar(); await v2.ativar()
    expect(a.caixas.has('dt-b1'), 'apagou o único cache que o tablet tinha').toBe(true)
    const r = await v2.pedir('/portaria/ev1') as Response
    expect(await r.text()).toContain('v1')
  })

  it('versão nova COM rede: rebaixa as telas que o tablet usava e só então apaga o velho', async () => {
    const a = armazem()
    const v1 = carregarWorker('b1', async (u) => html(`v1 ${u}`), a)
    await v1.instalar(); await v1.ativar()
    await v1.pedir('/portaria/ev1')

    const v2 = carregarWorker('b2', async (u) => html(`v2 ${u}`), a)
    await v2.instalar(); await v2.ativar()
    expect(a.caixas.has('dt-b1')).toBe(false)
    expect(a.caixas.get('dt-b2')!.has(`${ORIGEM}/portaria/ev1`), 'a tela do leitor não veio pro cache novo').toBe(true)
  })

  it('/api/, o painel e o número da versão nunca passam pelo cache', async () => {
    const sw = carregarWorker('b1', async () => new Response('x'))
    expect(await sw.pedir('/api/checkin', false)).toBe('passou-direto')
    expect(await sw.pedir('/admin/financeiro')).toBe('passou-direto')
    expect(await sw.pedir('/_nuxt/builds/latest.json', false)).toBe('passou-direto')
    expect(await sw.pedir('/admin/evento/ev1/validacao')).not.toBe('passou-direto')
  })
})
