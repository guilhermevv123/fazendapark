// @vitest-environment happy-dom
/**
 * P1-4 (05/10) · o PIX do plano B (Asaas) que nasceu SEM QR.
 *
 * O checkout aceita a cobrança sem QR (o Asaas às vezes ainda não gerou no segundo da compra) e a
 * tela ficava em "O QR está sendo gerado" pra sempre — sem copia e cola, sem saída. Agora:
 *   · enquanto não há QR nem código, a tela diz "Gerando o código Pix…" e pergunta a cada 1,5 s —
 *     sem link pra fatura do Asaas (dono, 06/10: tudo no nosso site);
 *   · quando a consulta do pedido trouxer o código (o servidor pergunta de novo ao gateway), a
 *     tela mostra — em vez de seguir com o que veio no checkout.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { VERSAO_DO_CARRINHO } from './carrinhoDaVitrine'
import { limparTela, montarTela } from './.vitest-setup-dom'

const SLUG = 'zz-evento-pix-sem-qr'
const LINHA = {
  loteId: '11111111-1111-4111-8111-111111111111', tipoId: null,
  quantidade: 1, nome: 'Inteira', setor: 'Pista',
  unitFaceCents: 3000, unitTaxaCents: 300, unitTotalCents: 3300, pedeMeia: false, declaracao: null,
}
const CONTA = {
  nome: 'Maria de Teste', primeiroNome: 'Maria', email: 'maria@exemplo.com', cpf: '52998224725',
  telefone: '73998260963', instagram: null, endereco: {}, aceitaNovidades: false, temSenha: true,
  google: false, apple: false,
}
const PEDIDO = {
  ok: true, pedido: 'PED-SEMQR-1', pedidoId: '55555555-5555-4555-8555-555555555555',
  status: 'aguardando_pagamento',
  expiraEm: new Date(Date.now() + 20 * 60_000).toISOString(),
  totalCents: 3300, faceCents: 3000, feeCents: 300, descontoCents: 0,
  pagamento: { forma: 'pix', pixPayload: null, pixQrBase64: null, linkFatura: 'https://sandbox.asaas.com/i/pay_zz' },
}

let tela: Awaited<ReturnType<typeof montarTela>> | null = null
const espera = () => new Promise((r) => setTimeout(r, 30))

async function reabrir(consulta: any) {
  sessionStorage.clear()
  // F5 com a cobrança guardada na aba: a tela reabre e consulta o pedido na hora
  sessionStorage.setItem('dt:pedido', JSON.stringify({
    slug: SLUG, pedido: PEDIDO, email: 'maria@exemplo.com', linhas: [LINHA], criadoEm: 1000,
  }))
  sessionStorage.setItem('dt:carrinho', JSON.stringify({
    versao: VERSAO_DO_CARRINHO, slug: SLUG, linhas: [LINHA], totais: { face: 3000, taxa: 300, total: 3300, n: 1 },
    criadoEm: 500,
  }))
  tela = await montarTela(await import('../pages/e/[slug]/pagamento.vue'), {
    rota: { params: { slug: SLUG }, path: `/e/${SLUG}/pagamento` },
    respostas: {
      '/api/conta/eu': { conta: CONTA, exigeConta: true, social: { google: false, apple: false } },
      [`/api/pedido/${PEDIDO.pedidoId}`]: consulta,
    },
    stubs: { CabecalhoPublico: true, RodapePublico: true, OndasMarca: true },
  })
  await espera()
}

// a primeira importação da tela compila o SFC inteiro: fora do relógio de cada caso
beforeAll(async () => { await import('../pages/e/[slug]/pagamento.vue') }, 120_000)

afterEach(() => {
  tela?.unmount()
  tela = null
  limparTela()
  sessionStorage.clear()
})

describe('P1-4 · PIX sem QR', () => {
  it('sem QR e sem copia e cola: "Gerando o código Pix…", e NADA de fatura do Asaas (dono, 06/10)', async () => {
    await reabrir({ status: 'aguardando_pagamento', pagamento: PEDIDO.pagamento })
    expect(tela!.text()).toContain('Pague com PIX')
    expect(tela!.find('[data-parte="gerando-pix"]').text()).toContain('Gerando o código Pix')
    const fatura = tela!.findAll('a').find((a) => a.attributes('href') === PEDIDO.pagamento.linkFatura)
    expect(fatura, 'a tela mandou o comprador pra página do Asaas').toBeUndefined()
    expect(tela!.text()).not.toMatch(/Abrir a fatura/i)
  })

  it('a consulta trouxe o código: a tela mostra o copia e cola', async () => {
    await reabrir({ status: 'aguardando_pagamento',
      pagamento: { ...PEDIDO.pagamento, pixPayload: '000201-veio-depois', pixQrBase64: null } })
    expect(tela!.text(), 'a tela seguiu com o pedido sem código').toContain('000201-veio-depois')
    expect(tela!.findAll('button').some((b) => /Copiar código PIX/.test(b.text()))).toBe(true)
  })
})
