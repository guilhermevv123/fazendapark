// @vitest-environment happy-dom
/**
 * painel-financeiro.test.ts — o Financeiro redesenhado (27/09), olhando o que a TELA mostra.
 *
 * `financeiro-saques.test.ts` segue travando o botão de enviar (quem vê, a pergunta, duplo clique,
 * recado da rota, recebido direto). Aqui, o que o redesenho trouxe:
 *
 *   · FIN-02: o botão conta só o PIX pedido; a conta bancária aparece à parte, com valor, e o
 *     pergunta diz que ela não sai por ali;
 *   · FIN-03: saldo devedor em vermelho com o valor; as partes da barra somam o líquido + devedor;
 *   · FIN-07: situação da transferência em português, forma nula "Não informada", páginas;
 *   · FIN-01 (metade do navegador): o eixo lê a chave do parque — setembro é setembro em Manaus;
 *   · FIN-06: a planilha passa pelo `baixarCsv` (célula que parece fórmula ganha apóstrofo);
 *   · FIN-09: o botão segue a régua de `papeis.ts` (operação não vê);
 *   · FIN-10: avisos do gateway pendurados ganham bloco com "Tentar agora".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chamadas, limparTela, montarTela, navegacoes } from './.vitest-setup-dom'

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { limparTela(); vi.unstubAllGlobals() })

const FINANCEIRO = () => ({
  diasDeRetencao: 2,
  totais: {
    faceCents: 110_000, taxaCents: 0, estornadoCents: 4_000, liquidoCents: 95_000,
    naPlataformaCents: 86_000, recebidoDiretoCents: 9_000,
    transferidoCents: 48_000, emCursoCents: 23_000, retidoCents: 0, disponivelCents: 19_000,
    saldoCents: 19_000, saldoDevedorCents: 4_000,
  },
  filtro: { periodo: 'ano', de: '2026-01-01', ate: '2026-09-27', hoje: '2026-09-27', primeiroDia: '2026-08-18' },
  noPeriodo: { cobradoCents: 110_000, liquidoCents: 95_000, pedidos: 4 },
  eventos: [{
    id: 'ev-a', nome: '=1+1 Festa', status: 'encerrado', comeca: null, termina: null, liberado: true, liberaEm: null,
    pedidos: 3, pedidosFechados: 3, faceCents: 90_000, taxaCents: 0, estornadoCents: 0, liquidoCents: 81_000,
    naPlataformaCents: 72_000, recebidoDiretoCents: 9_000, transferidoCents: 30_000, emCursoCents: 23_000,
    retidoCents: 0, disponivelCents: 19_000, saldoCents: 19_000, saldoDevedorCents: 0,
  }, {
    id: 'ev-b', nome: 'ZZ Fin B', status: 'encerrado', comeca: null, termina: null, liberado: true, liberaEm: null,
    pedidos: 1, pedidosFechados: 0, faceCents: 20_000, taxaCents: 0, estornadoCents: 4_000, liquidoCents: 14_000,
    naPlataformaCents: 14_000, recebidoDiretoCents: 0, transferidoCents: 18_000, emCursoCents: 0,
    retidoCents: 0, disponivelCents: 0, saldoCents: 0, saldoDevedorCents: 4_000,
  }],
  porMes: [],
  porDia: [
    { dia: '2026-08-18', pedidos: 1, cobradoCents: 50_000, liquidoCents: 45_000 },
    { dia: '2026-09-01', pedidos: 3, cobradoCents: 60_000, liquidoCents: 50_000 },
  ],
  porForma: [{ forma: 'pix', pedidos: 2, cobradoCents: 70_000, liquidoCents: 59_000 }, { forma: null, pedidos: 2, cobradoCents: 40_000, liquidoCents: 36_000 }],
  saques: {
    enviaveis: { pedidos: 1, valorCents: 10_000 },
    manuais: { pedidos: 1, valorCents: 8_000 },
    emVoo: { pedidos: 1, valorCents: 5_000 },
  },
  transferenciasTotal: 57, pagina: 1, porPagina: 25,
  transferencias: [
    { id: 't1', codigo: 'P-1', beneficiario: 'Fulano', valorCents: 10_000, status: 'solicitada', destinoTipo: 'pix', evento: 'ZZ Fin A', pedidoPor: 'Dono', solicitadaEm: '2026-09-26T12:00:00Z', processadaEm: null },
    { id: 't2', codigo: 'P-2', beneficiario: 'Gelo', valorCents: 8_000, status: 'solicitada', destinoTipo: 'conta', evento: 'ZZ Fin A', pedidoPor: 'Dono', solicitadaEm: '2026-09-26T12:00:00Z', processadaEm: null },
    { id: 't3', codigo: 'P-3', beneficiario: 'Fulano', valorCents: 30_000, status: 'concluida', destinoTipo: 'pix', evento: 'ZZ Fin A', pedidoPor: 'Dono', solicitadaEm: '2026-08-26T12:00:00Z', processadaEm: '2026-08-26T12:05:00Z' },
  ],
})

const eu = (papel: string) => ({ usuario: { papel, nome: 'ZZQA' } })

async function abrir(opcoes: { papel?: string; dados?: any; entregas?: any; query?: Record<string, string> } = {}) {
  const respostas: Record<string, any> = {
    // a mais específica primeiro não importa: o dublê escolhe o prefixo MAIS LONGO
    '/api/admin/financeiro': opcoes.dados ?? FINANCEIRO(),
    '/api/admin/financeiro/entregas': opcoes.entregas ?? { total: 0, mostrando: 0, entregas: [] },
    '/api/auth/eu': eu(opcoes.papel ?? 'master'),
    '/api/admin/payout/executar': { ok: true, mensagem: '1 transferência enviada (R$ 100,00).' },
  }
  return montarTela(await import('../pages/admin/financeiro.vue'), {
    rota: { path: '/admin/financeiro', query: opcoes.query ?? {} }, respostas, stubs: { teleport: true },
  })
}

describe('Financeiro — saques pelo que o botão faz (FIN-02)', () => {
  it('o botão conta só o PIX pedido; a conta bancária aparece à parte, com valor', async () => {
    const tela = await abrir()
    expect(tela.find('[data-acao="enviar-saques"]').text()).toContain('Enviar saques pendentes (1)')
    expect(tela.find('[data-parte="saques-pix"]').text()).toContain('R$ 100,00')
    const manual = tela.find('[data-parte="saques-manuais"]').text()
    expect(manual).toContain('transferência manual')
    expect(manual).toContain('R$ 80,00')
    expect(tela.find('[data-parte="saques-em-voo"]').text()).toContain('R$ 50,00')
  })

  it('a pergunta anuncia o valor que SAI e avisa que a conta bancária não sai por ali', async () => {
    const tela = await abrir()
    await tela.find('[data-acao="enviar-saques"]').trigger('click')
    await tela.vm.$nextTick()
    const janela = tela.find('[data-parte="janela-confirmar"]')
    const texto = janela.text().replace(/\u00a0/g, ' ')
    expect(texto).toContain('Enviar 1 saque PIX pendente (R$ 100,00)')
    expect(texto).toContain('para conta bancária (R$ 80,00) não saem por este botão')
    await janela.find('[data-acao="cancelar"]').trigger('click')
    expect(chamadas.filter((c) => c.url === '/api/admin/payout/executar')).toHaveLength(0)
  })

  it('sem PIX pedido: botão desligado e a frase "Nenhum saque esperando envio"', async () => {
    const dados = FINANCEIRO()
    dados.saques.enviaveis = { pedidos: 0, valorCents: 0 }
    const tela = await abrir({ dados })
    const botao = tela.find('[data-acao="enviar-saques"]')
    expect((botao.element as HTMLButtonElement).disabled).toBe(true)
    expect(botao.attributes('title')).toBe('Nenhum saque esperando envio')
    expect(tela.find('[data-parte="saques-pix"]').text()).toContain('Nenhum saque esperando envio.')
  })

  it('a operação não vê o botão — a régua é a de papeis.ts (FIN-09)', async () => {
    expect((await abrir({ papel: 'operacao' })).find('[data-acao="enviar-saques"]').exists()).toBe(false)
    limparTela()
    expect((await abrir({ papel: 'financeiro' })).find('[data-acao="enviar-saques"]').exists()).toBe(true)
  })
})

describe('Financeiro — para onde foi o líquido (FIN-03, proposta 12)', () => {
  it('o saldo devedor aparece em vermelho com o valor, e a linha do evento diz quanto deve', async () => {
    const tela = await abrir()
    const devedor = tela.find('[data-parte="saldo-devedor"]')
    expect(devedor.exists(), 'a conta negativa sumiu num zero de novo').toBe(true)
    expect(devedor.text()).toContain('Saldo devedor −R$ 40,00')
    expect(tela.find('[data-parte="deve"]').text()).toBe('deve −R$ 40,00')
  })

  it('as cinco partes somam o total líquido mais o que se deve', async () => {
    const tela = await abrir()
    const partes = tela.findAll('[data-parte="parte"]')
    expect(partes.map((p) => p.find('.font-semibold').text())).toEqual(['Transferido', 'Em curso', 'Disponível', 'Retido', 'Recebido direto'])
    const reaisDe = (txt: string) => Number(txt.replace(/[^\d,]/g, '').replace(',', '.'))
    const soma = partes.reduce((s, p) => s + Math.round(reaisDe(p.find('.text-right').text().split('%')[0]!.replace(/\d+$/, '')) * 100), 0)
    // 480 + 230 + 190 + 0 + 90 = 990 = 950 de líquido + 40 devidos
    expect(soma).toBe(95_000 + 4_000)
  })
})

describe('Financeiro — o que a tela escreve (FIN-07)', () => {
  it('situação em português com acento, e forma nula como "Não informada"', async () => {
    const tela = await abrir()
    const situacoes = tela.findAll('[data-parte="situacao-transferencia"]').map((s) => s.text())
    expect(situacoes).toEqual(['Solicitada', 'Solicitada', 'Concluída'])
    expect(tela.findAll('[data-parte="linha-forma"]').map((l) => l.find('td').text())).toEqual(['PIX', 'Não informada'])
  })

  it('páginas: "1–3 de 57", e Próxima escreve ?pagina=2 na URL sem perder o período', async () => {
    const tela = await abrir({ query: { periodo: 'ano' } })
    expect(tela.find('[data-parte="faixa-da-pagina"]').text()).toBe('1–3 de 57')
    expect(tela.find('[data-parte="paginas"]').text()).toContain('página 1 de 3')
    const proxima = tela.findAll('[data-parte="paginas"] button').find((b) => b.text() === 'Próxima')!
    await proxima.trigger('click')
    expect(navegacoes.at(-1)).toMatchObject({ path: '/admin/financeiro', query: { periodo: 'ano', pagina: '2' } })
  })
})

describe('Financeiro — o gráfico (FIN-01, FIN-04, FIN-08)', () => {
  const fusoOriginal = process.env.TZ
  afterEach(() => { process.env.TZ = fusoOriginal })

  it('"Este ano" desenha por mês, com o ano no primeiro rótulo, e setembro é setembro em Manaus', async () => {
    process.env.TZ = 'America/Manaus'
    const tela = await abrir({ query: { periodo: 'ano' } })
    expect(tela.find('#titulo-entrada').text()).toBe('Entrada por mês')
    const eixo = tela.findAll('[data-parte="rotulo-eixo"]').map((r) => r.text())
    expect(eixo[0]).toBe('jan. 2026')
    // nove meses de janeiro a setembro, com os vazios em zero
    expect(tela.findAll('[data-parte="barra"]')).toHaveLength(9)
    expect(eixo).not.toContain('ago. 2026')
  })
})

describe('Financeiro — planilha (FIN-06)', () => {
  let blobs: Blob[] = []
  let original: any
  beforeEach(() => {
    blobs = []
    original = URL.createObjectURL
    URL.createObjectURL = ((b: Blob) => { blobs.push(b); return 'blob:teste' }) as any
    URL.revokeObjectURL = (() => {}) as any
  })
  afterEach(() => { URL.createObjectURL = original })

  it('passa pelo baixarCsv: nome de evento que parece fórmula ganha apóstrofo, dinheiro é número', async () => {
    const tela = await abrir()
    await tela.find('[data-acao="exportar"]').trigger('click')
    await tela.find('[data-planilha="por-evento"]').trigger('click')
    const csv = (await blobs[0]!.text()).replace(/^﻿/, '')
    const linha = csv.split('\r\n')[1]!
    expect(linha.startsWith(`"'=1+1 Festa"`), linha).toBe(true)
    expect(linha).toContain('"810,00"')
  })
})

describe('Financeiro — avisos do gateway pendurados (FIN-10)', () => {
  it('aparecem com o total e o "Tentar agora" manda a entrega certa', async () => {
    const tela = await abrir({
      entregas: {
        total: 2, mostrando: 2, tetoDeTentativas: 8,
        entregas: [
          { id: '11111111-1111-4111-8111-111111111111', evento: 'PAYMENT_REFUNDED', pedido: 'ZZ-1', valorCents: 4_000, tentativas: 1, esgotada: false, erro: 'estorno sem valor', chegouEm: '2026-09-26T12:00:00Z' },
          { id: '22222222-2222-4222-8222-222222222222', evento: 'PAYMENT_RECEIVED', pedido: null, valorCents: 0, tentativas: 8, esgotada: true, erro: null, chegouEm: '2026-09-25T12:00:00Z' },
        ],
      },
    })
    const bloco = tela.find('[data-parte="entregas"]')
    expect(bloco.text()).toContain('2 avisos de pagamento chegaram e não foram aplicados')
    const botoes = bloco.findAll('tbody button')
    expect(botoes[1]!.text()).toBe('Precisa de gente')
    expect((botoes[1]!.element as HTMLButtonElement).disabled).toBe(true)
    await botoes[0]!.trigger('click')
    const post = chamadas.find((c) => c.url === '/api/admin/financeiro/entregas' && c.opcoes?.method === 'POST')
    expect(post?.opcoes?.body).toEqual({ id: '11111111-1111-4111-8111-111111111111' })
  })

  it('sem pendência, o bloco não existe', async () => {
    expect((await abrir()).find('[data-parte="entregas"]').exists()).toBe(false)
  })
})
