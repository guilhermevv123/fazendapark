// @vitest-environment happy-dom
/**
 * reagendamento-telas.test.ts — o "Reagendar / Pedir reembolso" do cliente (dono, 30/09).
 *
 *   · `/ingressos/<pedido>` — ingresso vivo ganha os 2 botões embaixo; cortesia, usado, de dia
 *     que já passou ou já trocado NÃO ganham; o trocado mostra REAGENDADO e leva pro novo;
 *   · `/reagendar/<ingresso>` — lista os dias, escolhe, confirma, manda {loteId, tipoId} e vai
 *     pro pedido novo; recusa (motivo) não mostra opção; sem conta abre o "Entrar";
 *   · `/reembolso` — diz que está em manutenção e aponta pro reagendar.
 *
 * As REGRAS da troca moram em `server/utils/reagendamento.ts` (e no teste dele); aqui é só a tela.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { chamadas, limparTela, montarTela, navegacoes } from './.vitest-setup-dom'

const STUBS = { CabecalhoPublico: true, RodapePublico: true, OndasMarca: true, LogoMarca: true }
let tela: Awaited<ReturnType<typeof montarTela>> | null = null
afterEach(() => { tela?.unmount(); tela = null; limparTela() })

/* ============================================================ o bilhete */
const FUTURO = new Date(Date.now() + 5 * 86400000).toISOString()
const PASSADO = new Date(Date.now() - 86400000).toISOString()
const INGRESSO = (n: number, extra: Record<string, any> = {}) => ({
  id: `t-${n}`, codigo: `COD${n}`, status: 'valido', titular: null, cortesia: false, gratuito: false,
  usadoEm: null, setor: 'Pista', lote: 'Lote 1', tipo: 'Inteira', sessao: null, sessaoInicio: null,
  qr: `DT2:k1:e-1:COD${n}:assinatura`, reagendadoPara: null, ...extra,
})
const pedido = (ingressos: any[], inicio = FUTURO) => ({
  pedido: 'PED-ZZRG-0001', pedidoId: 'p-1', status: 'pago', criadoEm: '2026-09-27T12:00:00Z',
  pagoEm: '2026-09-27T12:01:00Z', expiraEm: null, faceCents: 5000, feeCents: 0, descontoCents: 0,
  totalCents: 5000, estornadoCents: 0, formaDePagamento: 'pix', fuso: 'America/Bahia',
  cortesia: false, gratuito: false, comprador: { nome: 'Maria de Teste', email: 'ma•••@exemplo.com' },
  evento: { nome: 'ZZ Sábado', slug: 'zz-sabado', inicio, substantivo: 'Ingressos',
    local: 'Conquista Park', cidade: 'Vitória da Conquista', estado: 'BA', banner: null },
  itens: [], pagamento: null, ingressos, pagoSemIngresso: false,
})
async function abrirPedido(resposta: any) {
  tela = await montarTela(await import('../pages/ingressos/[code].vue'), {
    rota: { params: { code: 'PED-ZZRG-0001' }, path: '/ingressos/PED-ZZRG-0001' },
    respostas: { '/api/pedido/PED-ZZRG-0001': resposta },
    stubs: STUBS,
  })
  await nextTick()
  return tela
}
const links = () => tela!.findAll('[data-parte="acoes-do-ingresso"] a').map((a) => ({
  texto: a.text().trim(), para: a.attributes('href') ?? a.attributes('to'),
}))

describe('/ingressos · botão de reagendar (o de reembolso saiu, 05/10)', () => {
  it('ingresso vivo: só "Reagendar" (→ /reagendar/<id>); nenhum "Pedir reembolso"', async () => {
    await abrirPedido(pedido([INGRESSO(1)]))
    expect(links()).toEqual([{ texto: 'Reagendar', para: '/reagendar/t-1' }])
    expect(tela!.text()).not.toContain('reembolso')
    expect(tela!.find('a[href^="/reembolso"]').exists()).toBe(false)
  })
  it('um botão POR ingresso', async () => {
    await abrirPedido(pedido([INGRESSO(1), INGRESSO(2)]))
    expect(tela!.findAll('[data-parte="acoes-do-ingresso"]')).toHaveLength(2)
    expect(tela!.find('a[href="/reagendar/t-2"]').exists()).toBe(true)
  })
  it('cortesia, usado e dia que já começou: sem botões', async () => {
    await abrirPedido(pedido([INGRESSO(1, { cortesia: true }), INGRESSO(2, { status: 'usado', usadoEm: PASSADO })]))
    expect(tela!.findAll('[data-parte="acoes-do-ingresso"]')).toHaveLength(0)
    tela!.unmount(); tela = null
    await abrirPedido(pedido([INGRESSO(1)], PASSADO))
    expect(tela!.findAll('[data-parte="acoes-do-ingresso"]')).toHaveLength(0)
  })
  it('ingresso já trocado: REAGENDADO, sem QR, com link pro ingresso novo', async () => {
    await abrirPedido(pedido([INGRESSO(1, { status: 'cancelado', qr: null, reagendadoPara: 'PED-NOVO-0001' })]))
    expect(tela!.text()).toContain('REAGENDADO')
    expect(tela!.text()).toContain('Este ingresso foi trocado por outro dia.')
    expect(tela!.find('a[href="/ingressos/PED-NOVO-0001"]').text()).toContain('Ver o ingresso novo')
    expect(tela!.findAll('img[src^="/api/ingresso/"]')).toHaveLength(0)
    expect(tela!.findAll('[data-parte="acoes-do-ingresso"]')).toHaveLength(0)
  })
})

/* ============================================================ /reagendar */
const CONTA = { conta: { id: 'c-1', nome: 'Maria' }, exigeConta: false, social: { google: false, apple: false } }
const OPCAO = (evento: string, inicio: string, n: number, extra: Record<string, any> = {}) => ({
  eventoId: `e-${evento}`, evento: `ZZ ${evento}`, slug: `zz-${evento}`, inicio, fuso: 'America/Bahia',
  banner: null, setor: 'Parque', loteId: `l-${evento}-${n}`, lote: 'Lote 1', tipoId: `tt-${evento}-${n}`,
  tipo: 'Inteira', totalCents: 5000, ...extra,
})
const DOMINGO = '2026-10-11T12:00:00.000Z'
const SABADO = '2026-10-17T12:00:00.000Z'
const DADOS = (extra: Record<string, any> = {}) => ({
  ingresso: { id: 't-1', codigo: 'COD1', pedido: 'PED-ZZRG-0001', evento: 'ZZ Sábado',
    inicio: '2026-10-10T12:00:00.000Z', fuso: 'America/Bahia', setor: 'Parque', lote: 'Lote 1',
    tipo: 'Inteira', pagoCents: 5000 },
  motivo: null,
  opcoes: [OPCAO('domingo', DOMINGO, 1), OPCAO('outro-sabado', SABADO, 1)],
  ...extra,
})
/** o erro do $fetch como o ofetch entrega: status + corpo do createError em `data` */
const erroDaRota = (statusCode: number, statusMessage: string, tipo: string) =>
  Object.assign(new Error(statusMessage), { statusCode, data: { statusCode, statusMessage, data: { tipo } } })

async function abrirReagendar(respostas: Record<string, any>) {
  tela = await montarTela(await import('../pages/reagendar/[ingresso].vue'), {
    rota: { params: { ingresso: 't-1' }, path: '/reagendar/t-1' },
    respostas,
    stubs: STUBS,
  })
  await nextTick()
  return tela
}

describe('/reagendar/<ingresso>', () => {
  it('lista os dias com o dia da semana, um grupo por dia', async () => {
    await abrirReagendar({ '/api/conta/eu': CONTA, '/api/reagendamento/t-1': DADOS() })
    const dias = tela!.findAll('[data-parte="dia-de-troca"]')
    expect(dias).toHaveLength(2)
    expect(dias[0].text()).toMatch(/^Domingo/)
    expect(dias[1].text()).toMatch(/^Sábado/)
    expect(tela!.find('[data-parte="ingresso-atual"]').text()).toContain('COD1')
  })
  it('escolhe → confirma → manda {loteId, tipoId} e vai pro pedido novo', async () => {
    await abrirReagendar({
      '/api/conta/eu': CONTA,
      '/api/reagendamento/t-1': DADOS(),
    })
    const botao = () => tela!.findAll('button').find((b) => /Reagendar para|Escolha um dia/.test(b.text()))!
    expect(botao().attributes('disabled')).toBeDefined() // sem escolha, nada a confirmar
    await tela!.findAll('input[type="radio"]')[0].setValue(true)
    expect(botao().text()).toBe('Reagendar para este dia')
    await botao().trigger('click')
    expect(tela!.text()).toContain('A troca não pode ser desfeita')
    // a troca só vai quando a pessoa confirma
    expect(chamadas.filter((c) => c.opcoes?.method === 'POST')).toHaveLength(0)
    await tela!.findAll('button').find((b) => b.text() === 'Confirmar troca')!.trigger('click')
    await new Promise((r) => setTimeout(r, 0)); await nextTick()
    const post = chamadas.find((c) => c.opcoes?.method === 'POST')!
    expect(post.url).toBe('/api/reagendamento/t-1')
    expect(post.opcoes.body).toEqual({ loteId: 'l-domingo-1', tipoId: 'tt-domingo-1' })
  })
  it('recusa do servidor (motivo) mostra o motivo e nenhuma opção', async () => {
    await abrirReagendar({ '/api/conta/eu': CONTA,
      '/api/reagendamento/t-1': DADOS({ motivo: 'Este dia já começou — não dá mais pra trocar.' }) })
    expect(tela!.text()).toContain('Este dia já começou')
    expect(tela!.findAll('[data-parte="dia-de-troca"]')).toHaveLength(0)
    expect(tela!.findAll('input[type="radio"]')).toHaveLength(0)
  })
  it('sem outro dia à venda: avisa e diz que o ingresso atual segue valendo', async () => {
    await abrirReagendar({ '/api/conta/eu': CONTA, '/api/reagendamento/t-1': DADOS({ opcoes: [] }) })
    expect(tela!.text()).toContain('Nenhum outro dia disponível para troca agora')
    expect(tela!.text()).toContain('Seu ingresso atual continua valendo')
  })
  it('sem conta: a rota diz 401 e a tela pede pra entrar', async () => {
    await abrirReagendar({ '/api/conta/eu': { conta: null, exigeConta: false, social: {} },
      '/api/reagendamento/t-1': erroDaRota(401, 'Entre na sua conta para reagendar.', 'conta') })
    expect(tela!.text()).toContain('Entre na sua conta para reagendar')
    expect(tela!.find('[data-parte="reagendar-manutencao"]').exists()).toBe(false)
  })
  it('em manutenção (rota 503): mostra o aviso, sem dias, sem pedir login — com ou sem conta', async () => {
    for (const eu of [CONTA, { conta: null, exigeConta: false, social: {} }]) {
      await abrirReagendar({ '/api/conta/eu': eu,
        '/api/reagendamento/t-1': erroDaRota(503, 'O reagendamento pelo site está em manutenção. Seu ingresso continua valendo para o dia da compra.', 'manutencao') })
      await new Promise((r) => setTimeout(r, 0)); await nextTick()
      const aviso = tela!.find('[data-parte="reagendar-manutencao"]')
      expect(aviso.exists()).toBe(true)
      expect(aviso.text()).toContain('Reagendamento em manutenção')
      expect(aviso.text()).toContain('continua valendo')
      expect(tela!.findAll('[data-parte="dia-de-troca"]')).toHaveLength(0)
      expect(tela!.text()).not.toContain('Entre na sua conta')
      tela!.unmount(); tela = null
    }
  })
})

describe('/reagendar · a navegação depois da troca', () => {
  it('POST ok → /ingressos/<pedido novo>', async () => {
    const respostas: Record<string, any> = { '/api/conta/eu': CONTA, '/api/reagendamento/t-1': DADOS() }
    await abrirReagendar(respostas)
    await tela!.findAll('input[type="radio"]')[1].setValue(true)
    await tela!.findAll('button').find((b) => b.text() === 'Reagendar para este dia')!.trigger('click')
    respostas['/api/reagendamento/t-1'] = { pedido: 'PED-NOVO-0001', ingresso: 'COD9' }
    await tela!.findAll('button').find((b) => b.text() === 'Confirmar troca')!.trigger('click')
    await new Promise((r) => setTimeout(r, 0)); await nextTick()
    expect(chamadas.find((c) => c.opcoes?.method === 'POST')!.opcoes.body)
      .toEqual({ loteId: 'l-outro-sabado-1', tipoId: 'tt-outro-sabado-1' })
    expect(navegacoes).toContain('/ingressos/PED-NOVO-0001')
  })
})

/* ============================================================ /reembolso */
describe('/reembolso', () => {
  it('link antigo: diz que o reembolso não é pelo site e leva de volta pro ingresso (não oferece reagendar)', async () => {
    tela = await montarTela(await import('../pages/reembolso.vue'), {
      rota: { path: '/reembolso', query: { pedido: 'PED-ZZRG-0001' } }, stubs: STUBS,
    })
    expect(tela.text()).toContain('Reembolso pelo site indisponível')
    expect(tela.find('a[href="/ingressos/PED-ZZRG-0001"]').text()).toContain('Voltar para o ingresso')
    expect(tela.text()).not.toMatch(/reagendar/i)
  })
  it('pedido torto na URL não vira link: cai em "Ver meus ingressos"', async () => {
    tela = await montarTela(await import('../pages/reembolso.vue'), {
      rota: { path: '/reembolso', query: { pedido: '../admin' } }, stubs: STUBS,
    })
    expect(tela.find('a[href="/conta"]').text()).toContain('Ver meus ingressos')
    expect(tela.html()).not.toContain('admin')
  })
})
