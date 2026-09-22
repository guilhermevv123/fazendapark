// @vitest-environment happy-dom
/**
 * pagamento-cadastro.test.ts — o formulário do site que vira o cadastro do cliente.
 *
 * A rota de checkout já é conferida pela HTTP (`checkout-cadastro.test.ts`).
 * O que só a TELA pode errar, e nenhum teste de rota vê:
 *
 *   · mandar um campo com o NOME errado (`uf` em vez de `estado`), e o servidor
 *     aceitar em silêncio porque tudo é opcional lá — o cadastro chega vazio;
 *   · deixar a SENHA ir parar no `sessionStorage`. O `form` inteiro é gravado
 *     lá pra o F5 não perder a cobrança, e sessionStorage é legível por
 *     qualquer script da página;
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
async function preencherTudo(extra: { novidades?: boolean; senha?: string; nascimento?: string } = {}) {
  await digitar('nome', 'Maria de Teste')
  await digitar('email', 'maria@exemplo.com')
  await digitar('cpf', '52998224725')
  await digitar('tel', '73998260963')
  await digitar('nascimento', extra.nascimento ?? '25121990')
  await digitar('instagram', '@Maria.Souza')
  await digitar('cep', '45000000')
  await digitar('cidade', 'Vitória da Conquista')
  await campo('estado').setValue('BA')
  await digitar('rua', 'Rua das Flores')
  await digitar('numero', '120')
  await digitar('bairro', 'Centro')
  await digitar('senha', extra.senha ?? 'cachoeira2026')
  if (extra.novidades) await tela!.get('input[type=checkbox]').setValue(true)
}

const enviar = async () => {
  await tela!.get('form').trigger('submit')
  // a chamada e o que vem depois dela são assíncronos
  await new Promise((r) => setTimeout(r, 30))
}

const chamadaDoCheckout = () => chamadas.find((c) => c.url === '/api/checkout')

describe('o formulário pede o cadastro', () => {
  it('tem os campos do cadastro, e a senha é de senha', async () => {
    await abrir()
    for (const id of ['nascimento', 'instagram', 'cep', 'cidade', 'estado', 'rua', 'numero', 'bairro', 'senha']) {
      expect(tela!.find(`#${id}`).exists(), `falta o campo #${id}`).toBe(true)
    }
    expect(campo('senha').attributes('type')).toBe('password')
    expect(campo('senha').attributes('autocomplete')).toBe('new-password')
    // o consentimento começa DESMARCADO: marcar por ele é consentimento que a pessoa não deu
    expect((tela!.get('input[type=checkbox]').element as HTMLInputElement).checked).toBe(false)
  })

  it('as máscaras arrumam o que se digita: data, CEP', async () => {
    await abrir()
    await digitar('nascimento', '25121990')
    await digitar('cep', '45000000')
    expect((campo('nascimento').element as HTMLInputElement).value).toBe('25/12/1990')
    expect((campo('cep').element as HTMLInputElement).value).toBe('45000-000')
  })

  it('"Mostrar" troca o tipo do campo da senha e volta', async () => {
    await abrir()
    const botao = tela!.findAll('button').find((b) => /Mostrar/.test(b.text()))!
    await botao.trigger('click')
    expect(campo('senha').attributes('type')).toBe('text')
    await tela!.findAll('button').find((b) => /Ocultar/.test(b.text()))!.trigger('click')
    expect(campo('senha').attributes('type')).toBe('password')
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
      senha: 'cachoeira2026',
      aceitaNovidades: true,
    })
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

describe('a senha não sai da memória da tela', () => {
  it('NÃO vai pro sessionStorage, que guarda o formulário pra o F5 não perder a cobrança', async () => {
    await abrir()
    await preencherTudo({ novidades: true })
    await enviar()

    const guardado = sessionStorage.getItem('dt:pedido')
    expect(guardado, 'o pedido não foi guardado (a compra não passou?)').toBeTruthy()
    expect(guardado).not.toContain('cachoeira2026')
    // e o resto do cadastro também não precisa estar lá: só o que a cobrança usa
    expect(Object.keys(JSON.parse(guardado!).comprador).sort())
      .toEqual(['cupom', 'documento', 'email', 'nome', 'telefone'])
    expect(guardado).not.toContain('1990')
    expect(guardado).not.toContain('Vitória')
  })

  it('depois de criar o pedido a tela esquece a senha digitada', async () => {
    await abrir()
    await preencherTudo()
    await enviar()
    expect(tela!.text()).toContain('Pague com PIX')
    // a senha não fica na memória da tela nem depois que ela deixou de ser útil
    const pagina = tela!.findComponent({ name: 'Pagamento' })
    expect((pagina.vm as any).cadastro.senha).toBe('')
  })
})

describe('quando o servidor recusa o cadastro', () => {
  it('marca o campo que ele apontou, diz o recado e não cria pedido nenhum', async () => {
    const recusa = Object.assign(new Error('400'), {
      data: {
        statusMessage: 'A senha precisa ter pelo menos 8 caracteres.',
        data: { tipo: 'cadastro', campo: 'senha' },
      },
    })
    await abrir({ '/api/checkout': recusa })
    await preencherTudo()
    await enviar()

    expect(tela!.get('.faixa-erro').text()).toContain('pelo menos 8 caracteres')
    expect(campo('senha').classes()).toContain('ring-danger-600')
    // o outro campo NÃO fica marcado
    expect(campo('nascimento').classes()).not.toContain('ring-danger-600')
    expect(sessionStorage.getItem('dt:pedido')).toBeNull()
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
