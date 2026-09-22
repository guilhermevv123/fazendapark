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

/**
 * O componente de link do item do menu — resolvido AQUI, antes de qualquer
 * `await` da função.
 *
 * `resolveComponent` só enxerga a instância certa dentro de `setup()`/render;
 * depois de um `await` (este arquivo tem dois, mais abaixo) o Vue não garante
 * mais esse contexto — o `<script setup>` assíncrono PODE retomar sem ele.
 * Medido: chamado depois dos dois `await useFetch`, o harness de teste
 * (`telas.test.ts`, sob `<Suspense>`) perdia a instância e todo item do menu
 * sumia da tela — sem erro nenhum, calado. Antes de qualquer `await` a
 * instância é sempre a certa, no teste e na Nuxt de verdade.
 *
 * `<component :is="… 'NuxtLink'">` com o NOME em texto direto NÃO funciona no
 * Nuxt: o Vue procura "NuxtLink" entre os componentes registrados
 * globalmente, e o Nuxt não registra ele lá — troca a tag `<NuxtLink>` por um
 * IMPORT no compilador, e um nome dentro de uma string o compilador não vê. O
 * item saía como `<nuxtlink to="…">`, um elemento inventado sem `href`, que o
 * navegador desenha e não sabe abrir: o clique só selecionava o texto.
 */
const LinkDoMenu = resolveComponent('NuxtLink')

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

/**
 * A lateral do DESKTOP expande no hover e recolhe ao tirar o mouse — mesma
 * lógica do Diamond CRM (`Sidebar.vue`, componente `isCollapsed`): abrir é
 * na hora, fechar espera um respiro de 200ms, porque o mouse só raspando a
 * borda ao sair não pode abrir/fechar em rajada (era a fonte do "hover
 * travado" que o Diamond documenta).
 *
 * Só desktop — `railAberta` nunca é lido por nenhuma classe abaixo de `lg:`,
 * então no celular (que não tem hover; um toque dispara `mouseleave`
 * SINTÉTICO em alguns navegadores) esta variável pode até mudar de valor,
 * mas não desenha nada: a gaveta continua sendo só `gavetaAberta`.
 *
 * A largura anima SÓ na própria lateral, que é `fixed` (fora do fluxo): o
 * respiro do conteúdo (`lg:ml-24`, no miolo) é FIXO no tamanho do trilho
 * recolhido e nunca acompanha o hover. Animar a margem do conteúdo junto
 * refaria o layout da página inteira a cada frame só pra abrir um menu — o
 * mesmo travo de performance que o comentário do Diamond mede e evita.
 * Expandida, a lateral fica por CIMA do conteúdo (`z-50` + sombra), nunca
 * empurra nada.
 */
const railAberta = ref(false)
let temporizadorRecolherRail: ReturnType<typeof setTimeout> | null = null
function abrirRail() {
  if (temporizadorRecolherRail) { clearTimeout(temporizadorRecolherRail); temporizadorRecolherRail = null }
  railAberta.value = true
}
function recolherRail() {
  if (temporizadorRecolherRail) clearTimeout(temporizadorRecolherRail)
  temporizadorRecolherRail = setTimeout(() => { railAberta.value = false }, 200)
}

/** Linha do menu com o rail recolhido: ícone centralizado, sem respiro extra. */
const classeLinhaRail = computed(() => !railAberta.value && 'lg:justify-center lg:gap-0 lg:px-0')
/**
 * O rótulo (texto) some visualmente com a largura zerada — não com `v-show`/
 * `display:none` — porque o link continua tendo NOME pra quem usa leitor de
 * tela mesmo com o rail fechado: `display:none` tiraria o texto da árvore de
 * acessibilidade junto com o desenho.
 */
const classeRotuloRail = computed(() => [
  'transition-[max-width,opacity] duration-200',
  railAberta.value ? 'lg:max-w-none lg:opacity-100' : 'lg:max-w-0 lg:opacity-0',
])
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
      // O menu de ANTES de entrar num evento: a organização inteira. As telas de
      // cada evento moram em `menuDoEvento`. A ordem é a que o dono pediu:
      // eventos, a organização, os clientes, os relatórios — e o resto depois.
      { nome: 'Eventos', icone: 'calendario', para: '/admin' },
      // singular: a conta é uma só. A rota segue `/admin/organizacoes` (a tela é
      // lista por construção; ver o comentário dela).
      { nome: 'Organização', icone: 'organizacao', para: '/admin/organizacoes' },
      { nome: 'Clientes', icone: 'pessoas', para: '/admin/clientes' },
      { nome: 'Relatórios', icone: 'relatorio', para: '/admin/relatorios' },
      { nome: 'Financeiro', icone: 'financeiro', para: '/admin/financeiro' },
      { nome: 'Equipe', icone: 'cracha', para: '/admin/equipe' },
      { nome: 'Configurações', icone: 'config', para: '/admin/configuracoes' },
      // As duas telas de conferência do dinheiro existiam sem NENHUM caminho
      // até elas: nenhuma página linkava, o menu não listava, e a única
      // maneira de abrir era digitar o endereço. Tela que ninguém acha não
      // protege ninguém — é o mesmo motivo por que a auditoria foi feita.
      { nome: 'Reconciliação', icone: 'carteira', para: '/admin/reconciliacao' },
      { nome: 'Auditoria', icone: 'busca', para: '/admin/auditoria' },
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

// `/admin` é a lista de eventos E o prefixo de toda tela do painel: casando por
// prefixo, "Eventos" ficava aceso em Clientes, Relatórios, Equipe… — dois itens
// marcados ao mesmo tempo, e a barra deixava de dizer onde a pessoa está.
const ativo = (para: string) => para === '/admin'
  ? route.path === para
  : route.path === para || route.path.startsWith(para + '/')

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
/** o segmento da URL não tem acento; o nome que a pessoa lê na trilha tem */
const NOME_DA_TELA: Record<string, string> = {
  relatorios: 'Relatórios', organizacoes: 'Organização', configuracoes: 'Configurações',
  reconciliacao: 'Reconciliação', sessoes: 'Sessões', transferencias: 'Transferências',
  validacao: 'Validação', historico: 'Histórico', promocionais: 'Promocionais',
}

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
    t.push({ texto: (NOME_DA_TELA[ultima] ?? ultima.replace(/-/g, ' ')).toUpperCase() })
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
  <div class="min-h-screen">
    <!-- véu da gaveta: só no celular, só com a gaveta aberta -->
    <div v-if="gavetaAberta"
         class="fixed inset-0 z-40 animate-fade-in bg-ink-950/40 lg:hidden"
         aria-hidden="true"
         @click="gavetaAberta = false" />

    <!-- ============================================================ lateral -->
    <aside id="menu-lateral"
           class="fixed inset-y-0 left-0 z-50 w-[min(86vw,300px)] rail-suave
                  transition-[transform,visibility] duration-200
                  lg:inset-y-auto lg:left-4 lg:top-4 lg:h-[calc(100vh-2rem)]
                  lg:transition-[width,transform] lg:duration-[320ms] lg:will-change-[width]"
           :class="[
             gavetaAberta ? 'visible translate-x-0' : 'invisible -translate-x-full lg:visible lg:translate-x-0',
             railAberta ? 'lg:w-72' : 'lg:w-20',
           ]"
           @mouseenter="abrirRail"
           @mouseleave="recolherRail">
      <div class="flex h-full flex-col overflow-hidden bg-white px-3 py-5 shadow-pop lg:rounded-2xl lg:shadow-lateral lg:ring-1 lg:ring-ink-200/60">
        <div class="flex items-center justify-between px-3" :class="!railAberta && 'lg:justify-center lg:px-0'">
          <NuxtLink to="/admin" class="flex w-fit shrink-0 items-center">
            <LogoMarca class="h-8" :class="!railAberta && 'lg:hidden'" />
            <!-- rail recolhido: a marca inteira (302×122) não cabe em 80px —
                 vira um monograma, no mesmo desenho do avatar de evento sem
                 foto (app/pages/admin/index.vue), pra ficar uma família só. -->
            <span v-if="!railAberta"
                  class="titulo hidden size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-pool-600 to-grape-700 text-[12px] font-bold text-white lg:flex">
              CP
            </span>
          </NuxtLink>
          <button type="button"
                  class="grid size-10 shrink-0 place-items-center rounded-xl text-ink-500 transition-colors hover:bg-ink-100 lg:hidden"
                  aria-label="Fechar menu"
                  @click="gavetaAberta = false">
            <IconeMenu nome="fechar" />
          </button>
        </div>

        <!-- `select-none`: rótulo de menu não é texto pra copiar; sem isto, um
             clique duplo arrastado pinta o nome de azul em vez de abrir a tela -->
        <nav aria-label="Menu do painel" class="-mx-1 mt-7 flex flex-1 select-none flex-col overflow-y-auto px-1">
          <NuxtLink v-if="eventoId" to="/admin"
                    class="mb-3 flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] font-medium text-ink-500 transition-colors hover:bg-ink-100/80 hover:text-ink-900"
                    :class="classeLinhaRail">
            <IconeMenu nome="voltar" :tamanho="18" class="shrink-0" />
            <span class="truncate" :class="classeRotuloRail">Voltar aos eventos</span>
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
              <component :is="i.filhos ? 'button' : LinkDoMenu"
                         :to="i.filhos ? undefined : i.para"
                         :type="i.filhos ? 'button' : undefined"
                         :aria-current="!i.filhos && route.path === i.para ? 'page' : undefined"
                         :aria-expanded="i.filhos ? abertos.includes(i.nome) : undefined"
                         class="group relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] transition-colors"
                         :class="[
                           ativo(i.para)
                             ? 'bg-pool-50 font-semibold text-pool-800'
                             : 'font-medium text-ink-600 hover:bg-ink-100/80 hover:text-ink-900',
                           classeLinhaRail,
                         ]"
                         @click="i.filhos && alternar(i)">
                <span v-if="ativo(i.para)" aria-hidden="true"
                      class="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-pool-600" />
                <IconeMenu :nome="i.icone" :tamanho="18" class="shrink-0"
                           :class="ativo(i.para) ? 'text-pool-700' : 'text-ink-400 group-hover:text-ink-600'" />
                <span class="flex-1 truncate" :class="classeRotuloRail">{{ i.nome }}</span>
                <IconeMenu v-if="i.filhos" nome="seta" :tamanho="16"
                           class="shrink-0 text-ink-400 transition-transform"
                           :class="[abertos.includes(i.nome) && 'rotate-90', !railAberta && 'lg:hidden']" />
              </component>

              <!-- telas do grupo: uma régua fina à esquerda, a ativa em azul.
                   `lg:hidden` no rail recolhido: o estado (`abertos`) continua
                   valendo — reexpande sozinho ao passar o mouse de novo — só
                   não cabe desenhado em 80px. -->
              <ul v-if="i.filhos && abertos.includes(i.nome)"
                  class="ml-[21px] mt-0.5 grid gap-0.5 border-l border-ink-200 pl-2.5"
                  :class="!railAberta && 'lg:hidden'">
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

    <!-- ========================================================== conteúdo
         `lg:ml-24` = left-4 (16px) + w-20 (80px) do rail RECOLHIDO — e não
         muda com o hover. A lateral expandida flutua por CIMA (fixed, z-50),
         nunca empurra: animar esta margem junto com a largura da lateral
         refaria o layout da página inteira a cada frame do hover. -->
    <div class="flex min-w-0 flex-col lg:ml-24">
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

<style scoped>
/*
 * Curva "expo-out" pra abrir/fechar o rail — a mesma do Diamond CRM
 * (`Sidebar.vue`, classe `.sidebar-fluid` lá): mais suave que o `ease-out`
 * padrão do Tailwind pra animar LARGURA, que é uma propriedade cara (força
 * reflow a cada frame, não roda no compositor como `transform`/`opacity`).
 * Não tira o custo do reflow — só disfarça o "travadinho" com uma
 * desaceleração mais pronunciada no final. Ref.: https://easings.net/#easeOutExpo
 */
.rail-suave {
  transition-timing-function: cubic-bezier(0.16, 1, 0.3, 1) !important;
}
</style>
