// @vitest-environment happy-dom
/**
 * vitrine.test.ts — a página do evento (`/e/<slug>`), o que só a TELA erra.
 *
 * As regras puras do carrinho têm o teste delas (`carrinhoDaVitrine.test.ts`).
 * Aqui é a página montada, com a resposta da rota na mão:
 *
 *   · B22 — o slug vai codificado pra rota (`..%2Fadmin` não vira `/api/admin`);
 *   · B10 — só o 404 é "não existe" (e sai como erro 404 de verdade); o resto é
 *     "a bilheteria não respondeu", com "Tentar de novo";
 *   · B24 — a data no fuso do EVENTO;
 *   · B07 — o `?promoter=` chega no carrinho que vai pro pagamento;
 *   · B19 — o carrinho volta do F5, e a gravação de cada mudança deixa o
 *     documento da meia de fora;
 *   · B32 — o mínimo é do lote, pela soma: dá pra montar 2 + 2 num mínimo 4;
 *   · PROD-06 — sem como cobrar online, a vitrine diz e não deixa seguir;
 *   · B30 — evento sem lote tem estado vazio com saída;
 *   · B31 — endereço sem logradouro não deixa travessão solto.
 *
 * Cada caso diz a trava que o deixa vermelho (a prova de mutação).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, onErrorCaptured, ref, Suspense } from 'vue'
import { VERSAO_DO_CARRINHO } from './carrinhoDaVitrine'
import { limparTela, montarTela, navegacoes } from './.vitest-setup-dom'

const SLUG = 'zz-vitrine-tela'
const G = globalThis as any

const variacao = (extra: Record<string, any> = {}) => ({
  tipoId: 't-inteira', nome: 'Inteira', exigeDocumento: false, ehMeia: false,
  faceCents: 5000, taxaCents: 500, totalCents: 5500, esgotado: false, maxPorCompra: 10, tetoPor: 'estoque',
  ...extra,
})
const lote = (extra: Record<string, any> = {}) => ({
  id: 'l-1', nome: 'Lote 1', descricao: null, situacao: 'disponivel', minPorCompra: 1, maxPorCompra: 10,
  tetoPor: 'estoque', expiraEm: null, abreEm: null, variacoes: [variacao()], ...extra,
})
function vitrine(extra: { evento?: Record<string, any>; setores?: any[] } = {}) {
  return {
    evento: {
      id: 'e-1', nome: 'ZZ Festa na Piscina', slug: SLUG, descricao: null,
      vendasAbertas: true, avisoDeVenda: null, pagamentoOnline: { disponivel: true },
      fuso: 'America/Bahia', maxPorPedido: 20,
      // 12h UTC = 9h em Salvador = 8h em Manaus
      inicio: '2026-10-04T12:00:00.000Z', fim: null, encerraVendas: null, classificacao: null,
      substantivo: 'Ingressos', organizacao: 'Conquista Park',
      local: { online: false, nome: 'Conquista Park', endereco: 'Rodovia BA-099, km 10', cidade: 'Salvador', estado: 'BA' },
      banner: null, thumb: null, suporte: null, aPartirDeCents: 5500,
      ...extra.evento,
    },
    setores: extra.setores ?? [{ id: 's-1', nome: 'Pista', tipo: 'normal', sessao: null, descricao: null, lotes: [lote()] }],
  }
}

let tela: Awaited<ReturnType<typeof montarTela>> | null = null
let useFetchOriginal: any
/** As URLs que a página pediu ao `useFetch` — o dublê da casa não guarda. */
const pedidas: string[] = []

async function abrir(resposta: any = vitrine(), rota: { query?: Record<string, any>; slug?: string } = {}) {
  const slug = rota.slug ?? SLUG
  tela = await montarTela(await import('../pages/e/[slug]/index.vue'), {
    rota: { params: { slug }, query: rota.query ?? {}, path: `/e/${slug}` },
    respostas: { [`/api/e/${encodeURIComponent(slug)}`]: resposta },
    stubs: { CabecalhoPublico: true, RodapePublico: true, OndasMarca: true },
  })
  return tela
}

/** Troca o `useFetch` da casa por um que devolve ESTA falha. */
function falharCom(status: number | null, refresh: () => Promise<void> = async () => {}) {
  G.useFetch = (url: any) => {
    pedidas.push(String(url))
    return {
      data: ref(null), pending: ref(false), status: ref('error'), refresh, execute: refresh,
      error: ref(status == null ? { message: 'fetch failed' } : { statusCode: status, statusMessage: `HTTP ${status}` }),
    }
  }
}

beforeEach(() => {
  tela = null
  pedidas.length = 0
  sessionStorage.clear()
  useFetchOriginal = G.useFetch
  // espião por cima do dublê: guarda a URL e devolve o que a casa devolveria
  G.useFetch = (url: any, o: any) => { pedidas.push(String(url)); return useFetchOriginal(url, o) }
})
afterEach(() => {
  tela?.unmount()
  G.useFetch = useFetchOriginal
  delete G.createError
  limparTela()
  sessionStorage.clear()
})

const botao = (texto: string | RegExp) => {
  const b = tela!.findAll('button').find((x) => (typeof texto === 'string' ? x.text() === texto : texto.test(x.text())))
  if (!b) throw new Error(`botão ${texto} não está na tela`)
  return b
}
const mais = (nome: string) => tela!.get(`button[aria-label="Adicionar um ${nome}"]`)
const menos = (nome: string) => tela!.get(`button[aria-label="Remover um ${nome}"]`)
const guardado = () => JSON.parse(sessionStorage.getItem('dt:carrinho') || 'null')

describe('B22 · o slug vai codificado pra rota', () => {
  it('`..%2Fadmin%2Fclientes` pede `/api/e/..%2Fadmin%2Fclientes`, nunca `/api/admin/clientes`', async () => {
    // trava: `encodeURIComponent(slug)` no useFetch da página
    await abrir(vitrine(), { slug: '../admin/clientes' })
    expect(pedidas).toContain('/api/e/..%2Fadmin%2Fclientes')
    expect(pedidas.some((u) => u.includes('/api/admin'))).toBe(false)
  })
})

describe('B10 · a vitrine só diz "não encontrado" quando é isso', () => {
  it('banco fora do ar (500): "a bilheteria não respondeu", com Tentar de novo', async () => {
    // trava: `v-if="falha === 'nao_encontrado'"` no template (com `v-if="falha"` o 500 lê "não encontrado")
    let tentou = 0
    falharCom(500, async () => { tentou++ })
    await abrir()
    const texto = tela!.text()
    expect(texto).toContain('A bilheteria não respondeu agora')
    expect(texto, 'com o banco fora do ar, quem tem o link certo lia que o evento não existe')
      .not.toContain('Evento não encontrado')
    await botao('Tentar de novo').trigger('click')
    expect(tentou).toBe(1)
  })

  it('sem resposta nenhuma (rede caiu) também é "não respondeu"', async () => {
    falharCom(null)
    await abrir()
    expect(tela!.text()).toContain('A bilheteria não respondeu agora')
  })

  it('404 vira erro 404 DE VERDADE (fatal) — a página de erro responde, com o status certo', async () => {
    // trava: o `throw createError({ statusCode: 404, fatal: true })` depois do useFetch
    const pedidos: any[] = []
    G.createError = (o: any) => { pedidos.push(o); return Object.assign(new Error(o.statusMessage), o) }
    falharCom(404)
    const capturados: any[] = []
    const Pagina = (await import('../pages/e/[slug]/index.vue')).default
    const Pegador = defineComponent({
      setup() {
        onErrorCaptured((e) => { capturados.push(e); return false })
        return () => h(Suspense, null, { default: () => h(Pagina) })
      },
    })
    await montarTela(Pegador, { rota: { params: { slug: SLUG }, path: `/e/${SLUG}` } }).catch(() => null)
    expect(pedidos).toEqual([expect.objectContaining({ statusCode: 404, fatal: true })])
    expect(capturados[0]?.statusCode).toBe(404)
  })
})

describe('B24 · a data no fuso do evento', () => {
  it('9h em Salvador aparece 9h; o mesmo instante num evento de Manaus aparece 8h', async () => {
    // trava: `dataNoFuso(v, data.value?.evento?.fuso)` — sem o fuso do evento, Manaus sai 9h
    await abrir()
    expect(tela!.text()).toMatch(/04 de outubro de 2026[^0-9]*09:00/)
    tela!.unmount()
    await abrir(vitrine({ evento: { fuso: 'America/Manaus' } }))
    expect(tela!.text()).toMatch(/04 de outubro de 2026[^0-9]*08:00/)
  })
})

describe('B07 · o link do promoter atribui a venda', () => {
  it('`?promoter=joao1` vai no carrinho que atravessa pro pagamento, em maiúsculas', async () => {
    // trava: `codigoDePromoter(route.query.promoter)` na página
    await abrir(vitrine(), { query: { promoter: 'joao1' } })
    await mais('Inteira').trigger('click')
    await botao('Ir para pagamento').trigger('click')
    expect(guardado()?.promoter).toBe('JOAO1')
    expect(navegacoes).toContain(`/e/${SLUG}/pagamento`)
  })
})

describe('B19 · o carrinho sobrevive ao F5', () => {
  const salvo = (quantidade: number, extra: Record<string, any> = {}) => ({
    versao: VERSAO_DO_CARRINHO, slug: SLUG, promoter: 'MARIA',
    linhas: [{ loteId: 'l-1', tipoId: 't-inteira', quantidade, nome: 'Inteira', setor: 'Pista',
      unitFaceCents: 5000, unitTaxaCents: 500, unitTotalCents: 5500, pedeMeia: false, declaracao: null }],
    totais: { face: 5000 * quantidade, taxa: 500 * quantidade, total: 5500 * quantidade, n: quantidade },
    ...extra,
  })

  it('a seleção guardada volta — com o promoter do link que a trouxe', async () => {
    // trava: o `restaurarCarrinho(...)` do onMounted
    sessionStorage.setItem('dt:carrinho', JSON.stringify(salvo(3)))
    await abrir()
    await tela!.vm.$nextTick()
    expect(tela!.text()).toContain('R$ 165,00')
    await botao('Ir para pagamento').trigger('click')
    expect(guardado()).toMatchObject({ promoter: 'MARIA', totais: { n: 3 } })
    expect(typeof guardado().criadoEm).toBe('number')
  })

  it('cada mudança regrava na hora — sem o número do documento da meia', async () => {
    // trava: o `watch` que grava a cada mudança, e o `comDocumento: false` dele
    const meia = variacao({ tipoId: 't-meia', nome: 'Meia', exigeDocumento: true, ehMeia: true,
      faceCents: 2500, taxaCents: 250, totalCents: 2750 })
    await abrir(vitrine({ setores: [{ id: 's-1', nome: 'Pista', tipo: 'normal', sessao: null, descricao: null,
      lotes: [lote({ variacoes: [variacao(), meia] })] }] }))
    await mais('Inteira').trigger('click')
    await mais('Inteira').trigger('click')
    await tela!.vm.$nextTick()
    expect(guardado()?.totais?.n, 'o F5 aqui zerava a seleção').toBe(2)

    await mais('Meia').trigger('click')
    await tela!.get('select[id^="motivo-"]').setValue('estudante')
    await tela!.get('input[id^="doc-"]').setValue('CARTEIRINHA-123')
    await tela!.vm.$nextTick()
    const linhaMeia = guardado().linhas.find((l: any) => l.tipoId === 't-meia')
    expect(linhaMeia.declaracao).toEqual({ motivo: 'estudante', documento: '' })
    // no clique de pagar vai inteiro: o checkout precisa do número
    await botao('Ir para pagamento').trigger('click')
    expect(guardado().linhas.find((l: any) => l.tipoId === 't-meia').declaracao.documento).toBe('CARTEIRINHA-123')
  })

  it('carrinho de OUTRO evento não é restaurado aqui', async () => {
    sessionStorage.setItem('dt:carrinho', JSON.stringify(salvo(3, { slug: 'outro-evento' })))
    await abrir()
    await tela!.vm.$nextTick()
    expect(tela!.text()).toContain('Nenhum ingresso escolhido ainda')
  })
})

describe('B32 · o mínimo é do lote, pela soma das opções', () => {
  it('num lote de mínimo 4 dá pra montar 2 inteiras + 2 meias, e o botão acende', async () => {
    // trava: `outrasDoLote(lote, v)` em `ajustar` — sem ele, a inteira cai de 3 pra 0
    const promo = variacao({ tipoId: 't-promo', nome: 'Promo', faceCents: 4000, taxaCents: 400, totalCents: 4400 })
    await abrir(vitrine({ setores: [{ id: 's-1', nome: 'Pista', tipo: 'normal', sessao: null, descricao: null,
      lotes: [lote({ minPorCompra: 4, variacoes: [variacao(), promo] })] }] }))
    expect(tela!.text()).toContain('Mínimo de 4 por compra, somando as opções deste lote')
    await mais('Inteira').trigger('click')        // 4 + 0 (o primeiro "+" entra no mínimo)
    await mais('Promo').trigger('click')          // 4 + 1
    await mais('Promo').trigger('click')          // 4 + 2
    await menos('Inteira').trigger('click')       // 3 + 2
    await menos('Inteira').trigger('click')       // 2 + 2
    expect(tela!.text()).toContain('R$ 198,00')   // 2 × 55 + 2 × 44
    expect(botao('Ir para pagamento').attributes('disabled')).toBeUndefined()
  })
})

describe('PROD-06 · sem como cobrar online, a vitrine avisa antes do formulário', () => {
  it('mostra o aviso e não deixa seguir pro pagamento', async () => {
    // trava: `!bloqueioDePagamento.value` em `podePagar`
    await abrir(vitrine({ evento: { pagamentoOnline: { disponivel: false,
      recado: 'As vendas online estão indisponíveis no momento. Tente mais tarde ou compre na bilheteria.' } } }))
    expect(tela!.text()).toContain('Venda online indisponível agora')
    await mais('Inteira').trigger('click')
    const b = botao('Venda online indisponível')
    expect(b.attributes('disabled')).toBeDefined()
    await b.trigger('click')
    expect(navegacoes).toEqual([])
  })

  it('com o pagamento no ar, nada de aviso', async () => {
    await abrir()
    expect(tela!.text()).not.toContain('Venda online indisponível')
  })
})

describe('B30 · evento sem lote na vitrine', () => {
  it('diz "Ingressos em breve" e oferece os outros eventos', async () => {
    // trava: o bloco `v-if="!temLotes"`
    await abrir(vitrine({ evento: { descricao: 'Tarde de piscina\ncom DJ.' },
      setores: [{ id: 's-1', nome: 'Pista', tipo: 'normal', sessao: null, descricao: null, lotes: [] }] }))
    expect(tela!.text()).toContain('Ingressos em breve')
    expect(tela!.find('a[href="/"]').exists()).toBe(true)
    // a descrição continua: sem ela o "em breve" não diz do que se trata
    expect(tela!.text()).toContain('Tarde de piscina')
    expect(tela!.text()).not.toContain('Seu pedido')
  })
})

describe('B31 · endereço sem logradouro', () => {
  it('sai só "Cidade/UF", sem travessão solto', async () => {
    // trava: `enderecoDoLocal(...)` no template (o antigo emendava " — " sempre)
    await abrir(vitrine({ evento: { local: { online: false, nome: 'Conquista Park', endereco: '', cidade: 'Salvador', estado: 'BA' } } }))
    expect(tela!.text()).toContain('Salvador/BA')
    expect(tela!.text()).not.toMatch(/—\s*Salvador/)
  })
})
