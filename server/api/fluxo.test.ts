/**
 * Teste da camada HTTP — a que a suíte não tocava.
 *
 * POR QUE ELE EXISTE: em 20/09 a suíte fechou 54/54 verde enquanto três bugs
 * reais estavam no ar, todos invisíveis pra teste de unidade:
 *   1. `SELECT t.used_at` numa coluna chamada `checked_in_at` → 500 em toda
 *      consulta de pedido pago;
 *   2. filtro de data no ON de um LEFT JOIN, que somava pedido não pago e
 *      fazia um lote mostrar 34 vendidos "no período" tendo 25 no total;
 *   3. `pages/e/[slug].vue` ao lado de `pages/e/[slug]/`, que faz o Nuxt
 *      tratar a primeira como rota PAI e nunca renderizar a de pagamento.
 * Os três só apareciam abrindo a tela. Nenhum tinha exceção, console vermelho
 * ou teste falhando — a classe de falha que mais passa batido.
 *
 * Precisa do servidor de dev no ar. Sem ele, PULA em vez de falhar: teste que
 * fica vermelho por infra ausente treina todo mundo a ignorar vermelho.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { comSessao, entrar } from '../../scripts/teste-sessao'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
const SLUG = 'conquista-park-4-edicao'

let noAr = false
/** Os testes de painel e portaria passam pelo mesmo login do navegador. */
let http: ReturnType<typeof comSessao>
beforeAll(async () => {
  try {
    const r = await fetch(`${BASE}/api/e/${SLUG}`, { signal: AbortSignal.timeout(2500) })
    noAr = r.ok
    if (noAr) http = comSessao(await entrar('master'))
  } catch { noAr = false }
})

/** CPF sintético que passa no dígito verificador. */
function cpf() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

const post = (rota: string, body: unknown) =>
  fetch(`${BASE}${rota}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

describe('fluxo de compra pela HTTP', () => {
  it('vai de escolher ingresso até QR na mão', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar em ' + BASE + ')')

    // ---------------------------------------------------- 1. vitrine
    const ev = await fetch(`${BASE}/api/e/${SLUG}`).then((r) => r.json())
    expect(ev.evento.vendasAbertas).toBe(true)

    const setor = ev.setores.find((s: any) => s.lotes.some((l: any) => l.situacao === 'disponivel'))
    const lote = setor.lotes.find((l: any) => l.situacao === 'disponivel')
    const variacao = lote.variacoes.find((v: any) => !v.esgotado)

    // o total tem que fechar com face + taxa: é a conta que o comprador vê
    expect(variacao.totalCents).toBe(variacao.faceCents + variacao.taxaCents)

    // ---------------------------------------------------- 2. checkout
    const r = await post('/api/checkout', {
      eventSlug: SLUG,
      itens: [{ lotId: lote.id, ticketTypeId: variacao.tipoId, quantidade: 2 }],
      comprador: {
        nome: 'Teste Automático', email: `teste.${Date.now()}@exemplo.com`,
        documento: cpf(), telefone: '73998260963',
      },
      forma: 'pix',
    })
    expect(r.status).toBe(200)
    const ped = await r.json()
    expect(ped.status).toBe('aguardando_pagamento')
    expect(ped.totalCents).toBe(variacao.totalCents * 2)
    expect(ped.pagamento.pixPayload).toBeTruthy()

    // ------------------------------- 3. pedido ainda não pago não dá ingresso
    const antes = await fetch(`${BASE}/api/pedido/${ped.pedidoId}`).then((x) => x.json())
    expect(antes.status).toBe('aguardando_pagamento')
    expect(antes.ingressos).toEqual([])

    // ---------------------------------------------------- 4. pagamento
    const pagou = await post('/api/dev/pagar', { pedido: ped.pedidoId })
    expect(pagou.status).toBe(200)
    expect((await pagou.json()).emitiu).toBe(true)

    // idempotência: pagar de novo não emite ingresso a mais
    const denovo = await post('/api/dev/pagar', { pedido: ped.pedidoId }).then((x) => x.json())
    expect(denovo.emitiu).toBe(false)

    // ---------------------------------- 5. consulta do pedido (o 500 de hoje)
    const depois = await fetch(`${BASE}/api/pedido/${ped.pedido}`)
    expect(depois.status).toBe(200)          // ← pegaria o `used_at`
    const pago = await depois.json()
    expect(pago.status).toBe('pago')
    expect(pago.ingressos).toHaveLength(2)
    expect(pago.comprador.email).toContain('•')   // e-mail não vaza inteiro
    for (const t of pago.ingressos) {
      // shape: versão : evento : código legível : assinatura de 10 chars
      expect(t.qr).toMatch(/^DT1:[0-9a-f-]{36}:[A-Z0-9-]+:[A-Z0-9]{10}$/)
      expect(t.status).toBe('valido')
    }

    // ---------------------------------------------------- 6. QR em PNG
    const png = await fetch(
      `${BASE}/api/ingresso/${pago.ingressos[0].id}/qr.png?pedido=${pago.pedido}`)
    expect(png.status).toBe(200)
    expect(png.headers.get('content-type')).toBe('image/png')

    // sem o código do pedido, o id do ingresso sozinho não abre nada
    const semCredencial = await fetch(`${BASE}/api/ingresso/${pago.ingressos[0].id}/qr.png`)
    expect(semCredencial.status).toBe(400)
    const comCodigoErrado = await fetch(
      `${BASE}/api/ingresso/${pago.ingressos[0].id}/qr.png?pedido=PED-XXXX-XXXX`)
    expect(comCodigoErrado.status).toBe(404)

    // ---------------------------------------------------- 7. portaria
    const ev2 = pago.ingressos[0].qr.split(':')[1]
    const forjado = await http('/api/checkin', {
      method: 'POST',
      body: JSON.stringify({ eventId: ev2, qr: pago.ingressos[0].qr.slice(0, -3) + 'XXX' }),
    }).then((x) => x.json())
    expect(forjado.resultado).toBe('invalido')   // assinatura quebrada não passa

    const inexistente = await http('/api/checkin', { method: 'POST', body: JSON.stringify({ eventId: ev2, qr: 'CON-ZZZZ-ZZZZ' }) })
      .then((x) => x.json())
    expect(inexistente.ok).toBe(false)
  }, 30_000)

  it('recusa preço vindo do navegador', async () => {
    if (!noAr) return
    const ev = await fetch(`${BASE}/api/e/${SLUG}`).then((r) => r.json())
    const setor = ev.setores.find((s: any) => s.lotes.some((l: any) => l.situacao === 'disponivel'))
    const lote = setor.lotes.find((l: any) => l.situacao === 'disponivel')
    const variacao = lote.variacoes.find((v: any) => !v.esgotado)

    // manda preço de 1 centavo junto; o servidor tem que ignorar e cobrar o real
    const ped = await post('/api/checkout', {
      eventSlug: SLUG,
      itens: [{ lotId: lote.id, ticketTypeId: variacao.tipoId, quantidade: 1, price_cents: 1, totalCents: 1 }],
      comprador: {
        nome: 'Teste Preço', email: `preco.${Date.now()}@exemplo.com`,
        documento: cpf(),
      },
      forma: 'pix',
    }).then((x) => x.json())

    expect(ped.totalCents).toBe(variacao.totalCents)
    expect(ped.totalCents).toBeGreaterThan(1)
  }, 20_000)

  it('não vende lote de outro evento no mesmo pedido', async () => {
    if (!noAr) return
    const r = await post('/api/checkout', {
      eventSlug: SLUG,
      itens: [{ lotId: '00000000-0000-0000-0000-000000000000', quantidade: 1 }],
      comprador: { nome: 'Teste Lote', email: `lote.${Date.now()}@exemplo.com`, documento: cpf() },
      forma: 'pix',
    })
    expect(r.status).toBe(404)
  }, 20_000)

  it('dashboard fecha a conta: soma dos lotes − descontos = total', async () => {
    if (!noAr) return
    const eventos = await http('/api/admin/eventos').then((r) => r.json())
    const ev = eventos.find((e: any) => e.slug === SLUG)
    const d = await http(`/api/admin/evento/${ev.id}/dashboard`).then((r) => r.json())

    const somaLotes = d.porSetor.reduce((s: number, l: any) => s + l.cobradoCents, 0)
    expect(somaLotes - d.totais.descontoCents).toBe(d.totais.cobradoCents)

    // forma de pagamento e canal são recortes do MESMO total
    const porForma = d.porForma.reduce((s: number, f: any) => s + f.cobradoCents, 0)
    const porCanal = d.porCanal.reduce((s: number, c: any) => s + c.cobradoCents, 0)
    expect(porForma).toBe(d.totais.cobradoCents)
    expect(porCanal).toBe(d.totais.cobradoCents)

    // ← pegaria o filtro no ON do LEFT JOIN: vendido no período nunca pode
    //   passar do vendido histórico do lote
    for (const l of d.porSetor) {
      expect(l.vendidosPeriodo).toBeLessThanOrEqual(l.vendidos)
    }
  }, 20_000)

  it('a rota de pagamento existe e não é engolida pela rota do evento', async () => {
    if (!noAr) return
    // ← pegaria a colisão [slug].vue × [slug]/: a página pai renderizava no
    //   lugar da filha e o comprador nunca chegava no PIX
    const html = await fetch(`${BASE}/e/${SLUG}/pagamento`).then((r) => r.text())
    expect(html).toContain('Finalizar compra')
    expect(html).not.toContain('Escolha seus')
  }, 20_000)
})
