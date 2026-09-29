<script setup lang="ts">
/**
 * app/error.vue — a página de erro do site (B25).
 *
 * Não existia: `/qualquer-coisa`, um evento que saiu do ar ou a bilheteria
 * fora do ar caíam na tela padrão do Nuxt, em inglês, sem caminho de volta.
 * Quem abre um link de ingresso no celular e lê "Page not found" não sabe se
 * o problema é o link, o evento ou o pagamento que acabou de fazer.
 *
 * O texto sai de `paginaDeErro` (app/composables/carrinhoDaVitrine.ts), que
 * é pura e testada: o 404 diz O QUE não achou pelo caminho (evento, pedido,
 * transferência), o 5xx diz que o sistema não respondeu e oferece tentar de
 * novo. O status HTTP é o do erro — a vitrine lança 404 de verdade pro evento
 * que não existe (B10), e é esta página que aparece.
 *
 * Os links são `<a href>` e não `<NuxtLink>`: saindo de um erro, a carga
 * inteira da página é o caminho que sempre funciona.
 */
import { caminhoDoErro, paginaDeErro } from '~/composables/carrinhoDaVitrine'

const props = defineProps<{ error: { statusCode?: number; url?: string } | null }>()
const route = useRoute()

const status = computed(() => Number(props.error?.statusCode) || 500)

/**
 * O caminho que deu erro. No navegador vale a barra de endereço: numa navegação
 * que falhou (o `throw createError` da vitrine num link seguido pelo próprio
 * site), a rota "atual" do Nuxt ainda é a página de ANTES — o erro nasceu antes
 * de a nova montar —, e a página dizia "Página não encontrada" pra um evento.
 * No servidor, a rota da requisição; `error.url` (URL inteira) é a última rede.
 */
const caminho = computed(() => caminhoDoErro({
  enderecoDoNavegador: import.meta.client && typeof window !== 'undefined' ? window.location.pathname : null,
  rota: route?.path,
  url: props.error?.url,
}))
const pagina = computed(() => paginaDeErro(status.value, caminho.value))

useHead(() => ({ title: pagina.value.titulo }))

function tentarDeNovo() {
  if (import.meta.client) window.location.reload()
}
</script>

<template>
  <div class="min-h-screen">
    <CabecalhoPublico :conta="false" />
    <main class="mx-auto max-w-xl px-4 py-12 sm:py-16">
      <section class="card flex flex-col items-center px-6 py-10 text-center" role="alert">
        <span class="grid size-14 place-items-center rounded-2xl bg-pool-50 text-pool-700" aria-hidden="true">
          <IconeMenu :nome="status === 404 ? 'busca' : 'suporte'" :tamanho="28" />
        </span>
        <h1 class="titulo mt-4 text-2xl font-semibold text-tinta">{{ pagina.titulo }}</h1>
        <p class="mt-2 max-w-md text-tinta-suave">{{ pagina.frase }}</p>
        <div class="mt-6 flex flex-wrap justify-center gap-3">
          <button v-if="pagina.tentarDeNovo" type="button" class="btn-primario px-5" @click="tentarDeNovo">
            Tentar de novo
          </button>
          <a :href="pagina.voltar.para" class="px-5" :class="pagina.tentarDeNovo ? 'btn-secundario' : 'btn-primario'">
            {{ pagina.voltar.rotulo }}
          </a>
        </div>
        <p class="mt-6 text-xs text-tinta-fraca">Código do erro: {{ status }}</p>
      </section>
    </main>
  </div>
</template>
