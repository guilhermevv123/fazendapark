// @vitest-environment happy-dom
/**
 * cadastro-evento.test.ts — o que a TELA faz com preço, canal, datas e o
 * destino do clique no evento. O lado do servidor está em
 * `server/api/admin/evento-cadastro.test.ts`; aqui a pergunta é outra: com
 * estes dados, o que a tela mostra e o que ela MANDA.
 *
 *   · o assistente trava lote a R$ 0,00 sem "Ingresso gratuito";
 *   · o lote sai do assistente vendendo no site E no balcão;
 *   · passo 5 enxuto: sem sessões por dia, sem "Publicar", sem conferência —
 *     o clique final PUBLICA (dono, 23/09: "tem que ser publicar");
 *   · sem campo de endereço: o servidor tira o endereço do nome (dono, 23/09);
 *   · o campo de dinheiro avisa valor abaixo de R$ 5,00;
 *   · operação clica no evento e cai numa tela que ela abre (não o dashboard);
 *   · "Mapa de Assentos" saiu do menu.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chamadas, limparTela, montarTela, navegacoes } from './.vitest-setup-dom'
import { menuDoEvento, primeiraTelaDoEvento } from './menuDoEvento'

/**
 * `localStorage` em memória. O Node 26 tem um `localStorage` global próprio
 * (vazio sem `--localstorage-file`) que esconde o do happy-dom — no navegador
 * de verdade não existe esse problema. O rascunho do assistente precisa dele.
 */
const memoria = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => memoria.get(k) ?? null,
    setItem: (k: string, v: string) => { memoria.set(k, String(v)) },
    removeItem: (k: string) => { memoria.delete(k) },
    clear: () => memoria.clear(),
  },
})

afterEach(() => { limparTela(); localStorage.clear() })

/** O layout do assistente de verdade tem o botão "Prosseguir"; o dublê também. */
const LayoutComBotao = defineComponent({
  emits: ['avancar', 'voltar', 'sair'],
  setup: (_p, { slots, emit }) => () => h('div', [
    h('button', { id: 'zz-avancar', type: 'button', onClick: () => emit('avancar') }, 'Prosseguir'),
    h('button', { id: 'zz-voltar', type: 'button', onClick: () => emit('voltar') }, 'Voltar'),
    slots.default?.(),
  ]),
})

async function avancar(tela: any) {
  await tela.find('#zz-avancar').trigger('click')
  await nextTick()
}

function porRotulo(tela: any, texto: string) {
  const label = tela.findAll('label').find((l: any) => l.text().includes(texto))
  if (!label) throw new Error(`não achei o rótulo "${texto}"`)
  return label.find('input')
}

describe('assistente de criação', () => {
  it('trava R$ 0,00, manda os dois canais, publica sem sessões e sem campo de endereço', async () => {
    const tela = await montarTela(await import('../pages/admin/evento/novo.vue'), {
      rota: { path: '/admin/evento/novo' },
      // o CampoMoeda DE VERDADE: é nele que mora o alerta de valor baixo
      stubs: {
        NuxtLayout: LayoutComBotao,
        CampoMoeda: (await import('../components/CampoMoeda.vue')).default,
        EnvioDeImagem: (await import('../components/EnvioDeImagem.vue')).default,
      },
      respostas: {
        '/api/admin/organizacoes': [{ id: 'org-1', nome: 'Fazenda Park' }],
        '/api/admin/evento': { ok: true, id: 'ev-1', slug: 'zz-noite-2', slugPedido: 'zz-noite' },
      },
    })

    // ---- passo 1: a capa por arquivo (não mais por URL)
    const capa = new File([new Uint8Array([137, 80, 78, 71])], 'capa.png', { type: 'image/png' })
    const entrada = tela.findAll('input[type="file"]')[0]!
    Object.defineProperty(entrada.element, 'files', { value: [capa], configurable: true })
    await entrada.trigger('change')
    expect(tela.text()).toContain('Sobe ao criar o evento')
    expect(tela.find('input[placeholder="https://…"]').exists()).toBe(false)

    await tela.find('#nome').setValue('ZZ Noite')
    expect(tela.find('#slug').exists(), 'o endereço sai do nome, no servidor').toBe(false)
    await tela.find('#cid').setValue('Ubatã')
    await tela.find('#sval').setValue('(73) 99999-0000')
    await avancar(tela)
    await avancar(tela) // passo 2 (descrição) → 3

    // ---- passo 3 (modelo Zig): já vem "Geral", "1º lote", Inteira e Meia-entrada
    expect(tela.text()).toContain('Geral')
    expect(tela.text()).toContain('1º lote')
    const nomesDosTipos = tela.findAll('input[aria-label^="Nome do tipo"]').map((i: any) => (i.element as HTMLInputElement).value)
    expect(nomesDosTipos).toEqual(['Inteira', 'Meia-entrada'])
    // troca "Geral" por "Pista" — digitado e SEM clicar em Adicionar: entra ao prosseguir
    await tela.find('button[aria-label="Remover o setor Geral"]').trigger('click')
    await tela.find('input[aria-label="Nome do setor"]').setValue('Pista')
    await avancar(tela)

    // ---- passo 4 (tabela da Zig): o lote nasce a R$ 0,00 — e não passa
    expect(tela.text()).toContain('Setor: Pista')
    expect(tela.text()).not.toContain('Política de taxas') // sem taxa/absorver no assistente
    await avancar(tela)
    expect(tela.text()).toMatch(/"Pista · 1º lote": o valor está R\$ 0,00/)
    // canais: uma coluna só, e nasce em "Todos" (site e bilheteria)
    expect((tela.find('select[aria-label="Canais de venda do 1º lote"]').element as HTMLSelectElement).value).toBe('todos')
    // digitar "30" vira R$ 0,30 — passa, mas com o alerta amarelo
    await tela.find('input[inputmode="numeric"]').setValue('30')
    expect(tela.text()).toContain('Confira o valor: R$ 0,30')
    // a data de expiração do lote (opcional) vai pro servidor
    await tela.find('input[aria-label="Data de expiração do 1º lote"]').setValue('2031-03-09T18:00')
    // gratuito de propósito zera e libera
    await porRotulo(tela, 'Ingresso gratuito').setValue(true)
    expect(tela.text()).not.toContain('Confira o valor')
    await avancar(tela)

    // ---- passo 5: 22h → 02h
    // (modelo Zig: um campo de data-e-hora por ponta, um só de encerramento)
    expect(tela.findAll('input[type="radio"]').length, 'as 3 opções de encerramento saíram').toBe(0)
    await tela.find('#inicio').setValue('2031-03-10T22:00')
    await tela.find('#fim').setValue('2031-03-11T02:00')
    await tela.find('#encerra').setValue('2031-03-10T20:00')

    // saíram do passo 5 (dono, 23/09): conferência, sessões por dia e "Publicar"
    for (const fora of ['Confira antes de criar', 'Vender ingressos por dia', 'Publicar assim que criar']) {
      expect(tela.text(), fora).not.toContain(fora)
    }

    await avancar(tela)
    const post = chamadas.find((c) => c.url === '/api/admin/evento')
    expect(post, 'o assistente não mandou o POST').toBeTruthy()
    const corpo = post!.opcoes.body
    expect(corpo.setores.map((x: any) => x.nome)).toEqual(['Pista'])
    expect(corpo.slug, 'endereço não vai da tela: o servidor tira do nome').toBeUndefined()
    // data e hora do campo único chegam como antes; o encerramento preenchido vale
    expect(corpo.inicio).toBe(new Date('2031-03-10T22:00').toISOString())
    expect(corpo.fim).toBe(new Date('2031-03-11T02:00').toISOString())
    expect(corpo.encerraVendasMinutosApos).toBeNull()
    expect(corpo.encerraVendasEm).toBe(new Date('2031-03-10T20:00').toISOString())
    expect(corpo.setores[0].lotes[0].expiraEm).toBe(new Date('2031-03-09T18:00').toISOString())
    // criou: nada de rascunho pra "continuar" e criar de novo
    expect(localStorage.getItem('dt:criar-evento:v1')).toBeNull()
    const lote = corpo.setores[0].lotes[0]
    // os dois tipos do passo 3 chegaram em cada lote, COMPARTILHANDO o estoque:
    // cada um vai até o lote inteiro (é o lote que segura o total)
    expect(lote.tipos.map((t: any) => [t.nome, t.descontoBps, t.exigeDocumento, t.quantidade]))
      .toEqual([['Inteira', 0, false, lote.quantidade], ['Meia-entrada', 5000, true, lote.quantidade]])
    expect(lote.faceCents).toBe(0)
    expect(lote.gratuito).toBe(true)
    expect([...lote.canais].sort()).toEqual(['bilheteria', 'online'])
    expect(corpo.publicar, 'criar tem que publicar: rascunho não aparece no site').toBe(true)
    expect(corpo.taxaBps, 'sem taxa de serviço por padrão (dono, 23/09)').toBe(0)
    // sessões por dia ficam em Ingressos → Sessões, não no assistente
    expect(corpo.sessoes).toEqual([])
    expect(corpo.setores[0].indiceSessao).toBeNull()
    // a capa sobe DEPOIS do evento gravado, no id que o servidor devolveu
    await vi.waitFor(() => expect(chamadas.some((c) => c.url === '/api/admin/evento/ev-1/imagem')).toBe(true))
    const iEvento = chamadas.findIndex((c) => c.url === '/api/admin/evento')
    const iCapa = chamadas.findIndex((c) => c.url === '/api/admin/evento/ev-1/imagem')
    expect(iCapa).toBeGreaterThan(iEvento)
    expect(corpo.banner, 'URL de imagem não vai mais no cadastro').toBeUndefined()
    const envio = chamadas[iCapa]!.opcoes.body as FormData
    expect(envio.get('campo')).toBe('banner')
    expect((envio.get('arquivo') as File).name).toBe('capa.png')
    // gravou: o "Evento publicado!" aparece ANTES de trocar de página (a pausa de
    // 1,2 s é de propósito — sem ela a pessoa cai nos ingressos sem saber se
    // o clique gravou)
    await vi.waitFor(() => expect(tela.text()).toContain('Evento publicado!'))
    await vi.waitFor(() => expect(navegacoes.length).toBeGreaterThan(0), { timeout: 3000 })
    expect(navegacoes.at(-1)).toBe('/admin/evento/ev-1/ingressos')
  })
})

describe('campo de dinheiro', () => {
  it('avisa valor abaixo do limite de conferência — "30" vira R$ 0,30', async () => {
    const CampoMoeda = (await import('../components/CampoMoeda.vue')).default
    const baixo = await montarTela(CampoMoeda, { props: { modelValue: 30, conferirAbaixo: 500 } })
    expect(baixo.text()).toContain('Confira o valor: R$ 0,30')
    const certo = await montarTela(CampoMoeda, { props: { modelValue: 3000, conferirAbaixo: 500 } })
    expect(certo.text()).not.toContain('Confira o valor')
    const zero = await montarTela(CampoMoeda, { props: { modelValue: 0, conferirAbaixo: 500 } })
    expect(zero.text()).not.toContain('Confira o valor')
  })
})

describe('clique no evento e menu', () => {
  it('operação cai na primeira tela que abre; master continua no dashboard', () => {
    expect(primeiraTelaDoEvento('e1', 'operacao')).toBe('/admin/evento/e1/ingressos')
    expect(primeiraTelaDoEvento('e1', 'master')).toBe('/admin/evento/e1/dashboard')
    expect(primeiraTelaDoEvento('e1', null)).toBe('/admin/evento/e1/dashboard')
  })

  it('a lista de eventos leva a operação pra essa tela, não pro dashboard', async () => {
    const tela = await montarTela(await import('../pages/admin/index.vue'), {
      rota: { path: '/admin' },
      respostas: {
        '/api/admin/eventos': [{
          id: 'e1', nome: 'ZZ Noite', status: 'ativo', inicio: '2031-03-10T22:00:00Z',
          organizacao: 'Fazenda Park', estoque: { total: 0, vendidos: 0 },
        }],
        '/api/auth/eu': { usuario: { papel: 'operacao' } },
      },
    })
    const destinos = tela.findAll('a').map((a: any) => a.attributes('href'))
    expect(destinos).toContain('/admin/evento/e1/ingressos')
    expect(destinos).not.toContain('/admin/evento/e1/dashboard')
  })

  it('rascunho tem "Publicar" no próprio card (dono, 23/09) — e só pra quem abre as Configurações', async () => {
    const rascunho = [{
      id: 'e2', nome: 'ZZ Rascunho', status: 'rascunho', inicio: '2031-03-10T22:00:00Z',
      organizacao: 'Fazenda Park', estoque: { total: 100, vendidos: 0 },
    }]
    const tela = await montarTela(await import('../pages/admin/index.vue'), {
      rota: { path: '/admin' },
      respostas: { '/api/admin/eventos': rascunho, '/api/auth/eu': { usuario: { papel: 'master' } } },
    })
    const botao = tela.findAll('button').find((b: any) => b.text() === 'Publicar')
    expect(botao, 'o rascunho não oferece publicar').toBeTruthy()
    await botao!.trigger('click')
    const patch = chamadas.find((c) => c.url === '/api/admin/evento/e2/configuracoes')
    expect(patch?.opcoes.method).toBe('PATCH')
    expect(patch?.opcoes.body).toEqual({ status: 'ativo' })

    limparTela()
    const portaria = await montarTela(await import('../pages/admin/index.vue'), {
      rota: { path: '/admin' },
      respostas: { '/api/admin/eventos': rascunho, '/api/auth/eu': { usuario: { papel: 'portaria' } } },
    })
    expect(portaria.findAll('button').some((b: any) => b.text() === 'Publicar')).toBe(false)
  })

  it('"Mapa de Assentos" saiu do menu do evento', () => {
    expect(menuDoEvento('e1').map((g) => g.nome)).not.toContain('Mapa de Assentos')
  })
})

describe('passo 3 no modelo da Zig', () => {
  it('voltar pro passo 3 e acrescentar um lote não apaga o preço já digitado no 4', async () => {
    const tela = await montarTela(await import('../pages/admin/evento/novo.vue'), {
      rota: { path: '/admin/evento/novo' },
      stubs: {
        NuxtLayout: LayoutComBotao,
        CampoMoeda: (await import('../components/CampoMoeda.vue')).default,
        EnvioDeImagem: (await import('../components/EnvioDeImagem.vue')).default,
      },
      respostas: { '/api/admin/organizacoes': [{ id: 'org-1', nome: 'Fazenda Park' }] },
    })
    await tela.find('#nome').setValue('ZZ Parque')
    await tela.find('#cid').setValue('Ubatã')
    await tela.find('#sval').setValue('(73) 99999-0000')
    await avancar(tela)
    await avancar(tela)
    await avancar(tela) // passo 3 com o padrão → 4

    await tela.find('input[inputmode="numeric"]').setValue('3000')
    expect(tela.text()).toContain('1º lote')
    // sem taxa de serviço: nada de "R$ 33,00" — a meia é metade do digitado
    await nextTick()
    expect(tela.text()).toContain('Meia-entrada: R$ 15,00')
    expect(tela.text()).not.toContain('33,00')

    await tela.find('#zz-voltar').trigger('click')
    await nextTick()
    // "Adicionar lote" em branco cria o próximo número
    await tela.findAll('button').find((b: any) => b.text() === 'Adicionar lote')!.trigger('click')
    expect(tela.find('button[aria-label="Remover o lote 2º lote"]').exists()).toBe(true)
    await avancar(tela)

    const precos = tela.findAll('input[inputmode="numeric"]').map((i: any) => (i.element as HTMLInputElement).value)
    expect(precos[0], 'o 1º lote perdeu o preço').toBe('30,00')
    // os dois lotes na tabela do setor
    expect(tela.find('input[aria-label="Quantidade do 1º lote"]').exists()).toBe(true)
    expect(tela.find('input[aria-label="Quantidade do 2º lote"]').exists()).toBe(true)
  })
})

describe('rascunho: sair no meio não perde nada', () => {
  const montar = async () => montarTela(await import('../pages/admin/evento/novo.vue'), {
    rota: { path: '/admin/evento/novo' },
    stubs: {
      NuxtLayout: LayoutComBotao,
      CampoMoeda: (await import('../components/CampoMoeda.vue')).default,
      EnvioDeImagem: (await import('../components/EnvioDeImagem.vue')).default,
    },
    respostas: { '/api/admin/organizacoes': [{ id: 'org-1', nome: 'Fazenda Park' }] },
  })

  it('preenche, sai, volta: continua no mesmo passo com o que tinha, e "Começar do zero" apaga', async () => {
    let tela = await montar()
    await tela.find('#nome').setValue('ZZ Rascunho')
    await tela.find('#cid').setValue('Ubatã')
    await tela.find('#sval').setValue('(73) 99999-0000')
    await avancar(tela)
    await avancar(tela) // → passo 3
    await tela.find('input[aria-label="Nome do setor"]').setValue('Camarote')
    await tela.findAll('button').find((b: any) => b.text() === 'Adicionar setor')!.trigger('click')
    await vi.waitFor(() => expect(localStorage.getItem('dt:criar-evento:v1')).toContain('Camarote'))

    limparTela() // saiu da página (o servidor reiniciou, fechou a aba…)
    tela = await montar()
    await vi.waitFor(() => expect(tela.text()).toContain('Camarote'))
    expect(tela.text(), 'sem faixa de aviso (dono, 23/09)').not.toContain('Continuando de onde você parou')                      // voltou no passo 3
    expect(tela.find('button[aria-label="Remover o setor Camarote"]').exists()).toBe(true)
    await avancar(tela); await avancar(tela)                        // …e os dados do passo 1 estão lá
    expect(tela.text()).toContain('Setor: Camarote')

    const recarregar = vi.fn()
    Object.defineProperty(window, 'location', { value: { ...window.location, reload: recarregar }, configurable: true })
    await tela.findAll('button').find((b: any) => b.text() === 'Começar do zero')!.trigger('click')
    expect(localStorage.getItem('dt:criar-evento:v1')).toBeNull()
    expect(recarregar).toHaveBeenCalled()
  })
})

describe('área de envio de imagem', () => {
  it('recusa o que não é foto antes de enviar, e diz o porquê', async () => {
    const EnvioDeImagem = (await import('../components/EnvioDeImagem.vue')).default
    const tela = await montarTela(EnvioDeImagem, {
      props: { rotulo: 'Capa', medida: '1600 × 900', proporcao: '16 / 9' },
    })
    const componente = tela.findComponent(EnvioDeImagem)
    const entrada = tela.find('input[type="file"]')
    const pdf = new File(['%PDF'], 'contrato.pdf', { type: 'application/pdf' })
    Object.defineProperty(entrada.element, 'files', { value: [pdf], configurable: true })
    await entrada.trigger('change')
    expect(tela.text()).toContain('Envie uma foto em JPG, PNG ou WEBP.')
    expect(componente.emitted('escolher')).toBeUndefined()

    const foto = new File([new Uint8Array([1])], 'ok.webp', { type: 'image/webp' })
    Object.defineProperty(entrada.element, 'files', { value: [foto], configurable: true })
    await entrada.trigger('change')
    expect(componente.emitted('escolher')?.[0]?.[0]).toBe(foto)
  })
})
