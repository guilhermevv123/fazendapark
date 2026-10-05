// @vitest-environment happy-dom
/**
 * A portaria como APP da tela inicial (dono, 05/10: "estar preparado para todas as variáveis").
 *
 * Cada caso aqui é uma pergunta que o porteiro faria no portão:
 *
 *  · "abri o app sem internet — cadê os eventos?" (e não o formulário de login, que sem rede
 *    não entra);
 *  · "li uns ingressos sem rede e fechei o app — eles sobem?" (sobem sozinhos, de todos os
 *    eventos, sem abrir o leitor de cada um);
 *  · "a sessão caiu com leitura guardada — perdi?" (não: a fila fica e o login avisa);
 *  · "a pessoa entrou com rede e voltou com a rede caída" (a lista do aparelho já sabe).
 *
 * As telas e o composable são os DE VERDADE; só a rede é dublê.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chamadas, montarTela } from './.vitest-setup-dom'
import {
  filasPendentesDaPortaria, guardarEventosDaPortaria, lembrarLoginDaPortaria, loginLembradoDaPortaria,
  situacaoOfflineDoEvento, sincronizarFilasDaPortaria,
} from './portariaOffline'

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
  while (montadas.length) montadas.pop().unmount()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const erroHttp = (status: number) => Object.assign(new Error(String(status)), { statusCode: status })
const semRede = () => new TypeError('Failed to fetch')
const passagem = (id: string) => ({ id, qr: `CON-${id}`, gate: null, em: new Date().toISOString(), offline: true })
const giro = async (t?: any) => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  await t?.vm.$nextTick()
}

/* ===================================================================== composable */

describe('a fila de todos os eventos sobe sem abrir o leitor', () => {
  it('sobe as duas filas, tira só o que o servidor confirmou e conta os conflitos', async () => {
    localStorage.setItem('dt_portaria_fila_ev1', JSON.stringify([passagem('a'), passagem('b')]))
    localStorage.setItem('dt_portaria_fila_ev2', JSON.stringify([passagem('c')]))
    const enviados: any[] = []
    vi.stubGlobal('$fetch', async (_u: string, o: any) => {
      enviados.push(o.body)
      return { itens: o.body.fila.map((p: any) => ({ id: p.id })), resumo: { conflitos: o.body.eventId === 'ev2' ? 1 : 0 } }
    })
    const r = await sincronizarFilasDaPortaria('aparelho1')
    expect(r).toEqual({ enviadas: 3, conflitos: 1, semSessao: false, semRede: false })
    expect(filasPendentesDaPortaria()).toEqual([])
    expect(enviados.every((b) => b.deviceId === 'aparelho1' && b.comLista === false)).toBe(true)
  })

  it('leitura gravada ENQUANTO a remessa viajava fica na fila (não some no regravar)', async () => {
    localStorage.setItem('dt_portaria_fila_ev1', JSON.stringify([passagem('a')]))
    const remessas: string[][] = []
    vi.stubGlobal('$fetch', async (_u: string, o: any) => {
      remessas.push(o.body.fila.map((p: any) => p.id))
      // o leitor, aberto em outra aba, grava uma passagem nova no meio da PRIMEIRA remessa
      if (remessas.length === 1) {
        localStorage.setItem('dt_portaria_fila_ev1', JSON.stringify([passagem('a'), passagem('nova')]))
      }
      return { itens: o.body.fila.map((p: any) => ({ id: p.id })), resumo: {} }
    })
    const r = await sincronizarFilasDaPortaria('x')
    // a 'nova' não foi apagada no regravar: subiu na volta seguinte do laço
    expect(remessas).toEqual([['a'], ['nova']])
    expect(r.enviadas).toBe(2)
    expect(JSON.parse(localStorage.getItem('dt_portaria_fila_ev1')!)).toEqual([])
  })

  it('sessão vencida (401): nada sai da fila e o resultado diz por quê', async () => {
    localStorage.setItem('dt_portaria_fila_ev1', JSON.stringify([passagem('a')]))
    vi.stubGlobal('$fetch', async () => { throw erroHttp(401) })
    const r = await sincronizarFilasDaPortaria('x')
    expect(r.semSessao).toBe(true)
    expect(situacaoOfflineDoEvento('ev1').pendentes).toBe(1)
  })

  it('sem rede: nada sai da fila, tenta depois', async () => {
    localStorage.setItem('dt_portaria_fila_ev1', JSON.stringify([passagem('a')]))
    vi.stubGlobal('$fetch', async () => { throw semRede() })
    const r = await sincronizarFilasDaPortaria('x')
    expect(r.semRede).toBe(true)
    expect(situacaoOfflineDoEvento('ev1').pendentes).toBe(1)
  })

  it('servidor que não confirma nada não vira laço infinito', async () => {
    localStorage.setItem('dt_portaria_fila_ev1', JSON.stringify([passagem('a')]))
    const f = vi.fn(async () => ({ itens: [], resumo: {} }))
    vi.stubGlobal('$fetch', f)
    await sincronizarFilasDaPortaria('x')
    expect(f).toHaveBeenCalledTimes(1)
  })
})

/* ====================================================================== /portaria */

const EV = { id: 'ev-zzqa-portaria', nome: 'Domingo de Sol', inicio: '2026-10-11T12:00:00Z', fim: null,
  validados: 3, faltam: 7, aptos: 10, comparecimentoPct: 30 }

/** useFetch com erro de verdade (o dublê da casa nunca devolve erro) */
function servidor(op: { eu: any; destino: any }) {
  vi.stubGlobal('useFetch', (url: any) => {
    const alvo = String(url)
    const r = alvo === '/api/auth/eu' ? op.eu : op.destino
    const ehErro = r instanceof Error
    return {
      data: ref(ehErro ? null : r), error: ref(ehErro ? r : null), pending: ref(false),
      refresh: async () => {}, execute: async () => {}, status: ref(ehErro ? 'error' : 'success'),
    }
  })
}

async function abrirPortaria(respostas: Record<string, any> = {}) {
  const t = await montarTela((await import('../pages/portaria/index.vue')).default, {
    rota: { path: '/portaria' },
    respostas: { '/api/portaria/sincronizar': { itens: [], resumo: {} }, ...respostas },
  })
  montadas.push(t)
  await giro(t)
  return t
}

describe('/portaria sem internet', () => {
  it('servidor não responde e o aparelho lembra do login: mostra os eventos guardados, não o login', async () => {
    lembrarLoginDaPortaria('Porteiro')
    guardarEventosDaPortaria([EV])
    servidor({ eu: semRede(), destino: semRede() })
    const t = await abrirPortaria()
    expect(t.find('[data-parte="login-portaria"]').exists(), 'pediu login sem rede').toBe(false)
    expect(t.find('[data-parte="sem-internet"]').exists()).toBe(true)
    expect(t.find(`[data-evento="${EV.id}"]`).exists(), 'os eventos guardados não apareceram').toBe(true)
    expect(t.text()).toContain('Domingo de Sol')
  })

  it('o SERVIDOR diz "sem sessão": esquece o login lembrado e mostra o formulário', async () => {
    lembrarLoginDaPortaria('Porteiro')
    servidor({ eu: { usuario: null }, destino: { eventos: [] } })
    const t = await abrirPortaria()
    expect(t.find('[data-parte="login-portaria"]').exists()).toBe(true)
    expect(loginLembradoDaPortaria()).toBeNull()
  })

  it('sessão caiu com leituras guardadas: o login avisa que nada se perde', async () => {
    localStorage.setItem('dt_portaria_fila_ev9', JSON.stringify([passagem('a'), passagem('b')]))
    servidor({ eu: { usuario: null }, destino: { eventos: [] } })
    const t = await abrirPortaria({ '/api/portaria/sincronizar': erroHttp(401) })
    expect(t.find('[data-parte="fila-sem-sessao"]').text()).toContain('2 leituras')
  })
})

describe('/portaria com internet', () => {
  it('evento sem lista no aparelho pede "abra uma vez com internet"; com lista, "pronto"', async () => {
    servidor({ eu: { usuario: { nome: 'P' } }, destino: { eventos: [EV, { ...EV, id: 'ev-b', nome: 'Outro' }] } })
    localStorage.setItem(`dt_portaria_lista_${EV.id}`, JSON.stringify({ em: new Date().toISOString(), ingressos: [{ codigo: 'X' }] }))
    // a descida automática (deixarProntoOffline) falha aqui: o teste quer ver o estado ANTES dela
    const t = await abrirPortaria({ '/api/portaria/sincronizar': semRede() })
    const cards = t.findAll('[data-parte="eventos-da-portaria"] li')
    expect(cards[0].find('[data-parte="pronto-offline"]').exists()).toBe(true)
    expect(cards[1].find('[data-parte="nao-pronto-offline"]').exists()).toBe(true)
  })

  it('baixa sozinha a lista do evento que este aparelho ainda não tem', async () => {
    servidor({ eu: { usuario: { nome: 'P' } }, destino: { eventos: [EV] } })
    const lista = { geradaEm: new Date().toISOString(), truncada: false, sal: 's1', ingressos: [{ chave: 'k1' }, { chave: 'k2' }] }
    const t = await abrirPortaria({ '/api/portaria/sincronizar': { itens: [], resumo: {}, lista } })
    const guardada = JSON.parse(localStorage.getItem(`dt_portaria_lista_${EV.id}`) ?? 'null')
    expect(guardada?.ingressos).toHaveLength(2)
    // o MESMO formato que o leitor lê (em/truncada/sal/ingressos)
    expect(guardada).toMatchObject({ em: lista.geradaEm, truncada: false, sal: 's1' })
    expect(t.find('[data-parte="pronto-offline"]').exists()).toBe(true)
  })

  it('NÃO baixa lista por cima de fila parada (quem junta as marcas é o leitor)', async () => {
    servidor({ eu: { usuario: { nome: 'P' } }, destino: { eventos: [EV] } })
    localStorage.setItem(`dt_portaria_fila_${EV.id}`, JSON.stringify([passagem('a')]))
    await abrirPortaria({ '/api/portaria/sincronizar': semRede() })
    const descidas = chamadas.filter((c) => c.url === '/api/portaria/sincronizar' && c.opcoes?.body?.comLista)
    expect(descidas).toHaveLength(0)
  })

  it('fila parada aparece com o número e sobe sozinha ao abrir', async () => {
    servidor({ eu: { usuario: { nome: 'P' } }, destino: { eventos: [EV] } })
    localStorage.setItem(`dt_portaria_fila_${EV.id}`, JSON.stringify([passagem('a')]))
    const t = await abrirPortaria({ '/api/portaria/sincronizar': { itens: [{ id: 'a' }], resumo: {} } })
    const subidas = chamadas.filter((c) => c.url === '/api/portaria/sincronizar' && c.opcoes?.body?.fila?.length)
    expect(subidas.length).toBeGreaterThan(0)
    expect(situacaoOfflineDoEvento(EV.id).pendentes).toBe(0)
    expect(t.find('[data-parte="fila-pendente"]').exists()).toBe(false)
  })
})

/* ========================================================================= leitor */

describe('leitura COM rede marca a lista do aparelho', () => {
  const EVENTO = 'ev-zzqa-leitor-marca'
  const INGRESSO = { codigo: 'CON-MARC-AAAA', status: 'valido', titular: 'Fulana', setor: 'S', lote: 'L',
    tipo: null, pessoas: 1, sessaoInicio: null, sessaoFim: null }
  const SINC = { itens: [], resumo: {}, conflitos: [],
    publico: { pessoas: 0, entradas: 0, ingressos: 0, offline: 0, aptos: 1, faltam: 1, comparecimentoPct: 0 },
    lista: { geradaEm: new Date().toISOString(), truncada: false, ingressos: [INGRESSO] } }

  async function abrir(checkin: any) {
    const t = await montarTela((await import('../pages/admin/evento/[id]/validacao/index.vue')).default, {
      rota: { params: { id: EVENTO }, path: `/portaria/${EVENTO}` },
      respostas: { '/api/admin/evento/': { resumo: {}, porHora: [], portoes: [], leituras: [] },
        // cópia nova por teste: o leitor marca os objetos da lista que recebeu
        '/api/portaria/sincronizar': structuredClone(SINC), '/api/checkin': checkin },
      stubs: { AbasSecao: true, LeitorCamera: true },
    })
    montadas.push(t)
    await giro(t)
    return t
  }
  const ler = async (t: any, c: string) => {
    await t.find('#cod').setValue(c)
    await t.find('form').trigger('submit')
    await giro(t)
  }

  it('entrou com rede; a rede cai; o mesmo QR volta: o aparelho já sabe que foi usado', async () => {
    const t = await abrir({ ok: true, resultado: 'ok', mensagem: 'Liberado' })
    await ler(t, INGRESSO.codigo)
    const guardada = JSON.parse(localStorage.getItem(`dt_portaria_lista_${EVENTO}`)!)
    expect(guardada.ingressos[0].usadoAqui, 'a leitura online não marcou o aparelho').toBeTruthy()
    // nada foi pra fila: a passagem já está no servidor
    expect(JSON.parse(localStorage.getItem(`dt_portaria_fila_${EVENTO}`) ?? '[]')).toHaveLength(0)
  })

  it('o servidor disse "já usado": a lista do aparelho passa a dizer o mesmo', async () => {
    const t = await abrir({ ok: false, resultado: 'ja_usado', mensagem: 'Já usado' })
    await ler(t, INGRESSO.codigo)
    const guardada = JSON.parse(localStorage.getItem(`dt_portaria_lista_${EVENTO}`)!)
    expect(guardada.ingressos[0].status).toBe('usado')
  })

  it('"só conferir" com rede NÃO marca nada', async () => {
    const t = await abrir({ ok: true, resultado: 'ok', mensagem: 'Válido', consulta: true })
    await ler(t, INGRESSO.codigo)
    const guardada = JSON.parse(localStorage.getItem(`dt_portaria_lista_${EVENTO}`)!)
    expect(guardada.ingressos[0].usadoAqui).toBeFalsy()
  })
})
