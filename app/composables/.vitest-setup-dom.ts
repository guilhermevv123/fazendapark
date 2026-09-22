/**
 * .vitest-setup-dom.ts — a rede que faltava do lado `.vue`.
 *
 * ## O buraco que isto fecha
 *
 * O repositório tem 46 arquivos `.vue` e tinha **zero** teste de componente:
 * a suíte só cobria `app/composables/*.test.ts`. Medido: `import` de
 * `app/pages/admin/evento/[id]/dashboard.vue` dentro de um `it()` respondia
 * `Failed to parse source for import analysis … Install @vitejs/plugin-vue`.
 * Num projeto onde a classe de bug que mais passou é a que "só aparece
 * olhando", trinta e cinco telas sem uma pergunta automática é o maior
 * buraco da suíte — maior que qualquer rota.
 *
 * ## Como usar
 *
 * Primeira linha do arquivo de teste:
 *
 *     // @vitest-environment happy-dom
 *
 * Depois `await montarTela(Componente, { rota, respostas })`. O `environment`
 * padrão continua `node` — teste de dinheiro não paga por DOM que não usa.
 *
 * ## Por que globais em vez de mock de módulo
 *
 * O Nuxt injeta `ref`, `computed`, `useRoute`, `useFetch`, `reais`… sem
 * `import`. No código compilado isso vira referência a identificador solto,
 * que o JavaScript resolve em `globalThis` — é exatamente onde este arquivo
 * põe cada um. As funções do projeto (`reais`, `diaMes`, `podeAbrirPagina`)
 * entram **as de verdade**, importadas do fonte: uma cópia aqui dentro
 * transformaria o teste num espelho dele mesmo.
 *
 * Só `useFetch`/`$fetch`/`useRoute`/`resolveComponent` são dublês — a
 * fronteira com o servidor (os três primeiros) e a fronteira com o que a
 * Nuxt registra por fora do compilador (o último) —, e é justamente o que o
 * teste precisa segurar pra perguntar "com ESTES dados, o que a tela mostra?".
 */
import {
  computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, onUnmounted,
  provide, inject, reactive, readonly, ref, shallowRef, Suspense, toRef, toRefs, unref,
  watch, watchEffect,
} from 'vue'
import * as baixarCsv from './baixarCsv'
import * as formato from './formato'
import * as menuDoEvento from './menuDoEvento'

/** Em ambiente `node` não existe tela: o arquivo carrega e não faz nada. */
const TEM_DOM = typeof document !== 'undefined'

// ------------------------------------------------------- dublê do servidor
type Respostas = Record<string, any>
let respostas: Respostas = {}

/**
 * Acha a resposta de uma URL. Exata primeiro, depois prefixo mais longo.
 *
 * Prefixo (e não "qualquer pedaço") porque rota de painel é
 * `/api/admin/evento/<uuid>/dashboard`: o teste registra
 * `'/api/admin/evento/'` e não precisa inventar o uuid.
 */
function acharResposta(url: string): any {
  if (url in respostas) return respostas[url]
  const chaves = Object.keys(respostas)
    .filter((k) => url.startsWith(k))
    .sort((a, b) => b.length - a.length)
  return chaves.length ? respostas[chaves[0]] : undefined
}

const paraTexto = (u: any) => String(typeof u === 'function' ? u() : u)

/**
 * `useFetch` do Nuxt, com o formato que as telas usam.
 *
 * Devolve `data`/`pending`/`error`/`refresh`/`status` porque é isso que os
 * `.vue` desestruturam. `error` se chama `error` no Nuxt mesmo — as telas
 * renomeiam pra `falha` no destructuring quando querem português.
 */
function useFetchDuble(url: any, _opcoes?: any) {
  const alvo = paraTexto(url)
  const achou = acharResposta(alvo)
  return {
    data: ref(achou ?? null),
    pending: ref(false),
    error: ref(null),
    status: ref(achou === undefined ? 'error' : 'success'),
    refresh: async () => {},
    execute: async () => {},
  }
}

/**
 * Toda chamada de `$fetch` que a tela fez, com o que ela MANDOU. Sem isto o
 * teste só sabe o que a tela recebeu — e o defeito que importa num formulário
 * é o campo que a tela deixou de mandar, ou mandou com o nome errado.
 */
export const chamadas: { url: string; opcoes: any }[] = []

async function fetchDuble(url: any, opcoes?: any) {
  const alvo = paraTexto(url)
  chamadas.push({ url: alvo, opcoes })
  const achou = acharResposta(alvo)
  if (achou === undefined) throw new Error(`teste não registrou resposta para ${alvo}`)
  // resposta que é um Error vira RECUSA, como o `$fetch` de verdade (o corpo do
  // servidor vem em `.data`)
  if (achou instanceof Error) throw achou
  return achou
}

// ------------------------------------------------------------ dublê da rota
const rota = reactive<any>({ path: '/', params: {}, query: {}, name: '', fullPath: '/' })
const roteador = {
  push: async (x: any) => { registrarNavegacao(x) },
  replace: async (x: any) => { registrarNavegacao(x) },
  back: () => {},
}
/** Tudo que a tela tentou navegar — pra poder perguntar depois. */
export const navegacoes: any[] = []
function registrarNavegacao(x: any) { navegacoes.push(x) }

// --------------------------------------------------- dublês de componente
/** Componente burro que só mostra o conteúdo — pro stub não comer o `<slot>`. */
const soOConteudo = (tag: string) =>
  defineComponent({ inheritAttrs: false, setup: (_p, { slots }) => () => h(tag, slots.default?.()) })

/**
 * `<NuxtLink>` que vira `<a href>` de verdade.
 *
 * Um stub vazio apagaria o `href`, e é justamente o endereço que o teste de
 * papel precisa ler pra dizer "a portaria enxergou o link do financeiro".
 */
const NuxtLinkDuble = defineComponent({
  props: { to: { type: [String, Object], default: '' } },
  setup: (p, { slots }) => () =>
    h('a', { href: typeof p.to === 'string' ? p.to : JSON.stringify(p.to) }, slots.default?.()),
})

const STUBS: Record<string, any> = {
  NuxtLink: NuxtLinkDuble,
  RouterLink: NuxtLinkDuble,
  NuxtPage: soOConteudo('div'),
  NuxtLayout: soOConteudo('div'),
  ClientOnly: soOConteudo('div'),
  IconeMenu: defineComponent({ props: { nome: String, tamanho: Number }, setup: () => () => h('i') }),
  LogoMarca: defineComponent({ props: { clara: Boolean }, setup: () => () => h('i') }),
}

/**
 * `resolveComponent(nome)` — dublê, não o `resolveComponent` de verdade do Vue.
 *
 * Tentado primeiro com o de verdade (importado de `'vue'`) e MEDIDO quebrado:
 * só de EXISTIR uma chamada dele em algum `<script setup>` deste harness, TODA
 * resolução de componente por nome do MESMO arquivo passava a devolver um
 * objeto incompleto (`{ name: 'NuxtLink' }`, sem `render`) — inclusive a tag
 * estática `<NuxtLink>` da logo, que a chamada nem tocava. É incompatibilidade
 * do `@vitejs/plugin-vue` puro (fora da Nuxt) com o jeito que o
 * `@vue/test-utils` registra os stubs — não é bug do produto: o clique real,
 * no Chrome contra o `nuxt dev`, abre a tela certa (ver o comentário de
 * `layouts/admin.vue`). Este dublê lê do MESMO `STUBS` que o `mount()` usa
 * mais abaixo — nome que a tela pede e o `mount()` não empresta some daqui e
 * de lá do mesmo jeito.
 */
function resolveComponentDuble(nome: string) {
  return STUBS[nome] ?? nome
}

// ------------------------------------------------- instalação dos globais
/**
 * O que o Nuxt injeta sem `import` — e por que ele entra DUAS vezes.
 *
 * No `<script setup>` o identificador solto (`ref`, `useFetch`, `reais`)
 * resolve em `globalThis`. No TEMPLATE, não: o compilador do Vue reescreve
 * `reais(x)` como `_ctx.reais(x)`, que passa pelo proxy da instância e nunca
 * chega em `globalThis`. Medido: com só os globais instalados, a tela montava
 * e o Vue avisava `Property "reais" was accessed during render but is not
 * defined on instance` — e renderizava VAZIA.
 *
 * Por isso o mesmo mapa vai pro `globalThis` (script) e pro
 * `global.mocks` do test-utils, que vira `globalProperties` (template).
 */
const GLOBAIS: Record<string, any> = (() => {
  const globais: Record<string, any> = {
    // reatividade e ciclo de vida do Vue
    ref, computed, reactive, watch, watchEffect, nextTick, shallowRef, readonly,
    toRef, toRefs, unref, provide, inject, onMounted, onUnmounted, onBeforeUnmount,
    h, defineComponent,
    // `resolveComponent('NuxtLink')` — o jeito CERTO de trocar de componente por
    // nome dentro de `<component :is>` (a string crua `'NuxtLink'` não resolve
    // no Nuxt de verdade: ver o comentário em `layouts/admin.vue`). O dublê,
    // não o de verdade — ver o comentário dele, logo acima.
    resolveComponent: resolveComponentDuble,

    // composables do Nuxt — a fronteira com o servidor, que o teste segura
    useFetch: useFetchDuble,
    useLazyFetch: useFetchDuble,
    useAsyncData: (_chave: any, fn: any) => ({
      data: ref(null), pending: ref(false), error: ref(null), refresh: async () => { await fn?.() },
    }),
    $fetch: Object.assign(fetchDuble, { raw: fetchDuble }),
    useRoute: () => rota,
    useRouter: () => roteador,
    navigateTo: async (x: any) => { registrarNavegacao(x) },
    definePageMeta: () => {},
    useHead: () => {},
    useSeoMeta: () => {},
    useRuntimeConfig: () => ({ public: {} }),
    useNuxtApp: () => ({ $router: roteador }),
    useState: (_chave: string, inicial?: any) => ref(inicial?.()),
    useCookie: (_n: string, o?: any) => ref(o?.default?.()),
    refreshNuxtData: async () => {},
    onNuxtReady: (fn: any) => fn?.(),
  }

  // as funções DE VERDADE do projeto (data, dinheiro, CSV, menu): sem cópia.
  // É o que separa "o teste conferiu a tela" de "o teste conferiu um espelho".
  for (const modulo of [formato, menuDoEvento, baixarCsv]) {
    for (const [nome, valor] of Object.entries(modulo)) globais[nome] = valor
  }

  return globais
})()

if (TEM_DOM) {
  for (const [nome, valor] of Object.entries(GLOBAIS)) {
    if (!(nome in globalThis)) (globalThis as any)[nome] = valor
  }
}

// ------------------------------------------------------------- montagem
export interface OpcoesDaTela {
  /** `{ params, query, path }` da rota que a tela acha que está aberta */
  rota?: { params?: Record<string, any>; query?: Record<string, any>; path?: string }
  /** URL (exata ou prefixo) → corpo que `useFetch`/`$fetch` devolvem */
  respostas?: Respostas
  /** props do componente */
  props?: Record<string, any>
  /** stubs extras, somados aos da casa */
  stubs?: Record<string, any>
}

/**
 * Monta uma tela e devolve o wrapper do `@vue/test-utils`.
 *
 * É `async` porque as páginas deste projeto usam `await useFetch(...)` no
 * topo do `<script setup>` — setup assíncrono só resolve depois de um giro
 * do microtask, e sem o `flushPromises` o teste leria a tela ainda vazia e
 * ficaria verde à toa.
 */
export async function montarTela(componente: any, opcoes: OpcoesDaTela = {}) {
  if (!TEM_DOM) throw new Error('montarTela precisa de `// @vitest-environment happy-dom` no topo do arquivo')

  respostas = opcoes.respostas ?? {}
  navegacoes.length = 0
  chamadas.length = 0
  Object.assign(rota, {
    path: opcoes.rota?.path ?? '/',
    fullPath: opcoes.rota?.path ?? '/',
    params: opcoes.rota?.params ?? {},
    query: opcoes.rota?.query ?? {},
  })

  const { mount, flushPromises } = await import('@vue/test-utils')
  // `await import('…/tela.vue')` devolve o NAMESPACE do módulo, que não tem
  // `hasOwnProperty` (protótipo nulo) e faz o test-utils explodir com uma
  // mensagem que não diz nada sobre isso. Aqui o componente é desembrulhado.
  const alvo = componente?.default ?? componente

  /*
   * O <Suspense> é obrigatório, não enfeite.
   *
   * Toda página deste painel abre com `await useFetch(...)` no topo do
   * `<script setup>` — setup assíncrono. Sem a fronteira, o Vue avisa no
   * stderr ("no <Suspense> boundary was found") e renderiza VAZIO: o
   * `wrapper.text()` volta string vazia e um `expect(...).not.toContain(...)`
   * passa contente. Verde sobre tela em branco é exatamente o tipo de mentira
   * que esta rede existe pra não contar.
   */
  const envolucro = defineComponent({
    name: 'EnvolucroDeTeste',
    setup: () => () => h(Suspense, null, { default: () => h(alvo, opcoes.props ?? {}) }),
  })

  const wrapper = mount(envolucro, {
    global: {
      stubs: { ...STUBS, ...(opcoes.stubs ?? {}) },
      mocks: GLOBAIS,
    },
  })
  await flushPromises()
  await nextTick()
  if (!wrapper.html().trim()) {
    throw new Error('a tela montou VAZIA — teste sobre tela em branco passa sem provar nada')
  }
  return wrapper
}

/** Limpa o dublê entre casos. */
export function limparTela() {
  respostas = {}
  navegacoes.length = 0
  chamadas.length = 0
}
