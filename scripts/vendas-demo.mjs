/**
 * vendas-demo.mjs — gera vendas passando pelo FLUXO DE VERDADE.
 *
 * Não insere linha em `orders` na marra. Chama POST /api/checkout e depois
 * POST /api/dev/pagar, que é a mesma emissão que o webhook do Asaas dispara.
 * Assim o dashboard não é só "tela com número bonito": todo número que ele
 * mostra passou por reserva de estoque, precificação e emissão reais.
 *
 *   node scripts/vendas-demo.mjs [quantidade]
 */
const BASE = process.env.BASE ?? 'http://localhost:3100'
const SLUG = 'conquista-park-4-edicao'
const QUANTAS = Number(process.argv[2] ?? 40)

const nomes = ['Ana Souza', 'Bruno Lima', 'Carla Dias', 'Diego Rocha', 'Elaine Costa',
  'Fábio Nunes', 'Gisele Alves', 'Hugo Martins', 'Iara Pinto', 'João Pedro Silva',
  'Kelly Ramos', 'Lucas Barros', 'Marina Teles', 'Nelson Faria', 'Olívia Gomes',
  'Paulo Henrique', 'Queila Santos', 'Rafael Moura', 'Sabrina Luz', 'Tiago Abreu']

/** CPFs sintéticos que passam no dígito verificador (o checkout valida). */
function cpf() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr, peso) => {
    const s = arr.reduce((a, n, i) => a + n * (peso - i), 0)
    const r = (s * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

const sorteio = (a) => a[Math.floor(Math.random() * a.length)]

const ev = await fetch(`${BASE}/api/e/${SLUG}`).then((r) => r.json())
const opcoes = []
for (const s of ev.setores) {
  for (const l of s.lotes) {
    if (l.situacao !== 'disponivel' && l.situacao !== 'ultimas') continue
    for (const v of l.variacoes) {
      if (!v.esgotado) opcoes.push({ lotId: l.id, ticketTypeId: v.tipoId, setor: s.nome, tipo: v.nome })
    }
  }
}
if (!opcoes.length) { console.error('nenhum lote disponível'); process.exit(1) }

let ok = 0, pagos = 0, falhas = 0
for (let i = 0; i < QUANTAS; i++) {
  const nome = `${sorteio(nomes)} ${i}`
  const escolha = sorteio(opcoes)
  const itens = [{ lotId: escolha.lotId, ticketTypeId: escolha.ticketTypeId, quantidade: 1 + Math.floor(Math.random() * 3) }]
  // 1 em 5 pega um segundo item
  if (Math.random() < 0.2) {
    const b = sorteio(opcoes)
    if (b.lotId !== escolha.lotId) itens.push({ lotId: b.lotId, ticketTypeId: b.ticketTypeId, quantidade: 1 })
  }

  const body = {
    eventSlug: SLUG, itens,
    comprador: {
      nome,
      email: `demo${i}.${Date.now()}@exemplo.com`,
      documento: cpf(),
      telefone: `7398${String(1000000 + Math.floor(Math.random() * 8999999)).slice(0, 7)}`,
    },
    // 1 em 8 usa cupom
    ...(Math.random() < 0.125 ? { cupom: 'VIZINHO' } : {}),
    forma: 'pix',
  }

  const r = await fetch(`${BASE}/api/checkout`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!r.ok) { falhas++; console.error(' checkout', r.status, (await r.text()).slice(0, 120)); continue }
  const ped = await r.json()
  ok++

  // 3 em 4 pagam; o resto fica abandonado de propósito, pra o funil da tela
  // ter os dois lados e não ser 100% verde de mentira.
  if (Math.random() < 0.75) {
    const p = await fetch(`${BASE}/api/dev/pagar`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pedido: ped.pedidoId }),
    })
    if (p.ok) pagos++
    else console.error(' pagar', p.status, (await p.text()).slice(0, 120))
  }
}

console.log(`\n  pedidos criados: ${ok}   pagos: ${pagos}   abandonados: ${ok - pagos}   falhas: ${falhas}`)
