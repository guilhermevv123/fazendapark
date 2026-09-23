<script setup lang="ts">
import { ehPapel, podeAbrirPagina, type Papel } from '~~/server/utils/papeis'
import { primeiraTelaDoEvento } from '~/composables/menuDoEvento'

definePageMeta({ layout: 'admin' })

const { data: eventos, pending, error: falha, refresh } = await useFetch<any[]>('/api/admin/eventos')

// Mesma `key` do layout (`app/layouts/admin.vue`): o Nuxt reaproveita a
// resposta em vez de bater em `/api/auth/eu` duas vezes por navegação.
const { data: eu } = await useFetch<any>('/api/auth/eu', { key: 'auth-eu' })
const papel = computed<Papel | null>(() => {
  const p = eu.value?.usuario?.papel
  return ehPapel(p) ? p : null
})

/*
 * "Nenhum evento aqui ainda" e "você não pode ver esta lista" são coisas
 * diferentes, e a tela dizia a primeira nos dois casos.
 *
 * Medido com a sessão de portaria: `GET /api/admin/eventos` responde 403, a
 * `useFetch` deixa `eventos` nulo, e a página imprimia "Nenhum evento aqui
 * ainda" — abaixo de um botão "Criar evento" e dos filtros. O operador de
 * portão via um painel que afirmava que a produtora não tem evento nenhum,
 * com o parque vendendo ingresso naquele momento.
 *
 * A régua é a RESPOSTA do servidor, não um palpite de papel no front: quem
 * decide o que este login alcança é `utils/papeis.ts`, e repetir a decisão
 * aqui seria a segunda lista que um dia diverge da primeira.
 */
const semAcesso = computed(() => (falha.value as any)?.statusCode === 403)

/*
 * Quem não alcança a lista mas tem o leitor de entrada (a portaria) não pode
 * ficar num beco sem saída: `/admin` é o único endereço de painel que ela
 * recebe (o login cai aqui, a logo aponta pra cá), e a tela dizia "esta lista
 * não é do seu acesso" e mais nada — com fila de gente na frente e nenhum
 * caminho até o leitor, que só abre com o endereço do evento na mão.
 *
 * Então, no 403, a tela PERGUNTA ao servidor quais leitores este login abre
 * (`/api/portaria/destino`, que devolve só id e nome). Um único evento: vai
 * direto pra ele. Mais de um: oferece a escolha. Nenhum: diz isso. A régua
 * continua sendo a resposta do servidor — o front não adivinha por papel.
 */
const { data: portoes, execute: buscarPortoes } = useFetch<{ eventos: { id: string; nome: string }[] }>(
  '/api/portaria/destino', { immediate: false, key: 'portaria-destino' })
if (semAcesso.value) {
  await buscarPortoes()
  const unico = portoes.value?.eventos.length === 1 ? portoes.value.eventos[0] : null
  if (unico) await navigateTo(`/admin/evento/${unico.id}/validacao`, { replace: true })
}

const busca = ref('')
const filtro = ref<'todos' | 'ativo' | 'rascunho' | 'encerrado'>('todos')

const lista = computed(() => (eventos.value ?? []).filter((e) => {
  if (filtro.value !== 'todos' && e.status !== filtro.value) return false
  const t = busca.value.trim().toLowerCase()
  return !t || `${e.nome} ${e.cidade ?? ''} ${e.organizacao}`.toLowerCase().includes(t)
}))

// `reais` e `dataPorExtenso` vêm de `app/composables/formato.ts`: a conta de
// centavo e o corte do dia moram num lugar só, e nenhum dos dois passa por
// float nem por UTC.
const dia = dataPorExtenso

const selo: Record<string, { t: string; c: string }> = {
  ativo: { t: 'PUBLICADO', c: 'selo-ok' },
  rascunho: { t: 'RASCUNHO', c: 'selo-neutro' },
  pausado: { t: 'PAUSADO', c: 'selo-alerta' },
  encerrado: { t: 'ENCERRADO', c: 'selo-neutro' },
}

/** "4,8%" com a vírgula do `reais()`; `null` some a linha (evento sem lote ainda). */
const pct = (vendidos: number, total: number) =>
  total ? `${(vendidos / total * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : null

/** largura da barra de vendidos: nunca abaixo de 2% com alguma venda, senão 14 de 20.000 some */
const barra = (vendidos: number, total: number) =>
  !total || !vendidos ? '0%' : `${Math.max(2, Math.min(100, vendidos / total * 100))}%`

const milhar = (n: number) => n.toLocaleString('pt-BR')

const podeCriar = computed(() => !!papel.value && podeAbrirPagina(papel.value, '/admin/evento/novo'))

/** iniciais pro quadrado do evento sem `thumb_url` — a mesma conta do avatar da conta, em `layouts/admin.vue`. */
const iniciais = (nome: string) => {
  const partes = nome.trim().split(/\s+/)
  return ((partes[0]?.[0] ?? '') + (partes.length > 1 ? partes.at(-1)![0] : '')).toUpperCase()
}

/** o menu de três pontos da linha: uma aberta por vez. */
const abertoId = ref<string | null>(null)

const NOMES_DO_ATALHO = ['Dashboard', 'Relatórios', 'Validação e acessos', 'Configurações']
/**
 * Atalhos do menu de três pontos — as mesmas quatro telas que a lateral do
 * evento abre primeiro (`menuDoEvento`), filtradas pelo MESMO
 * `podeAbrirPagina` que filtra a lateral. Nunca uma segunda lista: sem o
 * filtro, o atalho de quem é da operação apontava pro dashboard (área
 * `dinheiro`, que operação não tem) e o clique voltava 403 — porta fechada
 * desenhada na parede, o mesmo defeito que o comentário da lateral evita.
 */
function atalhos(id: string) {
  if (!papel.value) return []
  return menuDoEvento(id)
    .filter((g) => NOMES_DO_ATALHO.includes(g.nome))
    .filter((g) => podeAbrirPagina(papel.value!, g.para))
}

/*
 * Publicar um rascunho direto da lista (dono, 23/09: "tá com um rascunho, como
 * é que eu publico?"). Antes o único caminho era Configurações → Status →
 * Ativo → Salvar — escondido pra quem só quer pôr o evento no ar. Mesma rota e
 * mesma trava do servidor (sem lote à venda → 422, e a frase dele aparece no
 * card). O botão só existe pra quem abre as Configurações do evento.
 */
const publicando = ref<string | null>(null)
const erroPublicar = ref<Record<string, string>>({})
const podePublicar = (id: string) => !!papel.value && podeAbrirPagina(papel.value, `/admin/evento/${id}/configuracoes`)
async function publicarEvento(id: string) {
  publicando.value = id
  erroPublicar.value = { ...erroPublicar.value, [id]: '' }
  try {
    await $fetch(`/api/admin/evento/${id}/configuracoes`, { method: 'PATCH', body: { status: 'ativo' } })
    await refresh()
  } catch (e: any) {
    erroPublicar.value = { ...erroPublicar.value, [id]: e?.data?.statusMessage || 'Não foi possível publicar. Tente de novo.' }
  } finally {
    publicando.value = null
  }
}

// Aonde o clique no evento leva: a primeira tela que ESTE papel abre (ver
// `primeiraTelaDoEvento` em composables/menuDoEvento.ts). Antes era sempre o
// dashboard — área de dinheiro — e a operação caía numa tela em branco.
const primeiraTela = (id: string) => primeiraTelaDoEvento(id, papel.value)

useHead({ title: 'Eventos' })
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Eventos</h1>
        <p class="mt-1 text-tinta-suave">
          {{ semAcesso ? 'O seu acesso é o leitor de entrada' : 'Todos os eventos das suas organizações' }}
        </p>
      </div>
      <div v-if="!semAcesso" class="flex flex-wrap items-center gap-2">
        <!-- financeiro alcança relatório, operação não — a mesma régua do menu -->
        <NuxtLink v-if="papel && podeAbrirPagina(papel, '/admin/relatorios')" to="/admin/relatorios" class="btn-secundario">
          <IconeMenu nome="relatorio" :tamanho="18" /> Relatórios
        </NuxtLink>
        <!-- e o inverso: operação cria evento, financeiro não. Antes desta
             linha o botão aparecia pros dois — clique de financeiro em
             "Criar evento" voltava 403 sem aviso nenhum. -->
        <NuxtLink v-if="papel && podeAbrirPagina(papel, '/admin/evento/novo')" to="/admin/evento/novo" class="btn-primario">
          <IconeMenu nome="mais" :tamanho="18" /> Criar evento
        </NuxtLink>
      </div>
    </div>

    <!-- No celular: busca na largura toda e os filtros numa fila que rola de
         lado — quebrando em linhas, "Todos" ficava ao lado da busca e o resto
         caía embaixo, torto. -->
    <div v-if="!semAcesso" class="mb-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
      <div class="relative w-full sm:w-72">
        <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-pool-700">
          <IconeMenu nome="busca" :tamanho="18" />
        </span>
        <input v-model="busca" class="campo w-full pl-10" placeholder="Buscar por nome, cidade…" aria-label="Buscar evento">
      </div>
      <div class="-mx-4 flex gap-2 sem-barra overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <button v-for="f in (['todos','ativo','rascunho','encerrado'] as const)" :key="f"
                type="button" class="shrink-0" :class="filtro === f ? 'chip-ativo' : 'chip'" @click="filtro = f">
          {{ f === 'todos' ? 'Todos' : (selo[f]?.t ?? f) }}
        </button>
      </div>
    </div>

    <p v-if="pending" class="card text-tinta-suave">Carregando…</p>

    <div v-else-if="semAcesso" class="card py-12 text-center">
      <!-- A portaria: o servidor disse quais leitores ela abre. -->
      <template v-if="portoes?.eventos.length">
        <p class="rotulo-kpi">Abrir o leitor de entrada</p>
        <ul class="mx-auto mt-4 grid max-w-md gap-2">
          <li v-for="p in portoes.eventos" :key="p.id">
            <NuxtLink :to="`/admin/evento/${p.id}/validacao`" class="btn-primario w-full justify-center">
              {{ p.nome }}
            </NuxtLink>
          </li>
        </ul>
      </template>
      <!-- Respondeu e veio vazio: não há evento no ar pra ler. Dito com essas
           palavras, e não como "sem acesso" — o acesso existe, falta evento. -->
      <template v-else-if="portoes">
        <p class="rotulo-kpi">Nenhum evento com leitor aberto agora</p>
        <p class="mx-auto mt-2 max-w-md text-sm text-tinta-suave">
          Não há evento publicado e em andamento na sua organização neste momento.
          Quando houver, ele aparece aqui.
        </p>
      </template>
      <!-- O leitor também é recusado (outro papel) ou a consulta não voltou: a
           recusa segue nomeada, sem afirmar que não existe evento. -->
      <template v-else>
        <p class="rotulo-kpi">Esta lista não é do seu acesso</p>
        <p class="mx-auto mt-2 max-w-md text-sm text-tinta-suave">
          O seu login não alcança a lista de eventos da produtora — não quer dizer que
          não exista evento. Se você precisa vê-la, peça a um master da sua organização
          para mudar o seu acesso.
        </p>
      </template>
    </div>

    <!-- Qualquer outra falha (servidor fora, 500, rede) NÃO é "não tem
         evento": dizer isso com o parque vendendo é pior que dizer que deu erro. -->
    <div v-else-if="falha" class="card py-12 text-center">
      <p class="rotulo-kpi text-erro">Não foi possível carregar os eventos</p>
      <p class="mx-auto mt-2 max-w-md text-sm text-tinta-suave">
        {{ (falha as any)?.data?.statusMessage || (falha as any)?.statusMessage
          || 'O servidor não respondeu. Confira a internet e tente de novo.' }}
      </p>
      <button type="button" class="btn-secundario mt-4" @click="refresh()">Tentar de novo</button>
    </div>

    <!-- Vazio com saída: um desenho, a frase e o botão que resolve. Só a frase
         cinza no meio de um cartão branco lia como tela quebrada. -->
    <div v-else-if="!lista.length" class="card flex flex-col items-center px-6 py-12 text-center">
      <span class="grid size-16 place-items-center rounded-2xl bg-gradient-to-br from-pool-100 to-grape-100 text-pool-700">
        <IconeMenu :nome="(eventos ?? []).length ? 'busca' : 'ingresso'" :tamanho="30" />
      </span>
      <template v-if="(eventos ?? []).length">
        <p class="titulo mt-4 text-lg font-semibold text-tinta">Nenhum evento com este filtro</p>
        <p class="mt-1 max-w-sm text-tinta-suave">Troque a situação ou apague a busca.</p>
        <button type="button" class="btn-secundario mt-5" @click="filtro = 'todos'; busca = ''">Mostrar todos</button>
      </template>
      <template v-else>
        <p class="titulo mt-4 text-lg font-semibold text-tinta">Nenhum evento ainda</p>
        <p class="mt-1 max-w-sm text-tinta-suave">Crie o primeiro evento, cadastre os ingressos e publique pra começar a vender.</p>
        <NuxtLink v-if="podeCriar" to="/admin/evento/novo" class="btn-primario mt-5">
          <IconeMenu nome="mais" :tamanho="18" /> Criar evento
        </NuxtLink>
      </template>
    </div>

    <ul v-else class="grid gap-3">
      <li v-for="e in lista" :key="e.id"
          class="card flex min-w-0 flex-col gap-4 transition-shadow hover:shadow-lateral sm:flex-row sm:flex-wrap sm:items-center">
        <!-- zona 1: o que abre o painel. NuxtLink SÓ até aqui — o resto da
             linha tem o botão de três pontos, e `<a>` dentro de `<a>` é HTML
             inválido: o navegador fecha o de fora sozinho (a árvore que a
             página manda difere da que o Vue montou) e o clique fica errático. -->
        <NuxtLink :to="primeiraTela(e.id)"
                  class="flex min-w-0 flex-1 items-center gap-3.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-pool-600">
          <span v-if="!e.thumb"
                class="titulo grid size-14 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-pool-600 to-grape-700 text-[15px] font-bold text-white">
            {{ iniciais(e.nome) }}
          </span>
          <img v-else :src="e.thumb" alt="" class="size-14 shrink-0 rounded-xl object-cover ring-1 ring-ink-200/70">
          <div class="min-w-0 flex-1">
            <h2 class="titulo text-[16px] font-semibold leading-snug text-tinta">{{ e.nome }}</h2>
            <div class="mt-1.5 flex flex-col gap-1 text-[13.5px] text-tinta-suave sm:flex-row sm:flex-wrap sm:gap-x-3">
              <span class="inline-flex min-w-0 items-center gap-1.5">
                <IconeMenu nome="calendario" :tamanho="14" class="text-pool-600" />{{ dia(e.inicio) }}
              </span>
              <span v-if="e.local" class="inline-flex min-w-0 items-start gap-1.5">
                <IconeMenu nome="mapa" :tamanho="14" class="mt-0.5 text-grape-500" />
                <span class="min-w-0">{{ e.local }}<template v-if="e.cidade"> · {{ e.cidade }}/{{ e.estado }}</template></span>
              </span>
            </div>
          </div>
        </NuxtLink>

        <!-- zona 2: números, selo e ações — fora do link de propósito -->
        <!-- vendidos como barra (o que o Zig mostra no card e o dono gostou):
             o número sozinho não diz se 14 é pouco ou muito. -->
        <div class="flex shrink-0 items-center gap-3 border-t border-linha pt-3 sm:w-80 sm:gap-4 sm:border-0 sm:pt-0">
          <div v-if="e.estoque.total" class="min-w-0 flex-1 leading-tight">
            <div class="flex items-baseline justify-between gap-2">
              <p class="text-[12.5px] font-medium text-tinta-suave"><span class="sm:hidden">Vendidos</span><span class="hidden sm:inline">Ingressos vendidos</span></p>
              <p class="text-[12.5px] font-semibold tabular-nums text-pool-700">{{ pct(e.estoque.vendidos, e.estoque.total) }}</p>
            </div>
            <p class="titulo mt-0.5 text-[17px] font-bold tabular-nums text-tinta">
              {{ milhar(e.estoque.vendidos) }}<span class="font-semibold text-tinta-fraca">/{{ milhar(e.estoque.total) }}</span>
            </p>
            <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-100" aria-hidden="true">
              <div class="h-full rounded-full bg-gradient-to-r from-pool-500 to-grape-600"
                   :style="{ width: barra(e.estoque.vendidos, e.estoque.total) }" />
            </div>
          </div>
          <p v-else class="min-w-0 flex-1 text-[13px] text-tinta-fraca">Sem ingresso cadastrado</p>
          <!-- rascunho: o selo vira a ação que tira ele do rascunho -->
          <button v-if="e.status === 'rascunho' && podePublicar(e.id)" type="button"
                  class="btn-primario shrink-0 px-3.5 py-2 text-[13.5px]"
                  :disabled="publicando === e.id" @click="publicarEvento(e.id)">
            {{ publicando === e.id ? 'Publicando…' : 'Publicar' }}
          </button>
          <span v-else :class="selo[e.status]?.c ?? 'selo-neutro'">{{ selo[e.status]?.t ?? e.status }}</span>

          <div class="relative">
            <button type="button"
                    class="grid size-11 shrink-0 place-items-center rounded-xl text-tinta-suave transition-colors hover:bg-fundo-cinza hover:text-tinta sm:size-9"
                    aria-haspopup="menu" :aria-expanded="abertoId === e.id" aria-label="Mais ações deste evento"
                    @click="abertoId = abertoId === e.id ? null : e.id"
                    @keydown.esc="abertoId = null">
              <IconeMenu nome="maisVertical" :tamanho="20" />
            </button>
            <!-- véu invisível pra fechar no clique fora, igual ao menu da conta em layouts/admin.vue -->
            <div v-if="abertoId === e.id" class="fixed inset-0 z-40" aria-hidden="true" @click="abertoId = null" />
            <div v-if="abertoId === e.id" role="menu"
                 class="absolute right-0 top-full z-50 mt-1 min-w-52 animate-rise-in rounded-xl bg-white p-1.5 shadow-pop ring-1 ring-ink-200">
              <NuxtLink v-for="a in atalhos(e.id)" :key="a.para" :to="a.para" role="menuitem"
                        class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] font-medium text-tinta-suave transition-colors hover:bg-fundo-cinza hover:text-tinta"
                        @click="abertoId = null">
                <IconeMenu :nome="a.icone" :tamanho="16" /> {{ a.nome }}
              </NuxtLink>
            </div>
          </div>
        </div>
        <p v-if="erroPublicar[e.id]" role="alert"
           class="rounded-lg bg-erro-claro px-3 py-2 text-[13px] font-medium text-erro sm:basis-full">
          {{ erroPublicar[e.id] }}
        </p>
      </li>
    </ul>
  </div>
</template>
