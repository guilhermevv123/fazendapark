<script setup lang="ts">
import { ehPapel, podeAbrirPagina, type Papel } from '~~/server/utils/papeis'

definePageMeta({ layout: 'admin' })

const { data: eventos, pending, error: falha } = await useFetch<any[]>('/api/admin/eventos')

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

    <div v-if="!semAcesso" class="mb-5 flex flex-wrap items-center gap-2">
      <div class="relative">
        <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tinta-fraca">
          <IconeMenu nome="busca" :tamanho="18" />
        </span>
        <input v-model="busca" class="campo w-72 pl-10" placeholder="Buscar por nome, cidade…" aria-label="Buscar evento">
      </div>
      <button v-for="f in (['todos','ativo','rascunho','encerrado'] as const)" :key="f"
              type="button" :class="filtro === f ? 'chip-ativo' : 'chip'" @click="filtro = f">
        {{ f === 'todos' ? 'Todos' : (selo[f]?.t ?? f) }}
      </button>
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

    <p v-else-if="!lista.length" class="card py-12 text-center text-tinta-suave">
      Nenhum evento aqui ainda.
    </p>

    <ul v-else class="grid gap-3">
      <li v-for="e in lista" :key="e.id"
          class="card flex flex-col gap-4 transition-shadow hover:shadow-lateral sm:flex-row sm:items-center">
        <!-- zona 1: o que abre o painel. NuxtLink SÓ até aqui — o resto da
             linha tem o botão de três pontos, e `<a>` dentro de `<a>` é HTML
             inválido: o navegador fecha o de fora sozinho (a árvore que a
             página manda difere da que o Vue montou) e o clique fica errático. -->
        <NuxtLink :to="`/admin/evento/${e.id}/dashboard`"
                  class="flex min-w-0 flex-1 items-center gap-3.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-pool-600">
          <span v-if="!e.thumb"
                class="titulo grid size-14 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-pool-600 to-grape-700 text-[15px] font-bold text-white">
            {{ iniciais(e.nome) }}
          </span>
          <img v-else :src="e.thumb" alt="" class="size-14 shrink-0 rounded-xl object-cover ring-1 ring-ink-200/70">
          <div class="min-w-0">
            <h2 class="titulo truncate text-[15px] font-semibold text-tinta">{{ e.nome }}</h2>
            <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-tinta-suave">
              <span class="inline-flex shrink-0 items-center gap-1.5">
                <IconeMenu nome="calendario" :tamanho="14" />{{ dia(e.inicio) }}
              </span>
              <span v-if="e.local" class="inline-flex min-w-0 items-center gap-1.5">
                <IconeMenu nome="mapa" :tamanho="14" />
                <span class="truncate">{{ e.local }}<template v-if="e.cidade"> · {{ e.cidade }}/{{ e.estado }}</template></span>
              </span>
            </div>
          </div>
        </NuxtLink>

        <!-- zona 2: números, selo e ações — fora do link de propósito -->
        <div class="flex shrink-0 items-center gap-5 border-t border-linha pt-3 sm:border-0 sm:pt-0">
          <div v-if="e.estoque.total" class="text-right leading-tight">
            <p class="text-xs text-tinta-fraca">Ingressos vendidos</p>
            <p class="titulo text-[15px] font-semibold tabular-nums text-tinta">
              {{ e.estoque.vendidos }}<span class="text-tinta-fraca">/{{ e.estoque.total }}</span>
            </p>
            <p class="text-xs tabular-nums text-tinta-fraca">{{ pct(e.estoque.vendidos, e.estoque.total) }}</p>
          </div>
          <span :class="selo[e.status]?.c ?? 'selo-neutro'">{{ selo[e.status]?.t ?? e.status }}</span>

          <div class="relative">
            <button type="button"
                    class="grid size-9 shrink-0 place-items-center rounded-xl text-tinta-fraca transition-colors hover:bg-fundo-cinza hover:text-tinta"
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
      </li>
    </ul>
  </div>
</template>
