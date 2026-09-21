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
 *
 * ## Por que ela pergunta o papel
 *
 * A barra monta do MESMO catálogo do menu da lateral (`menuDoEvento`) e, até
 * aqui, não filtrava nada: os quatro papéis recebiam as mesmas abas. Medido no
 * HTML servido a uma sessão de PORTARIA em `/admin/evento/<id>/validacao` — a
 * única tela que ela abre, com a lateral já reduzida a um item:
 *
 *     href=".../validacao"            ← o leitor, que é o trabalho dela
 *     href=".../validacao/historico"  ← e a rota dele responde 403 pra ela
 *
 * A lateral tirava a porta da parede e a barra de cima desenhava de volta,
 * dois centímetros acima. Filtrar aqui é a MESMA `podeAbrirPagina` de
 * `server/utils/papeis.ts` — não uma segunda lista, que envelheceria sozinha.
 *
 * Esconder continua não sendo proteção: quem tranca é o `middleware/03.papel.ts`.
 */
import { ehPapel, podeAbrirPagina, type Papel } from '~~/server/utils/papeis'

const props = defineProps<{ eventoId: string }>()
const route = useRoute()

// Mesma `key` do layout e do middleware de rota: o Nuxt reaproveita a
// resposta em vez de bater em /api/auth/eu mais uma vez por navegação.
const { data: eu } = await useFetch<any>('/api/auth/eu', { key: 'auth-eu' })

const papel = computed<Papel | null>(() => {
  const p = eu.value?.usuario?.papel
  return ehPapel(p) ? p : null
})

const abas = computed(() => {
  // Enquanto o papel não chegou, nada é listado: `middleware/admin.global.ts`
  // já mandou pro login quem não tem sessão, e listar por otimismo é oferecer
  // porta fechada — que é exatamente o defeito que isto fecha.
  const p = papel.value
  if (!p) return []
  const grupos = menuDoEvento(props.eventoId)
  const meu = grupos.find((g) => g.filhos?.some(
    (f) => route.path === f.para || route.path.startsWith(f.para + '/')))
  return (meu?.filhos ?? []).filter((f) => podeAbrirPagina(p, f.para))
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
  <nav v-if="abas.length > 1" data-parte="abas" class="-mb-px flex gap-6 overflow-x-auto border-b border-linha">
    <NuxtLink v-for="a in abas" :key="a.para" :to="a.para"
              class="whitespace-nowrap border-b-2 px-1 pb-3 pt-2 text-[15px] transition-colors"
              :class="atual === a.para
                ? 'border-acao font-semibold text-acao'
                : 'border-transparent text-tinta-suave hover:text-tinta'">
      {{ a.aba ?? a.nome }}
    </NuxtLink>
  </nav>
</template>
