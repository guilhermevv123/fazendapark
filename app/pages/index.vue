<script setup lang="ts">
/**
 * A home do site de vendas — o que o comprador vê primeiro.
 *
 * O desenho é o do site do parque (repositório `sistemapark`, `(site)/page.tsx`):
 * capa com foto, "como comprar", galeria, ingressos e preços, dúvidas e uma
 * chamada final. Os DADOS são os de cá. O parque vende por EDIÇÃO (evento com
 * data), não por calendário diário; então onde o site novo listava "próximas
 * datas abertas" esta home lista os eventos, e onde ele mostrava o preço do dia
 * ela mostra os ingressos do evento em destaque — com o preço que o comprador
 * de fato paga (`totalCents`, taxa inclusa), o mesmo que a vitrine cobra.
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
const aPartirDe = computed(() => {
  const v = eventos.value.filter((e) => vende(e.situacao) && e.aPartirDeCents != null)
    .map((e) => e.aPartirDeCents as number)
  return v.length ? Math.min(...v) : null
})
const cidade = computed(() => {
  const e = destaque.value ?? eventos.value[0]
  return e?.cidade ? `${e.cidade}${e.estado ? `, ${e.estado}` : ''}` : 'Ubatã, BA'
})

/**
 * O evento em destaque por dentro: setores, lotes e variações com preço. Uma
 * segunda consulta, e falha sozinha: sem ela a home mostra a lista de eventos e
 * só perde os cartões de preço.
 */
const { data: detalhe } = await useAsyncData('home-destaque',
  async () => (destaque.value
    ? await $fetch<any>(`/api/e/${destaque.value.slug}`).catch(() => null)
    : null),
  { watch: [destaque] })

/** Um cartão por setor, com o lote que ainda vende (ou o primeiro, se nenhum vende). */
const ingressos = computed(() => (detalhe.value?.setores ?? [])
  .map((s: any) => {
    const lotes: any[] = s.lotes ?? []
    const lote = lotes.find((l) => vende(l.situacao)) ?? lotes[0]
    if (!lote) return null
    return {
      id: s.id as string,
      nome: s.nome as string,
      sessao: s.sessao as { titulo: string; inicio: string } | null,
      // "ENTRADA" dentro de "ENTRADA INDIVIDUAL SÁBADO" é ruído; "COMBO 10
      // PESSOAS" dentro de "COMBO SÁBADO" é informação.
      lote: s.nome.toLowerCase().includes(String(lote.nome).toLowerCase()) ? '' : lote.nome as string,
      situacao: lote.situacao as string,
      variacoes: (lote.variacoes ?? []) as { tipoId: string; nome: string; totalCents: number; esgotado: boolean }[],
    }
  })
  .filter(Boolean) as {
    id: string; nome: string; sessao: { titulo: string; inicio: string } | null; lote: string
    situacao: string; variacoes: { tipoId: string; nome: string; totalCents: number; esgotado: boolean }[]
  }[])

const PASSOS = [
  {
    titulo: 'Escolha o evento e os ingressos',
    texto: 'Veja as datas, os setores e os preços. Os ingressos ficam reservados enquanto você preenche os dados.',
  },
  {
    titulo: 'Pague com PIX ou cartão',
    texto: 'O pagamento é confirmado em instantes, sem precisar enviar comprovante.',
  },
  {
    titulo: 'Entre com o QR Code',
    texto: 'Os ingressos aparecem na hora e chegam por e-mail. Na portaria, basta mostrar o QR Code no celular.',
  },
]

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

useHead({ title: 'Parque aquático em Ubatã, Bahia' })
useSeoMeta({
  description: 'Toboáguas, piscinas e área infantil em Ubatã, Bahia. Compre o ingresso pelo site e entre com o QR Code.',
})
</script>

<template>
  <div>
    <CabecalhoPublico largura="max-w-6xl">
      <NuxtLink to="/#ingressos"
                class="hidden rounded-lg px-3 py-2 font-semibold text-ink-700 transition-colors hover:bg-ink-100 hover:text-ink-900 sm:inline-flex">
        Ingressos
      </NuxtLink>
      <NuxtLink :to="irComprar" class="btn-cta">Comprar ingressos</NuxtLink>
    </CabecalhoPublico>

    <!-- capa -->
    <section class="relative isolate overflow-hidden bg-ink-950 text-white">
      <img src="/photos/vista-geral-1280.webp" alt="" fetchpriority="high"
           class="absolute inset-0 -z-20 h-full w-full object-cover opacity-70">
      <div aria-hidden="true"
           class="absolute inset-0 -z-10 bg-gradient-to-r from-ink-950/90 via-ink-950/60 to-ink-950/10" />
      <div class="mx-auto flex min-h-[520px] max-w-6xl flex-col justify-center px-4 py-20 sm:min-h-[600px] sm:px-6">
        <p class="text-[13px] font-semibold uppercase tracking-[0.22em] text-pool-300">
          Parque aquático · {{ cidade }}
        </p>
        <h1 class="titulo mt-4 max-w-3xl text-[42px] font-semibold leading-[1.02] tracking-[-0.035em] sm:text-[68px]">
          Água, sol e diversão em família.
        </h1>
        <p class="mt-5 max-w-xl text-lg leading-8 text-ink-100">
          Compre pelo site, pague com PIX ou cartão e entre com o QR Code no celular.
        </p>
        <div class="mt-8 flex flex-wrap items-center gap-3">
          <NuxtLink :to="irComprar" class="btn-cta px-7 py-3.5 text-base">Comprar ingressos</NuxtLink>
          <NuxtLink to="/#ingressos"
                    class="inline-flex items-center rounded-xl px-6 py-3.5 text-base font-semibold text-white ring-1 ring-inset ring-white/40 transition-colors hover:bg-white/10">
            Ver preços
          </NuxtLink>
        </div>
        <p v-if="aPartirDe !== null" class="mt-6 text-sm text-ink-200">
          Ingresso a partir de <span class="font-semibold text-white">{{ reais(aPartirDe) }}</span>
        </p>
      </div>
    </section>

    <!-- como comprar -->
    <section aria-labelledby="como-funciona" class="bg-white">
      <div class="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <h2 id="como-funciona" class="titulo text-3xl font-semibold tracking-[-0.02em] text-ink-950 sm:text-4xl">
          Como comprar
        </h2>
        <ol class="mt-8 grid gap-4 md:grid-cols-3">
          <li v-for="(passo, i) in PASSOS" :key="passo.titulo"
              class="rounded-3xl bg-canvas p-6 ring-1 ring-inset ring-ink-200/60">
            <div class="flex items-center gap-3">
              <span class="grid size-10 place-items-center rounded-2xl bg-pool-700 text-white">
                <svg v-if="i === 0" class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M8 2v4M16 2v4" /><rect width="18" height="18" x="3" y="4" rx="2" />
                  <path d="M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" />
                </svg>
                <svg v-else-if="i === 1" class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
                <svg v-else class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect width="5" height="5" x="3" y="3" rx="1" /><rect width="5" height="5" x="16" y="3" rx="1" />
                  <rect width="5" height="5" x="3" y="16" rx="1" />
                  <path d="M21 16h-3a2 2 0 0 0-2 2v3M21 21v.01M12 7v3a2 2 0 0 1-2 2H7M3 12h.01M12 3h.01M12 16v.01M16 12h1M21 12v.01M12 21v-1" />
                </svg>
              </span>
              <span class="text-sm font-semibold text-pool-700">Passo {{ i + 1 }}</span>
            </div>
            <h3 class="titulo mt-4 text-lg font-semibold text-ink-900">{{ passo.titulo }}</h3>
            <p class="mt-2 text-[15px] leading-7 text-ink-600">{{ passo.texto }}</p>
          </li>
        </ol>
      </div>
    </section>

    <!-- o parque -->
    <section aria-labelledby="o-parque" class="bg-canvas">
      <div class="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <h2 id="o-parque" class="titulo text-3xl font-semibold tracking-[-0.02em] text-ink-950 sm:text-4xl">
          O parque
        </h2>
        <p class="mt-3 max-w-2xl text-base leading-7 text-ink-600">
          Toboáguas, piscinas, área infantil e espaço para descansar à sombra.
        </p>
        <div class="mt-8 grid auto-rows-[180px] gap-3 sm:grid-cols-4 sm:auto-rows-[190px]">
          <figure v-for="f in FOTOS" :key="f.arquivo"
                  class="group relative overflow-hidden rounded-3xl bg-ink-200" :class="f.classe">
            <img :src="`/photos/${f.arquivo}.webp`" :alt="f.titulo" loading="lazy"
                 class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]">
            <figcaption class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950/80 to-transparent px-4 pb-3 pt-10 text-sm font-semibold text-white">
              {{ f.titulo }}
            </figcaption>
          </figure>
        </div>
      </div>
    </section>

    <!-- ingressos e preços -->
    <section id="ingressos" aria-labelledby="precos" class="relative scroll-mt-16 overflow-hidden bg-white">
      <OndasMarca class="absolute inset-x-0 bottom-0 h-40 w-full text-pool-100" />
      <div class="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <div class="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="precos" class="titulo text-3xl font-semibold tracking-[-0.02em] text-ink-950 sm:text-4xl">
              Ingressos e preços
            </h2>
            <p class="mt-3 max-w-2xl text-base leading-7 text-ink-600">
              {{ detalhe?.evento?.descricao
                || 'Escolha o evento, os ingressos e pague em poucos minutos. O valor exibido já inclui a taxa de serviço.' }}
            </p>
          </div>
          <NuxtLink v-if="destaque" :to="irComprar" class="btn-cta px-7 py-3.5 text-base">
            Escolher ingressos
          </NuxtLink>
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
          <!-- o evento em destaque: o nome, quando e onde, e os ingressos com preço -->
          <div v-if="destaque" class="mt-8">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h3 class="titulo text-xl font-semibold text-ink-900">{{ destaque.nome }}</h3>
              <span :class="selo(destaque.situacao).classe">{{ selo(destaque.situacao).texto }}</span>
            </div>
            <p class="mt-1 text-sm text-ink-600">
              {{ [destaque.cidade, dataPorExtenso(destaque.inicio)].filter(Boolean).join(' · ') }}
            </p>

            <ul v-if="ingressos.length" class="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <li v-for="i in ingressos" :key="i.id"
                  class="flex flex-col rounded-3xl bg-white p-6 shadow-card ring-1 ring-ink-200/70">
                <p v-if="i.sessao" class="text-xs font-semibold uppercase tracking-wide text-pool-700">
                  {{ i.sessao.titulo }} · {{ diaMes(i.sessao.inicio) }}
                </p>
                <h4 class="titulo mt-1 text-lg font-semibold leading-snug text-ink-900">{{ i.nome }}</h4>
                <p v-if="i.lote" class="mt-1 text-sm text-ink-600">{{ i.lote }}</p>
                <ul class="mt-4 grid gap-1.5">
                  <li v-for="v in i.variacoes" :key="v.tipoId" class="flex items-baseline justify-between gap-3 text-[15px]">
                    <!-- Combo não tem "Inteira/Meia": o valor é o do grupo todo. -->
                    <span class="text-ink-700">{{ v.nome || 'Valor do combo' }}</span>
                    <span class="titulo font-semibold tabular-nums text-ink-950"
                          :class="v.esgotado ? 'text-ink-400 line-through' : ''">{{ reais(v.totalCents) }}</span>
                  </li>
                </ul>
                <div class="mt-auto pt-5">
                  <span v-if="!vende(i.situacao)" :class="selo(i.situacao).classe">{{ selo(i.situacao).texto }}</span>
                  <NuxtLink v-else :to="irComprar"
                            class="inline-flex items-center gap-1 text-sm font-semibold text-pool-700 hover:text-pool-800">
                    Comprar
                    <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </NuxtLink>
                </div>
              </li>
            </ul>
          </div>

          <!-- os demais eventos, sem rodeio: uma linha cada -->
          <ul v-if="eventos.filter((e) => e !== destaque).length" class="mt-8 space-y-3">
            <li v-for="e in eventos.filter((x) => x !== destaque)" :key="e.slug">
              <NuxtLink :to="`/e/${e.slug}`"
                        class="card flex items-center justify-between gap-4 p-5 transition-colors hover:bg-fundo-cinza">
                <span class="min-w-0">
                  <span class="titulo block truncate text-lg font-semibold text-tinta">{{ e.nome }}</span>
                  <!-- O separador só existe quando há os dois lados: evento sem
                       cidade cadastrada renderizava "· 21/09/2026", com o ponto
                       solto na frente da data. -->
                  <span class="block text-sm text-tinta-suave">
                    {{ [e.cidade, dataCurta(e.inicio)].filter(Boolean).join(' · ') }}
                  </span>
                </span>
                <span class="shrink-0 text-right">
                  <span :class="selo(e.situacao).classe">{{ selo(e.situacao).texto }}</span>
                  <!-- Preço só quando existe lote comprável: anunciar o valor de
                       um lote que não vende é a isca que o comprador descobre na
                       página seguinte. -->
                  <span v-if="e.aPartirDeCents != null" class="mt-1 block text-sm text-tinta-suave">
                    a partir de
                    <strong class="font-semibold tabular-nums text-tinta">{{ reais(e.aPartirDeCents) }}</strong>
                  </span>
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
        <div>
          <h2 id="duvidas" class="titulo text-3xl font-semibold tracking-[-0.02em] text-ink-950 sm:text-4xl">
            Dúvidas frequentes
          </h2>
          <p class="mt-3 text-base leading-7 text-ink-600">
            O passo a passo da compra e da entrada, em poucas linhas.
          </p>
        </div>
        <div class="grid gap-3">
          <details v-for="d in DUVIDAS" :key="d.pergunta"
                   class="group rounded-2xl bg-white px-5 py-4 ring-1 ring-inset ring-ink-200/70">
            <summary class="flex cursor-pointer list-none items-center justify-between gap-3 font-semibold text-ink-900">
              {{ d.pergunta }}
              <svg class="size-4 shrink-0 text-ink-400 transition-transform group-open:rotate-90" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                   aria-hidden="true">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </summary>
            <p class="mt-2 text-[15px] leading-7 text-ink-600">{{ d.resposta }}</p>
          </details>
        </div>
      </div>
    </section>

    <!-- chamada final -->
    <section class="bg-grape-700 text-white">
      <div class="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 class="titulo text-3xl font-semibold tracking-[-0.02em]">Garanta a sua vaga</h2>
          <p class="mt-2 max-w-xl text-grape-100">
            Vagas limitadas. Compre com antecedência e entre com o QR Code no celular.
          </p>
        </div>
        <NuxtLink :to="irComprar" class="btn-cta px-7 py-3.5 text-base">Comprar ingressos</NuxtLink>
      </div>
    </section>

    <RodapePublico :cidade="cidade" />
  </div>
</template>
