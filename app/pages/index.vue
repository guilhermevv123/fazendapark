<script setup lang="ts">
/**
 * A home — a vitrine de todos os eventos.
 *
 * Duas coisas que esta tela errava, e nenhuma das duas lançava erro:
 *
 * 1. **Ela só sabia dizer preço.** Evento sem lote comprável aparecia com o
 *    espaço do preço em branco — nem "em breve", nem "esgotado", nem
 *    "encerrado". Quem entrava não descobria se o evento tinha acabado ou se
 *    ainda ia abrir; descobria clicando. Agora cada linha carrega a palavra
 *    que a página do evento usa pro mesmo fato, e ela vem pronta do servidor
 *    (`situacao`): a tela NÃO deduz estado de preço nulo — deduzir é como as
 *    duas telas voltam a discordar.
 *
 * 2. **Metade das classes não existia.** `rounded-bilhete`, `bg-papel`,
 *    `hover:bg-papel-fundo` e `.serial` não estão em `tailwind.config.js` nem
 *    em `app/assets/base.css`. O Tailwind não avisa: ele simplesmente não gera
 *    a regra, e a linha renderizava sem fundo, sem hover e com o raio errado.
 *    Aqui só entra classe que existe — medido com `getComputedStyle` depois de
 *    escrita, que é o único jeito de saber.
 *
 * 3. **Bilheteria quebrada aparecia como bilheteria vazia.** MEDIDO: com
 *    `/api/eventos-publicos` respondendo HTTP 500, a home renderizava
 *    "Nenhum evento à venda no momento." e mais nada — sem aviso, sem erro no
 *    console do comprador, sem teste vermelho. A frase é uma AFIRMAÇÃO sobre o
 *    catálogo, e afirmá-la quando não se conseguiu perguntar é a mentira mais
 *    cara que a vitrine consegue contar: quem procurou um evento pelo nome vai
 *    embora certo de que ele acabou, no dia em que o servidor caiu. As duas
 *    notícias são diferentes e agora têm cada uma a sua frase — `error`
 *    decide, e a frase de vazio só sai quando a resposta VEIO e veio vazia.
 */
const { data, pending, error } = await useFetch<any>('/api/eventos-publicos')

/**
 * O vocabulário é o MESMO da página do evento (`situacao` de lote) — a tela só
 * traduz pro português que o comprador lê. `selo-*` são as classes que existem
 * em `base.css`; qualquer outro nome renderiza sem cor nenhuma.
 */
const SELO: Record<string, { texto: string; classe: string }> = {
  disponivel: { texto: 'À VENDA', classe: 'selo-ok' },
  ultimas: { texto: 'ÚLTIMAS UNIDADES', classe: 'selo-alerta' },
  em_breve: { texto: 'EM BREVE', classe: 'selo-neutro' },
  esgotado: { texto: 'ESGOTADO', classe: 'selo-erro' },
  encerrado: { texto: 'ENCERRADO', classe: 'selo-neutro' },
}
const selo = (s: string) => SELO[s] ?? SELO.em_breve!

// `reais` e `dataCurta` vêm de `app/composables/formato.ts`: a conta de
// centavo mora num lugar só e a data é formatada em horário LOCAL (cortar de
// `toISOString()` joga o dia pra frente depois das 21h de Brasília).
useHead({ title: 'Ingressos' })
</script>

<template>
  <div class="mx-auto max-w-3xl px-4 py-12">
    <p class="rotulo">BILHETERIA</p>
    <h1 class="titulo mt-1 text-4xl font-extrabold uppercase text-tinta">Eventos</h1>

    <p v-if="pending" class="mt-8 text-tinta-suave">Carregando os eventos…</p>

    <!-- Não deu pra perguntar ≠ a resposta foi "nenhum". Quem lê isto tem que
         sair sabendo que o problema é aqui, não que o evento dele acabou. -->
    <p v-else-if="error" class="faixa-erro mt-8">
      Não deu pra carregar a lista de eventos agora. Atualize a página em alguns
      instantes — os eventos continuam lá, quem não respondeu foi a nossa
      bilheteria.
    </p>

    <ul v-else class="mt-8 space-y-3">
      <li v-for="e in data?.eventos ?? []" :key="e.slug">
        <NuxtLink :to="`/e/${e.slug}`"
          class="card flex items-center justify-between gap-4 p-5 transition-colors hover:bg-fundo-cinza">
          <span class="min-w-0">
            <span class="titulo block truncate text-lg font-bold uppercase text-tinta">{{ e.nome }}</span>
            <!-- O separador só existe quando há os dois lados. Evento sem
                 cidade cadastrada renderizava "· 21/09/2026", com o ponto
                 solto na frente da data. -->
            <span class="block text-sm text-tinta-suave">
              {{ [e.cidade, dataCurta(e.inicio)].filter(Boolean).join(' · ') }}
            </span>
          </span>
          <span class="shrink-0 text-right">
            <span :class="selo(e.situacao).classe">{{ selo(e.situacao).texto }}</span>
            <!-- Preço só quando existe lote comprável. Anunciar o valor de um
                 lote que não vende é a isca que o comprador descobre na página
                 seguinte — por isso ele é complemento do selo, nunca a
                 resposta sozinha. -->
            <span v-if="e.aPartirDeCents != null" class="mt-1 block text-sm text-tinta-suave">
              a partir de
              <strong class="font-bold tabular-nums text-tinta">{{ reais(e.aPartirDeCents) }}</strong>
            </span>
          </span>
        </NuxtLink>
      </li>
    </ul>

    <!-- `!error` é a trava: sem ele esta frase volta a ser o que a tela diz
         quando a rota cai, e ela AFIRMA que o catálogo está vazio. -->
    <p v-if="!pending && !error && !data?.eventos?.length" class="mt-8 text-tinta-suave">
      Nenhum evento à venda no momento.
    </p>
  </div>
</template>
