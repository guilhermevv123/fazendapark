// @vitest-environment happy-dom
/**
 * paginas-publicas.test.ts — o pedido, a transferência, a página de erro e a
 * home, montados com a resposta da rota na mão.
 *
 *   · `/ingressos/<código>` — B22 (código codificado), B10 (só o 404 é "não
 *     existe"; cada status diz o que houve), B01 (estorno parcial mostra os
 *     ingressos), B08 (cartão pendente paga de qualquer aparelho), B20 (QR some
 *     com o prazo vencido), B24 (fuso do evento);
 *   · `/transferencia/<token>` — B22, B10, B24, B33 (ingresso morto diz por
 *     quê; CPF recusado marca o campo);
 *   · `app/error.vue` — B25 (erro em português, com saída);
 *   · home — B23 (h2 → h3, sem pular pra h4) e B31 (descrição em parágrafos).
 *
 * Cada caso diz a trava que o deixa vermelho (a prova de mutação).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, onErrorCaptured, ref, Suspense } from 'vue'
import { limparTela, montarTela } from './.vitest-setup-dom'

const G = globalThis as any
const STUBS = { CabecalhoPublico: true, RodapePublico: true, OndasMarca: true, LogoMarca: true }

let tela: Awaited<ReturnType<typeof montarTela>> | null = null
let originais: Record<string, any> = {}
const pedidas: string[] = []

beforeEach(() => {
  tela = null
  pedidas.length = 0
  originais = { useFetch: G.useFetch, useAsyncData: G.useAsyncData, $fetch: G.$fetch }
  G.useFetch = (url: any, o: any) => { pedidas.push(String(url)); return originais.useFetch(url, o) }
})
afterEach(() => {
  tela?.unmount()
  Object.assign(G, originais)
  delete G.createError
  limparTela()
})

/** O `useFetch` passa a devolver ESTA falha. */
function falharCom(status: number) {
  G.useFetch = (url: any) => {
    pedidas.push(String(url))
    return { data: ref(null), pending: ref(false), status: ref('error'), refresh: async () => {},
      execute: async () => {}, error: ref({ statusCode: status, statusMessage: `HTTP ${status}` }) }
  }
}

/** Monta a página esperando que ela LANCE (404 fatal), e devolve o que foi lançado. */
async function montarEsperandoErro(pagina: string, rota: any) {
  const lancados: any[] = []
  G.createError = (o: any) => { lancados.push(o); return Object.assign(new Error(o.statusMessage), o) }
  const Pagina = (await import(/* @vite-ignore */ pagina)).default
  const Pegador = defineComponent({
    setup() {
      onErrorCaptured(() => false)
      return () => h(Suspense, null, { default: () => h(Pagina) })
    },
  })
  await montarTela(Pegador, { rota, stubs: STUBS }).catch(() => null)
  return lancados
}

/* ============================================================ ingressos */
const INGRESSO = (n: number, extra: Record<string, any> = {}) => ({
  id: `t-${n}`, codigo: `COD${n}`, status: 'valido', titular: null, cortesia: false, gratuito: false,
  usadoEm: null, setor: 'Pista', lote: 'Lote 1', tipo: 'Inteira', sessao: null, sessaoInicio: null,
  qr: `DT2:k1:e-1:COD${n}:assinatura`, ...extra,
})
function pedido(extra: Record<string, any> = {}) {
  return {
    pedido: 'PED-ZZTL-0001', pedidoId: 'p-1', status: 'pago', criadoEm: '2026-09-27T12:00:00Z',
    pagoEm: '2026-09-27T12:01:00Z', expiraEm: null, faceCents: 15000, feeCents: 1500, descontoCents: 0,
    totalCents: 16500, estornadoCents: 0, formaDePagamento: 'pix', fuso: 'America/Bahia',
    cortesia: false, gratuito: false, comprador: { nome: 'Maria de Teste', email: 'ma•••@exemplo.com' },
    evento: { nome: 'ZZ Festa', slug: 'zz-festa', inicio: '2026-10-04T12:00:00.000Z', substantivo: 'Ingressos',
      local: 'Conquista Park', cidade: 'Salvador', estado: 'BA', banner: null },
    itens: [], pagamento: null, ingressos: [INGRESSO(1), INGRESSO(2), INGRESSO(3)], pagoSemIngresso: false,
    ...extra,
  }
}
const CODIGO = 'PED-ZZTL-0001'
const abrirPedido = async (resposta: any, codigo = CODIGO) => {
  tela = await montarTela(await import('../pages/ingressos/[code].vue'), {
    rota: { params: { code: codigo }, path: `/ingressos/${codigo}` },
    respostas: { [`/api/pedido/${encodeURIComponent(codigo)}`]: resposta },
    stubs: STUBS,
  })
  await nextTick()
  return tela
}

describe('/ingressos · B22 e B10', () => {
  it('o código vai codificado: `..%2Fadmin` não vira /api/admin', async () => {
    // trava: `encodeURIComponent(code)` no useFetch
    await abrirPedido(pedido(), '../admin/clientes')
    expect(pedidas).toContain('/api/pedido/..%2Fadmin%2Fclientes')
  })
  it('500: "a bilheteria não respondeu", nunca "Pedido não encontrado"', async () => {
    // trava: `v-if="falha === 'nao_encontrado'"` (com `v-if="falha"` o 500 lê "não encontrado")
    falharCom(500)
    await abrirPedido(null)
    expect(tela!.text()).toContain('A bilheteria não respondeu agora')
    expect(tela!.text()).not.toContain('Pedido não encontrado')
  })
  it('404 vira erro 404 de verdade (fatal)', async () => {
    // trava: o `throw createError({ statusCode: 404, fatal: true })`
    falharCom(404)
    const lancados = await montarEsperandoErro('../pages/ingressos/[code].vue',
      { params: { code: CODIGO }, path: `/ingressos/${CODIGO}` })
    expect(lancados).toEqual([expect.objectContaining({ statusCode: 404, fatal: true })])
  })
  it('cada status fora do ar diz o que houve — nenhum lê "ainda não foi pago"', async () => {
    // trava: `situacao.frase` no lugar da frase fixa "ainda não foi pago"
    const casos: Record<string, RegExp> = {
      estornado: /valor deste pedido foi devolvido/, expirado: /prazo para pagar/,
      falhou: /não foi aprovado/, chargeback: /contestado/, cancelado: /foi cancelado/,
    }
    for (const [status, frase] of Object.entries(casos)) {
      await abrirPedido(pedido({ status, ingressos: [] }))
      expect(tela!.text(), status).toMatch(frase)
      expect(tela!.text(), status).not.toContain('ainda não foi pago')
      expect(tela!.text(), `${status}: "Total pago" num pedido que não foi pago`).not.toContain('Total pago')
      tela!.unmount(); tela = null
    }
  })
})

describe('/ingressos · B01 — estorno parcial', () => {
  it('os 3 ingressos aparecem com QR, e a página diz quanto voltou', async () => {
    // trava: `v-if="!situacao.vivo"` (com `status !== 'pago'` os ingressos somem)
    await abrirPedido(pedido({ status: 'estornado_parcial', estornadoCents: 2000 }))
    expect(tela!.findAll('article')).toHaveLength(3)
    expect(tela!.findAll('img[src^="/api/ingresso/"]')).toHaveLength(3)
    expect(tela!.text()).toContain('R$ 20,00 deste pedido foram devolvidos')
    expect(tela!.text()).toContain('PAGO · DEVOLUÇÃO PARCIAL')
    expect(tela!.text()).not.toContain('ainda não foi pago')
  })
})

describe('/ingressos · cada ingresso diz o que houve com ele (matriz 94, 95, 96)', () => {
  it('usado: JÁ UTILIZADO com a hora da entrada; transferido: sem código; cancelado: CANCELADO — nenhum com QR', async () => {
    // travas: `v-if="t.qr"` no <img>, `SEM_QR[t.status]` no lugar dele, `v-if="t.usadoEm"` e
    // `v-if="t.codigo"` — o "usado" é o caso que o E2E não monta (a catraca barra fora da sessão)
    await abrirPedido(pedido({ ingressos: [
      INGRESSO(1, { status: 'usado', qr: null, usadoEm: '2026-10-04T13:30:00.000Z' }),
      INGRESSO(2, { status: 'transferido', qr: null, codigo: null }),
      INGRESSO(3, { status: 'cancelado', qr: null }),
    ] }))
    const blocos = tela!.findAll('article')
    expect(blocos).toHaveLength(3)
    expect(tela!.findAll('img[src^="/api/ingresso/"]'), 'ingresso que não entra com QR na tela').toHaveLength(0)
    expect(blocos[0].text()).toContain('JÁ UTILIZADO')
    expect(blocos[0].text()).toContain('Ingresso já utilizado')
    // 13h30 UTC é 10h30 no parque (America/Bahia)
    expect(blocos[0].text()).toMatch(/Entrada em\s*04 de outubro de 2026[^0-9]*10:30/)
    expect(blocos[1].text()).toContain('TRANSFERIDO')
    expect(blocos[1].text()).toContain('Ingresso transferido para outra pessoa')
    expect(blocos[1].text(), 'o remetente ainda via o código do ingresso que passou adiante').not.toContain('Código')
    expect(blocos[2].find('.selo-erro').text()).toBe('CANCELADO')
    expect(blocos[2].text()).toContain('Ingresso cancelado')
  })
})

describe('/ingressos · B08 e B20 — pedido pendente', () => {
  const pendente = (extra: Record<string, any>) => pedido({
    status: 'aguardando_pagamento', ingressos: [], pagoEm: null,
    expiraEm: new Date(Date.now() + 15 * 60_000).toISOString(), ...extra,
  })
  it('cartão pendente: o link da fatura abre de qualquer aparelho', async () => {
    // trava: o bloco `data.pagamento?.forma === 'credito'` com o `linkFatura`
    const fatura = 'https://www.asaas.com/i/zz-fatura'
    await abrirPedido(pendente({ pagamento: { forma: 'credito', pixPayload: null, pixQrBase64: null, linkFatura: fatura } }))
    const a = tela!.find(`a[href="${fatura}"]`)
    expect(a.exists(), 'quem fechou a aba do cartão não tinha como pagar').toBe(true)
    expect(a.text()).toContain('Pagar com cartão')
    expect(a.attributes('rel')).toContain('noopener')
  })
  it('PIX com o prazo vencido: o copia-e-cola SOME e a página diz que venceu', async () => {
    // trava: `prazoVencido` antes do bloco do PIX
    await abrirPedido(pendente({ expiraEm: new Date(Date.now() - 60_000).toISOString(),
      pagamento: { forma: 'pix', pixPayload: '000201-copia-e-cola-zz', pixQrBase64: null, linkFatura: null } }))
    await nextTick()
    expect(tela!.text()).toContain('O prazo deste pagamento venceu')
    expect(tela!.text(), 'pagar um PIX cancelado é dinheiro que não chega').not.toContain('000201-copia-e-cola-zz')
  })
  it('PIX dentro do prazo segue na tela', async () => {
    await abrirPedido(pendente({ pagamento: { forma: 'pix', pixPayload: '000201-copia-e-cola-zz', pixQrBase64: null, linkFatura: null } }))
    expect(tela!.text()).toContain('000201-copia-e-cola-zz')
    expect(tela!.text()).not.toContain('venceu')
  })
})

describe('/ingressos · B24 — o fuso do evento', () => {
  it('o mesmo instante sai 9h num evento de Salvador e 8h num de Manaus', async () => {
    // trava: `dataNoFuso(v, data.value?.fuso)`
    await abrirPedido(pedido())
    expect(tela!.text()).toMatch(/04 de outubro de 2026[^0-9]*09:00/)
    tela!.unmount(); tela = null
    await abrirPedido(pedido({ fuso: 'America/Manaus' }))
    expect(tela!.text()).toMatch(/04 de outubro de 2026[^0-9]*08:00/)
  })
})

/* ======================================================== transferência */
const TOKEN = 'zzTokenDeTransferencia'
function transferencia(extra: Record<string, any> = {}) {
  return {
    status: 'aguardando', statusTexto: 'Aguardando aceite', podeAceitar: true, motivo: null,
    venceEm: '2026-10-01T15:00:00.000Z',
    de: { nome: 'João', email: 'jo•••@exemplo.com' }, para: { nome: 'Ana', email: null },
    evento: { nome: 'ZZ Festa', comecaEm: '2026-10-04T12:00:00.000Z', slug: 'zz-festa', local: 'Conquista Park',
      cidade: 'Salvador', estado: 'BA', fuso: 'America/Bahia' },
    ingresso: { setor: 'Pista', lote: 'Lote 1', tipo: 'Inteira', assento: null, sessao: null, sessaoInicio: null,
      codigo: null, situacao: null, id: null, qrDisponivel: false },
    ...extra,
  }
}
const abrirTransferencia = async (resposta: any, token = TOKEN, extra: Record<string, any> = {}) => {
  tela = await montarTela(await import('../pages/transferencia/[code].vue'), {
    rota: { params: { code: token }, path: `/transferencia/${token}` },
    respostas: { [`/api/transferencia/${encodeURIComponent(token)}`]: resposta, ...extra },
    stubs: STUBS,
  })
  return tela
}

describe('/transferencia · B22, B10, B24', () => {
  it('o token vai codificado', async () => {
    // trava: `encodeURIComponent(code)` na rota
    await abrirTransferencia(transferencia(), '../admin/clientes')
    expect(pedidas).toContain('/api/transferencia/..%2Fadmin%2Fclientes')
  })
  it('500: "a bilheteria não respondeu", nunca "Link não encontrado"', async () => {
    // trava: `v-if="falha === 'nao_encontrado'"`
    falharCom(500)
    await abrirTransferencia(null)
    expect(tela!.text()).toContain('A bilheteria não respondeu agora')
    expect(tela!.text()).not.toContain('Link não encontrado')
  })
  it('404 vira erro 404 de verdade (fatal)', async () => {
    falharCom(404)
    const lancados = await montarEsperandoErro('../pages/transferencia/[code].vue',
      { params: { code: TOKEN }, path: `/transferencia/${TOKEN}` })
    expect(lancados).toEqual([expect.objectContaining({ statusCode: 404, fatal: true })])
  })
  it('a data sai no fuso do evento', async () => {
    // trava: `dataNoFuso(v, data.value?.evento?.fuso)`
    await abrirTransferencia(transferencia({ evento: { ...transferencia().evento, fuso: 'America/Manaus' } }))
    expect(tela!.text()).toMatch(/04 de outubro de 2026[^0-9]*08:00/)
  })
})

describe('/transferencia · B33', () => {
  it('ingresso já usado: nada de formulário, e a página diz por quê', async () => {
    // trava: `data.motivo` na frase (sem ele o texto saía VAZIO)
    await abrirTransferencia(transferencia({ podeAceitar: false, statusTexto: 'Ingresso já utilizado',
      motivo: 'Este ingresso já foi usado na entrada e não pode mais ser transferido.' }))
    expect(tela!.find('form').exists()).toBe(false)
    expect(tela!.text()).toContain('Este ingresso já foi usado na entrada e não pode mais ser transferido.')
  })
  it('matriz 109 · vencida: sem formulário, e a frase manda pedir de novo', async () => {
    // trava: `RECADO[data.status]` no fim da cadeia (sem ele a frase sai vazia)
    await abrirTransferencia(transferencia({ status: 'expirado', statusTexto: 'Prazo vencido', podeAceitar: false }))
    expect(tela!.find('form').exists()).toBe(false)
    expect(tela!.text()).toContain('Prazo vencido')
    expect(tela!.text()).toContain('O prazo pra aceitar venceu. Peça pra quem enviou mandar de novo')
  })
  it('CPF recusado pelo servidor: o recado aparece e o campo fica marcado', async () => {
    // trava: `erroNoCpf` ligado pelo `data.campo === 'documento'` da recusa
    const recusa = Object.assign(new Error('400'), {
      data: { statusCode: 400, message: 'Digite só os números do CPF.', data: { campo: 'documento' } } })
    await abrirTransferencia(transferencia(), TOKEN)
    G.$fetch = async () => { throw recusa }
    await tela!.get('input[inputmode="numeric"]').setValue('abc😀')
    await tela!.get('form').trigger('submit')
    await nextTick(); await nextTick()
    expect(tela!.text()).toContain('Digite só os números do CPF.')
    expect(tela!.get('input[inputmode="numeric"]').attributes('aria-invalid')).toBe('true')
  })
})

/* ======================================================= página de erro */
describe('app/error.vue · B25 — o erro em português, com saída', () => {
  const abrirErro = async (statusCode: number, caminho: string) => {
    tela = await montarTela(await import('../error.vue'), {
      rota: { path: caminho }, props: { error: { statusCode, url: caminho } }, stubs: STUBS,
    })
    return tela
  }
  it('404 de evento: "Evento não encontrado", e o link volta pros eventos', async () => {
    await abrirErro(404, '/e/evento-que-nao-existe')
    expect(tela!.text()).toContain('Evento não encontrado')
    expect(tela!.find('a[href="/"]').exists()).toBe(true)
    expect(tela!.text()).not.toMatch(/page not found|not found/i)
  })
  it('404 qualquer: "Página não encontrada"', async () => {
    await abrirErro(404, '/qualquer-coisa')
    expect(tela!.text()).toContain('Página não encontrada')
  })
  it('500: "a bilheteria não respondeu", com Tentar de novo', async () => {
    await abrirErro(500, '/e/zz')
    expect(tela!.text()).toContain('A bilheteria não respondeu agora')
    expect(tela!.findAll('button').some((b) => b.text() === 'Tentar de novo')).toBe(true)
  })
  it('no painel, a saída é o painel', async () => {
    await abrirErro(404, '/admin/coisa')
    expect(tela!.find('a[href="/admin"]').text()).toContain('Voltar ao painel')
  })
})

/* ================================================================ home */
describe('home · B23 e B31', () => {
  const EVENTOS = { eventos: [{ slug: 'zz-festa', nome: 'ZZ Festa', situacao: 'disponivel', cidade: 'Salvador',
    estado: 'BA', inicio: '2026-10-04T12:00:00.000Z', aPartirDeCents: 5500 }] }
  const DETALHE = {
    evento: { descricao: 'Primeiro parágrafo.\nSegundo parágrafo.', inicio: '2026-10-04T12:00:00.000Z', fim: null },
    setores: [{ id: 's-1', nome: 'Entrada individual', sessao: null, lotes: [{ id: 'l-1', nome: 'Lote 1',
      situacao: 'disponivel', variacoes: [{ tipoId: 't-1', nome: 'Inteira', totalCents: 5500, esgotado: false }] }] }],
  }
  it('o nome do ingresso é h3 logo abaixo do h2 (sem pular pra h4), e a descrição guarda as quebras', async () => {
    // travas: `<h3>` no cartão (era `<h4>`); `whitespace-pre-line` no parágrafo da descrição
    G.useAsyncData = () => ({ data: ref(DETALHE), pending: ref(false), error: ref(null), refresh: async () => {} })
    tela = await montarTela(await import('../pages/index.vue'), {
      rota: { path: '/' }, respostas: { '/api/eventos-publicos': EVENTOS }, stubs: STUBS,
    })
    expect(tela!.findAll('h4')).toHaveLength(0)
    const h3 = tela!.findAll('h3').map((x) => x.text())
    expect(h3).toContain('Entrada individual')
    const descricao = tela!.findAll('p').find((p) => p.text().includes('Primeiro parágrafo.'))
    expect(descricao?.classes()).toContain('whitespace-pre-line')
  })
})
