<script setup lang="ts">
/**
 * A barra de abas do grupo em que a tela está.
 *
 * Não recebe lista: descobre sozinha em qual grupo a rota atual cai e mostra
 * os irmãos. Assim a tela nova aparece na barra no mesmo commit em que entra
 * no menu — não existe um segundo lugar pra lembrar de atualizar.
 *
 * Some quando o grupo tem uma tela só: barra com uma aba não navega, só
 * ocupa altura e sugere que existe mais coisa ali.
 */
const props = defineProps<{ eventoId: string }>()
const route = useRoute()

const abas = computed(() => {
  const grupos = menuDoEvento(props.eventoId)
  const meu = grupos.find((g) => g.filhos?.some(
    (f) => route.path === f.para || route.path.startsWith(f.para + '/')))
  return meu?.filhos ?? []
})

/**
 * Qual aba está acesa. O caminho mais longo que casa vence: sem isso
 * `/vendas/participantes` acende "Pedidos" também, porque `/vendas` é
 * prefixo dela.
 */
const atual = computed(() => {
  const candidatas = abas.value
    .filter((a) => route.path === a.para || route.path.startsWith(a.para + '/'))
    .sort((x, y) => y.para.length - x.para.length)
  return candidatas[0]?.para ?? ''
})
</script>

<template>
  <nav v-if="abas.length > 1" class="-mb-px flex gap-6 overflow-x-auto border-b border-linha">
    <NuxtLink v-for="a in abas" :key="a.para" :to="a.para"
              class="whitespace-nowrap border-b-2 px-1 pb-3 pt-2 text-[15px] transition-colors"
              :class="atual === a.para
                ? 'border-acao font-bold text-acao'
                : 'border-transparent text-tinta-suave hover:text-tinta'">
      {{ a.aba ?? a.nome }}
    </NuxtLink>
  </nav>
</template>
