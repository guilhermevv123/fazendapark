<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { data: eventos, pending, error: falha } = await useFetch<any[]>('/api/admin/eventos')

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
      <NuxtLink v-if="!semAcesso" to="/admin/evento/novo" class="btn-primario">
        <IconeMenu nome="mais" :tamanho="18" /> Criar evento
      </NuxtLink>
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

    <div v-else class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <NuxtLink v-for="e in lista" :key="e.id" :to="`/admin/evento/${e.id}/dashboard`"
                class="card flex flex-col transition-shadow hover:border-acao/40 hover:shadow-sm">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="titulo truncate text-base font-semibold text-tinta">{{ e.nome }}</h2>
            <p class="mt-0.5 truncate text-sm text-tinta-suave">{{ e.organizacao }}</p>
          </div>
          <span :class="selo[e.status]?.c ?? 'selo-neutro'">{{ selo[e.status]?.t ?? e.status }}</span>
        </div>

        <dl class="mt-3 space-y-1 text-sm text-tinta-suave">
          <div class="flex items-center gap-2">
            <IconeMenu nome="calendario" :tamanho="16" />
            <dd>{{ dia(e.inicio) }}</dd>
          </div>
          <div v-if="e.local" class="flex items-center gap-2">
            <IconeMenu nome="mapa" :tamanho="16" />
            <dd class="truncate">{{ e.local }}<template v-if="e.cidade"> · {{ e.cidade }}/{{ e.estado }}</template></dd>
          </div>
        </dl>

        <div class="mt-4 grid grid-cols-3 gap-2 border-t border-linha pt-3 text-center">
          <div>
            <p class="titulo text-base font-semibold tabular-nums text-tinta">{{ reais(e.cobradoCents) }}</p>
            <p class="text-xs text-tinta-fraca">vendido</p>
          </div>
          <div>
            <p class="titulo text-base font-semibold tabular-nums text-tinta">{{ e.ingressos }}</p>
            <p class="text-xs text-tinta-fraca">ingressos</p>
          </div>
          <div>
            <p class="titulo text-base font-semibold tabular-nums text-tinta">{{ e.pedidos }}</p>
            <p class="text-xs text-tinta-fraca">pedidos</p>
          </div>
        </div>

        <div v-if="e.estoque.total" class="mt-3">
          <div class="h-1.5 w-full rounded-full bg-fundo-cinza">
            <div class="h-1.5 rounded-full bg-acao"
                 :style="{ width: `${Math.min((e.estoque.vendidos / e.estoque.total) * 100, 100)}%` }" />
          </div>
          <p class="mt-1 text-xs text-tinta-fraca">
            {{ e.estoque.vendidos }} de {{ e.estoque.total }} do estoque vendido
          </p>
        </div>
      </NuxtLink>
    </div>
  </div>
</template>
