// @vitest-environment happy-dom
/**
 * pagamento-cartao.test.ts — o cartão de crédito digitado NO SITE, na tela de pagamento (05/10).
 *
 *   · só aparece com o servidor dizendo "ligado" (/api/pagamento/cartao) e na forma CRÉDITO —
 *     débito e cartão desligado seguem pela fatura do Asaas;
 *   · faltando dado, o Pagar não chama o checkout e diz o que falta;
 *   · preenchido, o cartão vai no corpo do checkout (só dígitos no número e no CEP) — e sai da
 *     memória da tela depois do envio;
 *   · recusado pelo banco: a frase do servidor aparece, o código de segurança é apagado e a
 *     pessoa continua no pagamento pra tentar de novo.
 * A conta do cartão (bandeira, Luhn) está em `cartao.test.ts`; o servidor, em
 * `server/utils/cartao-no-site.test.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { VERSAO_DO_CARRINHO } from './carrinhoDaVitrine'
import { chamadas, limparTela, montarTela } from './.vitest-setup-dom'

const SLUG = 'zz-evento-cartao'
const LINHA = {
  loteId: '11111111-1111-4111-8111-111111111111', tipoId: '22222222-2222-4222-8222-222222222222',
  quantidade: 1, nome: 'Inteira', setor: 'Pista',
  unitFaceCents: 3000, unitTaxaCents: 300, unitTotalCents: 3300, pedeMeia: false, declaracao: null,
}
const CARRINHO = { versao: VERSAO_DO_CARRINHO, slug: SLUG, linhas: [LINHA], totais: { face: 3000, taxa: 300, total: 3300, n: 1 } }
const CONTA = {
  nome: 'Maria de Teste', primeiroNome: 'Maria', email: 'maria@exemplo.com', cpf: '52998224725',
  telefone: '73998260963', instagram: null, endereco: {}, aceitaNovidades: false, temSenha: true,
  google: false, apple: false,
}
const EU = { conta: CONTA, exigeConta: true, social: { google: false, apple: false } }
const PAGO = {
  ok: true, pedido: 'PED-CARTAO-1', pedidoId: '44444444-4444-4444-8444-444444444444', status: 'pago',
  expiraEm: new Date(Date.now() + 20 * 60_000).toISOString(),
  totalCents: 3300, faceCents: 3000, feeCents: 300, descontoCents: 0,
  pagamento: { forma: 'credito', pixPayload: null, pixQrBase64: null, linkFatura: null, cartaoNoSite: true },
}
const recusa = (statusMessage: string, tipo: string) =>
  Object.assign(new Error(statusMessage), { statusCode: 422, data: { statusCode: 422, statusMessage, data: { tipo } } })

let tela: Awaited<ReturnType<typeof montarTela>> | null = null
const espera = () => new Promise((r) => setTimeout(r, 30))
const checkout = () => chamadas.find((c) => c.url === '/api/checkout')

async function abrir(respostas: Record<string, any> = {}) {
  sessionStorage.clear()
  sessionStorage.setItem('dt:carrinho', JSON.stringify(CARRINHO))
  tela = await montarTela(await import('../pages/e/[slug]/pagamento.vue'), {
    rota: { params: { slug: SLUG }, path: `/e/${SLUG}/pagamento` },
    respostas: {
      '/api/conta/eu': EU, '/api/pagamento/cartao': { ligado: true }, '/api/checkout': PAGO,
      [`/api/pedido/${PAGO.pedidoId}`]: { ...PAGO, ingressos: [] }, ...respostas,
    },
    stubs: { CabecalhoPublico: true, RodapePublico: true, OndasMarca: true },
  })
  await espera()
  await tela!.get('form').trigger('submit') // passo 1 → pagamento
  await espera()
}
async function digitar(parte: string, texto: string) {
  const el = tela!.get(`[data-parte="${parte}"]`)
  ;(el.element as HTMLInputElement).value = texto
  await el.trigger('input'); await espera()
}
async function preencherCartao() {
  await digitar('campo-numero', '4111 1111 1111 1111')
  await digitar('campo-titular', 'Maria de Teste')
  await digitar('campo-validade', '1230')
  await digitar('campo-cvv', '123')
  await tela!.get('[data-parte="campo-cep"]').setValue('45000-000')
  await tela!.get('[data-parte="campo-numero-endereco"]').setValue('12')
}
const pagar = async () => { await tela!.get('form').trigger('submit'); await espera() }

beforeAll(async () => { await import('../pages/e/[slug]/pagamento.vue') }, 120_000)
beforeEach(() => { tela = null })
afterEach(() => { tela?.unmount(); limparTela(); sessionStorage.clear() })

describe('cartão no site · a tela de pagamento', () => {
  it('ligado + crédito: o formulário aparece; Pix e débito não mostram', async () => {
    await abrir()
    expect(tela!.find('[data-parte="cartao-no-site"]').exists()).toBe(false) // Pix é o padrão
    await tela!.get('[data-forma="credito"] input').setValue(true); await espera()
    // escolher o crédito não abre o formulário ali: o botão leva à tela do cartão (dono, 06/10)
    expect(tela!.find('[data-parte="cartao-no-site"]').exists()).toBe(false)
    expect(tela!.get('[data-parte="pagar"]').text()).toBe('Continuar com cartão de crédito')
    await pagar()
    expect(checkout(), 'o Continuar já mandou o checkout').toBeUndefined()
    expect(tela!.find('[data-parte="cartao-no-site"]').exists()).toBe(true)
    expect(tela!.find('h1').text()).toBe('Cartão de crédito')
    expect(tela!.find('[data-forma="pix"]').exists(), 'a lista de formas segue na tela do cartão').toBe(false)
    // "Trocar a forma" volta pra lista
    await tela!.get('[data-parte="trocar-forma"]').trigger('click'); await espera()
    expect(tela!.find('[data-parte="cartao-no-site"]').exists()).toBe(false)
    expect(tela!.find('[data-forma="pix"]').exists()).toBe(true)
    await pagar()
    expect(tela!.find('[data-parte="cartao-no-site"]').exists()).toBe(true)
    expect(tela!.text()).not.toContain('ambiente seguro do Asaas')
    // débito só existia pela fatura do Asaas: com o cartão no site, a opção some (dono, 06/10)
    await tela!.get('[data-parte="trocar-forma"]').trigger('click'); await espera()
    expect(tela!.find('[data-forma="debito"]').exists(), 'débito ainda na lista — levaria pra fatura do Asaas').toBe(false)
    expect(tela!.find('[data-forma="pix"]').exists()).toBe(true)
  })

  it('desligado: crédito segue pela fatura do Asaas, sem formulário', async () => {
    await abrir({ '/api/pagamento/cartao': { ligado: false } })
    await tela!.get('[data-forma="credito"] input').setValue(true); await espera()
    expect(tela!.find('[data-parte="cartao-no-site"]').exists()).toBe(false)
    expect(tela!.text()).toContain('ambiente seguro do Asaas')
    expect(tela!.find('[data-forma="debito"]').exists(), 'desligado, o débito segue na lista').toBe(true)
  })

  it('faltando dado: o Pagar não chama o checkout e diz o que falta', async () => {
    await abrir()
    await tela!.get('[data-forma="credito"] input').setValue(true); await espera(); await pagar()
    await pagar()
    expect(checkout(), 'mandou o checkout com o cartão vazio').toBeUndefined()
    expect(tela!.text()).toContain('Confira os dados do cartão.')
    expect(tela!.text()).toContain('Digite o número do cartão.')
    await preencherCartao()
    await tela!.get('[data-parte="campo-cep"]').setValue('450')
    await pagar()
    expect(checkout()).toBeUndefined()
    expect(tela!.text()).toContain('CEP do endereço da fatura')
  })

  it('preenchido: o cartão vai no checkout (só dígitos) e a tela vai pro pago', async () => {
    await abrir()
    await tela!.get('[data-forma="credito"] input').setValue(true); await espera(); await pagar()
    await preencherCartao()
    await pagar()
    expect(checkout()!.opcoes.body).toMatchObject({
      forma: 'credito', parcelas: 1,
      cartao: { numero: '4111111111111111', titular: 'MARIA DE TESTE', mes: '12', ano: '2030', cvv: '123',
                cep: '45000000', numeroEndereco: '12' },
    })
    expect(checkout()!.opcoes.body.cartao.cpfTitular).toBeUndefined()
    // nada do cartão foi pra aba (o F5 não traz número nem código)
    expect(JSON.stringify(Object.fromEntries(Object.entries(sessionStorage)))).not.toContain('4111111111111111')
  })

  it('o cartão de outra pessoa leva o CPF dela', async () => {
    await abrir()
    await tela!.get('[data-forma="credito"] input').setValue(true); await espera(); await pagar()
    await preencherCartao()
    await tela!.get('[data-parte="outro-titular"]').setValue(true); await espera()
    await tela!.get('[data-parte="campo-cpf-titular"]').setValue('111.444.777-35')
    await pagar()
    expect(checkout()!.opcoes.body.cartao.cpfTitular).toBe('11144477735')
  })

  it('recusado pelo banco: a frase aparece, o código some e a pessoa segue no pagamento', async () => {
    await abrir({ '/api/checkout': recusa('Cartão não aprovado: Transação não autorizada. Confira os dados ou use outro cartão.', 'cartao_recusado') })
    await tela!.get('[data-forma="credito"] input').setValue(true); await espera(); await pagar()
    await preencherCartao()
    await pagar()
    expect(tela!.text()).toContain('Cartão não aprovado: Transação não autorizada')
    expect(tela!.find('[data-parte="cartao-no-site"]').exists(), 'saiu do pagamento depois da recusa').toBe(true)
    expect((tela!.get('[data-parte="campo-cvv"]').element as HTMLInputElement).value).toBe('')
    expect((tela!.get('[data-parte="campo-numero"]').element as HTMLInputElement).value).toBe('4111 1111 1111 1111')
  })
})
