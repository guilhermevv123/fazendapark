// @vitest-environment happy-dom
/**
 * pagamento-conta.test.ts — o checkout em passos, com a conta do cliente (034, pedido do dono 28/09).
 *
 * A rota já confere a conta do lado dela (`checkout-conta.test.ts`). O que só a TELA pode errar:
 *
 *   · voltar a pedir nome, CPF e endereço no checkout (os dados vêm da conta);
 *   · deixar seguir sem conta, ou mandar o comprador no corpo (quem decide é a sessão);
 *   · pular o passo do pagamento, ou mandar "débito" como crédito parcelado;
 *   · no ingresso GRÁTIS, mostrar qualquer coisa de Pix ou cartão;
 *   · perder a cobrança no F5, ou prender a pessoa num pedido antigo (B13, B20, B34).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VERSAO_DO_CARRINHO } from './carrinhoDaVitrine'
import { chamadas, limparTela, montarTela } from './.vitest-setup-dom'

const SLUG = 'zz-evento-tela'

const LINHA = {
  loteId: '11111111-1111-4111-8111-111111111111', tipoId: '22222222-2222-4222-8222-222222222222',
  quantidade: 1, nome: 'Inteira', setor: 'Pista',
  unitFaceCents: 3002, unitTaxaCents: 300, unitTotalCents: 3302, pedeMeia: false, declaracao: null,
}
const CARRINHO = { versao: VERSAO_DO_CARRINHO, slug: SLUG, linhas: [LINHA], totais: { face: 3002, taxa: 300, total: 3302, n: 1 } }
const GRATIS = {
  versao: VERSAO_DO_CARRINHO, slug: SLUG,
  linhas: [{ ...LINHA, nome: 'Cortesia do dia', unitFaceCents: 0, unitTaxaCents: 0, unitTotalCents: 0 }],
  totais: { face: 0, taxa: 0, total: 0, n: 1 },
}

const CONTA = {
  nome: 'Maria de Teste', primeiroNome: 'Maria', email: 'maria@exemplo.com', cpf: '52998224725',
  telefone: '73998260963', instagram: null, endereco: {}, aceitaNovidades: false, temSenha: true,
  google: false, apple: false,
}
const EU_DENTRO = { conta: CONTA, exigeConta: true, social: { google: false, apple: false } }
const EU_FORA = { conta: null, exigeConta: true, social: { google: false, apple: false } }

const PEDIDO_CRIADO = {
  ok: true, pedido: 'PED-TESTE-1', pedidoId: '33333333-3333-4333-8333-333333333333',
  status: 'aguardando_pagamento',
  expiraEm: new Date(Date.now() + 20 * 60_000).toISOString(),
  totalCents: 3302, faceCents: 3002, feeCents: 300, descontoCents: 0,
  pagamento: { forma: 'pix', pixPayload: '000201-copia-e-cola', pixQrBase64: null, linkFatura: null },
}

let tela: Awaited<ReturnType<typeof montarTela>> | null = null
const espera = () => new Promise((r) => setTimeout(r, 30))

async function abrir(respostas: Record<string, any> = {}, carrinho: any = CARRINHO) {
  sessionStorage.clear()
  sessionStorage.setItem('dt:carrinho', JSON.stringify(carrinho))
  tela = await montarTela(await import('../pages/e/[slug]/pagamento.vue'), {
    rota: { params: { slug: SLUG }, path: `/e/${SLUG}/pagamento` },
    respostas: { '/api/conta/eu': EU_DENTRO, '/api/checkout': PEDIDO_CRIADO, ...respostas },
    stubs: { CabecalhoPublico: true, RodapePublico: true, OndasMarca: true },
  })
  await espera()
  return tela
}

const botao = (texto: RegExp) => tela!.findAll('button').find((b) => texto.test(b.text()))
const checkout = () => chamadas.find((c) => c.url === '/api/checkout')
async function avancar() {
  await tela!.get('form').trigger('submit')
  await espera()
}
async function pagar() {
  await tela!.get('form').trigger('submit')
  await espera()
}

beforeEach(() => { tela = null })
afterEach(() => {
  tela?.unmount()
  limparTela()
  sessionStorage.clear()
})

describe('passo 1 · quem compra é a conta', () => {
  it('não pede mais nome, CPF nem endereço: mostra a conta (com o CPF escondido)', async () => {
    await abrir()
    for (const id of ['nome', 'email', 'cpf', 'tel', 'nascimento', 'cep', 'cidade', 'estado', 'rua']) {
      expect(tela!.find(`#${id}`).exists(), `o checkout voltou a pedir #${id}`).toBe(false)
    }
    const dados = tela!.get('[data-parte="seus-dados"]').text()
    expect(dados).toContain('Maria de Teste')
    expect(dados).toContain('maria@exemplo.com')
    expect(dados).toContain('529.***.***-25')
    expect(dados).not.toContain('529.982.247-25')
    expect(tela!.text()).toContain('Passo 1 de 2')
  })

  it('sem conta: pede pra entrar, e o Avançar não passa', async () => {
    await abrir({ '/api/conta/eu': EU_FORA })
    expect(tela!.find('[data-parte="entre-para-comprar"]').exists()).toBe(true)
    expect(tela!.get('[data-parte="avancar"]').attributes('disabled')).toBeDefined()
    await avancar()
    expect(tela!.text(), 'passou pro pagamento sem conta').not.toContain('Como você quer pagar?')
    expect(checkout()).toBeUndefined()
  })

  it('o campo de cupom está escondido por enquanto (pedido do dono)', async () => {
    await abrir()
    expect(tela!.find('#cupom').exists()).toBe(false)
  })
})

describe('passo 2 · Pix, crédito ou débito', () => {
  it('Avançar leva às três formas, e o Pix é o padrão', async () => {
    await abrir()
    await avancar()
    expect(tela!.text()).toContain('Como você quer pagar?')
    expect(tela!.text()).toContain('Passo 2 de 2')
    for (const f of ['pix', 'credito', 'debito']) expect(tela!.find(`[data-forma="${f}"]`).exists()).toBe(true)
    expect(checkout(), 'o Avançar já criou pedido').toBeUndefined()
    await pagar()
    const corpo = checkout()!.opcoes.body
    expect(corpo.forma).toBe('pix')
    expect(corpo.parcelas).toBe(1)
    // quem compra sai da SESSÃO: o corpo não leva comprador nenhum
    expect(corpo.comprador).toBeUndefined()
    expect(tela!.text()).toContain('Pague com PIX')
  })

  it('débito vai como débito, sempre à vista', async () => {
    await abrir({ '/api/checkout': { ...PEDIDO_CRIADO, pagamento: { forma: 'credito', linkFatura: 'https://sandbox.asaas.com/i/x' } } })
    await avancar()
    await tela!.get('[data-forma="debito"] input').setValue(true)
    expect(tela!.find('#parcelas').exists(), 'débito com parcelas').toBe(false)
    await pagar()
    expect(checkout()!.opcoes.body).toMatchObject({ forma: 'debito', parcelas: 1 })
  })

  it('crédito leva as parcelas escolhidas', async () => {
    await abrir()
    await avancar()
    await tela!.get('[data-forma="credito"] input').setValue(true)
    await tela!.get('#parcelas').setValue('3')
    await pagar()
    expect(checkout()!.opcoes.body).toMatchObject({ forma: 'credito', parcelas: 3 })
  })

  it('"Voltar" do pagamento volta ao resumo sem criar pedido', async () => {
    await abrir()
    await avancar()
    await botao(/Voltar/)!.trigger('click')
    expect(tela!.text()).toContain('Finalizar compra')
    expect(checkout()).toBeUndefined()
  })
})

describe('ingresso grátis · nada de pagamento na tela', () => {
  it('não aparece Pix, cartão nem passo 2: só "Gerar ingresso"', async () => {
    await abrir({ '/api/checkout': { ...PEDIDO_CRIADO, status: 'pago', totalCents: 0, pagamento: null },
      [`/api/pedido/${PEDIDO_CRIADO.pedidoId}`]: { status: 'pago', totalCents: 0, ingressos: [
        { id: 'ti-1', codigo: 'COD1', status: 'valido', qr: 'DT2:x', setor: 'Pista', tipo: 'Cortesia do dia' }] } },
    GRATIS)
    const texto = tela!.text()
    expect(texto).not.toMatch(/pix/i)
    expect(texto).not.toMatch(/cart[aã]o|cr[eé]dito|d[eé]bito/i)
    expect(texto).not.toContain('Passo 1 de 2')
    expect(texto).toContain('Grátis')
    expect(tela!.get('[data-parte="avancar"]').text()).toBe('Gerar ingresso')

    await avancar()
    expect(checkout(), 'o grátis não chamou o checkout direto').toBeTruthy()
    expect(tela!.text()).toContain('Ingresso gerado')
    expect(tela!.text()).not.toMatch(/Pagamento confirmado/)
    expect(tela!.text()).toContain('COD1')
  })

  it('o grátis recusado pelo servidor (esgotou no meio): a recusa aparece na tela', async () => {
    const recusa = Object.assign(new Error('409'), { data: {
      statusMessage: 'Esgotou enquanto você escolhia: não sobrou ingresso grátis neste lote.',
      data: { tipo: 'estoque' } } })
    await abrir({ '/api/checkout': recusa }, GRATIS)
    await avancar()
    expect(tela!.get('.faixa-erro').text()).toContain('Esgotou')
    expect(sessionStorage.getItem('dt:pedido')).toBeNull()
  })
})

describe('a sessão da conta caiu no meio', () => {
  it('401 do checkout: relê a conta e volta pro passo 1', async () => {
    const recusa = Object.assign(new Error('401'), { data: {
      statusMessage: 'Entre na sua conta para comprar.', data: { tipo: 'conta' } } })
    await abrir({ '/api/checkout': recusa })
    await avancar()
    await pagar()
    expect(chamadas.filter((c) => c.url === '/api/conta/eu').length, 'não releu a conta').toBeGreaterThanOrEqual(2)
    expect(tela!.text()).toContain('Finalizar compra')
  })
})

describe('o que fica guardado na aba (F5)', () => {
  it('dt:pedido leva só o e-mail da pessoa — nada de nome ou CPF', async () => {
    await abrir()
    await avancar()
    await pagar()
    const guardado = sessionStorage.getItem('dt:pedido')
    expect(guardado, 'o pedido não foi guardado').toBeTruthy()
    expect(JSON.parse(guardado!).email).toBe('maria@exemplo.com')
    expect(guardado).not.toContain('52998224725')
    expect(guardado).not.toContain('Maria de Teste')
  })
})

describe('B13 · o pedido antigo não prende o comprador', () => {
  const ANTERIOR = { slug: SLUG, pedido: PEDIDO_CRIADO, email: 'maria@exemplo.com', linhas: CARRINHO.linhas, criadoEm: 1000 }
  const DESISTIR = `/api/pedido/${PEDIDO_CRIADO.pedidoId}/desistir`

  it('carrinho montado DEPOIS do pedido: mostra o novo, avisa do anterior e larga ele antes de pagar', async () => {
    sessionStorage.clear()
    sessionStorage.setItem('dt:pedido', JSON.stringify(ANTERIOR))
    sessionStorage.setItem('dt:carrinho', JSON.stringify({ ...CARRINHO, criadoEm: 2000 }))
    tela = await montarTela(await import('../pages/e/[slug]/pagamento.vue'), {
      rota: { params: { slug: SLUG }, path: `/e/${SLUG}/pagamento` },
      respostas: { '/api/conta/eu': EU_DENTRO, [DESISTIR]: { ok: true, status: 'expirado' },
        '/api/checkout': { ...PEDIDO_CRIADO, pedido: 'PED-TESTE-2', pedidoId: '44444444-4444-4444-8444-444444444444' } },
      stubs: { CabecalhoPublico: true, RodapePublico: true, OndasMarca: true },
    })
    await espera()
    expect(tela.text()).toContain('Você tem um pedido aguardando pagamento')
    expect(tela.text(), 'reabriu a cobrança velha em vez do carrinho novo').toContain('Finalizar compra')
    await avancar()
    await pagar()
    const urls = chamadas.map((c) => c.url)
    expect(urls.indexOf(DESISTIR), 'não largou o pedido anterior').toBeGreaterThanOrEqual(0)
    expect(urls.indexOf(DESISTIR)).toBeLessThan(urls.indexOf('/api/checkout'))
  })

  it('F5 sem carrinho novo reabre a cobrança — e "trocar a forma" volta pra escolha do pagamento', async () => {
    sessionStorage.clear()
    sessionStorage.setItem('dt:pedido', JSON.stringify(ANTERIOR))
    tela = await montarTela(await import('../pages/e/[slug]/pagamento.vue'), {
      rota: { params: { slug: SLUG }, path: `/e/${SLUG}/pagamento` },
      respostas: { '/api/conta/eu': EU_DENTRO, [`/api/pedido/${PEDIDO_CRIADO.pedidoId}`]: { status: 'aguardando_pagamento' },
        [DESISTIR]: { ok: true, status: 'expirado' } },
      stubs: { CabecalhoPublico: true, RodapePublico: true, OndasMarca: true },
    })
    expect(tela.text()).toContain('Pague com PIX')
    expect(tela.text()).toContain('Inteira')
    await botao(/Trocar a forma de pagamento/)!.trigger('click')
    await espera()
    expect(chamadas.some((c) => c.url === DESISTIR)).toBe(true)
    expect(tela.text()).toContain('Como você quer pagar?')
    expect(JSON.parse(sessionStorage.getItem('dt:carrinho')!).linhas).toHaveLength(1)
    expect(sessionStorage.getItem('dt:pedido')).toBeNull()
  })
})

describe('B34 e B20 · a cobrança diz o que houve', () => {
  const guardar = (extra: any = {}) => {
    sessionStorage.clear()
    sessionStorage.setItem('dt:pedido', JSON.stringify({
      slug: SLUG, pedido: { ...PEDIDO_CRIADO, ...extra }, email: '', linhas: CARRINHO.linhas, criadoEm: 1000,
    }))
  }
  const montar = async (status: string, extra: Record<string, any> = {}) =>
    montarTela(await import('../pages/e/[slug]/pagamento.vue'), {
      rota: { params: { slug: SLUG }, path: `/e/${SLUG}/pagamento` },
      respostas: { '/api/conta/eu': EU_DENTRO, [`/api/pedido/${PEDIDO_CRIADO.pedidoId}`]: { status, ...extra } },
      stubs: { CabecalhoPublico: true, RodapePublico: true, OndasMarca: true },
    })

  it('B01 · estorno PARCIAL é venda de pé: a tela mostra os ingressos', async () => {
    guardar()
    tela = await montar('estornado_parcial', { pedido: PEDIDO_CRIADO.pedido, ingressos: [
      { id: 'ti-1', codigo: 'COD1', status: 'valido', qr: 'DT2:k1:e:COD1:x', setor: 'Pista', tipo: 'Inteira' }] })
    await espera()
    expect(tela.text()).not.toContain('Pagamento devolvido')
    expect(tela.text()).toContain('COD1')
  })

  it('B34 · cartão em análise: "Pagamento em análise", sem "Tempo de reserva esgotado"', async () => {
    guardar({ pagamento: { forma: 'credito', linkFatura: 'https://sandbox.asaas.com/i/x' },
      expiraEm: new Date(Date.now() - 60_000).toISOString() })
    tela = await montar('em_analise')
    await espera()
    expect(tela.text()).toContain('Pagamento em análise')
    expect(tela.text()).not.toContain('Tempo de reserva esgotado')
  })

  it('B20 · PIX vencido: o QR e o copia-e-cola somem, e a tela diz por quê', async () => {
    guardar({ expiraEm: new Date(Date.now() - 60_000).toISOString() })
    tela = await montar('aguardando_pagamento')
    expect(tela.text()).toContain('O prazo deste PIX venceu')
    expect(tela.text()).not.toContain('000201-copia-e-cola')
    expect(tela.findAll('button').some((b) => /Copiar código PIX/.test(b.text()))).toBe(false)
  })
})
