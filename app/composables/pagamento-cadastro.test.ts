// @vitest-environment happy-dom
/**
 * pagamento-cadastro.test.ts — o formulário do site que vira o cadastro do cliente.
 *
 * A rota de checkout já é conferida pela HTTP (`checkout-cadastro.test.ts`).
 * O que só a TELA pode errar, e nenhum teste de rota vê:
 *
 *   · mandar um campo com o NOME errado (`uf` em vez de `estado`), e o servidor
 *     aceitar em silêncio porque tudo é opcional lá — o cadastro chega vazio;
 *   · pedir SENHA (B17): não existe login de cliente, e a senha era coleta sem
 *     finalidade que ainda deixava gravar a primeira senha de um e-mail alheio;
 *   · deixar o cadastro ir parar no `sessionStorage` — o `form` é gravado lá
 *     pra o F5 não perder a cobrança, e sessionStorage é legível por qualquer
 *     script da página;
 *   · gastar uma ida ao servidor com uma data que a própria tela já sabe que
 *     está torta, ou deixar o erro do servidor sem dizer QUAL campo;
 *   · marcar "aceito novidades" sozinha: o consentimento só vale se a pessoa
 *     marcou.
 *
 * Cada caso tem a prova de mutação que o `CLAUDE.md` pede — arranque a trava e
 * o caso fica vermelho — e o nome da trava está no próprio caso.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VERSAO_DO_CARRINHO } from './carrinhoDaVitrine'
import { chamadas, limparTela, montarTela } from './.vitest-setup-dom'

const SLUG = 'zz-evento-tela'

const CARRINHO = {
  versao: VERSAO_DO_CARRINHO,
  slug: SLUG,
  linhas: [{
    loteId: '11111111-1111-4111-8111-111111111111', tipoId: '22222222-2222-4222-8222-222222222222',
    quantidade: 1, nome: 'Inteira', setor: 'Pista',
    unitFaceCents: 3002, unitTaxaCents: 300, unitTotalCents: 3302, pedeMeia: false, declaracao: null,
  }],
  totais: { face: 3002, taxa: 300, total: 3302, n: 1 },
}

/** o que o checkout devolve quando o pedido nasce e falta pagar o PIX */
const PEDIDO_CRIADO = {
  ok: true, pedido: 'PED-TESTE-1', pedidoId: '33333333-3333-4333-8333-333333333333',
  status: 'aguardando_pagamento',
  expiraEm: new Date(Date.now() + 20 * 60_000).toISOString(),
  totalCents: 3302, faceCents: 3002, feeCents: 300, descontoCents: 0,
  pagamento: { forma: 'pix', pixPayload: '000201-copia-e-cola', pixQrBase64: null, linkFatura: null },
}

let tela: Awaited<ReturnType<typeof montarTela>> | null = null

async function abrir(respostas: Record<string, any> = { '/api/checkout': PEDIDO_CRIADO }) {
  sessionStorage.clear()
  sessionStorage.setItem('dt:carrinho', JSON.stringify(CARRINHO))
  tela = await montarTela(await import('../pages/e/[slug]/pagamento.vue'), {
    rota: { params: { slug: SLUG }, path: `/e/${SLUG}/pagamento` },
    respostas,
    // o cabeçalho e o rodapé da vitrine não são o assunto: sem o stub o Vue
    // avisa "Failed to resolve component" a cada montagem e enterra o que importa
    stubs: { CabecalhoPublico: true, RodapePublico: true, OndasMarca: true },
  })
  return tela
}

beforeEach(() => { tela = null })
afterEach(() => {
  // desmontar para os relógios do PIX (`setInterval`) pararem
  tela?.unmount()
  limparTela()
  sessionStorage.clear()
})

const campo = (id: string) => tela!.get(`#${id}`)
const digitar = (id: string, v: string) => campo(id).setValue(v)

/** o formulário todo, do jeito que a pessoa preenche */
async function preencherTudo(extra: { novidades?: boolean; nascimento?: string; email?: string;
  tel?: string; cidade?: string } = {}) {
  await digitar('nome', 'Maria de Teste')
  await digitar('email', extra.email ?? 'maria@exemplo.com')
  await digitar('cpf', '52998224725')
  await digitar('tel', extra.tel ?? '73998260963')
  await digitar('nascimento', extra.nascimento ?? '25121990')
  await digitar('instagram', '@Maria.Souza')
  await digitar('cep', '45000000')
  await digitar('cidade', extra.cidade ?? 'Vitória da Conquista')
  await campo('estado').setValue('BA')
  await digitar('rua', 'Rua das Flores')
  await digitar('numero', '120')
  await digitar('bairro', 'Centro')
  if (extra.novidades) await tela!.get('input[type=checkbox]').setValue(true)
}

const enviar = async () => {
  await tela!.get('form').trigger('submit')
  // a chamada e o que vem depois dela são assíncronos
  await new Promise((r) => setTimeout(r, 30))
}

const chamadaDoCheckout = () => chamadas.find((c) => c.url === '/api/checkout')

describe('o formulário pede o cadastro', () => {
  it('tem os campos do cadastro', async () => {
    await abrir()
    for (const id of ['nascimento', 'instagram', 'cep', 'cidade', 'estado', 'rua', 'numero', 'bairro']) {
      expect(tela!.find(`#${id}`).exists(), `falta o campo #${id}`).toBe(true)
    }
    // o consentimento começa DESMARCADO: marcar por ele é consentimento que a pessoa não deu
    expect((tela!.get('input[type=checkbox]').element as HTMLInputElement).checked).toBe(false)
  })

  it('B17 · não pede senha: não existe conta de cliente pra ela proteger', async () => {
    await abrir()
    expect(tela!.find('#senha').exists(), 'a tela voltou a pedir senha').toBe(false)
    expect(tela!.find('input[type=password]').exists()).toBe(false)
    expect(tela!.text()).not.toMatch(/senha/i)
  })

  it('B29 · os limites do servidor estão no campo, e o "Número" diz que é opcional', async () => {
    await abrir()
    expect(campo('nome').attributes('maxlength')).toBe('120')
    expect(campo('rua').attributes('maxlength')).toBe('120')
    expect(campo('numero').attributes('maxlength')).toBe('20')
    expect(campo('bairro').attributes('maxlength')).toBe('80')
    expect(campo('cidade').attributes('maxlength')).toBe('80')
    expect(tela!.get('label[for=numero]').text()).toMatch(/opcional/)
  })

  it('as máscaras arrumam o que se digita: data, CEP', async () => {
    await abrir()
    await digitar('nascimento', '25121990')
    await digitar('cep', '45000000')
    expect((campo('nascimento').element as HTMLInputElement).value).toBe('25/12/1990')
    expect((campo('cep').element as HTMLInputElement).value).toBe('45000-000')
  })

})

describe('o que a tela manda pro checkout', () => {
  it('cada campo do cadastro vai com o nome que o servidor lê', async () => {
    await abrir()
    await preencherTudo({ novidades: true })
    await enviar()

    const c = chamadaDoCheckout()
    expect(c, 'a tela não chamou o checkout').toBeTruthy()
    const comprador = c!.opcoes.body.comprador
    expect(comprador).toMatchObject({
      nome: 'Maria de Teste', email: 'maria@exemplo.com', documento: '52998224725',
      telefone: '73998260963',
      // dd/mm/aaaa → AAAA-MM-DD; o servidor lê ISO
      nascimento: '1990-12-25',
      instagram: '@Maria.Souza',
      endereco: {
        cep: '45000000', rua: 'Rua das Flores', numero: '120', bairro: 'Centro',
        cidade: 'Vitória da Conquista', estado: 'BA',
      },
      aceitaNovidades: true,
    })
    expect(comprador, 'a senha voltou pro corpo do checkout').not.toHaveProperty('senha')
  })

  it('desmarcado NÃO manda "aceitaNovidades" — silêncio não é revogação', async () => {
    await abrir()
    await preencherTudo({ novidades: false })
    await enviar()
    const comprador = chamadaDoCheckout()!.opcoes.body.comprador
    // ausente (não `false`): o servidor não mexe no consentimento que a pessoa já deu
    expect(comprador.aceitaNovidades).toBeUndefined()
  })

  it('a data que a própria tela sabe que está torta não gasta uma ida ao servidor', async () => {
    await abrir()
    await preencherTudo({ nascimento: '2512' })
    await enviar()
    expect(chamadaDoCheckout(), 'mandou um pedido com a data pela metade').toBeUndefined()
    // e a tela diz o que houve, marcando o campo certo
    expect(tela!.get('.faixa-erro').text()).toContain('data de nascimento')
    expect(campo('nascimento').classes()).toContain('ring-danger-600')
  })
})

describe('o cadastro não sai da memória da tela', () => {
  it('NÃO vai pro sessionStorage, que guarda o formulário pra o F5 não perder a cobrança', async () => {
    await abrir()
    await preencherTudo({ novidades: true })
    await enviar()

    const guardado = sessionStorage.getItem('dt:pedido')
    expect(guardado, 'o pedido não foi guardado (a compra não passou?)').toBeTruthy()
    // só o que a cobrança usa
    expect(Object.keys(JSON.parse(guardado!).comprador).sort())
      .toEqual(['cupom', 'documento', 'email', 'nome', 'telefone'])
    expect(guardado).not.toContain('1990')
    expect(guardado).not.toContain('Vitória')
  })
})

describe('quando o servidor recusa o cadastro', () => {
  const recusa = (statusMessage: string, data: any) =>
    Object.assign(new Error('400'), { data: { statusMessage, data } })

  it('marca o campo que ele apontou, diz o recado e não cria pedido nenhum', async () => {
    await abrir({ '/api/checkout': recusa('Instagram inválido: use só letras, números, ponto e sublinhado.',
      { tipo: 'cadastro', campo: 'instagram' }) })
    await preencherTudo()
    await enviar()

    expect(tela!.get('.faixa-erro').text()).toContain('Instagram inválido')
    expect(campo('instagram').classes()).toContain('ring-danger-600')
    expect(campo('instagram').attributes('aria-invalid')).toBe('true')
    // o outro campo NÃO fica marcado
    expect(campo('nascimento').classes()).not.toContain('ring-danger-600')
    expect(sessionStorage.getItem('dt:pedido')).toBeNull()
  })

  it('B12 · a recusa do GATEWAY ao celular marca o campo #tel (o servidor diz "telefone")', async () => {
    await abrir({ '/api/checkout': recusa(
      'O sistema de pagamento recusou o celular (O celular informado é inválido). Corrija e tente de novo.',
      { tipo: 'cadastro', campo: 'telefone', origem: 'gateway' }) })
    await preencherTudo()
    await enviar()
    expect(tela!.get('.faixa-erro').text()).toContain('recusou o celular')
    expect(campo('tel').classes()).toContain('ring-danger-600')
  })

  it('B11 · "documento" do servidor marca o #cpf', async () => {
    await abrir({ '/api/checkout': recusa('CPF inválido. Confira os 11 números.',
      { tipo: 'cadastro', campo: 'documento' }) })
    await preencherTudo()
    await enviar()
    expect(campo('cpf').classes()).toContain('ring-danger-600')
  })
})

describe('B11 · o que a própria tela já sabe que está errado não vai pro servidor', () => {
  it('e-mail a@b: marca o campo e não chama o checkout', async () => {
    await abrir()
    await preencherTudo({ email: 'a@b' })
    await enviar()
    expect(chamadaDoCheckout(), 'mandou pro servidor um e-mail que a tela sabia estar torto').toBeUndefined()
    expect(campo('email').classes()).toContain('ring-danger-600')
    expect(tela!.get('.faixa-erro').text()).toMatch(/e-mail/)
    expect(tela!.get('.faixa-erro').attributes('role')).toBe('alert')
  })

  it('celular pela metade: marca o campo #tel', async () => {
    await abrir()
    await preencherTudo({ tel: '7399' })
    await enviar()
    expect(chamadaDoCheckout()).toBeUndefined()
    expect(campo('tel').classes()).toContain('ring-danger-600')
  })
})

describe('B18 · "Continuar sem o cupom" confere o formulário como o botão principal', () => {
  it('com a cidade vazia, não cria pedido', async () => {
    await abrir({ '/api/cupom/conferir': { ok: false, recado: 'Não encontramos o cupom ZZX.' },
      '/api/checkout': PEDIDO_CRIADO })
    await preencherTudo({ cidade: '' })
    await digitar('cupom', 'ZZX')
    await campo('cupom').trigger('blur')
    await new Promise((r) => setTimeout(r, 30))
    const seguir = tela!.findAll('button').find((b) => /Continuar sem o cupom/.test(b.text()))
    expect(seguir, 'o botão de seguir sem o cupom não apareceu').toBeTruthy()
    await seguir!.trigger('click')
    await new Promise((r) => setTimeout(r, 30))
    expect(chamadaDoCheckout(), 'o pedido nasceu sem cidade').toBeUndefined()
    expect(campo('cidade').classes()).toContain('ring-danger-600')
  })
})

describe('B21 · as parcelas são do total COM o cupom, e dizem que não há juros', () => {
  it('cupom de R$ 10 num pedido de R$ 33,02: a parcela é sobre R$ 23,02', async () => {
    await abrir({ '/api/cupom/conferir': { ok: true, recado: 'Cupom ZZDEZ vale.', descontoCents: 1000 } })
    await digitar('cupom', 'ZZDEZ')
    await campo('cupom').trigger('blur')
    await new Promise((r) => setTimeout(r, 30))
    await tela!.findAll('button').find((b) => /Cartão de crédito/.test(b.text()))!.trigger('click')
    const opcoes = tela!.findAll('#parcelas option').map((o) => o.text())
    expect(opcoes[0]).toBe('À vista — R$ 23,02')
    expect(opcoes[1]).toBe('2× de R$ 11,51 sem juros')
    // piso de R$ 5 por parcela sobre o total com desconto: 4, não 6
    expect(opcoes).toHaveLength(4)
  })
})

describe('B13 · o pedido antigo não prende o comprador', () => {
  const ANTERIOR = {
    slug: SLUG, pedido: PEDIDO_CRIADO, comprador: { nome: 'Maria de Teste', email: 'maria@exemplo.com',
      documento: '529.982.247-25', telefone: '', cupom: '' },
    linhas: CARRINHO.linhas, criadoEm: 1000,
  }
  const DESISTIR = `/api/pedido/${PEDIDO_CRIADO.pedidoId}/desistir`

  it('carrinho montado DEPOIS do pedido: mostra o novo, avisa do anterior e larga ele antes de pagar', async () => {
    sessionStorage.clear()
    sessionStorage.setItem('dt:pedido', JSON.stringify(ANTERIOR))
    sessionStorage.setItem('dt:carrinho', JSON.stringify({ ...CARRINHO, criadoEm: 2000 }))
    tela = await montarTela(await import('../pages/e/[slug]/pagamento.vue'), {
      rota: { params: { slug: SLUG }, path: `/e/${SLUG}/pagamento` },
      respostas: { [DESISTIR]: { ok: true, status: 'expirado' },
        '/api/checkout': { ...PEDIDO_CRIADO, pedido: 'PED-TESTE-2', pedidoId: '44444444-4444-4444-8444-444444444444' } },
      stubs: { CabecalhoPublico: true, RodapePublico: true, OndasMarca: true },
    })
    expect(tela.text()).toContain('Você tem um pedido aguardando pagamento')
    expect(tela.text(), 'reabriu a cobrança velha em vez do carrinho novo').toContain('Finalizar compra')
    await preencherTudo()
    await enviar()
    const urls = chamadas.map((c) => c.url)
    expect(urls.indexOf(DESISTIR), 'não largou o pedido anterior').toBeGreaterThanOrEqual(0)
    expect(urls.indexOf(DESISTIR)).toBeLessThan(urls.indexOf('/api/checkout'))
  })

  it('F5 sem carrinho novo continua reabrindo a cobrança — e ela tem saída', async () => {
    sessionStorage.clear()
    sessionStorage.setItem('dt:pedido', JSON.stringify(ANTERIOR))
    tela = await montarTela(await import('../pages/e/[slug]/pagamento.vue'), {
      rota: { params: { slug: SLUG }, path: `/e/${SLUG}/pagamento` },
      respostas: { [`/api/pedido/${PEDIDO_CRIADO.pedidoId}`]: { status: 'aguardando_pagamento' },
        [DESISTIR]: { ok: true, status: 'expirado' } },
      stubs: { CabecalhoPublico: true, RodapePublico: true, OndasMarca: true },
    })
    expect(tela.text()).toContain('Pague com PIX')
    // a cobrança mostra o que está sendo pago
    expect(tela.text()).toContain('Inteira')
    const trocar = tela.findAll('button').find((b) => /Trocar a forma de pagamento/.test(b.text()))
    expect(trocar, 'a cobrança continua sem saída').toBeTruthy()
    await trocar!.trigger('click')
    await new Promise((r) => setTimeout(r, 30))
    expect(chamadas.some((c) => c.url === DESISTIR)).toBe(true)
    expect(tela.text()).toContain('Finalizar compra')
    expect(JSON.parse(sessionStorage.getItem('dt:carrinho')!).linhas).toHaveLength(1)
    expect(sessionStorage.getItem('dt:pedido')).toBeNull()
  })
})

describe('B34 e B20 · a cobrança diz o que houve', () => {
  const guardar = (extra: any = {}) => {
    sessionStorage.clear()
    sessionStorage.setItem('dt:pedido', JSON.stringify({
      slug: SLUG, pedido: { ...PEDIDO_CRIADO, ...extra }, comprador: {}, linhas: CARRINHO.linhas, criadoEm: 1000,
    }))
  }
  const montar = async (status: string, extra: Record<string, any> = {}) =>
    montarTela(await import('../pages/e/[slug]/pagamento.vue'), {
      rota: { params: { slug: SLUG }, path: `/e/${SLUG}/pagamento` },
      respostas: { [`/api/pedido/${PEDIDO_CRIADO.pedidoId}`]: { status, ...extra } },
      stubs: { CabecalhoPublico: true, RodapePublico: true, OndasMarca: true },
    })

  it('B01 · estorno PARCIAL é venda de pé: a tela mostra os ingressos, não "pagamento devolvido"', async () => {
    // trava: `pedidoVivo(r.status)` em `aplicarEstado` (e `situacaoDaCobranca` sem o parcial)
    guardar()
    tela = await montar('estornado_parcial', { pedido: PEDIDO_CRIADO.pedido, ingressos: [
      { id: 'ti-1', codigo: 'COD1', status: 'valido', qr: 'DT2:k1:e:COD1:x', setor: 'Pista', tipo: 'Inteira' }] })
    await new Promise((r) => setTimeout(r, 30))
    expect(tela.text()).not.toContain('Pagamento devolvido')
    expect(tela.text()).toContain('COD1')
  })

  it('B34 · cartão em análise: "Pagamento em análise", sem "Tempo de reserva esgotado"', async () => {
    guardar({ pagamento: { forma: 'credito', linkFatura: 'https://sandbox.asaas.com/i/x' },
      expiraEm: new Date(Date.now() - 60_000).toISOString() })
    tela = await montar('em_analise')
    await new Promise((r) => setTimeout(r, 30))
    expect(tela.text()).toContain('Pagamento em análise')
    expect(tela.text()).not.toContain('Tempo de reserva esgotado')
  })

  it('B20 · PIX vencido: o QR e o copia-e-cola somem, e a tela diz por quê', async () => {
    guardar({ expiraEm: new Date(Date.now() - 60_000).toISOString() })
    tela = await montar('aguardando_pagamento')
    expect(tela.text()).toContain('O prazo deste PIX venceu')
    expect(tela.text(), 'o copia-e-cola de uma cobrança cancelada continuou na tela')
      .not.toContain('000201-copia-e-cola')
    expect(tela.findAll('button').some((b) => /Copiar código PIX/.test(b.text()))).toBe(false)
  })
})

describe('o CEP preenche o resto — e falhar não trava a compra', () => {
  const VIACEP = 'https://viacep.com.br/ws/01310100/json/'

  it('cidade, estado, rua e bairro vêm do CEP', async () => {
    await abrir({
      [VIACEP]: { logradouro: 'Avenida Paulista', bairro: 'Bela Vista', localidade: 'São Paulo', uf: 'SP' },
    })
    await digitar('cep', '01310100')
    await new Promise((r) => setTimeout(r, 30))
    expect((campo('cidade').element as HTMLInputElement).value).toBe('São Paulo')
    expect((campo('estado').element as HTMLSelectElement).value).toBe('SP')
    expect((campo('rua').element as HTMLInputElement).value).toBe('Avenida Paulista')
    expect((campo('bairro').element as HTMLInputElement).value).toBe('Bela Vista')
  })

  it('CEP que não existe avisa e deixa a pessoa digitar', async () => {
    await abrir({ [VIACEP]: { erro: true } })
    await digitar('cep', '01310100')
    await new Promise((r) => setTimeout(r, 30))
    expect(tela!.text()).toContain('Não achamos esse CEP')
    expect((campo('cidade').element as HTMLInputElement).disabled).toBe(false)
  })

  it('serviço fora do ar também não trava: avisa e segue', async () => {
    await abrir({ [VIACEP]: new Error('rede caiu') })
    await digitar('cep', '01310100')
    await new Promise((r) => setTimeout(r, 30))
    expect(tela!.text()).toContain('Não deu pra buscar o CEP')
  })

  it('só pergunta com o CEP inteiro (8 dígitos), não a cada tecla', async () => {
    await abrir()
    await digitar('cep', '0131')
    await new Promise((r) => setTimeout(r, 30))
    expect(chamadas.filter((c) => c.url.includes('viacep'))).toHaveLength(0)
  })
})
