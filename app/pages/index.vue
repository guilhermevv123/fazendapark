<script setup lang="ts">
import VideoDoParque from '~/components/VideoDoParque.vue'
import LogoMarca from '~/components/LogoMarca.vue'
/**
 * A home do site de vendas — o que o comprador vê primeiro.
 *
 * O desenho é o do site do parque (repositório `sistemapark`, `(site)/page.tsx`):
 * capa com foto, "como comprar", galeria, ingressos e preços, dúvidas e uma
 * chamada final. Os DADOS são os de cá. O parque vende por EDIÇÃO (evento com
 * data), não por calendário diário; então onde o site novo listava "próximas
 * datas abertas" esta home lista os eventos, e onde ele mostrava o preço do dia
 * ela mostra o painel do evento em destaque (foto, quando, onde e o "a partir de",
 * taxa inclusa — o mesmo valor que a vitrine cobra).
 *
 * O que já era desta tela e ficou, porque cada item custou um bug:
 *
 * 1. **O vocabulário de situação vem PRONTO do servidor** (`situacao`). A tela
 *    não deduz estado de preço nulo: evento sem lote comprável aparecia com o
 *    preço em branco, sem dizer se acabou ou se ainda ia abrir. Deduzir é como
 *    duas telas voltam a discordar.
 * 2. **Bilheteria quebrada não pode parecer bilheteria vazia.** Com
 *    `/api/eventos-publicos` respondendo 500, a home dizia "nenhum evento à
 *    venda" e o comprador ia embora certo de que o evento acabou, no dia em que
 *    o servidor caiu. `error` decide primeiro; a frase de vazio só sai quando a
 *    resposta VEIO e veio vazia.
 * 3. **Só entra classe que existe.** O Tailwind não avisa da que falta — ele
 *    simplesmente não gera a regra. `telas.test.ts` varre isto.
 *
 * ## O movimento
 *
 * A página tem a vida de um parque aquático: a foto da capa respira devagar, a
 * luz da piscina passa por cima, bolhas sobem, a linha d'água corre no pé da
 * capa, as atrações correm num letreiro e o resto aparece conforme a pessoa
 * rola. Três regras seguram isso:
 *
 * - **Nada fica escondido sem JavaScript.** O que entra junto com a página é
 *   animação de CSS (roda sozinha); o que aparece ao rolar só é escondido
 *   DEPOIS de montar, e só se estiver abaixo da dobra — o que a pessoa já está
 *   vendo nunca pisca.
 * - **Quem pede menos movimento não recebe movimento**
 *   (`prefers-reduced-motion`): sem bolha, sem onda correndo, sem revelar ao
 *   rolar. O conteúdo é o mesmo.
 * - **Sem `<Transition>` e sem sorteio.** Com a aba escondida o `<Transition>`
 *   fica em opacidade 0; e número aleatório desenha uma coisa no servidor e
 *   outra no navegador. As bolhas têm posição fixa.
 *
 * Fora daqui, de propósito: contato, "meus ingressos" e as políticas. Eles
 * dependem de dado que só o dono tem (telefone oficial, texto jurídico do
 * cancelamento). Um link pra página com número inventado é pior que nenhum.
 */
const { data, pending, error } = await useFetch<any>('/api/eventos-publicos')

/**
 * `selo-*` são as classes que existem em `base.css`; qualquer outro nome
 * renderiza sem cor nenhuma.
 */
const SELO: Record<string, { texto: string; classe: string }> = {
  disponivel: { texto: 'À VENDA', classe: 'selo-ok' },
  ultimas: { texto: 'ÚLTIMAS UNIDADES', classe: 'selo-alerta' },
  em_breve: { texto: 'EM BREVE', classe: 'selo-neutro' },
  esgotado: { texto: 'ESGOTADO', classe: 'selo-erro' },
  encerrado: { texto: 'ENCERRADO', classe: 'selo-neutro' },
}
const selo = (s: string) => SELO[s] ?? SELO.em_breve!

const vende = (s: string) => s === 'disponivel' || s === 'ultimas'

const eventos = computed<any[]>(() => data.value?.eventos ?? [])
/** Onde o comprador cai ao apertar "Comprar": o primeiro evento que ainda vende. */
const destaque = computed(() => eventos.value.find((e) => vende(e.situacao)) ?? null)
const irComprar = computed(() => (destaque.value ? `/e/${destaque.value.slug}` : '/#ingressos'))
const cidade = computed(() => {
  const e = destaque.value ?? eventos.value[0]
  return e?.cidade ? `${e.cidade}${e.estado ? `, ${e.estado}` : ''}` : 'Entre Gandu e Itamari, BA'
})

/**
 * O evento em destaque por dentro: setores, lotes e variações com preço. Uma
 * segunda consulta, e falha sozinha: sem ela a home mostra a lista de eventos e
 * só perde os cartões de preço.
 */
/**
 * Mais de um evento no ar: todos entram no MESMO cartão, lado a lado (dono, 28/09: o destaque
 * detalhado em cima e o resto em linha, embaixo, ficava incoerente). Com um só, a home mostra o
 * painel dele (foto, nome, quando, onde, "a partir de" e o botão de comprar).
 */
const varios = computed(() => eventos.value.length > 1)

const { data: detalhe } = await useAsyncData('home-destaque',
  async () => (destaque.value && !varios.value
    ? await $fetch<any>(`/api/e/${destaque.value.slug}`).catch(() => null)
    : null),
  { watch: [destaque] })

/*
 * Quando começa e quando termina, com hora (dono, 23/09: "é interessante que
 * apareça data de início e data de final"). O fim vem de `/api/e/:slug`, que
 * já devolve `null` quando o produtor marcou "não mostrar o término" — aí a
 * linha do término simplesmente não sai.
 */
const comHora = (v: unknown) => {
  const d = paraData(v as any)
  return d ? `${dataPorExtenso(d)} às ${dataHora(d).slice(-5)}` : null
}
const quandoDestaque = computed(() => ({
  inicio: comHora(detalhe.value?.evento?.inicio ?? destaque.value?.inicio),
  fim: comHora(detalhe.value?.evento?.fim),
}))

/**
 * O painel do evento em destaque (dono, 06/10, com o print da Zig): foto, nome, quando, onde,
 * "a partir de" e um botão. A escolha do ingresso é na página do evento — a home listava o setor
 * ("Geral · 1º lote") com todos os tipos, nome que o dono nunca digitou e linha que quebrava
 * no celular.
 */
const painel = computed(() => {
  const e = destaque.value
  if (!e) return null
  const ev = detalhe.value?.evento
  const local = ev?.local
  const cidadeUf = [local?.cidade ?? e.cidade, local?.estado ?? e.estado].filter(Boolean).join(', ')
  return {
    nome: (ev?.nome ?? e.nome) as string,
    capa: (ev?.banner ?? ev?.thumb ?? e.capa ?? e.miniatura ?? null) as string | null,
    onde: [local?.online ? 'Online' : local?.nome, cidadeUf].filter(Boolean).join(' · '),
    aPartirDeCents: (ev?.aPartirDeCents ?? e.aPartirDeCents ?? null) as number | null,
  }
})

/** A capa entra palavra por palavra; "diversão" ganha o traço amarelo. */
const TITULO = ['Água,', 'sol', 'e', 'diversão', 'em', 'família.']

/**
 * As bolhas da capa: `x` é a posição (%), `t` o tamanho (px), `s` quanto
 * demora a subida (s) e `a` o atraso. Tudo FIXO — sorteio aqui desenharia uma
 * coisa no servidor e outra no navegador. Atraso negativo = já nascem no meio
 * da subida, em vez de todas saírem juntas do chão quando a página abre. Ficam
 * do meio pra direita, em cima da foto; a esquerda é do texto.
 */
const BOLHAS = [
  { x: 40, t: 9, s: 12, a: -2 },
  { x: 47, t: 5, s: 9, a: -6.5 },
  { x: 54, t: 14, s: 15, a: -1 },
  { x: 61, t: 7, s: 11, a: -8 },
  { x: 67, t: 18, s: 17, a: -4.5 },
  { x: 73, t: 6, s: 9.5, a: -0.5 },
  { x: 79, t: 11, s: 13, a: -9.5 },
  { x: 85, t: 8, s: 10.5, a: -3 },
  { x: 90, t: 15, s: 16, a: -7 },
  { x: 95, t: 6, s: 8.5, a: -5 },
]

/**
 * A linha d'água do pé da capa: quatro ondas iguais em 2880 de largura. O
 * desenho tem o dobro da largura da tela e anda metade dela; como as duas
 * metades são iguais, a emenda não aparece. A de trás tem outra fase e corre
 * pro outro lado.
 */
const ONDA_FRENTE = 'M0 44C180 14 540 74 720 44S1260 74 1440 44S1980 74 2160 44S2700 74 2880 44V80H0Z'
const ONDA_FUNDO = 'M0 34C240 60 480 8 720 34S1200 8 1440 34S1920 8 2160 34S2640 8 2880 34V80H0Z'

/**
 * O letreiro: só atração que aparece nas fotos do parque ou que a base
 * confirmada com o dono traz (os 2 restaurantes, o campo de futebol).
 * Tirolesa, piscina de ondas e afins seguem "a confirmar" lá — não entram num
 * anúncio.
 */
const ATRACOES = ['Toboáguas', 'Piscinas', 'Área infantil', 'Lago', 'Deck com guarda-sóis', 'Restaurantes',
  'Campo de futebol']

/**
 * Aparecer ao rolar. Marca-se o elemento com `data-revelar` (o valor é o
 * atraso em ms, pra escalonar cartões vizinhos).
 *
 * A classe `revelar` (escondido) só entra DEPOIS de montar, e só em quem está
 * abaixo da dobra. Quando o elemento chega na tela, `revelar` sai e `revelado`
 * entra — uma animação com `backwards`, que no fim devolve o elemento ao estilo
 * dele. Isso importa: um `transform: none` preso depois da entrada mataria o
 * "levantar ao passar o mouse" dos cartões de preço.
 *
 * As linhas da lista de eventos (`<li>` sem atributo) não levam a marca: o
 * teste da home corta o HTML exatamente em `<li>`. A marca vai na `<ul>`.
 */
let observador: IntersectionObserver | null = null
let montada = false
onMounted(async () => {
  montada = true
  if (typeof IntersectionObserver === 'undefined') return
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  // A dobra só é medida com a fonte da casa carregada: com a fonte reserva o
  // título da capa quebra em mais linhas, a capa cresce, e o que vem logo
  // abaixo — que a pessoa já está vendo — seria dado como "abaixo da dobra" e sumiria.
  await document.fonts?.ready
  if (!montada) return
  observador = new IntersectionObserver((entradas) => {
    for (const e of entradas) {
      if (!e.isIntersecting) continue
      e.target.classList.replace('revelar', 'revelado')
      observador?.unobserve(e.target)
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 })
  for (const el of document.querySelectorAll<HTMLElement>('[data-revelar]')) {
    // Só some quem está INTEIRO abaixo da tela: o que já aparece, nem que seja
    // na beirinha de baixo, fica como veio do servidor.
    if (el.getBoundingClientRect().top < innerHeight) continue
    el.style.setProperty('--atraso', `${Number(el.dataset.revelar) || 0}ms`)
    el.classList.add('revelar')
    observador.observe(el)
  }
})
onBeforeUnmount(() => {
  montada = false
  observador?.disconnect()
})

const FOTOS = [
  { arquivo: 'toboaguas-coloridos-1280', titulo: 'Toboáguas', classe: 'sm:col-span-2 sm:row-span-2' },
  { arquivo: 'area-infantil-800', titulo: 'Área infantil', classe: '' },
  { arquivo: 'piscinas-lago-800', titulo: 'Piscinas e lago', classe: '' },
  { arquivo: 'deck-guarda-sois-800', titulo: 'Deck com guarda-sóis', classe: '' },
  { arquivo: 'vista-geral-800', titulo: 'Vista geral do parque', classe: '' },
]

const DUVIDAS = [
  {
    pergunta: 'Como recebo os ingressos?',
    resposta: 'Assim que o pagamento é confirmado, os ingressos com QR Code aparecem na página do pedido e são enviados para o seu e-mail.',
  },
  {
    pergunta: 'Preciso imprimir?',
    resposta: 'Não. Mostre o QR Code no celular na portaria. Se preferir, a página do pedido também pode ser impressa.',
  },
  {
    pergunta: 'O QR Code vale para quantas entradas?',
    resposta: 'Cada ingresso tem um QR Code único, que vale uma vez: a primeira leitura na portaria libera a entrada e qualquer cópia deixa de valer. Nos combos, o mesmo QR libera o grupo inteiro de uma vez. Não compartilhe o seu.',
  },
  {
    pergunta: 'Tem meia-entrada?',
    resposta: 'Sim, nos ingressos que oferecem a opção, para quem tem direito por lei (como estudantes, idosos e pessoas com deficiência). Leve o documento que comprova: a portaria confere na entrada.',
  },
  {
    pergunta: 'E se o evento for cancelado ou adiado?',
    resposta: 'Se for cancelado, o valor é devolvido. Se for adiado, você escolhe entre a nova data e o reembolso.',
  },
]

useHead({ title: 'Parque aquático entre Gandu e Itamari, Bahia' })
useSeoMeta({
  description: 'Toboáguas, piscinas e área infantil entre Gandu e Itamari, Bahia. Compre o ingresso pelo site e entre com o QR Code.',
})
</script>

<template>
  <div class="home-parque">
    <CabecalhoPublico largura="max-w-6xl">
      <NuxtLink to="/#ingressos"
                class="hidden rounded-lg px-3 py-2 font-semibold text-ink-700 transition-colors hover:bg-ink-100 hover:text-ink-900 sm:inline-flex">
        Ingressos
      </NuxtLink>
      <NuxtLink :to="irComprar" class="btn-cta">Comprar ingressos</NuxtLink>
    </CabecalhoPublico>

    <!-- capa: a foto respira, a luz da piscina passa, bolhas sobem, a água corre no pé -->
    <section class="relative isolate overflow-hidden bg-ink-950 text-white">
      <img src="/photos/vista-geral-1280.webp" alt="" fetchpriority="high"
           srcset="/photos/vista-geral-800.webp 800w, /photos/vista-geral-1280.webp 1280w" sizes="100vw"
           class="capa-foto absolute inset-0 -z-20 h-full w-full object-cover opacity-70">
      <div aria-hidden="true"
           class="absolute inset-0 -z-10 bg-gradient-to-r from-ink-950/90 via-ink-950/60 to-ink-950/10" />
      <div aria-hidden="true"
           class="luz-agua pointer-events-none absolute -inset-[20%] -z-10 animate-drift bg-[radial-gradient(30%_26%_at_72%_36%,rgb(79_198_219/0.5),transparent_70%),radial-gradient(26%_22%_at_86%_70%,rgb(143_212_234/0.38),transparent_70%),radial-gradient(20%_18%_at_60%_14%,rgb(253_185_42/0.2),transparent_70%)] opacity-70 mix-blend-screen" />
      <div aria-hidden="true" class="pointer-events-none absolute inset-0 -z-10">
        <span v-for="(b, i) in BOLHAS" :key="i" class="bolha" :class="i % 2 ? 'hidden sm:block' : ''"
              :style="{ left: `${b.x}%`, width: `${b.t}px`, height: `${b.t}px`, '--tempo': `${b.s}s`, '--atraso': `${b.a}s` }" />
      </div>

      <div class="mx-auto flex min-h-[540px] max-w-6xl flex-col justify-center px-4 pb-28 pt-20 sm:min-h-[620px] sm:px-6 sm:pb-32">
        <p class="entra flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.22em] text-pool-300">
          <svg class="sol-gira size-4 text-sun-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4" fill="currentColor" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
          </svg>
          Parque aquático · {{ cidade }}
        </p>
        <h1 class="titulo mt-4 max-w-3xl text-balance text-[42px] font-semibold leading-[1.04] tracking-[-0.035em] sm:text-[68px]">
          <template v-for="(p, i) in TITULO" :key="p">
            <span class="palavra" :style="{ '--atraso': `${140 + i * 90}ms` }"><span v-if="p === 'diversão'" class="relative text-sun-300">{{ p }}<svg class="sublinha" viewBox="0 0 200 16" preserveAspectRatio="none" aria-hidden="true"><path d="M3 10C40 3 70 14 100 8S160 2 197 9" pathLength="1" /></svg></span><template v-else>{{ p }}</template></span>{{ i !== TITULO.length - 1 ? ' ' : '' }}
          </template>
        </h1>
        <p class="entra mt-5 max-w-xl text-lg leading-8 text-ink-100" style="--atraso: 720ms">
          Compre pelo site, pague com PIX ou cartão e entre com o QR Code no celular.
        </p>
        <div class="entra mt-8 flex flex-wrap items-center gap-3" style="--atraso: 860ms">
          <NuxtLink :to="irComprar" class="btn-cta brilho px-7 py-3.5 text-base">Comprar ingressos</NuxtLink>
          <NuxtLink to="/#ingressos"
                    class="inline-flex items-center gap-2 rounded-xl px-6 py-3.5 text-base font-semibold text-white ring-1 ring-inset ring-white/40 transition-colors hover:bg-white/10">
            Ver preços
            <svg class="seta-desce size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
          </NuxtLink>
        </div>
        <!-- o selo "Ingresso a partir de…" da capa saiu (dono, 28/09): o preço mora nos cartões de ingresso -->
      </div>

      <!-- a linha d'água: duas ondas em velocidades e sentidos diferentes -->
      <div aria-hidden="true" class="pointer-events-none absolute inset-x-0 -bottom-px h-14 text-white sm:h-20">
        <svg class="mar mar-fundo text-pool-300" viewBox="0 0 2880 80" preserveAspectRatio="none"><path :d="ONDA_FUNDO" /></svg>
        <svg class="mar mar-frente" viewBox="0 0 2880 80" preserveAspectRatio="none"><path :d="ONDA_FRENTE" /></svg>
      </div>
    </section>

    <!-- letreiro: as atrações correndo. Decorativo — repete o que a galeria
         mostra logo abaixo —, por isso fora da leitura de tela. -->
    <div class="letreiro overflow-hidden bg-sun-400 py-4 text-ink-950" aria-hidden="true">
      <div class="letreiro-trilho flex w-max">
        <template v-for="volta in 4" :key="volta">
          <span v-for="a in ATRACOES" :key="`${volta}-${a}`"
                class="titulo flex shrink-0 items-center gap-6 pr-6 text-lg font-semibold uppercase tracking-[0.08em] sm:text-xl">
            {{ a }}
            <svg class="size-5 text-grape-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round">
              <circle cx="12" cy="12" r="4" fill="currentColor" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          </span>
        </template>
      </div>
    </div>

    <!-- o vídeo de destaque (dono, 05/10) -->
    <VideoDoParque :ir-comprar="irComprar" />

    <!-- o parque -->
    <section aria-labelledby="o-parque" class="bg-canvas">
      <div class="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <div data-revelar>
          <h2 id="o-parque" class="titulo text-3xl font-semibold tracking-[-0.02em] text-ink-950 sm:text-4xl">
            O parque
          </h2>
          <p class="mt-3 max-w-2xl text-base leading-7 text-ink-600">
            Toboáguas, piscinas, área infantil e espaço para descansar à sombra.
          </p>
        </div>
        <div class="mt-8 grid auto-rows-[180px] gap-3 sm:grid-cols-4 sm:auto-rows-[190px]">
          <figure v-for="(f, i) in FOTOS" :key="f.arquivo" :data-revelar="i * 90"
                  class="group relative overflow-hidden rounded-3xl bg-ink-200" :class="f.classe">
            <img :src="`/photos/${f.arquivo}.webp`" :alt="f.titulo" loading="lazy"
                 class="h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.07]">
            <figcaption class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950/80 to-transparent px-4 pb-3 pt-10 text-sm font-semibold text-white transition-[padding] duration-300 group-hover:pb-4">
              {{ f.titulo }}
            </figcaption>
          </figure>
        </div>
      </div>
    </section>

    <!-- ingressos e preços -->
    <section id="ingressos" aria-labelledby="precos" class="relative scroll-mt-16 overflow-hidden bg-white">
      <OndasMarca class="ondas-lentas absolute inset-x-0 bottom-0 h-40 w-full text-pool-100" />
      <div class="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <div data-revelar class="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="precos" class="titulo text-3xl font-semibold tracking-[-0.02em] text-ink-950 sm:text-4xl">
              Ingressos e preços
            </h2>
            <!-- B31: a descrição que o produtor escreveu em parágrafos sai em parágrafos -->
            <p class="mt-3 max-w-2xl whitespace-pre-line text-base leading-7 text-ink-600">{{ (!varios && detalhe?.evento?.descricao)
                || 'Escolha seus ingressos e pague em poucos minutos.' }}</p>
          </div>
          <!-- sem "Escolher ingressos" aqui (dono, 23/09): a compra sai do
               "Comprar" de cada cartão logo abaixo -->
        </div>

        <p v-if="pending" class="mt-8 text-ink-600">Carregando os eventos…</p>

        <!-- Não deu pra perguntar ≠ a resposta foi "nenhum". Quem lê isto tem que
             sair sabendo que o problema é aqui, não que o evento dele acabou. -->
        <p v-else-if="error" class="faixa-erro mt-8">
          Não deu pra carregar a lista de eventos agora. Atualize a página em alguns
          instantes — os eventos continuam lá, quem não respondeu foi a nossa
          bilheteria.
        </p>

        <template v-else>
          <!-- o evento em destaque: quando e onde, e os ingressos com preço. O nome
               e o selo "À VENDA" saíram (dono, 23/09) — o nome é o que o produtor
               digitou no painel, e na vitrine só atrapalhava. -->
          <!-- o evento em destaque, no desenho da Zig (dono, 06/10): foto, nome, quando, onde, "a partir
               de" e o botão. Os tipos de ingresso são escolhidos na página do evento. -->
          <article v-if="destaque && !varios && painel" data-parte="painel-do-evento" data-revelar
                   class="mt-8 grid gap-6 rounded-3xl bg-white p-4 shadow-card ring-1 ring-ink-200/70 sm:p-6 md:grid-cols-[minmax(0,22rem)_1fr] md:gap-10">
            <NuxtLink :to="irComprar" class="block overflow-hidden rounded-2xl bg-pool-400" tabindex="-1" aria-hidden="true">
              <img v-if="painel.capa" :src="painel.capa" alt="" width="1080" height="1080"
                   class="aspect-square h-full w-full object-cover">
              <span v-else class="flex aspect-square items-center justify-center p-10"><LogoMarca clara /></span>
            </NuxtLink>

            <div class="flex min-w-0 flex-col">
              <h3 class="titulo text-3xl font-bold uppercase leading-[1.05] tracking-[-0.01em] text-ink-950 sm:text-4xl lg:text-5xl">
                {{ painel.nome }}
              </h3>

              <ul class="mt-6 grid gap-3 text-[15px] text-ink-700 sm:text-base">
                <li v-if="quandoDestaque.inicio" class="flex items-start gap-3">
                  <svg class="mt-0.5 size-5 shrink-0 text-pool-700" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
                  </svg>
                  <span><span class="sr-only">Quando: </span>{{ quandoDestaque.inicio }}<template v-if="quandoDestaque.fim">
                    <span class="mx-1.5 text-ink-400" aria-hidden="true">›</span><span class="sr-only"> até </span>{{ quandoDestaque.fim }}</template></span>
                </li>
                <li v-if="painel.onde" class="flex items-start gap-3">
                  <svg class="mt-0.5 size-5 shrink-0 text-pool-700" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" />
                  </svg>
                  <span><span class="sr-only">Onde: </span>{{ painel.onde }}</span>
                </li>
              </ul>

              <div class="mt-8 md:mt-auto md:pt-8">
                <p v-if="painel.aPartirDeCents === 0" class="titulo text-3xl font-bold text-ok">Grátis</p>
                <p v-else-if="painel.aPartirDeCents != null" class="titulo text-2xl font-bold text-ink-950 sm:text-3xl">
                  A partir de <span class="tabular-nums">{{ reais(painel.aPartirDeCents) }}</span>
                </p>
                <NuxtLink v-if="vende(destaque.situacao)" :to="irComprar"
                          class="btn-cta mt-4 w-full justify-center px-8 py-4 text-base font-bold uppercase tracking-wide sm:w-auto sm:min-w-[20rem]">
                  {{ painel.aPartirDeCents === 0 ? 'Pegar ingresso' : 'Comprar ingresso' }}
                </NuxtLink>
                <span v-else class="mt-4 inline-block" :class="selo(destaque.situacao).classe">{{ selo(destaque.situacao).texto }}</span>
              </div>
            </div>
          </article>

          <!-- mais de um evento: todos no mesmo cartão (o mesmo desenho dos cartões de ingresso).
               O `<li>` sai sem atributo de propósito: `eventos-publicos.test.ts` fatia o HTML nele. -->
          <ul v-if="varios" class="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-parte="eventos-da-home">
            <li v-for="e in eventos" :key="e.slug">
              <NuxtLink :to="`/e/${e.slug}`" data-revelar
                        class="group flex h-full flex-col rounded-3xl bg-white p-6 shadow-card ring-1 ring-ink-200/70 transition duration-300 hover:-translate-y-1.5 hover:shadow-pop hover:ring-pool-300">
                <!-- a foto do evento (dono, 06/10); sem foto, a marca no azul da piscina -->
                <span class="-mx-2 -mt-2 mb-4 block overflow-hidden rounded-2xl bg-pool-400">
                  <img v-if="e.miniatura" :src="e.miniatura" alt="" width="480" height="480" loading="lazy"
                       class="aspect-square w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]">
                  <span v-else class="flex aspect-square items-center justify-center p-10"><LogoMarca clara /></span>
                </span>
                <span class="flex items-start justify-between gap-3">
                  <h3 class="titulo text-lg font-semibold leading-snug text-ink-900">{{ e.nome }}</h3>
                  <span class="shrink-0"><span :class="selo(e.situacao).classe">{{ selo(e.situacao).texto }}</span></span>
                </span>
                <!-- O separador só existe quando há os dois lados: evento sem
                     cidade cadastrada renderizava "· 21/09/2026", com o ponto
                     solto na frente da data. -->
                <span class="block text-sm text-tinta-suave">{{ [e.cidade, dataCurta(e.inicio)].filter(Boolean).join(' · ') }}</span>
                <!-- Preço só quando existe lote comprável: anunciar o valor de
                     um lote que não vende é a isca que o comprador descobre na
                     página seguinte. Grátis diz "Grátis", nunca zero em reais. -->
                <span v-if="e.aPartirDeCents === 0" class="mt-4 block">
                  <strong class="titulo text-xl font-semibold text-ok">Grátis</strong>
                </span>
                <span v-else-if="e.aPartirDeCents != null" class="mt-4 block text-[15px] text-ink-700">
                  a partir de <strong class="titulo text-xl font-semibold tabular-nums text-ink-950">{{ reais(e.aPartirDeCents) }}</strong>
                </span>
                <span v-if="vende(e.situacao)" class="mt-auto inline-flex items-center gap-1 pt-5 text-sm font-semibold text-pool-700 group-hover:text-pool-800">
                  {{ e.aPartirDeCents === 0 ? 'Pegar ingresso' : 'Comprar' }}
                  <svg class="size-4 transition-transform duration-300 group-hover:translate-x-1" viewBox="0 0 24 24"
                       fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                       stroke-linejoin="round" aria-hidden="true">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </span>
              </NuxtLink>
            </li>
          </ul>
        </template>

        <!-- `!error` é a trava: sem ele esta frase volta a ser o que a tela diz
             quando a rota cai, e ela AFIRMA que o catálogo está vazio. A guarda
             fica na PRÓPRIA frase (e não só no v-else de cima) pra sobreviver a
             quem mover o bloco de lugar — `eventos-publicos.test.ts` lê esta
             linha na fonte. -->
        <p v-if="!pending && !error && !data?.eventos?.length"
           class="mt-8 rounded-3xl bg-canvas px-6 py-8 text-center text-ink-600">
          Nenhum evento à venda no momento. Volte em breve.
        </p>
      </div>
    </section>

    <!-- dúvidas -->
    <section aria-labelledby="duvidas" class="bg-canvas">
      <div class="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-[1fr_1.4fr]">
        <div data-revelar>
          <h2 id="duvidas" class="titulo text-3xl font-semibold tracking-[-0.02em] text-ink-950 sm:text-4xl">
            Dúvidas frequentes
          </h2>
          <p class="mt-3 text-base leading-7 text-ink-600">
            O passo a passo da compra e da entrada, em poucas linhas.
          </p>
        </div>
        <div class="grid gap-3">
          <details v-for="(d, k) in DUVIDAS" :key="d.pergunta" :data-revelar="k * 70"
                   class="group rounded-2xl bg-white px-5 py-4 ring-1 ring-inset ring-ink-200/70 transition duration-300 hover:ring-pool-200 open:shadow-card open:ring-pool-300">
            <summary class="flex cursor-pointer list-none items-center justify-between gap-3 font-semibold text-ink-900">
              {{ d.pergunta }}
              <svg class="size-4 shrink-0 text-ink-400 transition-transform duration-300 group-open:rotate-90" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                   aria-hidden="true">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </summary>
            <p class="resposta mt-2 text-[15px] leading-7 text-ink-600">{{ d.resposta }}</p>
          </details>
        </div>
      </div>
    </section>

    <!-- chamada final: o sol girando devagar atrás -->
    <section class="relative isolate overflow-hidden bg-grape-700 text-white">
      <div aria-hidden="true" class="raios" />
      <OndasMarca class="ondas-lentas absolute inset-x-0 bottom-0 -z-10 h-32 w-full text-white/[0.08]" />
      <div class="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-16 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div data-revelar>
          <h2 class="titulo text-3xl font-semibold tracking-[-0.02em]">Garanta a sua vaga</h2>
          <p class="mt-2 max-w-xl text-grape-100">
            Vagas limitadas. Compre com antecedência e entre com o QR Code no celular.
          </p>
        </div>
        <NuxtLink :to="irComprar" class="btn-cta brilho px-7 py-3.5 text-base">Comprar ingressos</NuxtLink>
      </div>
    </section>

    <RodapePublico :cidade="cidade" />
  </div>
</template>

<!--
  SEM `scoped`, de propósito. O `scoped` carimba `data-v-…` em TODO elemento da
  página, e as linhas de evento deixariam de sair como `<li>` puro — é nesse
  corte exato que `eventos-publicos.test.ts` lê a home. Em troca, tudo aqui
  mora debaixo de `.home-parque` (a raiz desta página) e toda animação tem
  prefixo `home-`: o CSS de página fica no documento depois que a pessoa
  navega pra outra tela, e um `@keyframes girar` de lá trocaria o daqui.
-->
<style>
/* ---------- a capa ---------- */

/* a foto surge e depois "respira": aproxima e afasta devagar, sem parar */
.home-parque .capa-foto {
  transform-origin: 65% 40%;
  animation: home-surgir 1.6s ease-out both, home-respirar 26s ease-in-out 1.6s infinite alternate;
  will-change: transform;
}
@keyframes home-surgir {
  from { opacity: 0; transform: scale(1.12); }
  to { transform: scale(1.03); }
}
@keyframes home-respirar {
  from { transform: scale(1.03); }
  to { transform: scale(1.12) translate3d(-1.5%, -1%, 0); }
}

/* o texto da capa entra subindo e saindo do desfoque, em escada (`--atraso`) */
.home-parque .entra,
.home-parque .palavra {
  animation: home-entrar 0.9s cubic-bezier(0.2, 0.7, 0.2, 1) var(--atraso, 0ms) both;
}
.home-parque .palavra { display: inline-block; }
@keyframes home-entrar {
  from { opacity: 0; transform: translate3d(0, 26px, 0); filter: blur(8px); }
  to { opacity: 1; transform: none; filter: none; }
}

/* o traço amarelo embaixo de "diversão", desenhado depois que o título assenta */
.home-parque .sublinha {
  position: absolute;
  left: 0;
  bottom: -0.16em;
  width: 100%;
  height: 0.34em;
  overflow: visible;
}
.home-parque .sublinha path {
  fill: none;
  stroke: currentColor;
  stroke-width: 4;
  stroke-linecap: round;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: home-sublinhar 1.1s cubic-bezier(0.6, 0, 0.2, 1) 1.1s forwards;
}
@keyframes home-sublinhar {
  to { stroke-dashoffset: 0; }
}

.home-parque .sol-gira { animation: home-girar 14s linear infinite; }
.home-parque .seta-desce { animation: home-quicar 1.8s ease-in-out infinite; }
@keyframes home-quicar {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(3px); }
}

/* bolhas: brilho no canto, borda de vidro, sobem balançando e somem */
.home-parque .bolha {
  position: absolute;
  bottom: -24px;
  border-radius: 9999px;
  background: radial-gradient(circle at 32% 30%, rgb(255 255 255 / 0.85), rgb(255 255 255 / 0.12) 42%,
    rgb(143 212 234 / 0.14) 70%, rgb(255 255 255 / 0.3) 100%);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.35);
  opacity: 0;
  animation: home-bolha var(--tempo, 12s) linear var(--atraso, 0s) infinite;
  will-change: transform, opacity;
}
@keyframes home-bolha {
  0% { transform: translate3d(0, 0, 0) scale(0.5); opacity: 0; }
  12% { opacity: 0.85; }
  50% { transform: translate3d(14px, -300px, 0) scale(0.95); }
  85% { opacity: 0.55; }
  100% { transform: translate3d(-10px, -640px, 0) scale(1.05); opacity: 0; }
}

/* a linha d'água: o desenho tem 200% e anda 50% — as metades são iguais */
.home-parque .mar {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 200%;
  height: 100%;
  fill: currentColor;
  will-change: transform;
}
.home-parque .mar-fundo { opacity: 0.45; animation: home-mar 19s linear infinite; }
.home-parque .mar-frente { animation: home-mar 12s linear infinite reverse; }
@keyframes home-mar {
  from { transform: translate3d(0, 0, 0); }
  to { transform: translate3d(-50%, 0, 0); }
}

/* ---------- o resto da página ---------- */

/* aparecer ao rolar (ver `data-revelar` no script) */
.home-parque .revelar { opacity: 0; }
.home-parque .revelado {
  animation: home-aparecer 0.8s cubic-bezier(0.2, 0.7, 0.2, 1) var(--atraso, 0ms) backwards;
}
@keyframes home-aparecer {
  from { opacity: 0; transform: translate3d(0, 24px, 0); }
}

/* o letreiro corre sem emenda (4 voltas iguais, anda metade) e para no mouse */
.home-parque .letreiro-trilho { animation: home-letreiro 36s linear infinite; }
.home-parque .letreiro:hover .letreiro-trilho { animation-play-state: paused; }
@keyframes home-letreiro {
  from { transform: translate3d(0, 0, 0); }
  to { transform: translate3d(-50%, 0, 0); }
}

/* as linhas d'água do fundo balançam devagar */
.home-parque .ondas-lentas { animation: home-balanco 9s ease-in-out infinite alternate; }
@keyframes home-balanco {
  from { transform: translate3d(-2%, 0, 0) scaleX(1.05); }
  to { transform: translate3d(2%, 0, 0) scaleX(1.05); }
}

/* o ponto que pulsa dentro do selo do evento que está vendendo */
.home-parque .ao-vivo > span::before {
  content: '';
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 9999px;
  background: currentColor;
  animation: home-pulsar 1.8s ease-out infinite;
}
@keyframes home-pulsar {
  from { box-shadow: 0 0 0 0 currentColor; }
  to { box-shadow: 0 0 0 6px transparent; }
}

/* a resposta da dúvida desliza ao abrir */
.home-parque details[open] .resposta {
  animation: home-aparecer 0.35s cubic-bezier(0.2, 0.7, 0.2, 1) both;
}

/* o sol da chamada final: raios girando atrás do texto */
.home-parque .raios {
  position: absolute;
  z-index: -1;
  top: 50%;
  right: -220px;
  width: 720px;
  height: 720px;
  margin-top: -360px;
  border-radius: 9999px;
  background: repeating-conic-gradient(rgb(253 185 42 / 0.55) 0deg 6deg, transparent 6deg 20deg);
  -webkit-mask-image: radial-gradient(circle, #000 12%, transparent 66%);
  mask-image: radial-gradient(circle, #000 12%, transparent 66%);
  opacity: 0.35;
  animation: home-girar 70s linear infinite;
}
@keyframes home-girar {
  to { transform: rotate(360deg); }
}

/* o brilho que atravessa o botão de comprar de tempos em tempos */
.home-parque .brilho {
  position: relative;
  overflow: hidden;
  isolation: isolate;
}
.home-parque .brilho::after {
  content: '';
  position: absolute;
  inset: -2px;
  background: linear-gradient(105deg, transparent 35%, rgb(255 255 255 / 0.6) 50%, transparent 65%);
  transform: translate3d(-120%, 0, 0);
  animation: home-brilho 4.2s ease-in-out 1.6s infinite;
  pointer-events: none;
}
@keyframes home-brilho {
  0%, 55% { transform: translate3d(-120%, 0, 0); }
  85%, 100% { transform: translate3d(120%, 0, 0); }
}

/* ---------- quem pede menos movimento ---------- */
@media (prefers-reduced-motion: reduce) {
  .home-parque .capa-foto, .home-parque .entra, .home-parque .palavra, .home-parque .sol-gira,
  .home-parque .seta-desce, .home-parque .mar, .home-parque .luz-agua, .home-parque .letreiro-trilho,
  .home-parque .ondas-lentas, .home-parque .raios, .home-parque .revelado, .home-parque .brilho::after,
  .home-parque .ao-vivo > span::before,
  .home-parque details[open] .resposta {
    animation: none !important;
  }
  .home-parque .sublinha path { animation: none; stroke-dashoffset: 0; }
  .home-parque .bolha { display: none !important; }
}

/* papel não rola: o que esperava a tela chegar sai no papel de uma vez — e SEM transição nem
   animação. O cartão de preço e a dúvida têm `transition` (a opacidade entra nela), e a página vai
   pro papel no instante em que a mídia vira "print": com a transição correndo, eles saíam ainda
   em 0 (medido no E2E da matriz 13: 9 blocos invisíveis logo depois de virar a mídia). */
@media print {
  .home-parque .revelar, .home-parque .revelado {
    opacity: 1 !important;
    transition: none !important;
    animation: none !important;
  }
}
</style>
