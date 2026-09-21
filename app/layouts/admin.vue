<script setup lang="ts">
/**
 * Shell do painel, no desenho do `AdminShell` do sistema do parque: lateral
 * branca e flutuante de 288px no computador, gaveta que desliza no celular, e
 * uma barra de topo com a trilha de onde a pessoa está, o aviso e a conta.
 *
 * A lateral é UM elemento só (não uma no desktop e outra na gaveta): no celular
 * ela sai da tela com `translate`, e fechada fica `invisible` pra não deixar o
 * foco do teclado andar por links que ninguém está vendo. Um elemento só também
 * significa uma logo e uma lista de telas no HTML — o teste de papel
 * (`telas.test.ts`) conta os endereços do menu, e duas cópias dariam contagem
 * dobrada que ninguém saberia ler.
 */
import { ehPapel, podeAbrirPagina, type Papel } from '~~/server/utils/papeis'

const route = useRoute()
const eventoId = computed(() => route.params.id as string | undefined)
const base = computed(() => (eventoId.value ? `/admin/evento/${eventoId.value}` : '/admin'))

const { data: evento } = await useFetch<any>(
  () => (eventoId.value ? `/api/admin/evento/${eventoId.value}/resumo` : ''),
  { immediate: !!eventoId.value, watch: [eventoId] })

// Mesma `key` do middleware de rota: o Nuxt reaproveita a resposta em vez de
// bater na rota duas vezes por navegação.
const { data: eu } = await useFetch<any>('/api/auth/eu', { key: 'auth-eu' })

const iniciais = computed(() => {
  const n = eu.value?.usuario?.nome
  if (!n) return 'CP'
  const partes = n.trim().split(/\s+/)
  return ((partes[0]?.[0] ?? '') + (partes.length > 1 ? partes.at(-1)![0] : '')).toUpperCase()
})

/** O menu suspenso da conta (avatar + nome, no canto do topo). */
const contaAberta = ref(false)
/** A gaveta da lateral — só existe no celular; no computador a lateral é fixa. */
const gavetaAberta = ref(false)
// Navegar fecha as duas: a gaveta aberta em cima da tela nova era o defeito
// clássico de menu lateral em celular.
watch(() => route.path, () => {
  gavetaAberta.value = false
  contaAberta.value = false
})

async function sair() {
  await $fetch('/api/auth/sair', { method: 'POST' })
  // Recarrega de verdade em vez de navegar: `navigateTo` manteria em memória
  // o cache do useFetch com o usuário antigo, e a tela de login apareceria
  // com o nome de quem acabou de sair no canto.
  window.location.href = '/entrar'
}

/**
 * O menu é em GRUPOS: o item de primeiro nível abre a lista de telas daquele
 * assunto em vez de navegar direto. Sem isso, "Ingressos" e "Financeiro"
 * viram uma tela só com dez abas, e a pessoa perde de vista que cortesia,
 * cupom e promoter são coisas diferentes que moram no mesmo assunto.
 */
// A lista das telas do evento mora em composables/menuDoEvento.ts, junto com
// a barra de abas que mostra as mesmas telas no alto da página.
type Item = GrupoDoEvento

const itensDoPainel = computed<Item[]>(() => eventoId.value
  ? menuDoEvento(eventoId.value)
  : [
      { nome: 'Eventos', icone: 'calendario', para: '/admin' },
      { nome: 'Organizações', icone: 'pessoas', para: '/admin/organizacoes' },
      { nome: 'Equipe', icone: 'pessoas', para: '/admin/equipe' },
      { nome: 'Financeiro', icone: 'financeiro', para: '/admin/financeiro' },
      // As duas telas de conferência do dinheiro existiam sem NENHUM caminho
      // até elas: nenhuma página linkava, o menu não listava, e a única
      // maneira de abrir era digitar o endereço. Tela que ninguém acha não
      // protege ninguém — é o mesmo motivo por que a auditoria foi feita.
      { nome: 'Auditoria', icone: 'busca', para: '/admin/auditoria' },
      { nome: 'Reconciliação', icone: 'carteira', para: '/admin/reconciliacao' },
      { nome: 'Configurações', icone: 'config', para: '/admin/configuracoes' },
      { nome: 'Suporte', icone: 'suporte', para: '/admin/suporte' },
    ])

/**
 * O papel de quem está logado — o MESMO que o servidor usa pra trancar a rota
 * (`users.papel`), agora que `/api/auth/eu` devolve a coluna certa.
 */
const papel = computed<Papel | null>(() => {
  const p = eu.value?.usuario?.papel
  return ehPapel(p) ? p : null
})

/**
 * O menu filtrado pelo papel.
 *
 * **Esconder item NÃO é a proteção** — quem tranca é o `middleware/03.papel.ts`,
 * e ele continua respondendo 403 pra quem digitar o endereço na mão. Isto aqui
 * é só pra não desenhar porta fechada na parede: medido antes, a sessão de
 * portaria recebia o menu inteiro no HTML ("Eventos, Organizações, Equipe,
 * Financeiro, Configurações, Suporte") e cada clique terminava em recusa.
 *
 * A régua vem de `server/utils/papeis.ts`, a MESMA que decide a rota. Uma
 * segunda lista aqui envelheceria sozinha: a tela nova entraria numa e não na
 * outra, e o menu passaria a esconder o que o servidor libera (tela que
 * "sumiu") ou a oferecer o que ele nega (item morto de novo).
 *
 * Enquanto o papel não chegou, nada é listado: o `middleware/admin.global.ts`
 * já mandou pro login quem não tem sessão, então este estado dura o tempo da
 * primeira resposta — e listar por otimismo é oferecer porta fechada.
 */
const itens = computed<Item[]>(() => {
  const p = papel.value
  if (!p) return []
  return itensDoPainel.value.flatMap<Item>((i) => {
    if (!i.filhos) return podeAbrirPagina(p, i.para) ? [i] : []
    const filhos = i.filhos.filter((f) => podeAbrirPagina(p, f.para))
    // grupo sem nenhuma tela visível não vira cabeçalho vazio
    if (!filhos.length) return []
    // `para` do grupo fica como está: ele não navega (só abre a lista) e é o
    // que acende a barra lateral quando a rota atual está dentro do assunto.
    return [{ ...i, filhos }]
  })
})

/** Só depois de saber o papel é que "nenhum item" quer dizer alguma coisa. */
const semNenhumaTela = computed(() => !!papel.value && itens.value.length === 0)

/**
 * A MESMA pergunta do menu, pros links que não moram no menu.
 *
 * Esta tela desenha caminho em três lugares, não um: a lateral, a trilha do
 * topo e o ícone de suporte ao lado do avatar. Filtrar só a lateral deixou as
 * outras duas prometendo exatamente as portas que ela tinha acabado de tirar
 * da parede. Medido no HTML servido, DEPOIS da lateral já estar filtrada:
 *
 * - portaria em `/admin/evento/<id>/validacao` (lateral com um item só, mais a
 *   frase "seu acesso é só o leitor de entrada") continuava recebendo no topo
 *   `EVENTOS → /admin` e o ícone de suporte → `/admin/suporte`. As duas telas
 *   respondem 403 pra ela em `/api/admin/eventos` — e a lista de eventos não
 *   mostra a recusa: mostra **"Nenhum evento aqui ainda."**, que é uma
 *   mentira. Quem está no portão lê "o parque não tem evento", não "não é seu
 *   acesso", e o chamado que chega é "o sistema apagou o evento".
 * - operação em qualquer tela do evento recebia na trilha o nome do evento
 *   ligado a `/admin/evento/<id>/dashboard` — a MESMA tela que a lateral
 *   esconde dela de propósito (dashboard é faturamento do dia, área
 *   `dinheiro`). O menu tirava com uma mão e a trilha devolvia com a outra,
 *   uma linha acima.
 *
 * Esconder continua não sendo proteção — quem tranca é o
 * `middleware/03.papel.ts`. Isto é só a régua de `papeis.ts` valendo nos três
 * lugares da tela, e não em um.
 */
const podeAbrir = (para: string) => !!papel.value && podeAbrirPagina(papel.value, para)

const ativo = (para: string) => route.path === para || route.path.startsWith(para + '/')

/**
 * Grupo aberto. Abre sozinho quando a rota atual está dentro dele — senão,
 * chegar por link direto mostra o menu fechado na página em que se está.
 */
const abertos = ref<string[]>([])
watchEffect(() => {
  for (const i of itens.value) {
    if (i.filhos?.some((f) => ativo(f.para)) && !abertos.value.includes(i.nome)) {
      abertos.value.push(i.nome)
    }
  }
})
function alternar(i: Item) {
  if (!i.filhos) return navigateTo(i.para)
  const k = abertos.value.indexOf(i.nome)
  if (k >= 0) abertos.value.splice(k, 1)
  else abertos.value.push(i.nome)
}

/**
 * A trilha continua dizendo ONDE a pessoa está — o texto nunca some, porque
 * ele é o contexto da tela. O que some é o LINK, quando o destino é uma tela
 * que o papel não abre: vira texto simples, igual ao último degrau, que nunca
 * foi link. Some o clique que termina em 403, fica a orientação.
 */
const trilha = computed(() => {
  const degrau = (texto: string, para: string) =>
    ({ texto, para: podeAbrir(para) ? para : undefined })

  const t: { texto: string; para?: string }[] = [degrau('EVENTOS', '/admin')]
  if (evento.value?.nome) {
    t.push(degrau(evento.value.nome.toUpperCase(), `${base.value}/dashboard`))
  }
  const ultima = route.path.split('/').filter(Boolean).pop()
  // 'admin' e o próprio id não são página: viram ruído na trilha.
  if (ultima && ultima !== 'admin' && ultima !== eventoId.value) {
    t.push({ texto: ultima.replace(/-/g, ' ').toUpperCase() })
  }
  return t
})

const situacao: Record<string, { texto: string; classe: string }> = {
  ativo: { texto: 'PUBLICADO', classe: 'selo-ok' },
  rascunho: { texto: 'RASCUNHO', classe: 'selo-neutro' },
  pausado: { texto: 'PAUSADO', classe: 'selo-alerta' },
  encerrado: { texto: 'ENCERRADO', classe: 'selo-neutro' },
}
</script>

<template>
  <div class="min-h-screen lg:grid lg:grid-cols-[288px_minmax(0,1fr)]">
    <!-- véu da gaveta: só no celular, só com a gaveta aberta -->
    <div v-if="gavetaAberta"
         class="fixed inset-0 z-40 animate-fade-in bg-ink-950/40 lg:hidden"
         aria-hidden="true"
         @click="gavetaAberta = false" />

    <!-- ============================================================ lateral -->
    <aside id="menu-lateral"
           class="fixed inset-y-0 left-0 z-50 w-[min(86vw,300px)] transition-[transform,visibility] duration-200
                  lg:sticky lg:inset-y-auto lg:left-auto lg:top-0 lg:z-auto lg:h-screen lg:w-auto lg:py-4 lg:pl-4 lg:transition-none"
           :class="gavetaAberta ? 'visible translate-x-0' : 'invisible -translate-x-full lg:visible lg:translate-x-0'">
      <div class="flex h-full flex-col bg-white px-3 py-5 shadow-pop lg:rounded-2xl lg:shadow-lateral lg:ring-1 lg:ring-ink-200/60">
        <div class="flex items-center justify-between px-3">
          <NuxtLink to="/admin" class="w-fit">
            <LogoMarca class="h-8" />
          </NuxtLink>
          <button type="button"
                  class="grid size-10 place-items-center rounded-xl text-ink-500 transition-colors hover:bg-ink-100 lg:hidden"
                  aria-label="Fechar menu"
                  @click="gavetaAberta = false">
            <IconeMenu nome="fechar" />
          </button>
        </div>

        <nav aria-label="Menu do painel" class="-mx-1 mt-7 flex flex-1 flex-col overflow-y-auto px-1">
          <NuxtLink v-if="eventoId" to="/admin"
                    class="mb-3 flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] font-medium text-ink-500 transition-colors hover:bg-ink-100/80 hover:text-ink-900">
            <IconeMenu nome="voltar" :tamanho="18" /> Voltar aos eventos
          </NuxtLink>

          <!--
            Papel sem nenhuma tela de painel (hoje: a portaria, cuja única área é
            o leitor de entrada, que mora dentro de um evento). Uma linha que diz
            o motivo, porque lateral vazia é lida como "o sistema quebrou" por
            quem está com fila na frente.
          -->
          <p v-if="semNenhumaTela" class="px-3 py-2 text-[13px] leading-snug text-ink-500">
            Seu acesso é só o leitor de entrada.
          </p>

          <ul class="grid gap-0.5">
            <li v-for="i in itens" :key="i.para">
              <component :is="i.filhos ? 'button' : 'NuxtLink'"
                         :to="i.filhos ? undefined : i.para"
                         :type="i.filhos ? 'button' : undefined"
                         :aria-current="!i.filhos && route.path === i.para ? 'page' : undefined"
                         :aria-expanded="i.filhos ? abertos.includes(i.nome) : undefined"
                         class="group relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] transition-colors"
                         :class="ativo(i.para)
                           ? 'bg-pool-50 font-semibold text-pool-800'
                           : 'font-medium text-ink-600 hover:bg-ink-100/80 hover:text-ink-900'"
                         @click="i.filhos && alternar(i)">
                <span v-if="ativo(i.para)" aria-hidden="true"
                      class="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-pool-600" />
                <IconeMenu :nome="i.icone" :tamanho="18"
                           :class="ativo(i.para) ? 'text-pool-700' : 'text-ink-400 group-hover:text-ink-600'" />
                <span class="flex-1 truncate">{{ i.nome }}</span>
                <IconeMenu v-if="i.filhos" nome="seta" :tamanho="16"
                           class="text-ink-400 transition-transform"
                           :class="abertos.includes(i.nome) && 'rotate-90'" />
              </component>

              <!-- telas do grupo: uma régua fina à esquerda, a ativa em azul -->
              <ul v-if="i.filhos && abertos.includes(i.nome)"
                  class="ml-[21px] mt-0.5 grid gap-0.5 border-l border-ink-200 pl-2.5">
                <li v-for="f in i.filhos" :key="f.para">
                  <NuxtLink :to="f.para"
                            :aria-current="route.path === f.para ? 'page' : undefined"
                            class="flex items-center rounded-lg px-3 py-1.5 text-[13.5px] transition-colors"
                            :class="route.path === f.para
                              ? 'bg-pool-50 font-semibold text-pool-800'
                              : 'font-medium text-ink-500 hover:bg-ink-100/80 hover:text-ink-900'">
                    {{ f.nome }}
                  </NuxtLink>
                </li>
              </ul>
            </li>
          </ul>
        </nav>
      </div>
    </aside>

    <!-- ========================================================== conteúdo -->
    <div class="flex min-w-0 flex-col">
      <div class="sticky top-0 z-30 px-3 pt-3 sm:px-4 lg:static lg:px-10 lg:pt-6">
        <header data-parte="topo" class="flex h-16 items-center gap-3 rounded-2xl bg-white/90 px-3 shadow-lateral ring-1 ring-ink-200/60 backdrop-blur
                       sm:px-4 lg:h-auto lg:min-h-[40px] lg:rounded-none lg:bg-transparent lg:px-0 lg:shadow-none lg:ring-0 lg:backdrop-blur-none">
          <button type="button"
                  class="grid size-10 shrink-0 place-items-center rounded-xl text-ink-700 transition-colors hover:bg-ink-100 lg:hidden"
                  aria-label="Abrir menu"
                  aria-controls="menu-lateral"
                  :aria-expanded="gavetaAberta"
                  @click="gavetaAberta = true">
            <IconeMenu nome="media" />
          </button>

          <nav aria-label="Onde você está" class="flex min-w-0 items-center gap-2 text-[12px] font-semibold tracking-[0.06em]">
            <template v-for="(t, i) in trilha" :key="i">
              <span v-if="i" class="text-ink-300" aria-hidden="true">/</span>
              <NuxtLink v-if="t.para" :to="t.para"
                        class="truncate transition-colors hover:text-pool-700"
                        :class="i === trilha.length - 1 ? 'text-ink-900' : 'text-ink-500'">
                {{ t.texto }}
              </NuxtLink>
              <span v-else class="truncate"
                    :class="i === trilha.length - 1 ? 'text-ink-900' : 'text-ink-500'">{{ t.texto }}</span>
            </template>
          </nav>
          <span v-if="evento?.status" class="shrink-0"
                :class="situacao[evento.status]?.classe ?? 'selo-neutro'">
            {{ situacao[evento.status]?.texto ?? evento.status.toUpperCase() }}
          </span>

          <div class="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <button type="button"
                    class="grid size-10 place-items-center rounded-xl text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-900"
                    aria-label="Notificações">
              <IconeMenu nome="sino" />
            </button>
            <!-- mesmo catálogo da lateral: o atalho só existe pra quem abre a
                 tela de suporte (ver `podeAbrir`, acima) -->
            <NuxtLink v-if="podeAbrir('/admin/suporte')" to="/admin/suporte"
                      class="grid size-10 place-items-center rounded-xl text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-900"
                      aria-label="Suporte">
              <IconeMenu nome="chat" />
            </NuxtLink>
            <span aria-hidden="true" class="mx-1 hidden h-8 w-px bg-ink-200 sm:block" />

            <div class="relative" @keydown.esc="contaAberta = false">
              <button type="button"
                      class="flex items-center gap-2.5 rounded-xl py-1.5 pl-1.5 pr-2 transition-colors hover:bg-ink-100"
                      :class="contaAberta && 'bg-ink-100'"
                      aria-haspopup="menu"
                      :aria-expanded="contaAberta"
                      aria-label="Menu da sua conta"
                      @click="contaAberta = !contaAberta">
                <span class="grid size-9 place-items-center rounded-full bg-grape-600 text-[13px] font-semibold text-white">
                  {{ iniciais }}
                </span>
                <span class="hidden min-w-0 text-left sm:block">
                  <span class="block max-w-44 truncate text-sm font-semibold text-ink-900">{{ eu?.usuario?.nome ?? 'Entrar' }}</span>
                  <span v-if="eu?.usuario" class="block max-w-44 truncate text-xs text-ink-500">
                    {{ eu.usuario.papelRotulo ?? eu.usuario.papel }}
                  </span>
                </span>
                <IconeMenu nome="baixo" :tamanho="16" class="hidden text-ink-400 sm:block" />
              </button>

              <!-- clicar fora fecha: um véu invisível atrás do painel -->
              <div v-if="contaAberta" class="fixed inset-0 z-40" aria-hidden="true" @click="contaAberta = false" />
              <div v-if="contaAberta" role="menu"
                   class="absolute right-0 top-full z-50 mt-2 min-w-64 animate-rise-in rounded-xl bg-white p-1.5 shadow-pop ring-1 ring-ink-200">
                <template v-if="eu?.usuario">
                  <div class="px-3 pb-2 pt-1.5">
                    <p class="truncate text-sm font-semibold text-ink-900">{{ eu.usuario.nome }}</p>
                    <p class="truncate text-xs text-ink-500">{{ eu.usuario.email }}</p>
                    <!-- o rótulo vem pronto da rota: quem escreve "Operação" é
                         o servidor, com a mesma palavra da tela de equipe -->
                    <p class="mt-1 text-xs text-ink-600">acesso: {{ eu.usuario.papelRotulo ?? eu.usuario.papel }}</p>
                  </div>
                  <hr class="my-1 border-ink-100">
                  <button type="button" role="menuitem"
                          class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-ink-700 transition-colors hover:bg-ink-100 hover:text-ink-900"
                          @click="sair">
                    <IconeMenu nome="sair" :tamanho="16" class="text-ink-500" />
                    Sair
                  </button>
                </template>
                <NuxtLink v-else to="/entrar" role="menuitem"
                          class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-700 transition-colors hover:bg-ink-100 hover:text-ink-900">
                  Entrar
                </NuxtLink>
              </div>
            </div>
          </div>
        </header>
      </div>

      <main id="conteudo" data-parte="miolo" class="mx-auto w-full max-w-[1280px] flex-1 px-4 pb-12 pt-6 sm:px-6 lg:px-10">
        <slot />
      </main>
    </div>
  </div>
</template>
