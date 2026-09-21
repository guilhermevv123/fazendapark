/**
 * Teste da configuração de ingressos (setor → lote → tipo) pela HTTP.
 *
 * POR QUE ELE EXISTE: o PATCH desta rota **nunca funcionou**. O UPDATE
 * terminava em `WHERE id = $1 AND $2 IS NOT NULL`, uma tentativa de "usar" o
 * id do evento pra fechar a contagem de parâmetros — e um parâmetro solto num
 * IS NOT NULL não tem tipo que o Postgres consiga inferir. Toda alteração de
 * preço, de estoque e de visibilidade morria em "Server Error" com a tela
 * inteira verde.
 *
 * O que pegou o bug não foi o POST ter dado 200: foi a LEITURA DE VOLTA. Por
 * isso todo teste daqui pra baixo grava e depois lê do GET pra conferir se o
 * valor realmente mudou. Teste que só confere o retorno do próprio POST não
 * prova nada sobre o banco.
 *
 * Precisa do servidor de dev no ar. Sem ele, PULA em vez de falhar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { comSessao, entrar } from '../../scripts/teste-sessao'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
const SLUG = 'conquista-park-4-edicao'

let noAr = false
let eventoId = ''
let http: ReturnType<typeof comSessao>
const lixo: string[] = [] // setores criados aqui, apagados no fim

beforeAll(async () => {
  try {
    const r = await fetch(`${BASE}/api/e/${SLUG}`, { signal: AbortSignal.timeout(2500) })
    noAr = r.ok
    if (!noAr) return
    eventoId = (await r.json()).evento.id
    http = comSessao(await entrar('master'))
  } catch { noAr = false }
})

afterAll(async () => {
  for (const id of lixo) await chamar('DELETE', { o: 'setor', id }).catch(() => {})
})

const chamar = (metodo: string, body: unknown) =>
  http(`/api/admin/evento/${eventoId}/ingressos`, { method: metodo, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, corpo: await r.json() }))

const arvore = () =>
  http(`/api/admin/evento/${eventoId}/ingressos`).then((r) => r.json())

const acharLote = async (id: string) =>
  (await arvore()).setores.flatMap((s: any) => s.lotes).find((l: any) => l.id === id)

/** Cria setor + lote + tipo descartáveis e devolve os ids. */
async function cenario(nome: string, capacidade: number | null = null) {
  const s = await chamar('POST', { o: 'setor', nome, tipo: 'camarote', capacidade })
  expect(s.status, JSON.stringify(s.corpo)).toBe(200)
  lixo.push(s.corpo.id)
  const l = await chamar('POST', {
    o: 'lote', setorId: s.corpo.id, nome: 'lote de teste', faceCents: 5000, quantidade: 60,
  })
  expect(l.status, JSON.stringify(l.corpo)).toBe(200)
  return { setorId: s.corpo.id as string, loteId: l.corpo.id as string }
}

describe('configuração de ingressos', () => {
  it('grava o que mandou — provado lendo de volta, não pelo 200', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar em ' + BASE + ')')
    const { loteId } = await cenario('TESTE grava de volta ' + Date.now())

    // Preço "redondo": com taxa de 10% repassada, face 4091 dá total 4500.
    const r = await chamar('PATCH', { o: 'lote', id: loteId, campos: { faceCents: 4091 } })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)

    const lote = await acharLote(loteId)
    expect(lote.faceCents).toBe(4091)                       // ← o que o bug quebrava
    expect(lote.totalCents).toBe(lote.faceCents + lote.taxaCents)
    expect(lote.totalCents).toBe(4500)
  })

  it('esconde e mostra o lote', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const { loteId } = await cenario('TESTE visivel ' + Date.now())

    await chamar('PATCH', { o: 'lote', id: loteId, campos: { visivel: false } })
    expect((await acharLote(loteId)).visivel).toBe(false)

    await chamar('PATCH', { o: 'lote', id: loteId, campos: { visivel: true } })
    expect((await acharLote(loteId)).visivel).toBe(true)
  })

  it('não deixa a soma dos lotes passar da capacidade do setor', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const { setorId } = await cenario('TESTE capacidade ' + Date.now(), 100)
    // o cenário já alocou 60 de 100; mais 60 estoura
    const r = await chamar('POST', {
      o: 'lote', setorId, nome: 'estoura', faceCents: 1000, quantidade: 60,
    })
    expect(r.status).toBe(422)
    expect(r.corpo.statusMessage).toMatch(/capacidade do setor/i)
  })

  it('não deixa a soma dos tipos passar do lote', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const { loteId } = await cenario('TESTE tipos ' + Date.now())
    const r = await chamar('POST', { o: 'tipo', loteId, nome: 'Inteira', quantidade: 80 })
    expect(r.status).toBe(422)
    expect(r.corpo.statusMessage).toMatch(/estoura o lote/i)
  })

  it('não apaga nem encolhe o que já vendeu', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const todos = (await arvore()).setores.flatMap((s: any) => s.lotes)
    const vendido = todos.find((l: any) => l.vendidos > 0)
    expect(vendido, 'a base de teste precisa de pelo menos um lote com venda').toBeTruthy()

    const apagar = await chamar('DELETE', { o: 'lote', id: vendido.id })
    expect(apagar.status).toBe(409)

    const encolher = await chamar('PATCH', {
      o: 'lote', id: vendido.id, campos: { quantidade: 1 },
    })
    expect(encolher.status).toBe(409)

    // e o estoque continua intacto depois das duas recusas
    expect((await acharLote(vendido.id)).quantidade).toBe(vendido.quantidade)
  })

  it('preço é livre de mudar mesmo com venda feita', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const todos = (await arvore()).setores.flatMap((s: any) => s.lotes)
    const vendido = todos.find((l: any) => l.vendidos > 0)
    const antes = vendido.faceCents

    const r = await chamar('PATCH', { o: 'lote', id: vendido.id, campos: { faceCents: antes + 1 } })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect((await acharLote(vendido.id)).faceCents).toBe(antes + 1)

    await chamar('PATCH', { o: 'lote', id: vendido.id, campos: { faceCents: antes } })
    expect((await acharLote(vendido.id)).faceCents).toBe(antes)
  })

  it('recusa mexer em lote de outro evento', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const { loteId } = await cenario('TESTE dono ' + Date.now())
    const outro = '00000000-0000-0000-0000-000000000000'

    const r = await http(`/api/admin/evento/${outro}/ingressos`, {
      method: 'PATCH',
      body: JSON.stringify({ o: 'lote', id: loteId, campos: { faceCents: 1 } }),
    })
    expect(r.status).toBe(404)
    expect((await acharLote(loteId)).faceCents).toBe(5000) // continua intacto
  })

  it('apagar setor leva lote e tipo junto', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const { setorId, loteId } = await cenario('TESTE cascata ' + Date.now())
    await chamar('POST', { o: 'tipo', loteId, nome: 'Inteira', quantidade: 10 })

    const r = await chamar('DELETE', { o: 'setor', id: setorId })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)

    const restou = (await arvore()).setores.find((s: any) => s.id === setorId)
    expect(restou).toBeUndefined()
    expect(await acharLote(loteId)).toBeUndefined()
  })
})
