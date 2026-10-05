// @vitest-environment happy-dom
/**
 * organizacao-dados-telas.test.ts — PROD-08 na TELA: quem vende, no painel e no site.
 *
 *   · Dados e cobrança: campo vazio mostra "a preencher" (só aqui, pro master); o CNPJ ganha
 *     máscara e conferência de dígito antes de salvar (CFG-02); a chave colada pela metade avisa
 *     (CFG-01); o CNPJ de exemplo do seed pede troca; o Salvar manda só o que mudou, normalizado;
 *   · recebimento (05/10): o cliente vê só o estado (cartão pelo Asaas, Pix pelo Mercado Pago),
 *     sem campo de chave nem token; os campos são da equipe da plataforma;
 *   · sair com edição pendente pergunta na janela DO SISTEMA, nunca no `confirm` do navegador;
 *   · rodapé público: mostra razão social, CNPJ e endereço QUANDO existem, e omite a linha quando
 *     não — nunca "a preencher" pro comprador;
 *   · Cancelamento, Termos e Privacidade: o canal de atendimento vem do banco (ou dos eventos, como
 *     reserva) e, sem nenhum, mandam à bilheteria; as condições da desistência são as do sistema.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chamadas, limparTela, montarTela } from './.vitest-setup-dom'

/** a guarda de saída que a tela registrou, e o push que ela faz depois do "Sair sem salvar" */
const saida = vi.hoisted(() => ({ guarda: null as null | ((para: any) => any), push: [] as string[] }))
vi.mock('vue-router', async (original) => ({
  ...(await original<typeof import('vue-router')>()),
  onBeforeRouteLeave: (fn: any) => { saida.guarda = fn },
  useRouter: () => ({ push: (p: string) => { saida.push.push(p) } }),
}))

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => limparTela())

const ORG_VAZIA = {
  id: 'org-1', nome: 'ZZ Parque', slug: 'zz-parque', documento: null, ambienteAsaas: 'sandbox', ambienteEfetivo: 'sandbox',
  ambienteDivergente: false, carteiraAsaas: null, temChave: false, chaveFinal: null, eventos: 1, pessoas: 2, clientes: 3,
  criadoEm: '2026-09-01T12:00:00Z', razaoSocial: null,
  endereco: { linha: null, bairro: null, cidade: null, uf: null, cep: null },
  emailAtendimento: null, telefoneAtendimento: null, encarregadoDados: null,
  // a visão da equipe da plataforma (os campos de chave aparecem); a do cliente tem o caso dela
  podeConfigurarRecebimento: true,
  mercadoPago: { temToken: false, tokenFinal: null, contaDeTeste: false, contaId: null, temSegredo: false,
    pixPeloMercadoPago: false, motivo: 'sem_token', urlDoAviso: null },
}
/** o mesmo cadastro, visto pelo master do parque: sem fim de chave, sem conta do MP */
const ORG_DO_CLIENTE = { ...ORG_VAZIA, podeConfigurarRecebimento: false }

async function configuracoes(org: any = ORG_VAZIA) {
  return montarTela(await import('../pages/admin/configuracoes.vue'), {
    rota: { path: '/admin/configuracoes' },
    respostas: { '/api/admin/organizacao': org },
    stubs: { teleport: true },
  })
}

describe('Dados e cobrança — os dados da empresa (PROD-08)', () => {
  it('campo vazio aparece como "a preencher" e o selo diz quantos faltam', async () => {
    const tela = await configuracoes()
    expect(tela.find('h1').text()).toBe('Dados e cobrança')
    // CNPJ, razão social, endereço, cidade e o canal de atendimento
    expect(tela.findAll('[data-parte="a-preencher"]')).toHaveLength(5)
    expect(tela.find('[data-parte="faltam"]').text()).toBe('faltam 4')
  })

  it('o CNPJ ganha máscara ao digitar e o dígito errado segura o Salvar (CFG-02)', async () => {
    const tela = await configuracoes()
    const campo = tela.find('[data-parte="campo-documento"]')
    await campo.setValue('12ABC34501DE35')
    expect((campo.element as HTMLInputElement).value).toBe('12.ABC.345/01DE-35')
    expect(tela.find('[data-parte="erro-documento"]').exists()).toBe(false)
    await campo.setValue('12ABC34501DE36')
    expect(tela.find('[data-parte="erro-documento"]').text()).toContain('dígito verificador')
    expect((tela.find('[data-acao="salvar"]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('o CNPJ de exemplo da instalação pede troca e não entra na prévia do rodapé', async () => {
    const tela = await configuracoes({ ...ORG_VAZIA, documento: '00000000000191' })
    expect(tela.find('[data-parte="documento-de-exemplo"]').text()).toContain('Banco do Brasil')
    expect(tela.find('[data-parte="previa"]').text()).not.toContain('00.000.000/0001-91')
  })

  it('chave colada pela metade avisa, em vez de só não acender o Salvar (CFG-01)', async () => {
    const tela = await configuracoes()
    await tela.find('[data-parte="campo-chave"]').setValue('$aact_hmlg_123')
    expect(tela.find('[data-parte="chave-curta"]').text()).toContain('não parece a chave inteira')
  })

  it('o Salvar manda só o que mudou, já normalizado', async () => {
    const tela = await configuracoes()
    await tela.find('#cfg-razao').setValue('  ZZ Parque Aquático LTDA ')
    await tela.find('#cfg-cep').setValue('45.550-000')
    await tela.find('#cfg-tel').setValue('(73) 3281-0000')
    await tela.find('[data-acao="salvar"]').trigger('click')
    const patch = chamadas.find((c) => c.url === '/api/admin/organizacao' && c.opcoes?.method === 'PATCH')
    expect(patch?.opcoes.body).toEqual({ razaoSocial: 'ZZ Parque Aquático LTDA', enderecoCep: '45550000', telefoneAtendimento: '7332810000' })
  })
})

describe('Dados e cobrança — recebimento é da equipe da plataforma (05/10)', () => {
  it('o master do parque vê o estado do cartão e do Pix, e nenhum campo de chave ou token', async () => {
    const tela = await configuracoes({ ...ORG_DO_CLIENTE, temChave: true, ambienteEfetivo: 'production',
      mercadoPago: { ...ORG_VAZIA.mercadoPago, temToken: true, pixPeloMercadoPago: true, motivo: null } })
    const bloco = tela.find('[data-parte="recebimento"]')
    expect(bloco.exists()).toBe(true)
    expect(bloco.text()).toContain('Cartão de crédito e débito')
    expect(bloco.text()).toContain('pelo Asaas')
    expect(bloco.text()).toContain('pelo Mercado Pago')
    expect(tela.find('[data-parte="estado-cartao"]').text()).toBe('LIGADO')
    expect(tela.find('[data-parte="estado-pix"]').text()).toBe('LIGADO')
    for (const parte of ['asaas', 'mercado-pago', 'campo-chave', 'campo-token-mp', 'campo-segredo-mp']) {
      expect(tela.find(`[data-parte="${parte}"]`).exists(), `o cliente viu ${parte}`).toBe(false)
    }
    expect(tela.text()).not.toContain('Chave de API')
    expect(tela.text()).not.toContain('Access Token')
  })

  it('sem recebimento ligado, o cliente vê "aguardando a equipe" — e o Pix sem MP sai pelo Asaas', async () => {
    const nada = await configuracoes(ORG_DO_CLIENTE)
    expect(nada.find('[data-parte="estado-cartao"]').text()).toBe('AGUARDANDO A EQUIPE')
    expect(nada.find('[data-parte="estado-pix"]').text()).toBe('AGUARDANDO A EQUIPE')
    limparTela()
    const soAsaas = await configuracoes({ ...ORG_DO_CLIENTE, temChave: true, ambienteEfetivo: 'production' })
    expect(soAsaas.find('[data-parte="estado-cartao"]').text()).toBe('LIGADO')
    expect(soAsaas.find('[data-parte="estado-pix"]').text()).toBe('PELO ASAAS POR ENQUANTO')
  })

  it('a equipe da plataforma vê os campos de chave e de token', async () => {
    const tela = await configuracoes()
    expect(tela.find('[data-parte="recebimento"]').exists()).toBe(false)
    expect(tela.find('[data-parte="campo-chave"]').exists()).toBe(true)
    expect(tela.find('[data-parte="mercado-pago"]').exists()).toBe(true)
  })
})

describe('Dados e cobrança — edição pendente, sem caixa do navegador', () => {
  it('a tela não usa confirm() nem beforeunload', async () => {
    const pos = vi.spyOn(window, 'addEventListener')
    const confirmar = vi.spyOn(window, 'confirm')
    const tela = await configuracoes()
    await tela.find('#cfg-razao').setValue('ZZ Parque Aquático LTDA')
    saida.guarda?.({ fullPath: '/admin' })
    await new Promise((r) => setTimeout(r, 0))
    expect(pos.mock.calls.some((c) => c[0] === 'beforeunload'), 'voltou a caixa nativa do F5').toBe(false)
    expect(confirmar).not.toHaveBeenCalled()
    pos.mockRestore()
    confirmar.mockRestore()
  })

  it('sem mexer: sair não pergunta e não há barra de salvar no pé', async () => {
    const tela = await configuracoes()
    expect(saida.guarda?.({ fullPath: '/admin' })).toBeUndefined()
    await tela.vm.$nextTick()
    expect(tela.find('[data-parte="janela-confirmar"]').exists()).toBe(false)
    expect(tela.find('[data-parte="barra-salvar"]').exists()).toBe(false)
  })

  it('com edição pendente: sair pergunta na janela do sistema; "Continuar editando" fica', async () => {
    saida.push.length = 0
    const tela = await configuracoes()
    await tela.find('#cfg-razao').setValue('ZZ Parque Aquático LTDA')
    expect(saida.guarda?.({ fullPath: '/admin' }), 'a navegação passou sem perguntar').toBe(false)
    await tela.vm.$nextTick()
    const janela = tela.find('[data-parte="janela-confirmar"]')
    expect(janela.text()).toContain('Sair sem salvar?')
    await janela.find('[data-acao="cancelar"]').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(tela.find('[data-parte="janela-confirmar"]').exists()).toBe(false)
    expect(saida.push).toEqual([])
  })

  it('"Sair sem salvar" refaz a navegação que foi segurada', async () => {
    saida.push.length = 0
    const tela = await configuracoes()
    await tela.find('#cfg-razao').setValue('ZZ Parque Aquático LTDA')
    saida.guarda?.({ fullPath: '/admin/equipe' })
    await tela.vm.$nextTick()
    await tela.find('[data-parte="janela-confirmar"] [data-acao="confirmar"]').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(saida.push).toEqual(['/admin/equipe'])
  })

  it('com edição pendente, o Salvar do pé grava o mesmo que o do topo', async () => {
    const tela = await configuracoes()
    await tela.find('#cfg-razao').setValue('ZZ Parque Aquático LTDA')
    const barra = tela.find('[data-parte="barra-salvar"]')
    expect(barra.exists(), 'no celular o único Salvar ficava lá no topo').toBe(true)
    expect(barra.text()).toContain('Alteração não salva')
    await barra.find('[data-acao="salvar-rodape"]').trigger('click')
    const patch = chamadas.find((c) => c.url === '/api/admin/organizacao' && c.opcoes?.method === 'PATCH')
    expect(patch?.opcoes.body).toEqual({ razaoSocial: 'ZZ Parque Aquático LTDA' })
  })

  it('a chave colada pela metade também segura a saída e o Salvar do pé', async () => {
    const tela = await configuracoes()
    await tela.find('[data-parte="campo-chave"]').setValue('$aact_hmlg_123')
    expect(saida.guarda?.({ fullPath: '/admin' })).toBe(false)
    expect(tela.find('[data-parte="barra-salvar"]').text()).toContain('A chave colada ainda não está inteira')
    expect((tela.find('[data-acao="salvar-rodape"]').element as HTMLButtonElement).disabled).toBe(true)
  })
})

const EMPRESA_COMPLETA = {
  nome: 'ZZ Parque', razaoSocial: 'ZZ Parque Aquático LTDA', documento: '12ABC34501DE35',
  endereco: { linha: 'Rodovia BA-120, km 5', bairro: 'Zona Rural', cidade: 'Ubatã', uf: 'BA', cep: '45550000' },
  email: 'atendimento@zz.teste.invalido', telefone: '7332810000', encarregado: 'Fulana — privacidade@zz.teste.invalido',
}

async function rodape(empresa: any) {
  return montarTela(await import('../components/RodapePublico.vue'), {
    rota: { path: '/' }, respostas: { '/api/organizacao-publica': empresa },
  })
}

describe('rodapé do site — quem vende', () => {
  it('com o cadastro completo: razão social, CNPJ, endereço e os canais com link', async () => {
    const tela = await rodape(EMPRESA_COMPLETA)
    const quem = tela.find('[data-parte="quem-vende"]').text()
    expect(quem).toContain(`© ${new Date().getFullYear()} ZZ Parque Aquático LTDA · CNPJ 12.ABC.345/01DE-35`)
    expect(quem).toContain('Rodovia BA-120, km 5')
    const links = tela.findAll('[data-parte="atendimento"] a').map((a) => a.attributes('href'))
    expect(links).toEqual(['mailto:atendimento@zz.teste.invalido', 'tel:+557332810000'])
    for (const p of ['/termos', '/privacidade', '/cancelamento']) {
      expect(tela.findAll('a').map((a) => a.attributes('href'))).toContain(p)
    }
  })

  it('sem cadastro: só o nome — sem CNPJ, sem endereço, sem coluna de atendimento, e nada "a preencher"', async () => {
    const tela = await rodape({ nome: 'ZZ Parque' })
    const quem = tela.find('[data-parte="quem-vende"]').text()
    expect(quem.trim()).toBe(`© ${new Date().getFullYear()} ZZ Parque`)
    expect(tela.find('[data-parte="atendimento"]').exists()).toBe(false)
    expect(tela.text()).not.toMatch(/a preencher|CNPJ/i)
  })
})

async function pagina(nome: 'termos' | 'privacidade' | 'cancelamento', empresa: any) {
  const mod = nome === 'termos' ? import('../pages/termos.vue')
    : nome === 'privacidade' ? import('../pages/privacidade.vue') : import('../pages/cancelamento.vue')
  return montarTela(await mod, { rota: { path: `/${nome}` }, respostas: { '/api/organizacao-publica': empresa } })
}

describe('páginas públicas', () => {
  it('Cancelamento: condições do sistema (7 dias da compra e até 7 dias antes do evento) e os canais', async () => {
    const tela = await pagina('cancelamento', EMPRESA_COMPLETA)
    expect(tela.find('[data-parte="condicoes"]').text()).toContain('até 7 dias antes da data do evento')
    expect(tela.findAll('[data-parte="como-pedir"] a').map((a) => a.attributes('href')))
      .toEqual(['mailto:atendimento@zz.teste.invalido', 'tel:+557332810000'])
    expect(tela.find('[data-parte="meia-entrada"]').text()).toContain('na portaria')
  })

  it('Cancelamento sem canal da empresa: usa o contato dos eventos; sem nenhum, manda à bilheteria', async () => {
    const reserva = await pagina('cancelamento', { nome: 'ZZ Parque', contatosDosEventos: [{ tipo: 'whatsapp', valor: '73999990000' }] })
    expect(reserva.find('[data-parte="como-pedir"] a').attributes('href')).toBe('https://wa.me/5573999990000')
    expect(reserva.find('[data-parte="como-pedir"]').text()).toContain('contato de atendimento dos eventos')
    limparTela()
    const nada = await pagina('cancelamento', { nome: 'ZZ Parque' })
    expect(nada.find('[data-parte="como-pedir"]').text()).toContain('Procure o atendimento na bilheteria')
  })

  it('Privacidade: o controlador é a empresa do banco, com o encarregado; os direitos da LGPD estão lá', async () => {
    const tela = await pagina('privacidade', EMPRESA_COMPLETA)
    const controlador = tela.find('[data-parte="controlador"]').text()
    expect(controlador).toContain('ZZ Parque Aquático LTDA (ZZ Parque)')
    expect(controlador).toContain('12.ABC.345/01DE-35')
    expect(controlador).toContain('Fulana — privacidade@zz.teste.invalido')
    expect(tela.find('[data-parte="direitos"]').text()).toContain('portabilidade')
  })

  it('Termos: quem vende, sem inventar o que não foi preenchido', async () => {
    const completa = await pagina('termos', EMPRESA_COMPLETA)
    expect(completa.find('[data-parte="quem-vende"]').text()).toContain('CNPJ12.ABC.345/01DE-35')
    limparTela()
    const vazia = await pagina('termos', { nome: 'ZZ Parque' })
    const quem = vazia.find('[data-parte="quem-vende"]').text()
    expect(quem).toContain('ZZ Parque')
    expect(quem).not.toContain('CNPJ')
    expect(quem).not.toContain('Endereço')
  })
})
