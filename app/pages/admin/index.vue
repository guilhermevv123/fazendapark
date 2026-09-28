<script setup lang="ts">
/**
 * Eventos — a tela em que o painel abre.
 *
 * ## O redesenho de 27/09 (auditoria EVT-04, EVT-05, EVT-13 e proposta 15)
 *
 *   · no alto, a faixa do dia: pra quem vê o caixa, vendido hoje, líquido de 30 dias (com a variação),
 *     disponível pra saque e eventos à venda — os MESMOS números da Visão geral e do Financeiro
 *     (as mesmas rotas, nenhuma conta nova); pra operação, só o que não é dinheiro;
 *   · no cartão, a barra é dos ingressos PAGOS, com a cortesia marcada à parte (EVT-13: somadas, 10
 *     convites pareciam 10 vendas); quem vê o caixa ganha a linha do líquido do evento — a rota
 *     nem manda dinheiro pra operação (EVT-02);
 *   · a busca e a situação moram na URL (EVT-04: o F5 voltava pra "Todos");
 *   · todo status do banco tem selo e, quando existe, filtro — cancelado, adiado e oculto não saem
 *     mais em texto cru, e o "pausado" (que o banco não tem) saiu (EVT-05).
 */
import { ehPapel, papelPode, podeAbrirPagina, type Papel } from '~~/server/utils/papeis'
import { primeiraTelaDoEvento } from '~/composables/menuDoEvento'
import { variacao } from '~/composables/painelGrafico'
import { rotuloDoPeriodo } from '~/composables/painelPeriodo'
import PainelKpi from '~/components/painel/Kpi.vue'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { data: eventos, pending, error: falha, refresh } = await useFetch<any[]>('/api/admin/eventos')

// Mesma `key` do layout (`app/layouts/admin.vue`): o Nuxt reaproveita a
// resposta em vez de bater em `/api/auth/eu` duas vezes por navegação.
const { data: eu } = await useFetch<any>('/api/auth/eu', { key: 'auth-eu' })
const papel = computed<Papel | null>(() => {
  const p = eu.value?.usuario?.papel
  return ehPapel(p) ? p : null
})
/** quem vê o caixa — a MESMA régua da rota (`papelPode(papel, 'dinheiro')` em `eventos.get.ts`) */
const veDinheiro = computed(() => !!papel.value && papelPode(papel.value, 'dinheiro'))

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

/* --------------------------------------------- a faixa do dia (dinheiro) */

/**
 * Uma ida à Visão geral (30 dias, que já traz a curva por dia e o período anterior) e uma ao
 * Financeiro. Só pra quem vê o caixa: pra operação as duas respondem 403, e a faixa dela é feita
 * só com a lista de eventos.
 */
const { data: trinta, execute: buscarTrinta } = useFetch<any>('/api/admin/relatorios', {
  key: 'inicio-30d', query: { periodo: '30d' }, immediate: false,
})
const { data: caixa, execute: buscarCaixa } = useFetch<any>('/api/admin/financeiro', {
  key: 'inicio-caixa', immediate: false,
})
if (veDinheiro.value && !semAcesso.value) await Promise.all([buscarTrinta(), buscarCaixa()])

const hoje = computed(() => {
  const d = trinta.value
  if (!d?.filtro?.hoje) return null
  const dia = (d.porDia ?? []).find((x: any) => x.dia === d.filtro.hoje)
  return { cobradoCents: Number(dia?.cobradoCents ?? 0), pedidos: Number(dia?.pedidos ?? 0) }
})
const liquido30 = computed(() => trinta.value?.resumo ? Number(trinta.value.resumo.liquidoCents ?? 0) : null)
const variacao30 = computed(() => (trinta.value?.anterior?.resumo && liquido30.value !== null
  ? variacao(liquido30.value, Number(trinta.value.anterior.resumo.liquidoCents ?? 0)) : null))
const contra30 = computed(() => (trinta.value?.anterior ? rotuloDoPeriodo(trinta.value.anterior.de, trinta.value.anterior.ate) : ''))

const aVenda = computed(() => (eventos.value ?? []).filter((e: any) => e.status === 'ativo'))
const proximo = computed(() => {
  const agora = Date.now()
  return [...aVenda.value]
    .filter((e: any) => e.inicio && Date.parse(e.inicio) >= agora - 86_400_000)
    .sort((a: any, b: any) => Date.parse(a.inicio) - Date.parse(b.inicio))[0] ?? null
})
const pagosAVenda = computed(() => aVenda.value.reduce((s: number, e: any) => s + Number(e.estoque?.pagos ?? e.estoque?.vendidos ?? 0), 0))
const cortesiasAVenda = computed(() => aVenda.value.reduce((s: number, e: any) => s + Number(e.estoque?.cortesias ?? 0), 0))

/* ------------------------------------------------- busca e situação na URL */

/**
 * EVT-04: a URL é a fonte. A situação é lida da rota a cada troca (o F5 e o link mantêm); a
 * busca tem um espelho local pra digitação não esperar a URL, sincronizado nos dois sentidos.
 */
const SITUACOES = ['ativo', 'rascunho', 'encerrado', 'adiado', 'cancelado', 'oculto'] as const
type Situacao = typeof SITUACOES[number]
const filtro = computed<'todos' | Situacao>(() => {
  const s = route.query.situacao
  return typeof s === 'string' && (SITUACOES as readonly string[]).includes(s) ? s as Situacao : 'todos'
})
const busca = ref(typeof route.query.busca === 'string' ? route.query.busca : '')
watch(() => route.query.busca, (v) => {
  const vindo = typeof v === 'string' ? v : ''
  if (vindo !== busca.value) busca.value = vindo
})
let esperaBusca: ReturnType<typeof setTimeout> | null = null
function escreverNaUrl(mudanca: { situacao?: string; busca?: string }) {
  const query: Record<string, string> = {}
  const situacao = mudanca.situacao ?? filtro.value
  const texto = (mudanca.busca ?? busca.value).trim()
  if (situacao !== 'todos') query.situacao = situacao
  if (texto) query.busca = texto.slice(0, 120)
  return navigateTo({ path: route.path, query }, { replace: true })
}
watch(busca, (v) => {
  if (esperaBusca) clearTimeout(esperaBusca)
  esperaBusca = setTimeout(() => {
    const naUrl = typeof route.query.busca === 'string' ? route.query.busca : ''
    if (v.trim() !== naUrl) escreverNaUrl({ busca: v })
  }, 300)
})
const escolherSituacao = (s: 'todos' | Situacao) => escreverNaUrl({ situacao: s })
function mostrarTodos() {
  busca.value = ''
  return escreverNaUrl({ situacao: 'todos', busca: '' })
}

const lista = computed(() => (eventos.value ?? []).filter((e) => {
  if (filtro.value !== 'todos' && e.status !== filtro.value) return false
  const t = busca.value.trim().toLowerCase()
  return !t || `${e.nome} ${e.cidade ?? ''} ${e.organizacao}`.toLowerCase().includes(t)
}))

// `reais` e `dataPorExtenso` vêm de `app/composables/formato.ts`: a conta de
// centavo e o corte do dia moram num lugar só, e nenhum dos dois passa por
// float nem por UTC.
const dia = dataPorExtenso

/** EVT-05: um selo pra cada status que o banco aceita (`events.status`, db/001_schema.sql) */
const selo: Record<string, { t: string; c: string }> = {
  ativo: { t: 'PUBLICADO', c: 'selo-ok' },
  rascunho: { t: 'RASCUNHO', c: 'selo-neutro' },
  encerrado: { t: 'ENCERRADO', c: 'selo-neutro' },
  adiado: { t: 'ADIADO', c: 'selo-alerta' },
  cancelado: { t: 'CANCELADO', c: 'selo-erro' },
  oculto: { t: 'OCULTO', c: 'selo-neutro' },
}
/** os chips: os quatro de sempre, e adiado/cancelado/oculto só quando existe evento assim */
const chips = computed(() => {
  const existentes = new Set((eventos.value ?? []).map((e: any) => e.status))
  return (['todos', ...SITUACOES] as const).filter((s) =>
    s === 'todos' || s === 'ativo' || s === 'rascunho' || s === 'encerrado' || existentes.has(s) || filtro.value === s)
})

/** "4,8%"; `null` some a linha (evento sem lote ainda). */
const pct = (vendidos: number, total: number) =>
  total ? `${(vendidos / total * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : null

/** largura de uma parte da barra: nunca abaixo de 2% com alguma unidade, senão 14 de 20.000 some */
const largura = (parte: number, total: number) =>
  !total || !parte ? '0%' : `${Math.max(2, Math.min(100, parte / total * 100))}%`

const milhar = (n: number) => Number(n ?? 0).toLocaleString('pt-BR')
/** pagos e cortesias do cartão — resposta antiga (sem a separação) cai no "vendidos" */
const pagos = (e: any) => Number(e.estoque?.pagos ?? e.estoque?.vendidos ?? 0)
const cortesias = (e: any) => Number(e.estoque?.cortesias ?? 0)

const podeCriar = computed(() => !!papel.value && podeAbrirPagina(papel.value, '/admin/evento/novo'))
const abreVisaoGeral = computed(() => !!papel.value && podeAbrirPagina(papel.value, '/admin/relatorios'))
const abreFinanceiro = computed(() => !!papel.value && podeAbrirPagina(papel.value, '/admin/financeiro'))
/**
 * O cartão da faixa vira link só pra quem abre a tela de destino. `resolveComponent` e não a string
 * 'NuxtLink' no `:is` — a string crua não resolve no Nuxt (ver o comentário em `layouts/admin.vue`).
 */
const Ligacao = resolveComponent('NuxtLink')

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
  if (publicando.value) return
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
  <div class="pb-10">
    <div class="flex flex-wrap items-center justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-ink-900 sm:text-[28px]">Eventos</h1>
        <p class="mt-1 text-[15px] text-ink-700">
          {{ semAcesso ? 'O seu acesso é o leitor de entrada' : 'Todos os eventos do parque, do mais novo pro mais antigo' }}
        </p>
      </div>
      <div v-if="!semAcesso" class="flex flex-wrap items-center gap-2">
        <!-- financeiro alcança a Visão geral, operação não — a mesma régua do menu -->
        <NuxtLink v-if="abreVisaoGeral" to="/admin/relatorios" class="btn-secundario min-h-[40px]">
          <IconeMenu nome="relatorio" :tamanho="18" /> Visão geral
        </NuxtLink>
        <!-- e o inverso: operação cria evento, financeiro não. Antes desta
             linha o botão aparecia pros dois — clique de financeiro em
             "Criar evento" voltava 403 sem aviso nenhum. -->
        <NuxtLink v-if="podeCriar" to="/admin/evento/novo" class="btn-primario min-h-[40px]">
          <IconeMenu nome="mais" :tamanho="18" /> Criar evento
        </NuxtLink>
      </div>
    </div>

    <!-- =================================================== a faixa do dia -->
    <div v-if="!semAcesso && !falha && eventos" class="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4" data-parte="faixa-do-dia">
      <template v-if="veDinheiro">
        <component :is="abreVisaoGeral ? Ligacao : 'div'" :to="abreVisaoGeral ? '/admin/relatorios?periodo=30d' : undefined"
                   class="col-span-2 block rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-pool-600 sm:col-span-1">
          <PainelKpi rotulo="Líquido em 30 dias" :valor="liquido30 === null ? '—' : reais(liquido30)" tom="grape" icone="carteira" destaque
                     :variacao="variacao30" :contra="contra30" class="h-full" data-kpi="liquido-30">
            o que fica pro parque, depois da taxa e das devoluções
          </PainelKpi>
        </component>
        <component :is="abreVisaoGeral ? Ligacao : 'div'" :to="abreVisaoGeral ? '/admin/relatorios?periodo=hoje' : undefined"
                   class="block rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-pool-600">
          <PainelKpi rotulo="Vendido hoje" :valor="hoje ? reais(hoje.cobradoCents) : '—'" tom="pool" icone="vendas" compacto class="h-full" data-kpi="hoje">
            <template v-if="hoje">{{ milhar(hoje.pedidos) }} {{ hoje.pedidos === 1 ? 'pedido pago' : 'pedidos pagos' }} até agora</template>
          </PainelKpi>
        </component>
        <component :is="abreFinanceiro ? Ligacao : 'div'" :to="abreFinanceiro ? '/admin/financeiro' : undefined"
                   class="block rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-pool-600">
          <PainelKpi rotulo="Disponível pra saque" :valor="caixa?.totais ? reais(caixa.totais.disponivelCents) : '—'" tom="ok" icone="check" compacto class="h-full" data-kpi="disponivel">
            <template v-if="caixa?.totais">+ {{ reais(caixa.totais.retidoCents) }} retido até o fim dos eventos</template>
          </PainelKpi>
        </component>
      </template>
      <template v-else>
        <PainelKpi rotulo="Ingressos pagos" :valor="milhar(pagosAVenda)" tom="pool" icone="ingresso" compacto data-kpi="pagos">
          nos eventos à venda
        </PainelKpi>
        <PainelKpi rotulo="Cortesias" :valor="milhar(cortesiasAVenda)" tom="citrus" icone="presente" compacto data-kpi="cortesias">
          emitidas nos eventos à venda
        </PainelKpi>
        <PainelKpi rotulo="Próximo evento" :valor="proximo ? dataCurta(proximo.inicio) : '—'" tom="grape" icone="calendario" compacto data-kpi="proximo">
          {{ proximo?.nome ?? 'nenhum evento publicado com data à frente' }}
        </PainelKpi>
      </template>
      <PainelKpi rotulo="Eventos à venda" :valor="milhar(aVenda.length)" tom="sun" icone="calendario" compacto
                 :class="veDinheiro ? 'col-span-2 sm:col-span-1' : ''" data-kpi="a-venda">
        <template v-if="proximo && veDinheiro">próximo: {{ proximo.nome }} · {{ dataCurta(proximo.inicio) }}</template>
        <template v-else>publicados no site agora</template>
      </PainelKpi>
    </div>

    <!-- No celular: busca na largura toda e os filtros numa fila que rola de
         lado — quebrando em linhas, "Todos" ficava ao lado da busca e o resto
         caía embaixo, torto. -->
    <div v-if="!semAcesso" class="mb-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
      <div class="relative w-full sm:w-72">
        <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-pool-700">
          <IconeMenu nome="busca" :tamanho="18" />
        </span>
        <input v-model="busca" class="campo w-full pl-10" placeholder="Buscar por nome, cidade…" aria-label="Buscar evento"
               maxlength="120" data-parte="busca">
      </div>
      <div class="-mx-4 flex gap-2 sem-barra overflow-x-auto px-4 sm:mx-0 sm:px-0" role="group" aria-label="Situação">
        <button v-for="f in chips" :key="f" type="button" class="min-h-[40px] shrink-0 sm:min-h-0"
                :class="filtro === f ? 'chip-ativo' : 'chip'" :aria-pressed="filtro === f" :data-situacao="f"
                @click="escolherSituacao(f)">
          {{ f === 'todos' ? 'Todos' : (selo[f]?.t ?? f) }}
        </button>
      </div>
    </div>

    <p v-if="pending" class="card text-ink-700">Carregando…</p>

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
        <p class="mx-auto mt-2 max-w-md text-sm text-ink-700">
          Não há evento publicado e em andamento na sua organização neste momento.
          Quando houver, ele aparece aqui.
        </p>
      </template>
      <!-- O leitor também é recusado (outro papel) ou a consulta não voltou: a
           recusa segue nomeada, sem afirmar que não existe evento. -->
      <template v-else>
        <p class="rotulo-kpi">Esta lista não é do seu acesso</p>
        <p class="mx-auto mt-2 max-w-md text-sm text-ink-700">
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
      <p class="mx-auto mt-2 max-w-md text-sm text-ink-700">
        {{ (falha as any)?.data?.statusMessage || (falha as any)?.statusMessage
          || 'O servidor não respondeu. Confira a internet e tente de novo.' }}
      </p>
      <button type="button" class="btn-secundario mt-4" @click="refresh()">Tentar de novo</button>
    </div>

    <!-- Vazio com saída: um desenho, a frase e o botão que resolve. Só a frase
         cinza no meio de um cartão branco lia como tela quebrada. -->
    <div v-else-if="!lista.length" class="card flex flex-col items-center px-6 py-12 text-center" data-parte="vazio">
      <span class="grid size-16 place-items-center rounded-2xl bg-gradient-to-br from-pool-100 to-grape-100 text-pool-700">
        <IconeMenu :nome="(eventos ?? []).length ? 'busca' : 'ingresso'" :tamanho="30" />
      </span>
      <template v-if="(eventos ?? []).length">
        <p class="titulo mt-4 text-lg font-semibold text-ink-900">Nenhum evento com este filtro</p>
        <p class="mt-1 max-w-sm text-ink-700">Troque a situação ou apague a busca.</p>
        <button type="button" class="btn-secundario mt-5 min-h-[40px]" data-acao="mostrar-todos" @click="mostrarTodos">Mostrar todos</button>
      </template>
      <template v-else>
        <p class="titulo mt-4 text-lg font-semibold text-ink-900">Nenhum evento ainda</p>
        <p class="mt-1 max-w-sm text-ink-700">Crie o primeiro evento, cadastre os ingressos e publique pra começar a vender.</p>
        <NuxtLink v-if="podeCriar" to="/admin/evento/novo" class="btn-primario mt-5 min-h-[40px]">
          <IconeMenu nome="mais" :tamanho="18" /> Criar evento
        </NuxtLink>
      </template>
    </div>

    <ul v-else class="grid gap-3">
      <li v-for="e in lista" :key="e.id"
          class="card flex min-w-0 flex-col gap-4 transition-shadow hover:shadow-lateral sm:flex-row sm:flex-wrap sm:items-center"
          :data-evento="e.id">
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
            <h2 class="titulo text-[16px] font-semibold leading-snug text-ink-900">{{ e.nome }}</h2>
            <div class="mt-1.5 flex flex-col gap-1 text-[13.5px] text-ink-700 sm:flex-row sm:flex-wrap sm:gap-x-3">
              <span class="inline-flex min-w-0 items-center gap-1.5">
                <IconeMenu nome="calendario" :tamanho="14" class="text-pool-600" />{{ dia(e.inicio) }}
              </span>
              <span v-if="e.local" class="inline-flex min-w-0 items-start gap-1.5">
                <IconeMenu nome="mapa" :tamanho="14" class="mt-0.5 text-grape-500" />
                <span class="min-w-0">{{ e.local }}<template v-if="e.cidade"> · {{ e.cidade }}/{{ e.estado }}</template></span>
              </span>
            </div>
            <!-- proposta 15: o dinheiro do evento, só pra quem vê o caixa (a rota nem manda pros outros) -->
            <p v-if="veDinheiro && e.liquidoCents !== undefined" class="mt-1.5 text-[13.5px] text-ink-700" data-parte="dinheiro-do-evento">
              <strong class="tabular-nums text-grape-800">{{ reais(e.liquidoCents) }}</strong> líquido
              <span class="text-ink-600">· {{ milhar(e.pedidos ?? 0) }} {{ e.pedidos === 1 ? 'pedido' : 'pedidos' }}</span>
            </p>
          </div>
        </NuxtLink>

        <!-- zona 2: números, selo e ações — fora do link de propósito -->
        <!-- a barra é dos PAGOS (o que o Zig mostra no card e o dono gostou), com a cortesia
             marcada em outra cor ao lado: somadas, dez convites pareciam dez vendas (EVT-13). -->
        <div class="flex shrink-0 items-center gap-3 border-t border-linha pt-3 sm:w-80 sm:gap-4 sm:border-0 sm:pt-0">
          <div v-if="e.estoque.total" class="min-w-0 flex-1 leading-tight" data-parte="estoque">
            <div class="flex items-baseline justify-between gap-2">
              <p class="text-[12.5px] font-medium text-ink-700">Ingressos pagos</p>
              <p class="text-[12.5px] font-semibold tabular-nums text-pool-700">{{ pct(pagos(e), e.estoque.total) }}</p>
            </div>
            <p class="titulo mt-0.5 text-[17px] font-bold tabular-nums text-ink-900" data-parte="pagos">
              {{ milhar(pagos(e)) }}<span class="font-semibold text-ink-500">/{{ milhar(e.estoque.total) }}</span>
            </p>
            <div class="mt-1.5 flex h-2 overflow-hidden rounded-full bg-ink-100" aria-hidden="true">
              <div class="h-full rounded-l-full bg-gradient-to-r from-pool-500 to-grape-600" :style="{ width: largura(pagos(e), e.estoque.total) }" />
              <div v-if="cortesias(e)" class="h-full bg-citrus-500" :style="{ width: largura(cortesias(e), e.estoque.total) }" />
            </div>
            <p v-if="cortesias(e)" class="mt-1 flex items-center gap-1.5 text-[12px] text-ink-700" data-parte="cortesias-do-evento">
              <span class="size-2 rounded-full bg-citrus-500" /> + {{ milhar(cortesias(e)) }} {{ cortesias(e) === 1 ? 'cortesia' : 'cortesias' }}
            </p>
          </div>
          <p v-else class="min-w-0 flex-1 text-[13px] text-ink-500">Sem ingresso cadastrado</p>
          <!-- rascunho: o selo vira a ação que tira ele do rascunho -->
          <button v-if="e.status === 'rascunho' && podePublicar(e.id)" type="button"
                  class="btn-primario min-h-[40px] shrink-0 px-3.5 py-2 text-[13.5px]"
                  :disabled="publicando === e.id" @click="publicarEvento(e.id)">
            {{ publicando === e.id ? 'Publicando…' : 'Publicar' }}
          </button>
          <span v-else :class="selo[e.status]?.c ?? 'selo-neutro'" data-parte="selo">{{ selo[e.status]?.t ?? String(e.status).toUpperCase() }}</span>

          <div class="relative">
            <button type="button"
                    class="grid size-11 shrink-0 place-items-center rounded-xl text-ink-700 transition-colors hover:bg-fundo-cinza hover:text-ink-900"
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
                        class="flex min-h-[40px] items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] font-medium text-ink-700 transition-colors hover:bg-fundo-cinza hover:text-ink-900"
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
