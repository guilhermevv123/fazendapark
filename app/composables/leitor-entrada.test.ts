// @vitest-environment happy-dom
/**
 * Leitor de entrada — as decisões que a porta toma sem perguntar ao banco.
 *
 * Três defeitos que viravam gente barrada na porta, cada um travado aqui:
 *
 *  1. **erro do sistema pintado de "BARRADO" vermelho.** Sessão vencida (401),
 *     servidor caindo (500) e dado malformado (400) viravam `invalido`. O
 *     porteiro lê vermelho e manda embora quem tem ingresso;
 *  2. **uma falha de rede deixava o leitor offline até recarregar**, e
 *     offline o ingresso que não estava na lista baixada virava "inválido"
 *     — venda de balcão feita depois da descida, barrada;
 *  3. **a câmera relia o mesmo QR com 4G lento**: durante a leitura o laço
 *     pulava o quadro, o "visto" envelhecia, e o QR parado na lente saía de
 *     novo quando a resposta chegava.
 *
 * As funções são importadas DAS TELAS (o <script> não-setup de cada `.vue`),
 * não copiadas: é exatamente o código que a porta roda.
 */
import { describe, expect, it } from 'vitest'

const tela = () => import('../pages/admin/evento/[id]/validacao/index.vue')
const camera = () => import('../components/LeitorCamera.vue')

const erroHttp = (status: number, statusMessage = '') =>
  Object.assign(new Error(String(status)), { statusCode: status, data: { statusMessage } })

describe('leitor — erro do sistema não é veredito', () => {
  it('401 vira NÃO LIDO neutro com o caminho de entrar de novo', async () => {
    const { respostaDeFalha, tituloDoVeredito, CLASSE } = await tela()
    const r = respostaDeFalha(erroHttp(401, 'Faça login para continuar'))
    expect(r.resultado, 'sessão vencida virou veredito sobre o ingresso').toBe('nao_lido')
    expect(r.entrarDeNovo).toBe(true)
    expect(r.mensagem).toContain('Sua sessão expirou')
    expect(tituloDoVeredito(r)).toBe('NÃO LIDO — TENTE DE NOVO')
    expect(CLASSE[r.resultado], 'NÃO LIDO não pode ser vermelho').not.toContain('erro')
  })

  it('500 e 400 também viram NÃO LIDO, nunca BARRADO', async () => {
    const { respostaDeFalha, tituloDoVeredito, CLASSE } = await tela()
    for (const e of [erroHttp(500), erroHttp(400, 'Dados inválidos'), erroHttp(403, 'Sem permissão')]) {
      const r = respostaDeFalha(e)
      expect(r.resultado).toBe('nao_lido')
      expect(tituloDoVeredito(r)).not.toBe('BARRADO')
      expect(CLASSE[r.resultado]).not.toContain('bg-erro')
    }
  })

  it('sem status, ou proxy sem servidor atrás (502/503/504), é falha de REDE', async () => {
    const { falhaDeRede } = await tela()
    expect(falhaDeRede(new TypeError('Failed to fetch'))).toBe(true)
    for (const s of [502, 503, 504]) expect(falhaDeRede(erroHttp(s))).toBe(true)
    for (const s of [400, 401, 403, 404, 500]) expect(falhaDeRede(erroHttp(s))).toBe(false)
  })

  it('o código curto é barrado ANTES de sair, com o mesmo mínimo do servidor', async () => {
    const { MINIMO_DO_CODIGO } = await tela()
    // `/api/checkin`: qr: z.string().min(4)
    expect(MINIMO_DO_CODIGO).toBe(4)
  })
})

describe('leitor — offline', () => {
  it('fora da lista baixada é âmbar e manda chamar o supervisor, com a hora da lista', async () => {
    const { respostaForaDaLista, tituloDoVeredito, CLASSE, horaDaLista } = await tela()
    const em = '2026-09-22T21:47:00'
    const r = respostaForaDaLista(em)
    expect(r.resultado, 'fora da lista virou "inválido"').toBe('fora_da_lista')
    expect(r.local).toBe(true)
    expect(r.mensagem).toContain(`baixada às ${horaDaLista(em)}`)
    expect(r.mensagem).toContain('chame o supervisor')
    expect(horaDaLista(em)).toBe('21:47')
    expect(tituloDoVeredito(r)).toBe('CHAME O SUPERVISOR')
    expect(CLASSE[r.resultado]).toBe('bg-alerta text-white')
  })

  it('lista antiga desce de novo ao voltar a rede, não só a vazia', async () => {
    const { listaVelha, LISTA_VELHA_MS } = await tela()
    const agora = Date.parse('2026-09-22T22:00:00Z')
    expect(listaVelha(null, agora), 'sem lista, baixa').toBe(true)
    expect(listaVelha(new Date(agora - 60_000).toISOString(), agora)).toBe(false)
    expect(listaVelha(new Date(agora - LISTA_VELHA_MS - 1).toISOString(), agora),
      'lista da abertura do portão ficou a noite inteira no aparelho').toBe(true)
  })

  it('tenta o servidor sozinho a cada ~20 s', async () => {
    const { RETENTAR_MS } = await tela()
    expect(RETENTAR_MS).toBeGreaterThanOrEqual(15_000)
    expect(RETENTAR_MS).toBeLessThanOrEqual(30_000)
  })
})

describe('câmera — o mesmo QR não sai duas vezes com 4G lento', () => {
  it('QR parado na lente durante uma leitura de 4 s não dispara de novo', async () => {
    const { decidirLeitura } = await camera()
    let ultimo = { texto: '', visto: 0 }
    const t0 = 1_000_000

    // 1ª vista: dispara
    let d = decidirLeitura(ultimo, 'QR-A', t0, false)
    expect(d.emitir).toBe(true)
    ultimo = d.ultimo

    // a leitura segura a câmera por 4 s (4G lento); o QR continua no quadro
    for (let t = t0 + 140; t <= t0 + 4000; t += 140) {
      d = decidirLeitura(ultimo, 'QR-A', t, true)
      expect(d.emitir).toBe(false)
      ultimo = d.ultimo
    }

    // a pausa acabou e o QR ainda está lá: é a MESMA apresentação
    d = decidirLeitura(ultimo, 'QR-A', t0 + 4140, false)
    expect(d.emitir, 'o QR parado na lente foi lido de novo quando a resposta chegou').toBe(false)
  })

  it('outro QR durante a pausa não vira "repetido" depois dela', async () => {
    const { decidirLeitura } = await camera()
    let ultimo = decidirLeitura({ texto: '', visto: 0 }, 'QR-A', 0, false).ultimo
    ultimo = decidirLeitura(ultimo, 'QR-B', 500, true).ultimo
    expect(decidirLeitura(ultimo, 'QR-B', 700, false).emitir).toBe(true)
  })

  it('o mesmo QR vale de novo depois de sumir do quadro pela janela inteira', async () => {
    const { decidirLeitura, JANELA_DE_REPETICAO_MS } = await camera()
    const ultimo = decidirLeitura({ texto: '', visto: 0 }, 'QR-A', 0, false).ultimo
    expect(decidirLeitura(ultimo, 'QR-A', JANELA_DE_REPETICAO_MS + 1, false).emitir).toBe(true)
  })
})

// ===========================================================================
// A TELA montada — o caminho inteiro, do Enter ao cartão
// ===========================================================================
import { afterEach, beforeEach, vi } from 'vitest'
import { limparTela, montarTela, chamadas } from './.vitest-setup-dom'

/** memória do aparelho de mentira — o happy-dom desta suíte não traz `localStorage` */
function memoriaDoAparelho() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size },
  }
}

const montadas: any[] = []
beforeEach(() => { vi.stubGlobal('localStorage', memoriaDoAparelho()) })
afterEach(() => {
  // desmonta: o leitor offline deixa um `setInterval` de reconexão ligado
  while (montadas.length) montadas.pop().unmount()
  limparTela()
  vi.unstubAllGlobals()
})

const EVENTO = 'ev-zzqa-leitor'
const LOG = { resumo: { leituras: 0, aceitas: 0, recusadas: 0 }, porHora: [], portoes: [], leituras: [] }
const SINC_OK = { itens: [], resumo: {}, conflitos: [],
  publico: { pessoas: 0, entradas: 0, ingressos: 0, offline: 0, aptos: 10, faltam: 10, comparecimentoPct: 0 } }

async function abrirLeitor(checkin: any, sinc: any = SINC_OK) {
  const t = await montarTela(await tela(), {
    rota: { params: { id: EVENTO }, path: `/admin/evento/${EVENTO}/validacao` },
    respostas: {
      '/api/admin/evento/': LOG,
      '/api/portaria/sincronizar': sinc,
      '/api/checkin': checkin,
    },
    stubs: { AbasSecao: true, LeitorCamera: true },
  })
  montadas.push(t)
  // o onMounted é assíncrono (sincronização inicial): deixa ele terminar
  await new Promise((r) => setTimeout(r, 0))
  await t.vm.$nextTick()
  return t
}

async function lerCodigo(t: any, codigo: string) {
  await t.find('#cod').setValue(codigo)
  await t.find('form').trigger('submit')
  await new Promise((r) => setTimeout(r, 0))
  await t.vm.$nextTick()
}

describe('leitor montado', () => {
  it('sessão vencida: o cartão diz NÃO LIDO, não BARRADO, e oferece entrar de novo', async () => {
    const t = await abrirLeitor(erroHttp(401, 'Faça login para continuar'))
    await lerCodigo(t, 'CON-AAAA-BBBB')
    const veredito = t.find('[data-parte="veredito"]')
    expect(veredito.text()).toBe('NÃO LIDO — TENTE DE NOVO')
    expect(t.text()).toContain('Sua sessão expirou')
    expect(t.find('a[href^="/entrar?de="]').exists(), 'sem caminho pro login').toBe(true)
  })

  it('código com 3 caracteres: aviso na hora, nada vai pro servidor', async () => {
    const t = await abrirLeitor({ ok: true, resultado: 'ok', mensagem: 'Liberado' })
    await lerCodigo(t, 'ABC')
    expect(t.find('[data-parte="aviso-codigo"]').text()).toContain('Código curto demais')
    expect(chamadas.filter((c) => c.url === '/api/checkin')).toHaveLength(0)
    expect(t.find('[data-parte="veredito"]').exists()).toBe(false)
  })

  it('a rede cai numa leitura e o leitor VOLTA pro online quando o servidor responde', async () => {
    const t = await abrirLeitor(new TypeError('Failed to fetch'))
    await lerCodigo(t, 'CON-AAAA-BBBB')
    expect(t.text()).toContain('Sem rede')
    const botao = t.find('[data-parte="reconexao"] button')
    expect(botao.exists(), 'offline sem tentativa de reconexão à vista').toBe(true)

    await botao.trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    await t.vm.$nextTick()
    expect(t.text(), 'o leitor ficou preso no modo sem rede').toContain('Conectado')
  })

  it('…e volta SOZINHO, sem ninguém tocar em nada, no próximo ciclo de ~20 s', async () => {
    const { RETENTAR_MS } = await tela()
    const t = await abrirLeitor(new TypeError('Failed to fetch'))
    // só o relógio da reconexão é de mentira: o `setTimeout` segue de verdade
    // pras promessas da tela andarem
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await lerCodigo(t, 'CON-AAAA-BBBB')
      expect(t.text()).toContain('Sem rede')
      const antes = chamadas.filter((c) => c.url === '/api/portaria/sincronizar').length
      await vi.advanceTimersByTimeAsync(RETENTAR_MS + 100)
      await t.vm.$nextTick()
      expect(chamadas.filter((c) => c.url === '/api/portaria/sincronizar').length,
        'offline e ninguém tentou o servidor de novo').toBeGreaterThan(antes)
      expect(t.text()).toContain('Conectado')
    } finally {
      vi.useRealTimers()
    }
  })

  it('offline, código fora da lista baixada: âmbar e supervisor, não "inválido"', async () => {
    const t = await abrirLeitor(new TypeError('Failed to fetch'), {
      ...SINC_OK,
      lista: { geradaEm: new Date().toISOString(), truncada: false, ingressos: [{
        codigo: 'CON-LIST-AAAA', status: 'valido', titular: 'Fulano', setor: 'S', lote: 'L',
        tipo: null, pessoas: 1, sessaoInicio: null, sessaoFim: null,
      }] },
    })
    await lerCodigo(t, 'CON-NAOE-STAA')
    expect(t.find('[data-parte="veredito"]').text()).toBe('CHAME O SUPERVISOR')
    expect(t.text()).toContain('Não está na lista deste aparelho')
  })
})

// ===========================================================================
// 27/09 — "Só conferir" que ficava ligado, passaporte de vários dias sem rede e a lista que
// envelhecia com a rede de pé (ADM-03, ADM-04, ADM-06)
// ===========================================================================

describe('só conferir — pergunta, não passagem (ADM-03)', () => {
  it('a consulta boa não se parece com PODE ENTRAR: outro título, outra cor', async () => {
    const { tituloDoVeredito, classeDoVeredito, CLASSE, corDoPonto } = await tela()
    const consulta = { ok: true, resultado: 'ok', mensagem: 'Válido (não marcado)', consulta: true }
    const entrada = { ok: true, resultado: 'ok', mensagem: 'Liberado' }
    expect(tituloDoVeredito(consulta)).toBe('VÁLIDO — NÃO ENTROU')
    expect(tituloDoVeredito(entrada)).toBe('PODE ENTRAR')
    expect(classeDoVeredito(consulta), 'consulta pintada do verde de quem entrou').not.toBe(CLASSE.ok)
    expect(classeDoVeredito(entrada)).toBe(CLASSE.ok)
    expect(corDoPonto(consulta)).not.toBe(corDoPonto(entrada))
  })

  it('vale UMA leitura: a seguinte já marca entrada, e a faixa de modo consulta some', async () => {
    const t = await abrirLeitor({ ok: true, resultado: 'ok', mensagem: 'Válido (não marcado)', consulta: true })
    await t.find('[data-parte="so-conferir"] input').setValue(true)
    expect(t.find('[data-parte="modo-consulta"]').exists(), 'ligado sem aviso na tela').toBe(true)

    await lerCodigo(t, 'CON-AAAA-BBBB')
    await lerCodigo(t, 'CON-CCCC-DDDD')
    const corpos = chamadas.filter((c) => c.url === '/api/checkin').map((c) => c.opcoes.body)
    expect(corpos).toHaveLength(2)
    expect(corpos[0].apenasConsultar, 'a primeira leitura não foi consulta').toBe(true)
    expect(corpos[1].apenasConsultar,
      '"Só conferir" ficou ligado: o portão seguiu sem queimar ingresso').toBe(false)
    expect(t.find('[data-parte="modo-consulta"]').exists()).toBe(false)
    expect((t.find('[data-parte="so-conferir"] input').element as HTMLInputElement).checked).toBe(false)
  })
})

describe('passaporte de vários dias sem rede (ADM-04)', () => {
  const hoje = new Date(2026, 9, 10, 15, 0)   // 10/10 às 15h, no relógio do aparelho
  const ontem = '2026-10-09'

  it('um dia usado de três: entra hoje', async () => {
    const { decisaoDoPassaporte } = await tela()
    expect(decisaoDoPassaporte({ diasCobertos: 3, diasUsados: [ontem] }, hoje)).toBeNull()
  })

  it('já entrou hoje (pela lista ou por este aparelho): JÁ USADO', async () => {
    const { decisaoDoPassaporte } = await tela()
    expect(decisaoDoPassaporte({ diasCobertos: 3, diasUsados: ['2026-10-10'] }, hoje)?.resultado).toBe('ja_usado')
    expect(decisaoDoPassaporte({ diasCobertos: 3, diasAqui: ['2026-10-10'] }, hoje)?.mensagem)
      .toBe('Este passaporte já entrou hoje')
  })

  it('usou os três dias: JÁ USADO com o motivo', async () => {
    const { decisaoDoPassaporte } = await tela()
    const r = decisaoDoPassaporte({ diasCobertos: 3, diasUsados: ['2026-10-07', '2026-10-08', ontem] }, hoje)
    expect(r?.resultado).toBe('ja_usado')
    expect(r?.mensagem).toContain('3 dias')
  })

  it('lote com dias marcados: fora deles, FORA DO HORÁRIO', async () => {
    const { decisaoDoPassaporte } = await tela()
    const sabado = { inicio: new Date(2026, 9, 10, 9).toISOString(), fim: new Date(2026, 9, 10, 18).toISOString() }
    const domingo = { inicio: new Date(2026, 9, 11, 9).toISOString(), fim: new Date(2026, 9, 11, 18).toISOString() }
    expect(decisaoDoPassaporte({ diasCobertos: 2, sessoes: [sabado, domingo] }, hoje)).toBeNull()
    expect(decisaoDoPassaporte({ diasCobertos: 2, sessoes: [domingo] }, hoje)?.resultado).toBe('fora_da_sessao')
  })

  it('montado e sem rede: o passaporte que entrou ontem passa hoje; o de um dia só não passa duas vezes', async () => {
    const dia = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const ontemDeVerdade = new Date(Date.now() - 24 * 3600_000)
    const t = await abrirLeitor(new TypeError('Failed to fetch'), {
      ...SINC_OK,
      lista: { geradaEm: new Date().toISOString(), truncada: false, ingressos: [
        { codigo: 'CON-PASS-AAAA', status: 'valido', titular: 'Passaporte', setor: 'P', lote: 'L',
          tipo: null, pessoas: 1, sessaoInicio: null, sessaoFim: null,
          diasCobertos: 3, diasUsados: [dia(ontemDeVerdade)], sessoes: [] },
      ] },
    })
    await lerCodigo(t, 'CON-PASS-AAAA')   // a rede cai nesta leitura: decide pela lista
    expect(t.find('[data-parte="veredito"]').text(), 'passaporte de 3 dias barrado no 2º dia').toBe('PODE ENTRAR')
    await lerCodigo(t, 'CON-PASS-AAAA')
    expect(t.find('[data-parte="veredito"]').text(), 'o mesmo passaporte passou duas vezes no mesmo dia')
      .toBe('BARRADO')
    expect(t.text()).toContain('já entrou hoje')
  })
})

describe('a lista baixada não envelhece com rede (ADM-06)', () => {
  it('regra: com rede e lista antiga, renova; sem rede, não tenta', async () => {
    const { precisaRenovarLista, LISTA_VELHA_MS } = await tela()
    const agora = Date.parse('2026-10-10T14:00:00Z')
    const velha = new Date(agora - LISTA_VELHA_MS - 1).toISOString()
    const nova = new Date(agora - 60_000).toISOString()
    expect(precisaRenovarLista(true, velha, agora)).toBe(true)
    expect(precisaRenovarLista(true, nova, agora)).toBe(false)
    expect(precisaRenovarLista(false, velha, agora)).toBe(false)
  })

  it('montado: passados os 15 min, a lista desce de novo sozinha', async () => {
    const { LISTA_VELHA_MS, CONFERIR_LISTA_A_CADA_MS } = await tela()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      const t = await abrirLeitor({ ok: true, resultado: 'ok', mensagem: 'Liberado' }, {
        ...SINC_OK, lista: { geradaEm: new Date().toISOString(), truncada: false, ingressos: [] },
      })
      const baixadas = () => chamadas.filter((c) => c.url === '/api/portaria/sincronizar' && c.opcoes.body.comLista).length
      const antes = baixadas()
      await vi.advanceTimersByTimeAsync(LISTA_VELHA_MS + CONFERIR_LISTA_A_CADA_MS + 1_000)
      await t.vm.$nextTick()
      expect(baixadas(), 'com rede, a lista da abertura ficou o dia inteiro no aparelho').toBeGreaterThan(antes)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('no celular, campo e veredito no topo (ADM-24)', () => {
  /**
   * Em 375 px o campo de leitura ficava abaixo da dobra: KPIs, faixas, fila e sincronização vinham
   * antes. O happy-dom não calcula layout, então o que se prende aqui é o CONTRATO do reordenamento
   * (quem leva `max-lg:order-first`, e em que ordem do HTML); a medida em pixel é do navegador —
   * `e2e/evento.celular.e2e.ts` mede o campo dentro da primeira tela em 390 px.
   */
  it('abaixo de lg: cabeçalho, abas, leitura e veredito vêm antes de todo o resto, nessa ordem', async () => {
    const t = await abrirLeitor({ ok: true, resultado: 'ok', mensagem: 'Liberado', ingresso: { titular: 'Ana' } })
    await lerCodigo(t, 'CON-AAAA-BBBB')
    const pagina = t.find('[data-parte="leitor-pagina"]')
    expect(pagina.classes()).toEqual(expect.arrayContaining(['max-lg:flex', 'max-lg:flex-col']))
    const filhos = pagina.element.children
    const primeiros = [...filhos].filter((f) => f.classList.contains('max-lg:order-first'))
    expect(primeiros.length, 'algum bloco do topo perdeu o order-first').toBe(4)
    expect(primeiros[0].querySelector('h1')?.textContent).toContain('Leitor de entrada')
    expect(primeiros[2].getAttribute('data-parte')).toBe('cartao-leitura')
    expect(primeiros[2].querySelector('#cod'), 'o campo não está no cartão que sobe').toBeTruthy()
    expect(primeiros[3].getAttribute('data-parte')).toBe('cartao-veredito')
    // e o resto (estado da rede grande, contador, KPIs) NÃO sobe
    expect(t.find('[data-parte="contador"]').classes()).not.toContain('max-lg:order-first')
  })

  it('a rede aparece numa linha curta dentro do cartão de leitura', async () => {
    const t = await abrirLeitor({ ok: true, resultado: 'ok', mensagem: 'Liberado' })
    const linha = t.find('[data-parte="cartao-leitura"] [data-parte="rede-curta"]')
    expect(linha.exists(), 'no celular o operador perdeu de vista se está com rede').toBe(true)
    expect(linha.classes()).toContain('lg:hidden')
    expect(linha.text()).toContain('Conectado')
  })
})
