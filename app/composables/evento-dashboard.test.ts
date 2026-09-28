// @vitest-environment happy-dom
/**
 * Painel do evento na TELA — o que o dono lê (ADM-11, ADM-12, ADM-33).
 *
 * ADM-11: "− R$ 100 devolvidos" aparecia debaixo de um total que nunca teve esse dinheiro (o
 * pedido estornado por inteiro não é pedido vivo) e quem lia descontava de novo; o líquido vinha
 * na resposta e não aparecia em lugar nenhum. ADM-12: "Pedidos concluídos" contava a cortesia.
 * ADM-33: "1.5 ingressos por pedido", com ponto.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { limparTela, montarTela } from './.vitest-setup-dom'

const tela = () => import('../pages/admin/evento/[id]/dashboard.vue')
const EV = 'ev-painel'

/** um pedido de R$ 200 pago, um de R$ 100 estornado por inteiro, e duas cortesias */
const PAINEL = {
  periodo: { de: '2026-09-01T03:00:00.000Z', ate: '2026-09-21T02:59:59.999Z', fuso: 'America/Bahia', hoje: '2026-09-20' },
  regua: 'pedido que virou dinheiro, pela data do pagamento',
  totais: {
    cobradoCents: 200_00, faceCents: 200_00, taxaCents: 20_00, descontoCents: 0,
    estornadoCents: 100_00, pedidosComDevolucao: 1, estornadoNoLiquidoCents: 0, liquidoCents: 180_00,
    hojeCents: 0, hojeLiquidoCents: 0,
    pedidos: 3, pedidosFechados: 3, pedidosComEstorno: 0,
    ingressos: 5, pagos: 3, cortesiasEmitidas: 2,
    ticketMedioPorIngressoCents: 66_67, ticketMedioPorPedidoCents: 200_00,
    ingressosPorPedido: 1.5, pedidosPagantes: 1, ingressosPagantes: 3, pedidosSemCobranca: 2,
  },
  publico: { pessoas: 0, passagens: 0, ingressosComEntrada: 0, passagensOffline: 0, ultimaEm: null },
  ritmo: [{ dia: '2026-09-20', cobradoCents: 200_00, liquidoCents: 180_00, ingressos: 3 }],
  funil: { criados: 4, finalizados: 3, devolvidos: 1, abandonados: 0, abertos: 0, contestados: 0, comEstorno: 0, outros: 0 },
  porForma: [{ forma: 'pix', cobradoCents: 200_00, liquidoCents: 180_00, n: 1 }],
  porCanal: [{ canal: 'online', cobradoCents: 200_00, liquidoCents: 180_00, n: 1 }],
  porSetor: [{ setor: 'Pista', lote: '1º lote', quantidade: 100, vendidos: 5, reservados: 0,
               vendidosPeriodo: 5, cobradoCents: 200_00 }],
}

const montar = async (dados: any = PAINEL) => montarTela(await tela(), {
  rota: { params: { id: EV }, path: `/admin/evento/${EV}/dashboard` },
  respostas: { [`/api/admin/evento/${EV}/dashboard`]: dados },
})

afterEach(() => limparTela())

describe('painel — devolução, líquido e pedidos pagos', () => {
  it('devolvido aparece nomeado, sem sinal de menos, com o porquê de não subtrair (ADM-11)', async () => {
    const w = await montar()
    const linha = w.find('[data-parte="devolvido"]')
    expect(linha.exists(), 'a devolução sumiu da tela').toBe(true)
    expect(linha.text()).toContain('Devolvido ao comprador')
    expect(linha.text()).toContain('R$ 100,00')
    expect(linha.text()).toContain('em 1 pedido')
    expect(linha.text()).toContain('estornado por inteiro')
    expect(w.text(), 'o "− R$ X" voltou: quem lê desconta de novo').not.toMatch(/[−-]\s*R\$\s*100,00/)
  })

  it('o líquido do produtor está na tela (ADM-11)', async () => {
    const w = await montar()
    expect(w.find('[data-parte="liquido"]').text()).toContain('R$ 180,00')
  })

  it('"Pedidos pagos" não conta cortesia e "ingressos por pedido" sai com vírgula (ADM-12, ADM-33)', async () => {
    const w = await montar()
    expect(w.find('[data-parte="pedidos-pagos"]').text()).toBe('1')
    expect(w.text()).toContain('1,5 ingressos por pedido')
    expect(w.text()).toContain('+ 2 sem cobrança')
  })

  it('sem devolução, a linha nem aparece', async () => {
    const w = await montar({ ...PAINEL, totais: { ...PAINEL.totais, estornadoCents: 0, pedidosComDevolucao: 0 } })
    expect(w.find('[data-parte="devolvido"]').exists()).toBe(false)
  })
})

describe('a rosca é do checkout do site (ADM-28)', () => {
  it('o título e a legenda dizem que balcão e cortesia não entram', async () => {
    const w = await montar()
    const card = w.find('[data-parte="funil-site"]').text().replace(/\s+/g, ' ')
    expect(card).toContain('Checkout do site')
    expect(card, 'a rosca não diz que é só do site').toContain('balcão e cortesia não entram')
  })
})
