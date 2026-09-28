// @vitest-environment happy-dom
/**
 * Relatórios do evento na TELA — o que o navegador escreve com o que a rota mandou.
 *
 * ADM-10: o dia da tabela "por dia" chega como `AAAA-MM-DD` (dia de calendário do evento). O
 * extrato fazia `new Date('2026-09-20')`, que é meia-noite UTC — 21h do dia 19 na Bahia — e a
 * linha saía com o dia ANTERIOR. O fuso deste processo é fixado na Bahia aqui em cima: numa
 * máquina em UTC o defeito some e o teste passaria à toa.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'

const TZ_ANTES = process.env.TZ
process.env.TZ = 'America/Bahia'

const { limparTela, montarTela } = await import('./.vitest-setup-dom')

const EV = 'ev-relatorios'
const extrato = () => import('../pages/admin/evento/[id]/relatorios/extrato.vue')

const EXTRATO = {
  evento: { id: EV, nome: 'Evento', feeBps: 1000, modoOnline: 'repassar', modoBalcao: 'absorver' },
  filtros: { de: null, ate: null, canal: '', ponto: '', forma: '', limite: 300 },
  pontos: [],
  totais: { pedidos: 2, ingressos: 2, cobradoCents: 10000, faceCents: 10000, taxaCompradorCents: 0,
            taxaPlataformaCents: 1000, descontoCents: 0, estornadoCents: 0,
            estornadoNoLiquidoCents: 0, liquidoCents: 9000 },
  foraDoTotal: { pedidos: 0, cobradoCents: 0, estornadoCents: 0, porStatus: [] },
  porCanal: [], porPonto: [], porForma: [],
  porDia: [
    { dia: '2026-09-20', pedidos: 1, ingressos: 1, cobradoCents: 5000, faceCents: 5000, taxaCents: 500 },
    { dia: '2026-09-19', pedidos: 1, ingressos: 1, cobradoCents: 5000, faceCents: 5000, taxaCents: 500 },
  ],
  linhas: [],
  truncado: false,
}

afterEach(() => limparTela())
afterAll(() => { process.env.TZ = TZ_ANTES })

describe('extrato — o dia da tabela "por dia"', () => {
  it('20/09 é 20/09 (não 19/09) com o navegador na Bahia', async () => {
    const w = await montarTela(await extrato(), {
      rota: { params: { id: EV } },
      respostas: { [`/api/admin/evento/${EV}/extrato`]: EXTRATO },
      stubs: { AbasSecao: true },
    })
    const dias = w.findAll('tbody tr td:first-child').map((c) => c.text())
    expect(dias, 'data pura lida como UTC: cada linha saiu com o dia anterior').toEqual(['20/09/2026', '19/09/2026'])
  })
})
