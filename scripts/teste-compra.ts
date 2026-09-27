/**
 * Compra paga de teste, pelo MESMO caminho do cliente: vitrine → checkout → PIX simulado.
 *
 * Existe por causa da descoberta de 22/09 (e medida de novo em 27/09 no banco de E2E que nasce
 * vazio): `papeis.test.ts` ("a portaria confere um ingresso de verdade") e `isolamento.test.ts`
 * ("o dono continua enxergando o próprio evento") só passavam porque o banco JÁ tinha pedido pago
 * de rodada anterior. Em banco novo davam vermelho — o teste dependia de resto, não do que ele
 * mesmo montou. Agora o caso que precisa de venda compra a dele.
 *
 * Precisa do gateway simulado no servidor de teste (`PAGAMENTO_SIMULADO=1`, nunca em produção).
 */
const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

/** CPF sintético que passa no dígito verificador. */
function cpfDeTeste() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

const post = (rota: string, corpo: unknown) =>
  fetch(`${BASE}${rota}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo),
  })

export interface CompraDeTeste { pedidoId: string; pedido: string; totalCents: number }

export async function compraPagaDeTeste(slug = 'conquista-park-4-edicao', quantidade = 1): Promise<CompraDeTeste> {
  const ev = await fetch(`${BASE}/api/e/${slug}`).then((r) => r.json())
  const setor = ev.setores?.find((s: any) => s.lotes?.some((l: any) => l.situacao === 'disponivel'))
  const lote = setor?.lotes.find((l: any) => l.situacao === 'disponivel')
  const variacao = lote?.variacoes?.find((v: any) => !v.esgotado)
  if (!variacao) throw new Error(`compra de teste: o evento ${slug} não tem ingresso à venda`)

  const r = await post('/api/checkout', {
    eventSlug: slug,
    itens: [{ lotId: lote.id, ticketTypeId: variacao.tipoId, quantidade }],
    comprador: {
      nome: 'Compra de Teste', email: `compra.teste.${Date.now()}@teste.invalido`,
      documento: cpfDeTeste(), telefone: '73998260963',
    },
    forma: 'pix',
  })
  if (!r.ok) throw new Error(`compra de teste: checkout respondeu ${r.status} — ${await r.text()}`)
  const ped = await r.json()

  const pagou = await post('/api/dev/pagar', { pedido: ped.pedidoId })
  if (!pagou.ok) {
    throw new Error(`compra de teste: pagamento simulado respondeu ${pagou.status} — o servidor de teste está com PAGAMENTO_SIMULADO=1?`)
  }
  return { pedidoId: ped.pedidoId, pedido: ped.pedido, totalCents: ped.totalCents }
}
