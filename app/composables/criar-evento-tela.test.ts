// @vitest-environment happy-dom
/**
 * criar-evento-tela.test.ts — o assistente de "Criar evento" depois da rodada de 27/09.
 *
 *   · EVT-03: os horários valem no FUSO ESCOLHIDO no passo 5 — 20:00 em Manaus é 00:00 UTC do dia
 *     seguinte, qualquer que seja o relógio de quem cria (a expiração do lote também);
 *   · EVT-14: a faixa etária nasce "Livre" (0), como o servidor e o banco;
 *   · EVT-06 → 05/10: o endereço é fixo, o do parque (Ubatã/BA), sem campo pra digitar;
 *   · EVT-09: toda criação leva uma chave; resposta "repetido" diz que nada nasceu em dobro;
 *   · EVT-10: o rascunho é da PESSOA — quem entra depois no mesmo navegador não herda o do outro,
 *     e o de chave antiga (sem dono) é apagado;
 *   · EVT-07: rascunho que tinha foto avisa "escolha a capa de novo" até escolher.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { chamadas, limparTela, montarTela } from './.vitest-setup-dom'

vi.setConfig({ testTimeout: 30_000 })

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
afterEach(() => { limparTela(); memoria.clear() })

const LayoutComBotao = defineComponent({
  emits: ['avancar', 'voltar', 'sair'],
  setup: (_p, { slots, emit }) => () => h('div', [
    h('button', { id: 'zz-avancar', type: 'button', onClick: () => emit('avancar') }, 'Prosseguir'),
    slots.default?.(),
  ]),
})

const PESSOA_A = { usuario: { email: 'dono@fazendapark.com.br', orgId: 'org-1', papel: 'master' } }
const PESSOA_B = { usuario: { email: 'operacao@fazendapark.com.br', orgId: 'org-1', papel: 'operacao' } }

async function abrir(eu: any = PESSOA_A, resposta: any = { ok: true, id: 'ev-1', slug: 'zz', slugPedido: null, status: 'ativo' }) {
  return montarTela(await import('../pages/admin/evento/novo.vue'), {
    rota: { path: '/admin/evento/novo' },
    stubs: {
      NuxtLayout: LayoutComBotao,
      CampoMoeda: (await import('../components/CampoMoeda.vue')).default,
      EnvioDeImagem: (await import('../components/EnvioDeImagem.vue')).default,
    },
    respostas: { '/api/auth/eu': eu, '/api/admin/evento': resposta },
  })
}
const avancar = async (tela: any) => { await tela.find('#zz-avancar').trigger('click'); await nextTick() }
function porRotulo(tela: any, texto: string) {
  const label = tela.findAll('label').find((l: any) => l.text().includes(texto))
  if (!label) throw new Error(`não achei o rótulo "${texto}"`)
  return label.find('input')
}

/** passo 1 → 5 com o mínimo; devolve no passo 5 */
async function ateOPasso5(tela: any, passo1: (t: any) => Promise<void> = async () => {}) {
  await tela.find('#nome').setValue('ZZ Noite em Manaus')
  await passo1(tela)
  await avancar(tela); await avancar(tela); await avancar(tela) // 1 → 2 → 3 → 4
  await tela.find('input[aria-label="Data de expiração do 1º lote"]').setValue('2031-03-09T18:00')
  await porRotulo(tela, 'Ingresso gratuito').setValue(true)
  await avancar(tela) // → 5
}
const corpoDoPost = () => chamadas.find((c) => c.url === '/api/admin/evento')?.opcoes?.body

describe('EVT-03 — os horários valem no fuso escolhido', () => {
  it('20:00 em Manaus vai como 00:00 UTC do dia seguinte; a expiração do lote também', async () => {
    const tela = await abrir()
    await ateOPasso5(tela)
    await tela.find('#fuso').setValue('America/Manaus')
    await tela.find('#inicio').setValue('2031-03-10T20:00')
    await tela.find('#fim').setValue('2031-03-10T23:00')
    expect(tela.find('[data-parte="aviso-fuso"]').text()).toContain('valem no fuso escolhido')
    await avancar(tela)
    const corpo = corpoDoPost()
    expect(corpo.fuso).toBe('America/Manaus')
    expect(corpo.inicio).toBe('2031-03-11T00:00:00.000Z')
    expect(corpo.fim).toBe('2031-03-11T03:00:00.000Z')
    expect(corpo.setores[0].lotes[0].expiraEm).toBe('2031-03-09T22:00:00.000Z')
  })
})

describe('EVT-14, EVT-06 e EVT-09 — o que o assistente manda', () => {
  it('faixa etária nasce Livre; o endereço é o do parque, fixo; a criação leva uma chave', async () => {
    const tela = await abrir()
    expect((tela.find('#idade').element as HTMLSelectElement).value).toBe('0')
    // 05/10: endereço fixo — nenhum campo pra digitar, o card mostra o do parque
    expect(tela.find('#cid').exists()).toBe(false)
    expect(tela.find('[data-parte="local-fixo"]').text()).toContain('Ubatã/BA')
    await ateOPasso5(tela)
    await tela.find('#inicio').setValue('2031-03-10T20:00')
    await tela.find('#fim').setValue('2031-03-10T23:00')
    await avancar(tela)
    const corpo = corpoDoPost()
    expect(corpo.faixaEtaria).toBe(0)
    expect(corpo.online).toBe(false)
    expect(corpo.local).toMatchObject({ nome: 'Fazenda Park Nova Conquista', cidade: 'Ubatã', estado: 'BA', cep: '45550-000' })
    expect(corpo.chaveDeCriacao).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('resposta "repetido": o ✓ diz que nada nasceu em dobro', async () => {
    const tela = await abrir(PESSOA_A, { ok: true, id: 'ev-1', slug: 'zz', slugPedido: null, status: 'ativo', repetido: true })
    await ateOPasso5(tela)
    await tela.find('#inicio').setValue('2031-03-10T20:00')
    await tela.find('#fim').setValue('2031-03-10T23:00')
    await avancar(tela)
    await vi.waitFor(() => expect(tela.find('[data-parte="ja-existia"]').exists()).toBe(true))
    expect(tela.find('[data-parte="ja-existia"]').text()).toContain('Nada foi criado em dobro')
  })
})

describe('EVT-10 — o rascunho é da pessoa', () => {
  it('A preenche; B, no mesmo navegador, abre vazio — e A reencontra o dela', async () => {
    let tela = await abrir(PESSOA_A)
    await tela.find('#nome').setValue('ZZ Rascunho da A')
    await vi.waitFor(() => expect([...memoria.values()].some((v) => v.includes('ZZ Rascunho da A'))).toBe(true))
    const chaves = [...memoria.keys()]
    expect(chaves).toHaveLength(1)
    expect(chaves[0]).toMatch(/^dt:criar-evento:v2:[0-9a-f]{8}$/)
    expect(chaves[0], 'o e-mail não fica escrito no armazenamento').not.toContain('dono')

    limparTela()
    tela = await abrir(PESSOA_B)
    await nextTick()
    expect((tela.find('#nome').element as HTMLInputElement).value, 'B herdou o rascunho da A').toBe('')

    limparTela()
    tela = await abrir(PESSOA_A)
    await vi.waitFor(() => expect((tela.find('#nome').element as HTMLInputElement).value).toBe('ZZ Rascunho da A'))
  })

  it('o rascunho de chave antiga (sem dono) é apagado, não entregue', async () => {
    memoria.set('dt:criar-evento:v1', JSON.stringify({ versao: 1, salvoEm: 1, passo: 1, f: { nome: 'De quem é isto?' }, estrutura: {} }))
    const tela = await abrir(PESSOA_B)
    await nextTick()
    expect((tela.find('#nome').element as HTMLInputElement).value).toBe('')
    expect(memoria.has('dt:criar-evento:v1')).toBe(false)
  })
})

describe('EVT-07 — a foto que o rascunho não guarda', () => {
  it('rascunho que tinha foto avisa até escolher a capa de novo', async () => {
    let tela = await abrir(PESSOA_A)
    const capa = new File([new Uint8Array([137, 80, 78, 71])], 'capa.png', { type: 'image/png' })
    const entrada = tela.findAll('input[type="file"]')[0]!
    Object.defineProperty(entrada.element, 'files', { value: [capa], configurable: true })
    await entrada.trigger('change')
    await tela.find('#nome').setValue('ZZ Com Capa')
    await vi.waitFor(() => expect([...memoria.values()].some((v) => v.includes('"tinhaFoto":true'))).toBe(true))

    limparTela() // F5
    tela = await abrir(PESSOA_A)
    await vi.waitFor(() => expect(tela.find('[data-parte="foto-perdida"]').exists()).toBe(true))
    expect(tela.find('[data-parte="foto-perdida"]').text()).toContain('Escolha a capa de novo')

    const deNovo = tela.findAll('input[type="file"]')[0]!
    Object.defineProperty(deNovo.element, 'files', { value: [capa], configurable: true })
    await deNovo.trigger('change')
    expect(tela.find('[data-parte="foto-perdida"]').exists()).toBe(false)
  })
})

describe('EVT-12 — a ajuda da criação diz o que existe', () => {
  it('sem prometer guia que não existe; o Suporte é chamado pelo que é', async () => {
    const tela = await montarTela(await import('../layouts/criacao.vue'), {
      rota: { path: '/admin/evento/novo' },
      props: { passos: ['Dados básicos', 'Descrição do evento'], passo: 1 },
    })
    const ajuda = tela.find('[data-parte="ajuda-da-criacao"]')
    expect(ajuda.text()).not.toContain('Saiba como configurar')
    expect(ajuda.text()).toContain('continuam editáveis depois de publicar')
    expect(ajuda.find('a').attributes('href')).toBe('/admin/suporte')
    expect(ajuda.find('a').text()).toBe('Suporte: o que fazer quando algo dá errado')
  })
})

describe('quem não cria evento ouve isso NA ENTRADA (matriz: "Financeiro pela URL")', () => {
  it('financeiro abre o endereço: a recusa da rota, sem passo nenhum pra preencher à toa', async () => {
    const tela = await abrir({ usuario: { email: 'financeiro@fazendapark.com.br', orgId: 'org-1', papel: 'financeiro' } })
    const aviso = tela.find('[data-parte="sem-acesso-criar"]')
    expect(aviso.exists(), 'o financeiro preencheu cinco passos pra ouvir o 403 no fim').toBe(true)
    expect(aviso.text()).toContain('Criar evento não é do seu acesso')
    expect(aviso.text()).toContain('Seu acesso é de Financeiro')
    expect(tela.find('#nome').exists()).toBe(false)
  })

  it('master e operação seguem direto pro passo 1', async () => {
    for (const eu of [PESSOA_A, PESSOA_B]) {
      const tela = await abrir(eu)
      expect(tela.find('[data-parte="sem-acesso-criar"]').exists()).toBe(false)
      expect(tela.find('#nome').exists()).toBe(true)
      limparTela()
    }
  })
})

// 05/10 (dono): "tem que ficar fixo" — o suporte é o WhatsApp do parque, sem campo
describe('contato de suporte fixo', () => {
  it('sem campo pra digitar; o que vai pro servidor é o WhatsApp do parque', async () => {
    const tela = await abrir()
    expect(tela.find('#sval').exists()).toBe(false)
    expect(tela.find('[data-parte="suporte-fixo"]').text()).toContain('(73) 99842-1010')
    await ateOPasso5(tela)
    await tela.find('#inicio').setValue('2031-03-10T20:00')
    await tela.find('#fim').setValue('2031-03-10T23:00')
    await avancar(tela)
    expect(corpoDoPost().suporte).toEqual({ tipo: 'whatsapp', valor: '(73) 99842-1010' })
  })
})
