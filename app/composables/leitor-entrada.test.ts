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

// ===========================================================================
// 27/09 — a lista do tablet sem código em claro (ADM-25), o QR DT2 lido sem rede e o código
// digitado à mão, que não tem assinatura
// ===========================================================================
import { createHash } from 'node:crypto'
import { chaveDoCodigo as chaveDoServidor, numeroParaALista } from '../../server/utils/catraca'

describe('a chave da lista offline: a conta do leitor é a do servidor (ADM-25)', () => {
  it('o SHA-256 escrito à mão bate com o node:crypto — bordas de bloco e UTF-8 inclusive', async () => {
    const { sha256Hex } = await tela()
    const textos = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64),
      'a'.repeat(119), 'x'.repeat(1000), 'ação:ÇÃO ✓ 🎟']
    for (const t of textos) {
      expect(sha256Hex(t), `${t.length} caracteres`).toBe(createHash('sha256').update(t, 'utf8').digest('hex'))
    }
  })

  it('a chave de um código é a mesma nos dois lados, com caixa e espaço de qualquer jeito', async () => {
    const { chaveDoCodigo } = await tela()
    const sal = 'a1b2c3d4e5f60718293a4b5c'
    for (const c of ['CON-AB12-CD34', ' con-ab12-cd34 ', 'ING-ZZZZ-9999']) {
      expect(chaveDoCodigo(sal, c), c).toBe(chaveDoServidor(sal, c))
    }
  })
})

describe('o QR que a casa emite, lido sem rede', () => {
  it('DT2 (chave com nome) e DT1 (o já vendido) dão o código; o resto é digitado', async () => {
    const { codigoDoQr } = await tela()
    expect(codigoDoQr('DT2:k2:ev-1:CON-AAAA-BBBB:ABCDEFGHJK'))
      .toEqual({ codigo: 'CON-AAAA-BBBB', eventoDoQr: 'ev-1', digitado: false })
    expect(codigoDoQr('DT1:ev-1:CON-AAAA-BBBB:ABCDEFGHJK'))
      .toEqual({ codigo: 'CON-AAAA-BBBB', eventoDoQr: 'ev-1', digitado: false })
    expect(codigoDoQr(' con-aaaa-bbbb '))
      .toEqual({ codigo: 'CON-AAAA-BBBB', eventoDoQr: null, digitado: true })
  })

  it('QR torto (partes a mais ou a menos, versão que não existe) não vira código de outro ingresso', async () => {
    const { codigoDoQr } = await tela()
    // cada um cai como "digitado", com o texto inteiro: sem rede ele não acha nada na lista (fora da
    // lista, chame o supervisor) e com rede o servidor recusa — nunca um pedaço vira código válido
    for (const torto of [
      'DT2:k2:ev-1:CON-AAAA-BBBB',                 // DT2 sem a assinatura (4 partes)
      'DT2:k2:ev-1:CON-AAAA-BBBB:SIG:EXTRA',       // DT2 com parte a mais
      'DT1:ev-1:CON-AAAA-BBBB',                    // DT1 sem a assinatura
      'DT1:ev-1:CON-AAAA-BBBB:SIG:EXTRA',          // DT1 com parte a mais (5 partes, parece DT2)
      'DT3:k2:ev-1:CON-AAAA-BBBB:SIG',             // versão que não existe
      'dt2:k2:ev-1:CON-AAAA-BBBB:SIG',             // prefixo em minúsculas
      'https://exemplo.invalido/ingresso?c=CON-AAAA-BBBB',
    ]) {
      const r = codigoDoQr(torto)
      expect(r.digitado, `"${torto}" foi lido como QR assinado`).toBe(true)
      expect(r.eventoDoQr).toBeNull()
      expect(r.codigo, `"${torto}" virou só o código de dentro`).toBe(torto.trim().toUpperCase())
    }
    expect(codigoDoQr('').codigo).toBe('')
  })
})

describe('leitor montado com a lista de chaves (ADM-25)', () => {
  const SAL = 'f00dfeedbeef000011112222'
  const COD = 'CON-HASH-AAAA'
  const item = (sal: string, extra: Record<string, any> = {}) => ({
    chave: chaveDoServidor(sal, COD), status: 'valido', titular: 'Ana Chave', setor: 'Piscinas',
    lote: '1º lote', tipo: null, pessoas: 1, sessaoInicio: null, sessaoFim: null, ...extra,
  })
  const listaCom = (sal: string, ingressos: any[]) =>
    ({ geradaEm: new Date().toISOString(), truncada: false, sal, ingressos })

  /** como `abrirLeitor`, devolvendo as respostas pra o teste trocar a do servidor no meio */
  async function abrirSemRede(sinc: any) {
    const respostas: Record<string, any> = {
      '/api/admin/evento/': LOG,
      '/api/portaria/sincronizar': sinc,
      '/api/checkin': new TypeError('Failed to fetch'),
    }
    const t = await montarTela(await tela(), {
      rota: { params: { id: EVENTO }, path: `/admin/evento/${EVENTO}/validacao` },
      respostas, stubs: { AbasSecao: true, LeitorCamera: true },
    })
    montadas.push(t)
    await new Promise((r) => setTimeout(r, 0))
    await t.vm.$nextTick()
    return { t, respostas }
  }

  it('sem rede, o QR DT2 e o código digitado entram pela chave; o armazenamento não tem o código', async () => {
    const meia = { motivo: 'estudante', rotulo: 'Estudante', documento: 'Carteira estudantil',
                   numero: numeroParaALista('CIE 2026-44120') }
    const { t } = await abrirSemRede({ ...SINC_OK, lista: listaCom(SAL, [item(SAL, { meia })]) })
    const guardada = localStorage.getItem(`dt_portaria_lista_${EVENTO}`) ?? ''
    expect(guardada, 'a lista não foi guardada: nada abaixo prova nada').toContain(SAL)
    expect(guardada, 'o código do ingresso ficou em claro no aparelho').not.toContain(COD)
    expect(guardada, 'o número inteiro da meia ficou no aparelho').not.toContain('44120')

    await lerCodigo(t, `DT2:k2:${EVENTO}:${COD}:ABCDEFGHJK`)
    expect(t.find('[data-parte="veredito"]').text(), 'QR DT2 recusado sem rede').toBe('PODE ENTRAR')
    expect(t.text()).toContain('•••• 4120')
    expect(t.find('[data-parte="meia-numero-rotulo"]').text()).toContain('Final do número declarado')
    expect(t.find('[data-parte="codigo-digitado"]').exists(), 'QR lido marcado como digitado').toBe(false)

    await lerCodigo(t, COD.toLowerCase())
    expect(t.find('[data-parte="veredito"]').text(), 'o mesmo ingresso passou duas vezes').toBe('BARRADO')
  })

  it('QR DT2 de outro evento, sem rede: outro evento, não "fora da lista"', async () => {
    const { t } = await abrirSemRede({ ...SINC_OK, lista: listaCom(SAL, [item(SAL)]) })
    await lerCodigo(t, `DT2:k2:ev-de-outro:${COD}:ABCDEFGHJK`)
    expect(t.text()).toContain('Ingresso é de outro evento')
  })

  it('a lista nova vem com outro sal e herda a marca do que passou aqui e não subiu', async () => {
    const { t, respostas } = await abrirSemRede({ ...SINC_OK, lista: listaCom(SAL, [item(SAL)]) })
    await lerCodigo(t, COD)
    expect(t.find('[data-parte="veredito"]').text()).toBe('PODE ENTRAR')

    // o servidor volta, NÃO confirma a passagem (ela fica na fila) e manda a lista com sal novo
    const SAL2 = '0123456789abcdef01234567'
    respostas['/api/portaria/sincronizar'] = { ...SINC_OK, itens: [], lista: listaCom(SAL2, [item(SAL2)]) }
    await t.findAll('button').find((b) => b.text() === 'Baixar lista')!.trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    await t.vm.$nextTick()
    expect(localStorage.getItem(`dt_portaria_lista_${EVENTO}`), 'a lista nova não foi guardada').toContain(SAL2)

    await lerCodigo(t, COD)
    expect(t.find('[data-parte="veredito"]').text(),
      'baixar a lista no apagão devolveu a "válido" quem já passou por este portão').toBe('BARRADO')
    expect(t.text()).toContain('Ingresso já foi usado — não pode ser usado novamente')
  })
})

describe('código digitado à mão pede o documento (ADM-25)', () => {
  it('liberado por código digitado: o veredito pede o documento; pelo QR, não', async () => {
    const t = await abrirLeitor({ ok: true, resultado: 'ok', mensagem: 'Liberado', ingresso: { titular: 'Ana' } })
    await lerCodigo(t, 'CON-AAAA-BBBB')
    expect(t.find('[data-parte="veredito"]').text()).toBe('PODE ENTRAR')
    expect(t.find('[data-parte="codigo-digitado"]').exists(),
      'código sem assinatura liberado sem pedir o documento').toBe(true)

    await lerCodigo(t, `DT1:${EVENTO}:CON-AAAA-BBBB:ABCDEFGHJK`)
    expect(t.find('[data-parte="codigo-digitado"]').exists(), 'QR assinado tratado como digitado').toBe(false)
  })

  it('QR de antes da troca de chave: o servidor libera pelo código e a tela pede o documento', async () => {
    // o servidor manda `qrAntigo` quando a chave que assinou saiu do TICKET_KEYS (checkin.post.ts);
    // o leitor não tem as chaves pra saber sozinho
    const t = await abrirLeitor({ ok: true, resultado: 'ok', mensagem: 'Liberado', qrAntigo: true,
      aviso: 'QR de antes da troca de chave: confira o documento', ingresso: { titular: 'Ana' } })
    await lerCodigo(t, `DT2:zzvelha:${EVENTO}:CON-AAAA-BBBB:ABCDEFGHJK`)
    expect(t.find('[data-parte="veredito"]').text()).toBe('PODE ENTRAR')
    expect(t.find('[data-parte="codigo-digitado"]').text(), 'QR antigo liberado sem pedir o documento')
      .toBe('QR de antes da troca de chave: confira o documento')
  })

  it('recusa e "só conferir" não ganham o aviso — ele é sobre quem ENTRA', async () => {
    const t = await abrirLeitor({ ok: false, resultado: 'ja_usado', mensagem: 'Ingresso já foi usado — não pode ser usado novamente' })
    await lerCodigo(t, 'CON-AAAA-BBBB')
    expect(t.find('[data-parte="codigo-digitado"]').exists()).toBe(false)
  })
})

describe('o log de leituras só é pedido por quem pode lê-lo', () => {
  it('regra: a portaria não pede; operação e dono pedem; papel desconhecido pede como antes', async () => {
    const { pedeOLogDeLeituras } = await tela()
    expect(pedeOLogDeLeituras('portaria', EVENTO), 'a portaria pede o log que o servidor nega').toBe(false)
    expect(pedeOLogDeLeituras('operacao', EVENTO)).toBe(true)
    expect(pedeOLogDeLeituras('master', EVENTO)).toBe(true)
    expect(pedeOLogDeLeituras(undefined, EVENTO), 'aparelho reaberto sem rede ficou sem o log').toBe(true)
  })

  /** monta o leitor como `papel`, registrando cada `useFetch` e cada recarga que a tela pede */
  async function abrirComo(papel: string) {
    const pedidos: { url: string; op: any }[] = []
    const recargas: string[] = []
    const original = (globalThis as any).useFetch
    vi.stubGlobal('useFetch', (url: any, op?: any) => {
      const u = String(typeof url === 'function' ? url() : url)
      pedidos.push({ url: u, op })
      return { ...original(url, op), refresh: async () => { recargas.push(u) } }
    })
    const t = await montarTela(await tela(), {
      rota: { params: { id: EVENTO }, path: `/admin/evento/${EVENTO}/validacao` },
      respostas: {
        '/api/auth/eu': { usuario: { papel } },
        '/api/admin/evento/': LOG,
        '/api/portaria/sincronizar': SINC_OK,
        '/api/checkin': { ok: true, resultado: 'ok', mensagem: 'Liberado' },
      },
      stubs: { AbasSecao: true, LeitorCamera: true },
    })
    montadas.push(t)
    await new Promise((r) => setTimeout(r, 0))
    await t.vm.$nextTick()
    await lerCodigo(t, 'CON-AAAA-BBBB')
    const doLog = (u: string) => u.endsWith('/checkins')
    return { log: pedidos.find((p) => doLog(p.url)), recargasDoLog: recargas.filter(doLog).length, t }
  }

  it('montado como portaria: o log não sai ao abrir nem depois da entrada', async () => {
    const { log, recargasDoLog, t } = await abrirComo('portaria')
    expect(t.find('[data-parte="veredito"]').text(), 'nada abaixo prova nada').toBe('PODE ENTRAR')
    expect(log?.op?.immediate, 'a portaria abriu o leitor pedindo o log que o servidor nega (403)').toBe(false)
    expect(recargasDoLog, 'a cada entrada liberada, um 403 gastando a rede do portão').toBe(0)
  })

  it('montado como operação: o log sai ao abrir e é repintado depois da entrada', async () => {
    const { log, recargasDoLog } = await abrirComo('operacao')
    expect(log?.op?.immediate).toBe(true)
    expect(recargasDoLog).toBeGreaterThan(0)
  })
})
